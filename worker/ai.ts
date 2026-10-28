/**
 * AI API (Worker side), mounted under /api/ai/* and /api/admin/* by worker/entry.ts.
 *
 * This is the local proxy (server/index.mjs) ported to Cloudflare Workers, with
 * the parts the internet requires added on top:
 *
 *  - Identity: every request carries a Cloudflare Access token that is verified
 *    here (worker/auth.ts) — the edge is never trusted implicitly.
 *  - Permission: the verified account must have ai_grants.enabled = 1 in D1.
 *    Default is no row = no AI. A failed lookup DENIES. The check runs before
 *    any byte is sent upstream, and is repeated while a stream is running so a
 *    revocation stops an answer that is already being generated.
 *  - Credentials: AI_BASE_URL / AI_MODEL are Worker vars, AI_API_KEY is a Worker
 *    secret. Nothing here returns, logs or echoes them; upstream error text is
 *    redacted. The client can never choose the gateway: there is no config
 *    endpoint (POST /api/ai/config is a hard 404), redirects from the gateway are
 *    refused (the key is never re-sent to another host).
 *  - No usage quota (by product decision). Only technical guards: request size
 *    limits, a per-account cap on simultaneous requests, a burst limiter against
 *    runaway loops, and the timeouts below.
 *
 * Timeouts (same three-deadline design as the local proxy):
 *   connect   gateway must send response headers within min(timeout, 30s)
 *   idle      a stream may go silent for at most AI_TIMEOUT_MS (default 60s);
 *             a long answer that keeps producing text is never cut for length
 *   hard cap  max(10 × idle, 120s) total, so a trickling gateway cannot pin us
 */
import { sameOrigin, type Account, type ApiDeps, type Env } from './api'
import { platformAuth, type ProtectedEnv } from './platform/http'
import {
  addGrant,
  effectiveRole,
  entitlementOf,
  getMember,
  isOwner,
  revokeAdminPro,
  audit as pAudit,
} from './platform/core'
import type { PlatformEnv } from './platform/util'
import {
  buildGradePrompt,
  buildQaPrompt,
  extractJson,
  validateGrade,
  withAccuracyGuard,
  type ChatMessage,
  type GradeBody,
  type QaBody,
} from './ai-prompts'

export interface AiEnv extends Env {
  AI_BASE_URL?: string
  AI_API_KEY?: string
  AI_MODEL?: string
  AI_TIMEOUT_MS?: string
  AI_MAX_TOKENS?: string
  /**
   * STAGING ONLY: a service binding to the mock gateway Worker (Workers cannot
   * fetch another workers.dev Worker of the same account directly). Production
   * has no such binding, so its requests always go to AI_BASE_URL on the internet.
   */
  AI_UPSTREAM?: { fetch: typeof fetch }
}

export interface AiDeps extends ApiDeps {
  /** upstream fetch (tests inject a mock gateway) */
  fetch?: typeof fetch
  /** how often a running stream re-checks the account's AI permission */
  recheckMs?: number
  waitUntil?: (p: Promise<unknown>) => void
}

/* ---------------------------- limits ------------------------------ */
export const AI_LIMITS = {
  /** a request with images may carry up to maxImages × maxImageChars of base64 */
  maxBodyBytes: 4_600_000,
  /** text-only requests keep the original cap */
  maxTextBodyBytes: 300_000,
  maxImages: 3,
  /** one image as a data URI (≈1 MB of JPEG/PNG); the client downsizes before sending */
  maxImageChars: 1_450_000,
  maxMessages: 80,
  maxMessageChars: 40_000,
  maxTotalChars: 160_000,
  maxStemChars: 20_000,
  maxOptions: 12,
  maxOptionChars: 4_000,
  maxAnswerChars: 40_000,
  /** simultaneous AI requests per account in one isolate */
  maxConcurrent: 4,
  /** burst guard against client loops (per account, per minute, per isolate) */
  maxPerMinute: 60,
}

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
}
function json(body: unknown, status = 200, extra?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers: extra ? { ...JSON_HEADERS, ...extra } : JSON_HEADERS })
}

interface AiConfig {
  baseUrl: string
  apiKey: string
  model: string
  timeoutMs: number
  maxTokens: number
}
function readConfig(env: AiEnv): AiConfig {
  const n = (v: string | undefined, d: number, lo: number, hi: number) => {
    const x = Number(v)
    return Number.isFinite(x) && x >= lo && x <= hi ? x : d
  }
  return {
    baseUrl: (env.AI_BASE_URL || '').trim(),
    apiKey: (env.AI_API_KEY || '').trim(),
    model: (env.AI_MODEL || '').trim(),
    timeoutMs: n(env.AI_TIMEOUT_MS, 60_000, 5_000, 300_000),
    maxTokens: n(env.AI_MAX_TOKENS, 2048, 64, 32_000),
  }
}
/** Only an https gateway (http allowed for localhost tests) with no credentials in the URL. */
function validBaseUrl(u: string): boolean {
  try {
    const x = new URL(u)
    if (x.username || x.password) return false
    if (x.protocol === 'https:') return true
    return x.protocol === 'http:' && (x.hostname === '127.0.0.1' || x.hostname === 'localhost')
  } catch {
    return false
  }
}
function isConfigured(c: AiConfig): boolean {
  return Boolean(c.baseUrl && c.apiKey && c.model && validBaseUrl(c.baseUrl))
}

/** Remove anything secret-looking from text that may reach the browser. */
export function redact(text: string, c: AiConfig): string {
  let t = String(text ?? '')
  if (c.apiKey && c.apiKey.length >= 4) t = t.split(c.apiKey).join('***')
  t = t.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, 'Bearer ***')
  t = t.replace(/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
  return t
}

/* ------------------------- per-isolate guards ---------------------- */
/**
 * Concurrency LEASES (D-01). The old guard was a bare per-account counter that was
 * decremented only when a request's own code reached its cleanup. On Workers that
 * is not guaranteed: when the client goes away the runtime may never resume the
 * request's pending promises, and a stream pumped from `start()` was only cancelled
 * after the upstream answer finished. A lost decrement pinned the account at
 * "BUSY" for the isolate's whole lifetime (observed: >30 min; reproduced on
 * staging with .web-build/busy-repro.mjs).
 *
 * Now every request holds its own lease with an expiry:
 *   - release() removes exactly that lease (never someone else's);
 *   - a stream renews its lease while text keeps arriving;
 *   - an expired lease is simply not counted — so even a request whose cleanup
 *     never runs stops blocking within LEASE_TTL of its last sign of life.
 * The cap itself (maxConcurrent per account) is unchanged; no usage quota.
 */
type Lease = { exp: number; started: number; route: string }
const leases = new Map<string, Map<string, Lease>>()
const minute = new Map<string, { start: number; n: number }>()
let leaseSeq = 0
function liveLeases(accountId: string, now: number): Map<string, Lease> | undefined {
  const m = leases.get(accountId)
  if (!m) return undefined
  for (const [id, l] of m)
    if (l.exp <= now) {
      m.delete(id)
      console.log(
        `[ai-lease] expired account=${accountId.slice(0, 8)} lease=${id} route=${l.route} held=${now - l.started}ms`,
      )
    }
  if (m.size === 0) {
    leases.delete(accountId)
    return undefined
  }
  return m
}
export function acquireLease(accountId: string, now: number, ttlMs: number, route: string): string | null {
  const m = liveLeases(accountId, now)
  if (m && m.size >= AI_LIMITS.maxConcurrent) return null
  const id = `${now.toString(36)}-${(++leaseSeq).toString(36)}`
  const map = m ?? new Map<string, Lease>()
  map.set(id, { exp: now + ttlMs, started: now, route })
  leases.set(accountId, map)
  return id
}
export function renewLease(accountId: string, id: string, now: number, ttlMs: number) {
  const l = leases.get(accountId)?.get(id)
  if (l) l.exp = Math.max(l.exp, now + ttlMs)
}
export function releaseLease(accountId: string, id: string, now = Date.now()) {
  const m = leases.get(accountId)
  const l = m?.get(id)
  if (!m || !l) return
  m.delete(id)
  if (m.size === 0) leases.delete(accountId)
  console.log(
    `[ai-lease] released account=${accountId.slice(0, 8)} lease=${id} route=${l.route} held=${now - l.started}ms`,
  )
}
/** seconds until the earliest live lease of the account expires (for Retry-After) */
function retryAfterSec(accountId: string, now: number): number {
  const m = liveLeases(accountId, now)
  if (!m) return 1
  let min = Infinity
  for (const l of m.values()) min = Math.min(min, l.exp)
  return Math.max(1, Math.min(120, Math.ceil((min - now) / 1000)))
}
export function _activeLeaseCount(accountId: string, now = Date.now()): number {
  return liveLeases(accountId, now)?.size ?? 0
}
function burstLimited(id: string, now: number): boolean {
  const w = minute.get(id)
  if (!w || now - w.start > 60_000) {
    minute.set(id, { start: now, n: 1 })
    if (minute.size > 5000) minute.clear()
    return false
  }
  w.n++
  return w.n > AI_LIMITS.maxPerMinute
}
export function _resetAiGuards() {
  leases.clear()
  minute.clear()
}

/* ----------------------------- grants ------------------------------ */
/** true / false, or throws (callers treat a throw as "denied"). */
/**
 * Pro = the platform entitlement ledger, computed on every call (never a cache):
 * the member must be active and hold an unsuspended Pro grant right now.
 * ai_grants is only a mirror kept for rolling back to older code.
 */
export async function aiAllowed(env: Env, accountId: string, now = Date.now()): Promise<boolean> {
  const m = await env.DB.prepare('SELECT email, status FROM members WHERE account_id = ?')
    .bind(accountId)
    .first<{ email: string; status: string }>()
  if (!m || m.status !== 'active') return false
  return (await entitlementOf(env as unknown as PlatformEnv, m.email, now)).active
}
/** Super admin (AI admin pages). Reviewers are not AI admins. */
export async function isAdmin(env: Env, accountId: string): Promise<boolean> {
  const m = await env.DB.prepare('SELECT email, role, status FROM members WHERE account_id = ?')
    .bind(accountId)
    .first<{ email: string; role: string; status: string }>()
  if (!m || m.status !== 'active') return false
  return m.role === 'super' || isOwner(env as unknown as PlatformEnv, m.email)
}

function dayKey(now: number) {
  return new Date(now).toISOString().slice(0, 10)
}
function logUsage(env: Env, deps: AiDeps, accountId: string, now: number, failed: boolean) {
  // Observability only: never read back to limit anyone.
  const p = env.DB.prepare(
    `INSERT INTO ai_usage_daily (day, account_id, requests, failures) VALUES (?, ?, 1, ?)
     ON CONFLICT(day, account_id) DO UPDATE SET requests = requests + 1, failures = failures + excluded.failures`,
  )
    .bind(dayKey(now), accountId, failed ? 1 : 0)
    .run()
    .catch(() => undefined)
  if (deps.waitUntil) deps.waitUntil(p)
}

/* --------------------------- validation ---------------------------- */
const isStr = (v: unknown, max: number) => typeof v === 'string' && v.length <= max

function checkQa(b: QaBody): string | null {
  if (b.messages !== undefined) {
    if (!Array.isArray(b.messages) || b.messages.length > AI_LIMITS.maxMessages) return '对话轮数过多，请新开一个对话'
    let total = 0
    for (const m of b.messages as unknown[]) {
      const x = m as Record<string, unknown>
      if (!x || typeof x !== 'object') return '消息格式错误'
      if (x.role !== 'user' && x.role !== 'assistant' && x.role !== 'system') return '消息角色错误'
      if (!isStr(x.content, AI_LIMITS.maxMessageChars)) return '单条消息过长'
      total += (x.content as string).length
    }
    if (total > AI_LIMITS.maxTotalChars) return '对话内容过长，请新开一个对话'
  }
  if (b.question !== undefined) {
    const q = b.question as Record<string, unknown>
    if (!q || typeof q !== 'object') return '题目格式错误'
    if (q.stem !== undefined && !isStr(q.stem, AI_LIMITS.maxStemChars)) return '题干过长'
    if (q.type !== undefined && !isStr(q.type, 40)) return '题型格式错误'
    if (q.answer !== undefined && q.answer !== null && !isStr(q.answer, AI_LIMITS.maxOptionChars)) return '答案格式错误'
    if (q.options !== undefined) {
      if (!Array.isArray(q.options) || q.options.length > AI_LIMITS.maxOptions) return '选项格式错误'
      if (!(q.options as unknown[]).every((o) => isStr(o, AI_LIMITS.maxOptionChars))) return '选项过长'
    }
  }
  if (b.userAnswer !== undefined && !isStr(b.userAnswer, AI_LIMITS.maxAnswerChars)) return '作答过长'
  if (b.search !== undefined && typeof b.search !== 'boolean') return '联网参数错误'
  if (b.images !== undefined) {
    const bad = checkImages(b.images)
    if (bad) return bad
    if (!Array.isArray(b.messages) || !b.messages.some((m) => m.role === 'user')) return '图片必须随提问一起发送'
  }
  if (b.questionContext !== undefined) {
    const c = b.questionContext as Record<string, unknown>
    if (!c || typeof c !== 'object') return '上下文格式错误'
    if (c.chapter !== undefined && !isStr(c.chapter, 200)) return '章节格式错误'
  }
  return null
}
const IMG_RE = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/
/** MIME + real magic bytes + size; anything else is refused before reaching the gateway. */
export function checkImages(v: unknown): string | null {
  if (!Array.isArray(v) || v.length > AI_LIMITS.maxImages) return `最多附带 ${AI_LIMITS.maxImages} 张图片`
  for (const it of v as unknown[]) {
    if (typeof it !== 'string' || it.length > AI_LIMITS.maxImageChars) return '图片过大（单张需小于约 1MB）'
    const m = IMG_RE.exec(it)
    if (!m) return '只支持 JPEG / PNG 图片'
    let head: string
    try {
      head = atob(m[2].slice(0, 16))
    } catch {
      return '图片数据损坏'
    }
    const b = [...head].map((c) => c.charCodeAt(0))
    const isPng = b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47
    const isJpeg = b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff
    if ((m[1] === 'png' && !isPng) || (m[1] === 'jpeg' && !isJpeg))
      return '图片内容与格式不符（只支持真实的 JPEG / PNG）'
  }
  return null
}
function checkGrade(b: GradeBody): string | null {
  if (b.stem !== undefined && !isStr(b.stem, AI_LIMITS.maxStemChars)) return '题干过长'
  if (b.userAnswer !== undefined && !isStr(b.userAnswer, AI_LIMITS.maxAnswerChars)) return '作答过长'
  if (b.chapter !== undefined && !isStr(b.chapter, 200)) return '章节格式错误'
  if (b.qid !== undefined && !isStr(b.qid, 200)) return '题号格式错误'
  if (b.kind !== undefined && b.kind !== 'short' && b.kind !== 'material') return '题型格式错误'
  return null
}

async function readJsonBody(
  req: Request,
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; res: Response }> {
  const len = Number(req.headers.get('Content-Length') || 0)
  if (len > AI_LIMITS.maxBodyBytes)
    return { ok: false, res: json({ ok: false, reason: '请求内容过大', code: 'TOO_LARGE' }, 413) }
  const text = await req.text()
  if (text.length > AI_LIMITS.maxBodyBytes)
    return { ok: false, res: json({ ok: false, reason: '请求内容过大', code: 'TOO_LARGE' }, 413) }
  try {
    const v = JSON.parse(text || '{}')
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object')
    return { ok: true, body: v }
  } catch (e) {
    return {
      ok: false,
      res: json(
        { ok: false, reason: `请求体不是合法 JSON：${String((e as Error)?.message || e)}`, code: 'BAD_REQUEST_BODY' },
        400,
      ),
    }
  }
}

/* ------------------------------ handler ---------------------------- */
interface Authed {
  account: Account
  email: string
  role: string
}

async function authenticate(req: Request, env: Env, deps: AiDeps, now: number): Promise<Authed | Response> {
  const a = await platformAuth(req, env as unknown as ProtectedEnv, now, deps.auth)
  if (!a.ok) return json({ ok: false, error: a.error, code: a.code, reason: a.reason }, a.status)
  return { account: a.account, email: a.email, role: a.role }
}

const FORBIDDEN = () =>
  json({ ok: false, error: 'ai_forbidden', code: 'AI_FORBIDDEN', reason: '当前账号没有 AI 使用权限' }, 403)
const DENY_ON_ERROR = () =>
  json(
    {
      ok: false,
      error: 'ai_forbidden',
      code: 'AI_PERMISSION_UNAVAILABLE',
      reason: 'AI 权限校验暂时不可用，已拒绝本次请求',
    },
    503,
  )

export async function handleAi(req: Request, env: AiEnv, deps: AiDeps = {}): Promise<Response> {
  const now = deps.now ? deps.now() : Date.now()
  const url = new URL(req.url)
  const path = url.pathname

  // Routes that exist. Everything else under /api/ai/ — including the local-only
  // credential endpoint /api/ai/config — does not exist on the website.
  const route =
    path === '/api/ai/status' && req.method === 'GET'
      ? 'status'
      : path === '/api/ai/qa' && req.method === 'POST'
        ? 'qa'
        : path === '/api/ai/grade' && req.method === 'POST'
          ? 'grade'
          : path === '/api/admin/ai-users' && (req.method === 'GET' || req.method === 'POST')
            ? 'admin'
            : path === '/api/admin/ai-log' && req.method === 'GET'
              ? 'admin-log'
              : null
  if (!route) return json({ ok: false, error: 'not_found' }, 404)

  if (req.headers.get('X-ExamPilot-Client') !== '1')
    return json(
      {
        ok: false,
        error: 'bad_request',
        reason: req.headers.get('X-ExamPilot-Client') === null ? 'missing client header' : 'invalid client header',
      },
      400,
    )
  if (req.method === 'POST') {
    if (!sameOrigin(req)) return json({ ok: false, error: 'forbidden_origin' }, 403)
    if (!(req.headers.get('Content-Type') || '').startsWith('application/json'))
      return json({ ok: false, error: 'bad_request' }, 415)
  }

  const a = await authenticate(req, env, deps, now)
  if (a instanceof Response) return a
  const { account } = a

  if (route === 'admin') return handleAdmin(req, env, account, now, a.email)
  if (route === 'admin-log') return handleAdminLog(env, account)

  let allowed: boolean
  let admin: boolean
  try {
    ;[allowed, admin] = await Promise.all([
      aiAllowed(env, account.id, now),
      route === 'status' ? isAdmin(env, account.id) : false,
    ])
  } catch {
    // Not an answer about the grant: the browser keeps what it knew (N-01).
    if (route === 'status')
      return json({ ok: false, error: 'status_unavailable', message: 'AI 权限校验暂时不可用' }, 503)
    return DENY_ON_ERROR()
  }
  const cfg = readConfig(env)

  if (route === 'status') {
    let pro: Record<string, unknown> | null
    try {
      const e = await entitlementOf(env as unknown as PlatformEnv, a.email, now)
      pro = {
        tier: e.tier,
        permanent: e.permanent,
        until: e.until,
        remainingMs: e.remainingMs,
        suspended: e.suspended,
        paused: e.paused,
      }
    } catch {
      pro = null
    }
    const role = a.role
    if (!allowed) return json({ ok: true, allowed: false, admin, role, pro, configured: false })
    const configured = isConfigured(cfg)
    return json({
      ok: true,
      allowed: true,
      admin,
      role,
      pro,
      configured,
      provider: 'sub2api',
      model: configured ? cfg.model : '',
      timeoutMs: cfg.timeoutMs,
      message: configured ? `AI 网关已配置（model=${cfg.model}）` : 'AI 网关尚未由管理员配置',
    })
  }

  if (!allowed) return FORBIDDEN()

  if (burstLimited(account.id, now)) {
    return json(
      {
        ok: false,
        code: 'BUSY',
        reason: '请求过于频繁，请稍候几秒再试（这是防止程序异常循环的保护，不是使用次数限制）',
      },
      429,
    )
  }
  if (_activeLeaseCount(account.id, now) >= AI_LIMITS.maxConcurrent) {
    const ra = retryAfterSec(account.id, now)
    return json(
      {
        ok: false,
        code: 'BUSY',
        retryAfter: ra,
        reason: `当前账号已有 ${AI_LIMITS.maxConcurrent} 个 AI 回答在进行，请约 ${ra} 秒后再试，或先停止正在生成的回答`,
      },
      429,
      { 'Retry-After': String(ra) },
    )
  }

  const parsed = await readJsonBody(req)
  if (!parsed.ok) return parsed.res
  const body = parsed.body

  if (!isConfigured(cfg)) {
    return json({
      ok: false,
      reason: 'AI 网关尚未由管理员配置，暂时无法使用 AI。刷题、判分与学习记录不受影响。',
      code: 'NOT_CONFIGURED',
    })
  }

  if (!(route === 'qa' && Array.isArray((body as QaBody).images) && (body as QaBody).images!.length > 0)) {
    if (JSON.stringify(body).length > AI_LIMITS.maxTextBodyBytes)
      return json({ ok: false, reason: '请求内容过大', code: 'TOO_LARGE' }, 413)
  }
  const bad = route === 'qa' ? checkQa(body as QaBody) : checkGrade(body as GradeBody)
  if (bad) return json({ ok: false, reason: bad, code: 'BAD_REQUEST' }, 400)

  const upstream = env.AI_UPSTREAM
  const doFetch: typeof fetch = deps.fetch ?? (upstream ? (i, init) => upstream.fetch(i, init) : fetch)
  const isStreamReq =
    route === 'qa' && (body.stream === true || (req.headers.get('Accept') || '').includes('text/event-stream'))
  // Lease TTL: a non-stream call may take two gateway round trips (grade retry);
  // a stream renews its lease on every chunk, so its TTL only has to cover one idle gap.
  const leaseTtl = isStreamReq ? cfg.timeoutMs + 15_000 : cfg.timeoutMs * 2 + 15_000
  const leaseId = acquireLease(account.id, Date.now(), leaseTtl, route)
  if (!leaseId) {
    const ra = retryAfterSec(account.id, Date.now())
    return json(
      {
        ok: false,
        code: 'BUSY',
        retryAfter: ra,
        reason: `当前账号已有 ${AI_LIMITS.maxConcurrent} 个 AI 回答在进行，请约 ${ra} 秒后再试`,
      },
      429,
      { 'Retry-After': String(ra) },
    )
  }
  const release = () => releaseLease(account.id, leaseId)
  const renew = () => renewLease(account.id, leaseId, Date.now(), leaseTtl)

  const isStream = isStreamReq
  const messages = withAccuracyGuard(
    route === 'qa' ? buildQaPrompt(body as QaBody) : buildGradePrompt(body as GradeBody),
  )
  const extras: Extras | undefined = route === 'qa' ? extrasFor(body as QaBody, messages, now) : undefined

  if (isStream) {
    // release() is called when the stream finishes (normally, by error or by cancel)
    return streamQa(messages, cfg, env, account.id, deps, doFetch, req.signal, release, now, renew, extras)
  }

  try {
    let { content, provider, model } = await callGateway(messages, cfg, doFetch, req.signal, extras)
    logUsage(env, deps, account.id, now, false)
    // Web only: the real model occasionally drops a required field of the grade
    // JSON (seen ~1 in 7 real calls, e.g. no `deductions`). One silent retry for an
    // INCOMPLETE answer only; an out-of-range or unparsable result is still refused
    // exactly as before, and nothing is ever filled in or made up.
    if (route === 'grade') {
      const first = extractJson(content)
      const v0 = first ? validateGrade(first) : null
      if (v0 && !v0.ok && /缺少/.test(v0.reason) && !req.signal.aborted) {
        ;({ content, provider, model } = await callGateway(messages, cfg, doFetch, req.signal))
        logUsage(env, deps, account.id, now, false)
      }
    }
    if (route === 'qa') {
      if (!content.trim()) return json({ ok: false, reason: 'AI 未返回任何内容', code: 'EMPTY' })
      return json({ ok: true, answer: content, provider, model })
    }
    const raw = extractJson(content)
    if (!raw) {
      // Explicit failure — never fabricate a 0-score "successful" review
      return json({
        ok: false,
        reason: 'AI 未返回可解析的 JSON 评阅结果，本次评阅失败（未给出参考分）',
        code: 'BAD_GRADE_FORMAT',
      })
    }
    const v = validateGrade(raw)
    if (!v.ok) return json({ ok: false, reason: v.reason, code: 'BAD_GRADE_FORMAT' })
    return json({ ok: true, result: v.result, provider, model })
  } catch (e) {
    const code = (e as { code?: string }).code || ''
    logUsage(env, deps, account.id, now, true)
    const status = code === 'TIMEOUT' || code === 'CLIENT_ABORT' ? 200 : 502
    return json({ ok: false, reason: redact((e as Error).message || String(e), cfg), code }, status)
  } finally {
    release()
  }
}

/* --------------------------- gateway calls -------------------------- */
class GwError extends Error {
  code: string
  constructor(message: string, code: string) {
    super(message)
    this.code = code
  }
}

/* ---------------- web search + images (web edition only) ----------------
 * Plain questions keep the original /chat/completions body byte-for-byte (the
 * contract test compares it with the desktop proxy). Only when the student turns
 * on 联网 or attaches an image does the request change:
 *   - images  → OpenAI-style content parts (image_url data URI) on the last user turn
 *   - search  → /responses with tools:[{type:'web_search'}]; the gateway runs real
 *               Google Search grounding for Gemini and returns cited sources.
 */
export type Extras = { search: boolean; images: string[] }
function extrasFor(b: QaBody, messages: ChatMessage[], now: number): Extras | undefined {
  const images = Array.isArray(b.images) ? b.images : []
  const search = b.search === true
  if (!search && images.length === 0) return undefined
  if (search) {
    const day = new Date(now + 8 * 3600_000).toISOString().slice(0, 10)
    const sys = messages.find((m) => m.role === 'system')
    let hint =
      `\n【联网搜索已开启】今天是 ${day}（北京时间）。需要时效信息时请搜索网络；引用网络信息必须给出来源链接；` +
      '课程概念、提法以教材和题库为准，网络内容与教材冲突时以教材为准并说明。'
    // fix4: "今天/最新/本月/近期" questions must be answered from sources of that window.
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content || ''
    const timely =
      /今天|今日|最新|最近|近期|本月|这个月|本周|这周|本年|今年|当前|目前|现在|latest|today|this (week|month)/i.test(
        lastUser,
      )
    if (timely) {
      const month = day.slice(0, 7)
      hint +=
        `\n【时效要求】这个问题要的是最新信息（以今天 ${day} 为准）：` +
        `①优先采用发布日期或事件发生日期在 ${month}（或问题所指时间段）内的来源；②每条来源后用括号注明发布日期，例如（2026-10-22）；` +
        '③若搜索不到该时间段内的可靠报道，必须在开头明确写“未检索到该时间段内的可靠报道，以下是可查到的最近公开信息”，并写出这些信息的日期；' +
        '④绝不能把几个月前的报道说成“最新进展”；⑤不要引用搜索结果页、跳转页或无法定位到具体文章的链接。'
    }
    if (sys) sys.content += hint
    else messages.unshift({ role: 'system', content: hint.trim() })
  }
  return { search, images }
}
function lastUserIndex(messages: ChatMessage[]) {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'user') return i
  return -1
}
function chatMessagesWithImages(messages: ChatMessage[], images: string[]) {
  const li = lastUserIndex(messages)
  return messages.map((m, i) =>
    i === li && images.length
      ? {
          role: m.role,
          content: [
            { type: 'text', text: m.content },
            ...images.map((url) => ({ type: 'image_url', image_url: { url } })),
          ],
        }
      : m,
  )
}
function responsesInput(messages: ChatMessage[], images: string[]) {
  const li = lastUserIndex(messages)
  return messages.map((m, i) => {
    if (m.role === 'assistant') return { role: 'assistant', content: [{ type: 'output_text', text: m.content }] }
    const parts: unknown[] = [{ type: 'input_text', text: m.content }]
    if (i === li) for (const url of images) parts.push({ type: 'input_image', image_url: url })
    return { role: m.role, content: parts }
  })
}
/** text of a non-stream /responses result */
export function responsesText(data: unknown): string | undefined {
  const out = (data as { output?: unknown[] })?.output
  if (!Array.isArray(out)) return undefined
  let t = ''
  for (const item of out as { type?: string; content?: { type?: string; text?: string }[] }[]) {
    if (item?.type !== 'message' || !Array.isArray(item.content)) continue
    for (const c of item.content) if (c?.type === 'output_text' && typeof c.text === 'string') t += c.text
  }
  return t || undefined
}

function upstreamRequest(
  cfg: AiConfig,
  messages: ChatMessage[],
  stream: boolean,
  signal: AbortSignal,
  x?: Extras,
): Request {
  const base = cfg.baseUrl.replace(/\/$/, '')
  if (x?.search) {
    return new Request(base + '/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
        ...(stream ? { Accept: 'text/event-stream' } : {}),
      },
      body: JSON.stringify({
        model: cfg.model,
        input: responsesInput(messages, x.images),
        tools: [{ type: 'web_search' }],
        temperature: 0.3,
        max_output_tokens: cfg.maxTokens,
        ...(stream ? { stream: true } : {}),
      }),
      redirect: 'manual',
      signal,
    })
  }
  if (x?.images.length) {
    return new Request(base + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
        ...(stream ? { Accept: 'text/event-stream' } : {}),
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: chatMessagesWithImages(messages, x.images),
        temperature: 0.3,
        max_tokens: cfg.maxTokens,
        ...(stream ? { stream: true } : {}),
      }),
      redirect: 'manual',
      signal,
    })
  }
  return new Request(base + '/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
      ...(stream ? { Accept: 'text/event-stream' } : {}),
    },
    body: JSON.stringify({
      model: cfg.model,
      messages,
      temperature: 0.3,
      max_tokens: cfg.maxTokens,
      ...(stream ? { stream: true } : {}),
    }),
    // A redirect would re-send the Authorization header to wherever it points.
    redirect: 'manual',
    signal,
  })
}

async function callGateway(
  messages: ChatMessage[],
  cfg: AiConfig,
  doFetch: typeof fetch,
  clientSignal?: AbortSignal,
  extras?: Extras,
) {
  const ctrl = new AbortController()
  let abortReason = ''
  const abort = (reason: string) => {
    if (!ctrl.signal.aborted) {
      abortReason = reason
      ctrl.abort(new Error(reason))
    }
  }
  const timer = setTimeout(() => abort('timeout'), cfg.timeoutMs)
  const onClientAbort = () => abort('client-abort')
  if (clientSignal) {
    if (clientSignal.aborted) {
      clearTimeout(timer)
      throw new GwError('客户端已断开连接', 'CLIENT_ABORT')
    }
    clientSignal.addEventListener('abort', onClientAbort, { once: true })
  }
  try {
    let res: Response
    try {
      res = await doFetch(upstreamRequest(cfg, messages, false, ctrl.signal, extras))
    } catch (e) {
      if (abortReason === 'timeout')
        throw new GwError(`AI 请求超时（>${cfg.timeoutMs}ms），请重试或缩短题目长度`, 'TIMEOUT')
      if (abortReason === 'client-abort') throw new GwError('客户端已断开连接', 'CLIENT_ABORT')
      throw new GwError(`无法连接 AI 网关：${(e as Error)?.message || e}`, 'CONNECT_ERROR')
    }
    if (res.status >= 300 && res.status < 400)
      throw new GwError(`AI 网关返回重定向（HTTP ${res.status}），已拒绝`, 'GATEWAY_ERROR')
    let text: string
    try {
      text = await res.text()
    } catch (e) {
      if (abortReason === 'timeout')
        throw new GwError(`AI 请求超时（>${cfg.timeoutMs}ms），请重试或缩短题目长度`, 'TIMEOUT')
      if (abortReason === 'client-abort') throw new GwError('客户端已断开连接', 'CLIENT_ABORT')
      throw new GwError(`读取 AI 网关响应失败：${(e as Error)?.message || e}`, 'CONNECT_ERROR')
    }
    if (!res.ok) throw new GwError(`网关返回 ${res.status}: ${text.slice(0, 300)}`, 'GATEWAY_ERROR')
    let data: Record<string, unknown>
    try {
      data = JSON.parse(text)
    } catch {
      throw new GwError(`网关响应不是合法 JSON: ${text.slice(0, 120)}`, 'BAD_RESPONSE')
    }
    const content =
      (data?.choices as { message?: { content?: unknown } }[] | undefined)?.[0]?.message?.content ?? responsesText(data)
    if (typeof content !== 'string') throw new GwError('网关响应缺少 choices[0].message.content', 'BAD_RESPONSE')
    return { content, provider: (data.provider as string) || 'sub2api', model: (data.model as string) || cfg.model }
  } finally {
    clearTimeout(timer)
    clientSignal?.removeEventListener('abort', onClientAbort)
  }
}

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-store, no-transform',
  'X-Accel-Buffering': 'no',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
}

/**
 * 联网 answers cite Google grounding redirect links
 * (vertexaisearch.cloud.google.com/grounding-api-redirect/…). Those are real but
 * temporary, so before the text reaches the student each one is resolved to the
 * page it points at (one HEAD-less GET with redirect:'manual', 3 s cap). A link that
 * cannot be resolved is left exactly as the model gave it — never invented.
 */
const GROUNDING_RE = /https:\/\/vertexaisearch\.cloud\.google\.com\/grounding-api-redirect\/[A-Za-z0-9_\-=]+/g
/**
 * Gemini web search cites sources through short-lived Google redirect links
 * (vertexaisearch.cloud.google.com/grounding-api-redirect/...). They expire and then
 * answer 404 (defect fixed in v4), so they are never shown:
 *   1. follow the redirect (up to 3 hops) to the real article URL;
 *   2. check that URL answers (status < 400; 401/403/429 count as "exists but
 *      blocks robots", which a browser still opens);
 *   3. anything that cannot be resolved and checked is dropped — a markdown link
 *      keeps its title as plain text marked 未能核实, a bare link disappears.
 * No URL is ever invented.
 */
const LINK_DROPPED = '\u0000drop\u0000'

/**
 * fix4: the link resolver fetches URLs that come from model output and from redirect
 * Location headers, so every hop is checked first: http(s) only, default ports, no
 * credentials, no IP literals in private / loopback / link-local / CGNAT / ULA ranges,
 * no localhost / *.local / *.internal / single-label hosts. Anything else is not
 * fetched (and the link is dropped).
 */
export function isSafePublicUrl(raw: string): boolean {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return false
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false
  if (u.username || u.password) return false
  if (u.port && u.port !== '80' && u.port !== '443') return false
  const h = u.hostname.toLowerCase().replace(/\.$/, '')
  if (!h || !h.includes('.')) return false
  if (h === 'localhost' || /\.(localhost|local|internal|intranet|lan|home|corp|arpa)$/.test(h)) return false
  if (h.startsWith('[') || h.includes(':')) return false // IPv6 literal: never needed for news articles
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (m) {
    const [a, b2] = [+m[1], +m[2]]
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false
    if (a === 169 && b2 === 254) return false
    if (a === 172 && b2 >= 16 && b2 <= 31) return false
    if (a === 192 && b2 === 168) return false
    if (a === 100 && b2 >= 64 && b2 <= 127) return false
    if (a === 198 && (b2 === 18 || b2 === 19)) return false
  } else if (/^[\d.]+$/.test(h) || /^0x/i.test(h)) return false // odd numeric forms
  return true
}

/**
 * A source a reader cannot use: Google's grounding redirect (or its bare landing page),
 * a google.com/url or google.com/search wrapper. Never shown as a source, whatever its form.
 */
const UNVERIFIABLE_SRC = String.raw`https?:\/\/(?:vertexaisearch\.cloud\.google\.com|(?:www\.)?google\.[a-z.]+\/(?:url|search))[^\s)<>\]]*`
/**
 * A "source" that is only a site's home page or a static asset (image/icon/script) (path "/" or empty, no query) does not
 * locate any article, so in 联网 answers it is not shown as a link: the title stays,
 * marked. Bare home-page URLs are removed.
 */
export function stripHomepageLinks(text: string): string {
  const isHome = (u: string) => {
    try {
      const x = new URL(u)
      if ((x.pathname === '/' || x.pathname === '') && !x.search) return true
      // a picture / icon / script is not an article either (grounding sometimes lands on a share image)
      return /\.(png|jpe?g|gif|webp|svg|ico|bmp|avif|css|js|mp3|mp4|woff2?)$/i.test(x.pathname)
    } catch {
      return false
    }
  }
  return text
    .replace(/\[([^\]\n]*)\]\((https?:\/\/[^\s)]+)\)/g, (m, title: string, u: string) =>
      isHome(u) ? (title.trim() ? `${title}（未给出具体文章链接，已省略）` : '') : m,
    )
    .replace(/(^|[\s(（:：])(https?:\/\/[^\s)<>\]（）]+)/g, (m, pre: string, u: string) => (isHome(u) ? pre : m))
}

export function stripUnverifiableLinks(text: string): string {
  return text
    .replace(new RegExp(String.raw`\[([^\]\n]*)\]\(` + UNVERIFIABLE_SRC + String.raw`\)`, 'g'), (_m, title: string) =>
      title.trim() ? `${title}（来源链接未能核实，已省略）` : '',
    )
    .replace(new RegExp(UNVERIFIABLE_SRC, 'g'), '')
}

async function followRedirect(u: string, doFetch: typeof fetch, deadline: number): Promise<string | null> {
  let cur = u
  for (let hop = 0; hop < 3; hop++) {
    const left = deadline - Date.now()
    if (left <= 0 || !isSafePublicUrl(cur)) return null
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), left)
    try {
      const r = await doFetch(new Request(cur, { method: 'GET', redirect: 'manual', signal: ctrl.signal }))
      r.body?.cancel().catch(() => undefined)
      const loc = r.headers.get('location') || ''
      if (r.status >= 300 && r.status < 400 && loc) {
        cur = new URL(loc, cur).toString()
        if (!isSafePublicUrl(cur)) return null
        if (!new RegExp('^' + UNVERIFIABLE_SRC).test(cur) && !/^https?:\/\/[^/]*google\.[a-z.]+(\/|$)/i.test(cur))
          return cur
        continue
      }
      return null
    } catch {
      return null
    } finally {
      clearTimeout(t)
    }
  }
  return null
}
async function linkAlive(u: string, doFetch: typeof fetch, deadline: number): Promise<boolean> {
  let cur = u
  // follow at most 3 redirects by hand so every hop passes isSafePublicUrl
  for (let hop = 0; hop <= 3; hop++) {
    const left = deadline - Date.now()
    if (left <= 0 || !isSafePublicUrl(cur)) return false
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), left)
    try {
      const r = await doFetch(
        new Request(cur, {
          method: 'GET',
          redirect: 'manual',
          signal: ctrl.signal,
          headers: { 'User-Agent': 'Mozilla/5.0 (ExamPilot link check)' },
        }),
      )
      r.body?.cancel().catch(() => undefined)
      const loc = r.headers.get('location') || ''
      if (r.status >= 300 && r.status < 400 && loc) {
        cur = new URL(loc, cur).toString()
        continue
      }
      return r.status < 400 || r.status === 401 || r.status === 403 || r.status === 429
    } catch {
      return false
    } finally {
      clearTimeout(t)
    }
  }
  return false
}
export async function resolveGroundingLinks(
  text: string,
  doFetch: typeof fetch,
  cache: Map<string, string>,
  budgetMs = 6000,
) {
  const urls = [...new Set(text.match(GROUNDING_RE) || [])].filter((u) => !cache.has(u))
  const deadline = Date.now() + budgetMs
  await Promise.all(
    urls.map(async (u) => {
      const real = await followRedirect(u, doFetch, deadline)
      cache.set(
        u,
        real && /^https?:\/\/[^\s)<>]+$/.test(real) && (await linkAlive(real, doFetch, deadline)) ? real : LINK_DROPPED,
      )
    }),
  )
  const get = (u: string) => cache.get(u) ?? LINK_DROPPED
  return (
    text
      // [title](redirect) → [title](real)  or  title（来源未能核实）
      .replace(
        /\[([^\]\n]*)\]\((https:\/\/vertexaisearch\.cloud\.google\.com\/grounding-api-redirect\/[A-Za-z0-9_\-=]+)\)/g,
        (_m, title: string, u: string) => {
          const r = get(u)
          return r === LINK_DROPPED ? `${title}（来源链接未能核实，已省略）` : `[${title}](${r})`
        },
      )
      // bare redirect URLs
      .replace(GROUNDING_RE, (u) => {
        const r = get(u)
        return r === LINK_DROPPED ? '' : r
      })
      .replace(/[^\n]*/g, (line) =>
        /vertexaisearch\.|google\.[a-z.]+\/(url|search)/.test(line) ? stripUnverifiableLinks(line) : line,
      )
  )
}

function streamQa(
  messages: ChatMessage[],
  cfg: AiConfig,
  env: Env,
  accountId: string,
  deps: AiDeps,
  doFetch: typeof fetch,
  clientSignal: AbortSignal | undefined,
  release: () => void,
  now: number,
  renew: () => void = () => undefined,
  extras?: Extras,
): Promise<Response> {
  // a web search runs before the first token, so allow it a longer first byte
  const CONNECT_TIMEOUT_MS = Math.min(cfg.timeoutMs, extras?.search ? 45_000 : 30_000)
  const HARD_CAP_MS = Math.max(cfg.timeoutMs * 10, 120_000)
  const RECHECK_MS = deps.recheckMs ?? 15_000

  const ctrl = new AbortController()
  let abortReason = ''
  const abort = (reason: string) => {
    if (!ctrl.signal.aborted) {
      abortReason = reason
      ctrl.abort(new Error(reason))
    }
  }
  let connectTimer: ReturnType<typeof setTimeout> | null = setTimeout(
    () => abort('connect-timeout'),
    CONNECT_TIMEOUT_MS,
  )
  const clearConnect = () => {
    if (connectTimer) clearTimeout(connectTimer)
    connectTimer = null
  }
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => abort('idle-timeout'), cfg.timeoutMs)
  }
  armIdle()
  const hardTimer = setTimeout(() => abort('hard-cap'), HARD_CAP_MS)
  // Revocation: re-check the grant while the answer streams. Only a definitive
  // "no grant" answer is a revocation (AI_FORBIDDEN hides AI in the browser). A
  // check that could not run (a D1 hiccup) is NOT evidence of revocation (N-01:
  // treating it as one made long answers vanish from the page); two failed checks
  // in a row still stop the answer, but as a retryable error.
  let recheckFails = 0
  const recheck = setInterval(() => {
    aiAllowed(env, accountId).then(
      (ok) => {
        recheckFails = 0
        if (!ok) abort('revoked')
      },
      () => {
        recheckFails++
        if (recheckFails >= 2) abort('perm-unavailable')
      },
    )
  }, RECHECK_MS)
  const onClientAbort = () => abort('client-abort')
  clientSignal?.addEventListener('abort', onClientAbort, { once: true })

  let cleaned = false
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    clearConnect()
    if (idleTimer) clearTimeout(idleTimer)
    clearTimeout(hardTimer)
    clearInterval(recheck)
    clientSignal?.removeEventListener('abort', onClientAbort)
    release()
  }

  const abortText = () => {
    if (abortReason === 'connect-timeout') return `AI 请求超时（${CONNECT_TIMEOUT_MS}ms 内网关未返回响应头）`
    if (abortReason === 'idle-timeout') return `AI 响应超时（超过 ${cfg.timeoutMs}ms 没有收到新内容）`
    if (abortReason === 'hard-cap') return `AI 请求超时（总时长超过 ${HARD_CAP_MS}ms）`
    if (abortReason === 'revoked') return '管理员已关闭当前账号的 AI 权限，本次回答已停止'
    if (abortReason === 'perm-unavailable') return 'AI 权限校验暂时不可用，本次回答已停止，请稍后重试'
    return ''
  }
  const abortCode = () =>
    abortReason === 'revoked'
      ? 'AI_FORBIDDEN'
      : abortReason === 'perm-unavailable'
        ? 'AI_PERMISSION_UNAVAILABLE'
        : 'TIMEOUT'

  const fail = (status: number, reason: string, code: string): Response => {
    cleanup()
    logUsage(env, deps, accountId, now, true)
    return json({ ok: false, reason: redact(reason, cfg), code }, status)
  }

  return (async () => {
    let upstream: Response
    try {
      upstream = await doFetch(upstreamRequest(cfg, messages, true, ctrl.signal, extras))
      clearConnect()
    } catch (e) {
      if (abortReason === 'client-abort') return fail(200, '客户端已断开连接', 'CLIENT_ABORT')
      if (abortReason)
        return fail(
          abortReason === 'revoked' ? 403 : abortReason === 'perm-unavailable' ? 503 : 200,
          abortText(),
          abortCode(),
        )
      return fail(502, `无法连接 AI 网关：${(e as Error)?.message || e}`, 'CONNECT_ERROR')
    }
    if (upstream.status >= 300 && upstream.status < 400) {
      return fail(502, `AI 网关返回重定向（HTTP ${upstream.status}），已拒绝`, 'GATEWAY_ERROR')
    }
    if (!upstream.ok) {
      const errText = await upstream.text().catch(() => '')
      return fail(502, `网关返回 ${upstream.status}: ${errText.slice(0, 300)}`, 'GATEWAY_ERROR')
    }
    if (!upstream.body) {
      return fail(200, `AI 网关返回了空响应（HTTP ${upstream.status}），未收到任何内容`, 'EMPTY_UPSTREAM')
    }

    const enc = new TextEncoder()
    const frame = (o: unknown) => enc.encode(`data: ${JSON.stringify(o)}\n\n`)
    const upstreamType = upstream.headers.get('content-type') || ''

    // Gateway ignored stream:true and answered with one JSON completion: degrade
    // to a single-chunk SSE so the client keeps one code path (as the local proxy).
    if (!upstreamType.includes('text/event-stream')) {
      const text = await upstream.text().catch(() => '')
      let content: unknown
      try {
        const parsed = JSON.parse(text)
        content = parsed?.choices?.[0]?.message?.content ?? responsesText(parsed)
      } catch {
        content = undefined
      }
      if (typeof content !== 'string' || !content.trim()) {
        return fail(
          200,
          `AI 网关未返回可解析的内容（HTTP ${upstream.status}，Content-Type=${upstreamType || '未提供'}）`,
          'BAD_RESPONSE',
        )
      }
      cleanup()
      logUsage(env, deps, accountId, now, false)
      const body = new Uint8Array([
        ...frame({ type: 'start', model: cfg.model, provider: 'sub2api' }),
        ...frame({ type: 'chunk', delta: content }),
        ...frame({ type: 'done' }),
      ])
      return new Response(body, { status: 200, headers: SSE_HEADERS })
    }

    const reader = upstream.body.getReader()
    const decoder = new TextDecoder('utf-8')
    let buffer = ''
    let sawDone = false
    let wroteAny = false
    let finished = false
    let held = ''
    const linkCache = new Map<string, string>()

    // Parse one upstream SSE line into zero or more client frames.
    const handleLine = (line: string, push: (o: unknown) => void) => {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith(':') || !trimmed.startsWith('data:')) return
      const payload = trimmed.slice(5).trim()
      if (!payload) return
      if (payload === '[DONE]') {
        sawDone = true
        return
      }
      try {
        const parsed = JSON.parse(payload)
        // /responses (联网) streams typed events instead of chat deltas
        if (parsed?.type === 'response.completed') {
          sawDone = true
          return
        }
        const delta =
          parsed?.type === 'response.output_text.delta' ? parsed.delta : parsed?.choices?.[0]?.delta?.content
        if (typeof delta === 'string' && delta.length > 0) {
          push({ type: 'chunk', delta })
          wroteAny = true
        }
      } catch {
        // ignore partial json
      }
    }
    const finish = (controller: ReadableStreamDefaultController<Uint8Array>, last: unknown | null) => {
      if (finished) return
      finished = true
      logUsage(env, deps, accountId, now, !wroteAny || !!abortReason)
      cleanup()
      reader.cancel().catch(() => undefined)
      try {
        if (held) controller.enqueue(frame({ type: 'chunk', delta: held }))
        held = ''
        if (last) controller.enqueue(frame(last))
        controller.close()
      } catch {
        /* client already gone */
      }
    }

    // PULL-based pump (D-01): the runtime asks for the next piece only while the
    // client is still reading, and cancel() is delivered between pulls — so a client
    // that disconnects stops the upstream request and releases the lease at once.
    // (The previous version pumped the whole answer inside start(); its cancel()
    // was only honoured after the upstream answer had completed.)
    const out = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(frame({ type: 'start', model: cfg.model, provider: 'sub2api' }))
      },
      async pull(controller) {
        if (finished) return
        // search mode: hold text that may still contain a half-received link, then
        // resolve grounding redirects line by line before sending
        const emit = (o: unknown) => {
          const c = o as { type?: string; delta?: string }
          if (extras?.search && c.type === 'chunk' && typeof c.delta === 'string') held += c.delta
          else controller.enqueue(frame(o))
        }
        const flushHeld = async (all: boolean) => {
          if (!held) return false
          let take = held
          if (!all) {
            const nl = held.lastIndexOf('\n')
            const unsafe = /(\[[^\]\n]*$)|(\]\([^)\n]*$)|(https?:\/\/\S*$)|(h(t(t(p(s)?)?)?)?$)/.test(held)
            if (!unsafe) take = held
            else if (nl >= 0) take = held.slice(0, nl + 1)
            else return false
          }
          held = held.slice(take.length)
          const resolved = /vertexaisearch\.|google\.[a-z.]+\/(url|search)/.test(take)
            ? await resolveGroundingLinks(take, doFetch, linkCache)
            : take
          const out = stripHomepageLinks(resolved)
          if (out) controller.enqueue(frame({ type: 'chunk', delta: out }))
          return !!out
        }
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) {
              buffer += decoder.decode()
              if (buffer.trim()) handleLine(buffer, emit)
              buffer = ''
              await flushHeld(true)
              if (abortReason === 'revoked' || abortReason === 'perm-unavailable')
                return finish(controller, { type: 'error', code: abortCode(), reason: abortText() })
              if (!wroteAny)
                return finish(controller, {
                  type: 'error',
                  code: abortReason ? 'TIMEOUT' : 'EMPTY_STREAM',
                  reason: abortReason
                    ? abortText()
                    : sawDone
                      ? 'AI 网关返回了空内容（流中没有可用的 delta）'
                      : 'AI 网关未返回可解析的流式内容',
                })
              return finish(controller, { type: 'done' })
            }
            armIdle()
            renew()
            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split('\n')
            buffer = lines.pop() || ''
            let pushed = false
            for (const line of lines)
              handleLine(line, (o) => {
                emit(o)
                if (!extras?.search) pushed = true
              })
            if (extras?.search && (await flushHeld(false))) pushed = true
            if (sawDone && !abortReason) {
              // fix4: the gateway said [DONE] / response.completed but may keep its
              // connection open. End OUR response now: send the rest + done, close the
              // stream, cancel the upstream reader and release the lease — instead of
              // waiting for the upstream socket to close.
              if (buffer.trim()) handleLine(buffer, emit)
              buffer = ''
              await flushHeld(true)
              if (!wroteAny)
                return finish(controller, {
                  type: 'error',
                  code: 'EMPTY_STREAM',
                  reason: 'AI 网关返回了空内容（流中没有可用的 delta）',
                })
              return finish(controller, { type: 'done' })
            }
            if (pushed) return // hand control back; the next pull continues
          }
        } catch (err) {
          if (abortReason === 'client-abort') return finish(controller, null)
          const reason = abortReason ? abortText() : redact(String((err as Error)?.message || err), cfg)
          return finish(controller, {
            type: 'error',
            reason: reason || 'AI 流式响应中断',
            code: abortReason ? abortCode() : 'STREAM_ERROR',
          })
        }
      },
      cancel() {
        // The browser went away (stop button, page closed, network lost).
        abort('client-abort')
        if (!finished) {
          finished = true
          logUsage(env, deps, accountId, now, true)
          cleanup()
          reader.cancel().catch(() => undefined)
        }
      },
    })
    return new Response(out, { status: 200, headers: SSE_HEADERS })
  })()
}

/* ------------------------------ admin ------------------------------- */
/**
 * Read-only grant history (ai_grant_log, written by every POST /api/admin/ai-users).
 * Admins only; returns emails of both the target and the acting admin. No usage
 * statistics exist and none are invented.
 */
async function handleAdminLog(env: Env, account: Account): Promise<Response> {
  let admin: boolean
  try {
    admin = await isAdmin(env, account.id)
  } catch {
    return json({ ok: false, error: 'forbidden', reason: '权限校验暂时不可用' }, 503)
  }
  if (!admin) return json({ ok: false, error: 'forbidden', reason: '需要管理员权限' }, 403)
  const r = await env.DB.prepare(
    `SELECT l.id AS id, l.account_id AS accountId, l.enabled AS enabled, l.at AS at,
            (SELECT group_concat(email, ',') FROM identities i WHERE i.account_id = l.account_id) AS target,
            (SELECT group_concat(email, ',') FROM identities i WHERE i.account_id = l.by_account) AS actor
       FROM ai_grant_log l
      ORDER BY l.at DESC, l.id DESC
      LIMIT 100`,
  ).all<Record<string, unknown>>()
  return json({
    ok: true,
    log: r.results.map((x) => ({
      id: x.id,
      accountId: x.accountId,
      enabled: x.enabled === 1,
      at: x.at,
      target: String(x.target || ''),
      actor: String(x.actor || ''),
    })),
  })
}

async function handleAdmin(req: Request, env: Env, account: Account, now: number, actorEmail = ''): Promise<Response> {
  let admin: boolean
  try {
    admin = await isAdmin(env, account.id)
  } catch {
    return json({ ok: false, error: 'forbidden', reason: '权限校验暂时不可用' }, 503)
  }
  if (!admin) return json({ ok: false, error: 'forbidden', reason: '需要管理员权限' }, 403)

  if (req.method === 'GET') {
    const r = await env.DB.prepare(
      `SELECT a.id AS accountId, a.created_at AS createdAt,
              (SELECT group_concat(email, ',') FROM identities i WHERE i.account_id = a.id) AS emails,
              (SELECT MAX(last_seen_at) FROM identities i WHERE i.account_id = a.id) AS lastSeenAt,
              COALESCE(g.enabled, 0) AS aiEnabled, g.updated_at AS aiUpdatedAt,
              EXISTS (SELECT 1 FROM ai_admins d WHERE d.account_id = a.id) AS isAdmin
         FROM accounts a LEFT JOIN ai_grants g ON g.account_id = a.id
        ORDER BY lastSeenAt DESC
        LIMIT 500`,
    ).all<Record<string, unknown>>()
    return json({
      ok: true,
      users: r.results.map((u) => ({
        accountId: u.accountId,
        emails: String(u.emails || '')
          .split(',')
          .filter(Boolean),
        createdAt: u.createdAt,
        lastSeenAt: u.lastSeenAt,
        aiEnabled: u.aiEnabled === 1,
        aiUpdatedAt: u.aiUpdatedAt ?? null,
        isAdmin: u.isAdmin === 1,
      })),
    })
  }

  const parsed = await readJsonBody(req)
  if (!parsed.ok) return parsed.res
  const { accountId, enabled } = parsed.body as { accountId?: unknown; enabled?: unknown }
  if (typeof accountId !== 'string' || !/^acc_[0-9a-f]{24}$/.test(accountId) || typeof enabled !== 'boolean') {
    return json({ ok: false, error: 'bad_request', reason: '参数错误' }, 400)
  }
  const exists = await env.DB.prepare('SELECT 1 AS x FROM accounts WHERE id = ?').bind(accountId).first()
  if (!exists) return json({ ok: false, error: 'not_found', reason: '账号不存在' }, 404)
  // Legacy switch, now backed by the Pro ledger: on = permanent admin grant, off = 普通撤销.
  const pe = env as unknown as PlatformEnv
  const target = await env.DB.prepare('SELECT email FROM members WHERE account_id = ?')
    .bind(accountId)
    .first<{ email: string }>()
  if (!target) return json({ ok: false, error: 'not_found', reason: '成员不存在' }, 404)
  const m = await getMember(pe, target.email)
  if (!m || m.status !== 'active') return json({ ok: false, error: 'state', reason: '账号未启用' }, 409)
  if (enabled) {
    const cur = await entitlementOf(pe, target.email, now)
    if (!cur.permanent)
      await addGrant(pe, now, {
        email: target.email,
        source: 'admin',
        kind: 'permanent',
        reason: 'AI 开关开启',
        by: actorEmail || account.id,
      })
  } else {
    await revokeAdminPro(pe, now, target.email, actorEmail || account.id)
  }
  await env.DB.prepare('INSERT INTO ai_grant_log (account_id, enabled, by_account, at) VALUES (?, ?, ?, ?)')
    .bind(accountId, enabled ? 1 : 0, account.id, now)
    .run()
  await pAudit(
    pe,
    now,
    actorEmail || account.id,
    'super',
    enabled ? 'pro.grant' : 'pro.revoke_admin',
    target.email.replace(/^(.).*@/, '$1***@'),
    { via: 'ai-users' },
  )
  void effectiveRole
  const after = await env.DB.prepare('SELECT enabled, updated_at FROM ai_grants WHERE account_id = ?')
    .bind(accountId)
    .first<{ enabled: number; updated_at: number }>()
  return json({ ok: true, accountId, aiEnabled: after?.enabled === 1, aiUpdatedAt: after?.updated_at ?? null })
}
