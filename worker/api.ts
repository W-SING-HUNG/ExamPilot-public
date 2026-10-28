/**
 * Sync API (Worker side). Mounted under /api/sync/* by worker/entry.ts.
 *
 * Security model
 *  - Identity comes ONLY from a verified Cloudflare Access application token
 *    (worker/auth.ts). Request bodies never name the account; the client's
 *    `accountId` is only compared against the verified one (mismatch → 409,
 *    which is how a stale tab after an account switch is stopped).
 *  - Every SQL statement binds account_id from that verified identity.
 *  - State-changing requests require same-origin `Origin`, JSON content type and
 *    the custom `X-ExamPilot-Sync` header (blocks CSRF and simple cross-site posts).
 *  - Request size, op count, op size are bounded; per-isolate rate limit and a
 *    per-account daily op quota protect the free D1 budget.
 *  - Nothing user-provided is logged.
 *
 * Concurrency model
 *  - D1 executes a batch() as one SQL transaction (all-or-nothing).
 *  - A push reads the account row (seq, epoch), decides every op in JS, then
 *    commits one batch whose FIRST statement is an optimistic-concurrency guard:
 *    if the account's seq changed since the read, the guard inserts NULL into a
 *    NOT NULL column, the batch aborts and the push is re-planned. Two devices
 *    pushing at the same moment are therefore serialised without lost updates,
 *    and `seq` values are gap-free in commit order.
 *  - UNIQUE(account_id, op_id) and PRIMARY KEY(account_id, seq) back this up at
 *    the database level.
 */
import {
  EPOCH_FREE_KINDS,
  EXAM_GRACE_MS,
  MAX_BODY_BYTES,
  MAX_DOCS_PER_PUSH,
  MAX_DOC_BYTES,
  MAX_OPS_PER_PUSH,
  MAX_OP_BYTES,
  PROTOCOL_VERSION,
  PULL_PAGE,
  validateDocOp,
  validateOp,
  type ApiError,
  type DocResult,
  type ExamDocBody,
  type OpResult,
  type ServerDoc,
  type ServerOp,
  type WireDocOp,
  type WireOp,
} from '../src/sync/protocol'
import { verifyAccessJwt, AuthError, type AuthConfig } from './auth'
import { platformAuth, type ProtectedEnv } from './platform/http'
import { deleteConvImages, linkImages } from './media'

/* Minimal D1 typings (avoid a dependency on @cloudflare/workers-types). */
export interface D1Result<T = Record<string, unknown>> {
  results: T[]
  success: boolean
  meta?: { rows_read?: number; rows_written?: number; changes?: number }
}
export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement
  first<T = Record<string, unknown>>(): Promise<T | null>
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>
  run(): Promise<D1Result>
}
export interface D1Database {
  prepare(sql: string): D1PreparedStatement
  batch(stmts: D1PreparedStatement[]): Promise<D1Result[]>
}

export interface Env {
  DB: D1Database
  ACCESS_TEAM_DOMAIN: string
  ACCESS_AUD: string
  BANK_FP: string
  /** daily per-account op quota (string var) */
  DAILY_OP_QUOTA?: string
  MEDIA_DB?: D1Database
}

export interface ApiDeps {
  auth?: Partial<AuthConfig>
  now?: () => number
}

const PROVIDER = 'cf-access'

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS })
}
function err(status: number, error: ApiError['error'], message?: string): Response {
  const b: ApiError = { ok: false, error, ...(message ? { message } : {}) }
  return json(b, status)
}

/* ------------------------- rate limiting -------------------------- */
const windows = new Map<string, { start: number; n: number }>()
function rateLimited(key: string, now: number, limitPerMin: number): boolean {
  const w = windows.get(key)
  if (!w || now - w.start > 60_000) {
    windows.set(key, { start: now, n: 1 })
    if (windows.size > 5000) windows.clear()
    return false
  }
  w.n++
  return w.n > limitPerMin
}
export function _resetRateLimits() {
  windows.clear()
}

/* ------------------------- identity → account --------------------- */
export interface Account {
  id: string
  epoch: number
  seq: number
  reset_seq: number
  bank_fp: string
  status: string
}

function newAccountId(): string {
  const b = new Uint8Array(12)
  crypto.getRandomValues(b)
  return 'acc_' + [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
}

export async function resolveAccount(env: Env, email: string, sub: string, now: number): Promise<Account> {
  const find = () =>
    env.DB.prepare(
      `SELECT a.id, a.epoch, a.seq, a.reset_seq, a.bank_fp, a.status
         FROM identities i JOIN accounts a ON a.id = i.account_id
        WHERE i.provider = ? AND i.email = ?`,
    )
      .bind(PROVIDER, email)
      .first<Account>()
  let acc = await find()
  if (acc) return acc
  const id = newAccountId()
  // Create account + identity atomically. If another request created the
  // identity first, INSERT OR IGNORE keeps theirs and our account row is removed.
  await env.DB.batch([
    env.DB.prepare('INSERT INTO accounts (id, created_at, bank_fp) VALUES (?, ?, ?)').bind(id, now, env.BANK_FP),
    env.DB.prepare(
      'INSERT OR IGNORE INTO identities (provider, email, account_id, sub, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).bind(PROVIDER, email, id, sub || null, now, now),
    env.DB.prepare(
      'DELETE FROM accounts WHERE id = ? AND NOT EXISTS (SELECT 1 FROM identities WHERE account_id = ?)',
    ).bind(id, id),
  ])
  acc = await find()
  if (!acc) throw new Error('account creation failed')
  return acc
}

/* ------------------------------ helpers ---------------------------- */
interface DocRow {
  key: string
  version: number
  seq: number
  deleted: number
  body: string | null
  holder: string | null
  last_op_id: string | null
  updated_at: number
}
function toServerDoc(r: DocRow): ServerDoc {
  return {
    key: r.key,
    version: r.version,
    seq: r.seq,
    deleted: !!r.deleted,
    body: r.body ? JSON.parse(r.body) : null,
    holder: r.holder,
    updatedAt: r.updated_at,
  }
}

export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get('Origin')
  const host = new URL(req.url).host
  return origin === `https://${host}` || origin === `http://${host}`
}

function dayKey(now: number) {
  return new Date(now).toISOString().slice(0, 10)
}

/* ------------------------------ handler ---------------------------- */
export async function handleApi(req: Request, env: Env, deps: ApiDeps = {}): Promise<Response> {
  const now = deps.now ? deps.now() : Date.now()
  const url = new URL(req.url)
  const path = url.pathname

  if (req.headers.get('X-ExamPilot-Sync') !== '1') return err(400, 'bad_request', 'missing client header')

  // 1. Identity: verified Access token only; 2. membership gate (platform).
  // Rate limit is per verified e-mail, applied before any database work.
  let ident
  try {
    ident = await verifyAccessJwt(req.headers.get('Cf-Access-Jwt-Assertion'), {
      teamDomain: env.ACCESS_TEAM_DOMAIN,
      aud: env.ACCESS_AUD,
      ...deps.auth,
    })
  } catch (e) {
    if (e instanceof AuthError) return err(401, 'unauthenticated')
    return err(503, 'server_error', 'auth unavailable')
  }
  if (rateLimited(ident.email, now, 240)) return err(429, 'rate_limited')

  const a = await platformAuth(req, env as unknown as ProtectedEnv, now, deps.auth)
  if (!a.ok) {
    if (a.status === 401) return err(401, 'unauthenticated')
    if (a.status === 403) return json({ ok: false, error: 'unauthenticated', message: a.reason, code: a.code }, 403)
    return err(503, 'server_error', a.reason)
  }
  const account: Account = a.account

  try {
    if (path === '/api/sync/me' && req.method === 'GET') {
      return json({
        ok: true,
        accountId: account.id,
        email: ident.email,
        epoch: account.epoch,
        head: account.seq,
        now,
        bankFp: account.bank_fp,
      })
    }
    if (path === '/api/sync/pull' && req.method === 'GET') return await pull(env, account, url, now)
    if (path === '/api/sync/push' && req.method === 'POST') {
      if (!sameOrigin(req)) return err(403, 'forbidden_origin')
      if (!(req.headers.get('Content-Type') || '').startsWith('application/json')) return err(415 as 400, 'bad_request')
      return await push(env, account, req, now)
    }
    if (path === '/api/sync/usage' && req.method === 'GET') {
      const r = await env.DB.prepare(
        'SELECT day, requests, pushes, ops, bytes_in FROM usage_daily WHERE account_id = ? ORDER BY day DESC LIMIT 14',
      )
        .bind(account.id)
        .all()
      const size = await env.DB.prepare(
        'SELECT COUNT(*) AS ops, COALESCE(SUM(LENGTH(body)),0) AS bytes FROM ops WHERE account_id = ?',
      )
        .bind(account.id)
        .first()
      return json({ ok: true, days: r.results, stored: size })
    }
    return err(404 as 400, 'bad_request', 'unknown endpoint')
  } catch (e) {
    const msg = String((e as Error)?.message || e)
    if (/conflict_retry/.test(msg)) return err(503, 'conflict_retry')
    return err(503, 'server_error')
  }
}

async function pull(env: Env, account: Account, url: URL, now: number): Promise<Response> {
  const sinceRaw = Number(url.searchParams.get('since') ?? '0')
  if (!Number.isInteger(sinceRaw) || sinceRaw < 0) return err(400, 'bad_request', 'bad since')
  // Ops before the last reset are dead for every client — except the kinds a reset
  // does not touch (settings, AI conversations): those are still delivered, so a
  // device that joins after a reset sees them too.
  const from = sinceRaw
  const keep = EPOCH_FREE_KINDS.map((k) => `'${k}'`).join(',')
  // One batch = one consistent snapshot of account head, ops and docs.
  const [accR, opsR, docsR] = await env.DB.batch([
    env.DB.prepare('SELECT epoch, seq, reset_seq FROM accounts WHERE id = ?').bind(account.id),
    env.DB.prepare(
      `SELECT seq, op_id, client_id, epoch, kind, body, created_at
         FROM ops WHERE account_id = ? AND seq > ?
          AND (seq >= (SELECT reset_seq FROM accounts WHERE id = ?) OR kind IN (${keep}))
        ORDER BY seq LIMIT ?`,
    ).bind(account.id, from, account.id, PULL_PAGE + 1),
    env.DB.prepare(
      `SELECT key, version, seq, deleted, body, holder, last_op_id, updated_at
         FROM docs WHERE account_id = ? AND seq > ? ORDER BY seq`,
    ).bind(account.id, sinceRaw),
  ])
  const acc = accR.results[0] as { epoch: number; seq: number; reset_seq: number }
  const rows = opsR.results as {
    seq: number
    op_id: string
    client_id: string
    epoch: number
    kind: string
    body: string
    created_at: number
  }[]
  const more = rows.length > PULL_PAGE
  const page = more ? rows.slice(0, PULL_PAGE) : rows
  const ops: ServerOp[] = page.map((r) => ({
    seq: r.seq,
    id: r.op_id,
    clientId: r.client_id,
    epoch: r.epoch,
    kind: r.kind as ServerOp['kind'],
    body: JSON.parse(r.body),
    createdAt: r.created_at,
  }))
  // When paging, only return docs once the log is fully delivered so the client's
  // cursor never jumps past an op it has not received.
  const docs = more ? [] : (docsR.results as unknown as DocRow[]).map(toServerDoc)
  return json({
    ok: true,
    epoch: acc.epoch,
    resetSeq: acc.reset_seq,
    head: more ? page[page.length - 1].seq : acc.seq,
    now,
    ops,
    docs,
    more,
  })
}

async function push(env: Env, account: Account, req: Request, now: number): Promise<Response> {
  const lenHeader = Number(req.headers.get('Content-Length') || '0')
  if (lenHeader > MAX_BODY_BYTES) return err(413 as 400, 'too_large')
  const text = await req.text()
  if (text.length > MAX_BODY_BYTES) return err(413 as 400, 'too_large')
  let body: Record<string, unknown>
  try {
    body = JSON.parse(text)
  } catch {
    return err(400, 'bad_request', 'invalid json')
  }
  if (!body || typeof body !== 'object') return err(400, 'bad_request')
  if (body.protocol !== PROTOCOL_VERSION) return err(426 as 400, 'protocol_unsupported')
  if (body.accountId !== account.id) return err(409, 'identity_mismatch')
  if (body.bankFp !== env.BANK_FP || account.bank_fp !== env.BANK_FP) return err(409, 'bank_mismatch')
  const clientId = body.clientId
  if (typeof clientId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(clientId))
    return err(400, 'bad_request', 'clientId')
  const ops = Array.isArray(body.ops) ? (body.ops as unknown[]) : null
  const docs = Array.isArray(body.docs) ? (body.docs as unknown[]) : null
  if (!ops || !docs) return err(400, 'bad_request')
  if (ops.length > MAX_OPS_PER_PUSH || docs.length > MAX_DOCS_PER_PUSH) return err(413 as 400, 'too_large')

  // Daily quota (protects the shared free D1 write budget).
  const quota = Number(env.DAILY_OP_QUOTA || '20000')
  const day = dayKey(now)
  const used = await env.DB.prepare('SELECT ops FROM usage_daily WHERE day = ? AND account_id = ?')
    .bind(day, account.id)
    .first<{ ops: number }>()
  if ((used?.ops ?? 0) + ops.length > quota) return err(429, 'quota_exceeded')

  for (let attempt = 0; attempt < 8; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 15 + Math.floor(Math.random() * 40 * attempt)))
    const plan = await planPush(env, account.id, clientId, ops, docs, now)
    try {
      await env.DB.batch(plan.statements)
    } catch (e) {
      const msg = String((e as Error)?.message || e)
      if (/NOT NULL constraint failed: occ_guard\.ok|occ_guard/.test(msg) || /UNIQUE constraint failed/.test(msg)) {
        continue // someone else committed in between: re-plan on fresh state
      }
      throw e
    }
    await mediaHooks(env, account.id, ops, plan.opResults, now)
    return json({ ok: true, epoch: plan.epoch, head: plan.head, now, ops: plan.opResults, docs: plan.docResults })
  }
  throw new Error('conflict_retry')
}

/** after a committed push: images of deleted conversations go; images named by a message are linked */
async function mediaHooks(env: Env, accountId: string, ops: unknown[], results: OpResult[], now: number) {
  if (!env.MEDIA_DB) return
  const ok = new Set(results.filter((r) => r.status === 'ok' || r.status === 'dup').map((r) => r.id))
  const del: string[] = []
  const link: string[] = []
  for (const o of ops as {
    id?: string
    kind?: string
    body?: { conv?: string; msg?: { images?: { id?: string }[] } }
  }[]) {
    if (!o || !o.id || !ok.has(o.id)) continue
    if (o.kind === 'ai_conv_del' && typeof o.body?.conv === 'string') del.push(o.body.conv)
    if (o.kind === 'ai_msg' && Array.isArray(o.body?.msg?.images))
      for (const im of o.body!.msg!.images!) if (typeof im?.id === 'string') link.push(im.id)
  }
  try {
    if (del.length) await deleteConvImages(env, accountId, del)
    if (link.length) await linkImages(env, accountId, link, now)
  } catch {
    /* repaired by the media sweep */
  }
}

interface Plan {
  statements: D1PreparedStatement[]
  opResults: OpResult[]
  docResults: DocResult[]
  epoch: number
  head: number
}

async function planPush(
  env: Env,
  accountId: string,
  clientId: string,
  rawOps: unknown[],
  rawDocs: unknown[],
  now: number,
): Promise<Plan> {
  const acc = await env.DB.prepare('SELECT epoch, seq, reset_seq FROM accounts WHERE id = ?')
    .bind(accountId)
    .first<{ epoch: number; seq: number; reset_seq: number }>()
  if (!acc) throw new Error('account vanished')

  const opIds = rawOps
    .map((o) => (o && typeof o === 'object' ? (o as Record<string, unknown>).id : null))
    .filter((x): x is string => typeof x === 'string' && x.length < 200)
  const existing = new Map<string, number>()
  if (opIds.length) {
    const r = await env.DB.prepare(
      `SELECT op_id, seq FROM ops WHERE account_id = ? AND op_id IN (${opIds.map(() => '?').join(',')})`,
    )
      .bind(accountId, ...opIds)
      .all<{ op_id: string; seq: number }>()
    for (const x of r.results) existing.set(x.op_id, x.seq)
  }
  const docRows = await env.DB.prepare(
    'SELECT key, version, seq, deleted, body, holder, last_op_id, updated_at FROM docs WHERE account_id = ?',
  )
    .bind(accountId)
    .all<DocRow>()
  const docs = new Map<string, DocRow>()
  for (const d of docRows.results) docs.set(d.key, d)
  const dirtyDocs = new Set<string>()

  const st: D1PreparedStatement[] = []
  // Guard first: abort the whole batch if anyone committed after our read.
  st.push(
    env.DB.prepare('INSERT INTO occ_guard (ok) SELECT NULL WHERE (SELECT seq FROM accounts WHERE id = ?) <> ?').bind(
      accountId,
      acc.seq,
    ),
  )
  let seq = acc.seq
  let epoch = acc.epoch
  let resetSeq = acc.reset_seq
  const docResults: DocResult[] = []
  const opResults: OpResult[] = []

  const bumpDoc = (key: string, patch: Partial<DocRow>) => {
    const cur = docs.get(key)
    seq++
    const next: DocRow = {
      key,
      version: (cur?.version ?? 0) + 1,
      seq,
      deleted: 0,
      body: null,
      holder: cur?.holder ?? null,
      last_op_id: null,
      updated_at: now,
      ...patch,
    }
    docs.set(key, next)
    dirtyDocs.add(key)
    return next
  }

  /* ---- documents ---- */
  for (const raw of rawDocs) {
    const bad = validateDocOp(raw)
    const d = raw as WireDocOp
    if (bad) {
      docResults.push({
        opId: String(d?.opId ?? ''),
        key: String(d?.key ?? ''),
        status: 'rejected',
        doc: null,
        reason: bad,
      })
      continue
    }
    const bodyStr = d.body === undefined ? null : JSON.stringify(d.body)
    if (bodyStr && bodyStr.length > MAX_DOC_BYTES) {
      docResults.push({ opId: d.opId, key: d.key, status: 'rejected', doc: null, reason: 'doc too large' })
      continue
    }
    const cur = docs.get(d.key)
    const curDoc = () => (docs.get(d.key) ? toServerDoc(docs.get(d.key)!) : null)
    if (cur && cur.last_op_id === d.opId) {
      docResults.push({ opId: d.opId, key: d.key, status: 'dup', doc: curDoc() })
      continue
    }
    const curVersion = cur?.version ?? 0
    const curBody = cur?.body ? (JSON.parse(cur.body) as Record<string, unknown>) : null

    if (d.type === 'put') {
      if (curVersion !== d.baseVersion) {
        docResults.push({ opId: d.opId, key: d.key, status: 'conflict', doc: curDoc() })
        continue
      }
      bumpDoc(d.key, { body: bodyStr, holder: clientId, last_op_id: d.opId })
      docResults.push({ opId: d.opId, key: d.key, status: 'ok', doc: curDoc() })
      continue
    }
    if (d.type === 'delete') {
      if (!cur || cur.deleted) {
        docResults.push({ opId: d.opId, key: d.key, status: 'ok', doc: curDoc() })
        continue
      }
      const sameSession = d.ifSessionId !== undefined && curBody && curBody.sessionId === d.ifSessionId
      if (d.ifSessionId !== undefined && !sameSession) {
        // the stored draft belongs to a different (newer) session: keep it
        docResults.push({ opId: d.opId, key: d.key, status: 'ok', doc: curDoc() })
        continue
      }
      if (!sameSession && curVersion !== d.baseVersion) {
        docResults.push({ opId: d.opId, key: d.key, status: 'conflict', doc: curDoc() })
        continue
      }
      bumpDoc(d.key, { deleted: 1, body: null, holder: clientId, last_op_id: d.opId })
      docResults.push({ opId: d.opId, key: d.key, status: 'ok', doc: curDoc() })
      continue
    }

    // ----- running exam -----
    const exam = curBody as unknown as ExamDocBody | null
    const examLive = !!(exam && !cur!.deleted && exam.status === 'active')
    const examExpired = !!(exam && now > exam.endsAt + EXAM_GRACE_MS)
    const b = (d.body ?? {}) as Record<string, unknown>

    if (d.type === 'exam_start') {
      const runId = String(b.runId ?? '')
      const durationMs = Number(b.durationMs)
      const qids = b.qids as unknown
      if (
        !/^[A-Za-z0-9_-]{4,80}$/.test(runId) ||
        !Number.isFinite(durationMs) ||
        durationMs < 60_000 ||
        durationMs > 6 * 3600_000 ||
        !Array.isArray(qids) ||
        qids.length === 0 ||
        qids.length > 400
      ) {
        docResults.push({ opId: d.opId, key: d.key, status: 'rejected', doc: null, reason: 'bad exam' })
        continue
      }
      if (exam && exam.runId === runId) {
        docResults.push({ opId: d.opId, key: d.key, status: 'dup', doc: curDoc() })
        continue
      }
      if (examLive && !examExpired) {
        docResults.push({ opId: d.opId, key: d.key, status: 'conflict', doc: curDoc(), reason: 'another exam active' })
        continue
      }
      const proposedStart = Number(b.startedAt)
      const startedAt = Number.isFinite(proposedStart) ? Math.min(proposedStart, now) : now
      const proposedEnd = Number(b.endsAt)
      // The deadline can only be earlier than "now + duration", never later:
      // syncing can never buy extra exam time.
      const endsAt = Math.min(Number.isFinite(proposedEnd) ? proposedEnd : now + durationMs, now + durationMs)
      const next: ExamDocBody = {
        runId,
        qids: (qids as unknown[]).map(String),
        config: b.config ?? null,
        startedAt,
        endsAt,
        durationMs,
        answers: (b.answers && typeof b.answers === 'object' ? b.answers : {}) as Record<string, string | null>,
        idx: Number.isInteger(b.idx) ? (b.idx as number) : 0,
        status: 'active',
        leaseGen: 1,
        holder: clientId,
      }
      bumpDoc(d.key, { body: JSON.stringify(next), holder: clientId, last_op_id: d.opId })
      docResults.push({ opId: d.opId, key: d.key, status: 'ok', doc: curDoc() })
      continue
    }
    // save / takeover / abandon require the same exam
    if (!exam || cur!.deleted || exam.runId !== b.runId) {
      docResults.push({ opId: d.opId, key: d.key, status: 'conflict', doc: curDoc(), reason: 'no such exam' })
      continue
    }
    if (exam.status !== 'active') {
      docResults.push({ opId: d.opId, key: d.key, status: 'expired', doc: curDoc(), reason: 'exam ' + exam.status })
      continue
    }
    if (d.type === 'exam_takeover') {
      if (examExpired) {
        docResults.push({ opId: d.opId, key: d.key, status: 'expired', doc: curDoc() })
        continue
      }
      const next = { ...exam, leaseGen: exam.leaseGen + 1, holder: clientId }
      bumpDoc(d.key, { body: JSON.stringify(next), holder: clientId, last_op_id: d.opId })
      docResults.push({ opId: d.opId, key: d.key, status: 'ok', doc: curDoc() })
      continue
    }
    if (d.leaseGen !== exam.leaseGen) {
      docResults.push({ opId: d.opId, key: d.key, status: 'lease_lost', doc: curDoc() })
      continue
    }
    if (d.type === 'exam_abandon') {
      const next = { ...exam, status: 'abandoned' as const }
      bumpDoc(d.key, { body: JSON.stringify(next), holder: clientId, last_op_id: d.opId })
      docResults.push({ opId: d.opId, key: d.key, status: 'ok', doc: curDoc() })
      continue
    }
    // exam_save
    if (examExpired) {
      docResults.push({ opId: d.opId, key: d.key, status: 'expired', doc: curDoc() })
      continue
    }
    if (curVersion !== d.baseVersion) {
      docResults.push({ opId: d.opId, key: d.key, status: 'conflict', doc: curDoc() })
      continue
    }
    const answers = (b.answers && typeof b.answers === 'object' ? b.answers : {}) as Record<string, unknown>
    const allowed = new Set(exam.qids)
    const clean: Record<string, string | null> = {}
    for (const [k, v] of Object.entries(answers)) {
      if (!allowed.has(k)) continue
      clean[k] = typeof v === 'string' ? v.slice(0, 20000) : null
    }
    const idx =
      Number.isInteger(b.idx) && (b.idx as number) >= 0 && (b.idx as number) < exam.qids.length
        ? (b.idx as number)
        : exam.idx
    const next = { ...exam, answers: clean, idx }
    bumpDoc(d.key, { body: JSON.stringify(next), holder: clientId, last_op_id: d.opId })
    docResults.push({ opId: d.opId, key: d.key, status: 'ok', doc: curDoc() })
  }

  /* ---- operations ---- */
  const seenInBatch = new Set<string>()
  let accepted = 0
  for (const raw of rawOps) {
    const bad = validateOp(raw)
    const op = raw as WireOp
    if (bad) {
      opResults.push({ id: String(op?.id ?? ''), status: 'rejected', reason: bad })
      continue
    }
    if (existing.has(op.id)) {
      opResults.push({ id: op.id, status: 'dup', seq: existing.get(op.id) })
      continue
    }
    if (seenInBatch.has(op.id)) {
      opResults.push({ id: op.id, status: 'dup' })
      continue
    }
    const bodyStr = JSON.stringify(op.body)
    if (bodyStr.length > MAX_OP_BYTES) {
      opResults.push({ id: op.id, status: 'rejected', reason: 'op too large' })
      continue
    }
    if (!EPOCH_FREE_KINDS.includes(op.kind) && op.epoch !== epoch) {
      opResults.push({ id: op.id, status: 'stale_epoch' })
      continue
    }
    if (op.kind === 'mock') {
      const b = op.body as { run: { id: string; submissions: Record<string, string | null> }; leaseGen?: number }
      const cur = docs.get('exam.current')
      const exam = cur && !cur.deleted && cur.body ? (JSON.parse(cur.body) as ExamDocBody) : null
      if (exam && exam.runId === b.run.id) {
        if (exam.status === 'abandoned') {
          opResults.push({ id: op.id, status: 'rejected', reason: 'exam abandoned' })
          continue
        }
        if (exam.status === 'active') {
          if (b.leaseGen !== undefined && b.leaseGen !== exam.leaseGen) {
            opResults.push({ id: op.id, status: 'lease_lost', doc: toServerDoc(cur!) })
            continue
          }
          if (now > exam.endsAt + EXAM_GRACE_MS) {
            const a = JSON.stringify(normAnswers(b.run.submissions, exam.qids))
            const s = JSON.stringify(normAnswers(exam.answers, exam.qids))
            if (a !== s) {
              opResults.push({ id: op.id, status: 'late', doc: toServerDoc(cur!) })
              continue
            }
          }
          bumpDoc('exam.current', {
            body: JSON.stringify({ ...exam, status: 'submitted' }),
            holder: clientId,
            last_op_id: 'submit:' + op.id,
          })
        }
        // status 'submitted' with a different op id: the first submission stands
        if (exam.status === 'submitted') {
          opResults.push({ id: op.id, status: 'dup' })
          continue
        }
      }
    }
    seq++
    st.push(
      env.DB.prepare(
        `INSERT INTO ops (account_id, seq, op_id, client_id, epoch, kind, body, created_at, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        accountId,
        seq,
        op.id,
        clientId,
        op.kind === 'reset' ? epoch : op.epoch,
        op.kind,
        bodyStr,
        op.createdAt,
        now,
      ),
    )
    seenInBatch.add(op.id)
    accepted++
    opResults.push({ id: op.id, status: 'ok', seq })
    if (op.kind === 'reset') {
      epoch++
      resetSeq = seq
      // In-progress practice / exam documents belong to the data being reset.
      for (const [key, d] of docs) {
        if (d.deleted) continue
        bumpDoc(key, { deleted: 1, body: null, holder: clientId, last_op_id: 'reset:' + op.id })
      }
    }
  }

  for (const key of dirtyDocs) {
    const d = docs.get(key)!
    st.push(
      env.DB.prepare(
        `INSERT INTO docs (account_id, key, version, seq, deleted, body, holder, last_op_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (account_id, key) DO UPDATE SET version = excluded.version, seq = excluded.seq,
           deleted = excluded.deleted, body = excluded.body, holder = excluded.holder,
           last_op_id = excluded.last_op_id, updated_at = excluded.updated_at`,
      ).bind(accountId, key, d.version, d.seq, d.deleted, d.body, d.holder, d.last_op_id, d.updated_at),
    )
  }
  st.push(
    env.DB.prepare('UPDATE accounts SET seq = ?, epoch = ?, reset_seq = ? WHERE id = ?').bind(
      seq,
      epoch,
      resetSeq,
      accountId,
    ),
  )
  st.push(
    env.DB.prepare(
      `INSERT INTO clients (account_id, client_id, first_seen, last_seen) VALUES (?, ?, ?, ?)
       ON CONFLICT (account_id, client_id) DO UPDATE SET last_seen = excluded.last_seen`,
    ).bind(accountId, clientId, now, now),
  )
  st.push(
    env.DB.prepare(
      `INSERT INTO usage_daily (day, account_id, requests, pushes, ops, bytes_in) VALUES (?, ?, 1, 1, ?, 0)
       ON CONFLICT (day, account_id) DO UPDATE SET requests = requests + 1, pushes = pushes + 1, ops = ops + excluded.ops`,
    ).bind(dayKey(now), accountId, accepted),
  )
  // Re-map doc results to the final committed state of each doc.
  for (const r of docResults) if (r.status === 'ok' && docs.get(r.key)) r.doc = toServerDoc(docs.get(r.key)!)
  return { statements: st, opResults, docResults, epoch, head: seq }
}

function normAnswers(a: Record<string, string | null> | undefined, qids: string[]) {
  const out: (string | null)[] = []
  for (const q of qids) {
    const v = a?.[q]
    out.push(typeof v === 'string' && v.length ? v : null)
  }
  return out
}
