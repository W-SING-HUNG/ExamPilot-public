/**
 * Admin center API (learning host, behind Access + platform gate).
 * Every route checks the role on the server. Reviewer = applications + invites only.
 * Super = everything. Owners (SUPER_OWNERS) can never be demoted, revoked or deleted.
 */
import { syncAccess } from './access'
import {
  INVITE_TTL,
  REAPPLY_COOLDOWN,
  addGrant,
  admitMember,
  audit,
  entitlementOf,
  getMember,
  getSettings,
  handleNotices,
  isOwner,
  liftSuspension,
  loadLedger,
  payReferral,
  reconcileDeletions,
  refreshPro,
  revokeAdminPro,
  revokeGrant,
  setStatus,
  suspendPro,
  DEFAULT_TEXTS,
  type Member,
  type Role,
} from './core'
import { RETIRED_REASONS, drainOutbox, enqueueMail, mailConfigured, mailCutoff, releaseHeld } from './mail'
import { LAB_SCENARIOS, labClear, labSeed, labShift, labStatus, labTick } from './lab'
import {
  DAY,
  HOUR,
  chunks,
  cleanText,
  csvCell,
  fail,
  isReservedEmail,
  json,
  maskEmail,
  normEmail,
  readJson,
  rid,
  sha256hex,
  token,
  type PlatformEnv,
} from './util'

export interface AdminCtx {
  env: PlatformEnv
  me: Member
  role: Role
  now: number
  fetchImpl?: typeof fetch
  bg: (p: Promise<unknown>) => void
}

/* -------------------- invite limits: batch caps and per-reviewer quota -------------------- */
export const INVITE_BATCH_REVIEWER = 50
export const INVITE_BATCH_SUPER = 200
export const INVITE_DAILY_REVIEWER = 200
export const INVITE_CONFIRM_OVER = 20
export const INVITE_REVOKE_BATCH_MAX = 50
/** rate_buckets window for the current Beijing (UTC+8) calendar day, in minutes since epoch of its start
 *  (minute units keep it compatible with the hourly rate_buckets cleanup, which keeps the last 24h). */
export function bjDayWin(now: number) {
  const start = Math.floor((now + 8 * HOUR) / DAY) * DAY - 8 * HOUR
  return Math.floor(start / 60_000)
}
const dayKey = (actor: string) => 'invite_day:' + actor
/** atomically reserve n invites of today's reviewer quota; one conditional UPDATE, so parallel requests cannot overshoot */
async function reserveDaily(
  env: PlatformEnv,
  actor: string,
  win: number,
  n: number,
): Promise<{ ok: boolean; used: number }> {
  await env.DB.prepare('INSERT OR IGNORE INTO rate_buckets (key, win, n) VALUES (?, ?, 0)')
    .bind(dayKey(actor), win)
    .run()
  const r = await env.DB.prepare('UPDATE rate_buckets SET n = n + ? WHERE key = ? AND win = ? AND n + ? <= ?')
    .bind(n, dayKey(actor), win, n, INVITE_DAILY_REVIEWER)
    .run()
  const cur = await env.DB.prepare('SELECT n FROM rate_buckets WHERE key = ? AND win = ?')
    .bind(dayKey(actor), win)
    .first<{ n: number }>()
  return { ok: !!r.meta?.changes, used: cur?.n ?? 0 }
}
async function releaseDaily(env: PlatformEnv, actor: string, win: number, n: number) {
  if (n > 0)
    await env.DB.prepare('UPDATE rate_buckets SET n = MAX(0, n - ?) WHERE key = ? AND win = ?')
      .bind(n, dayKey(actor), win)
      .run()
}
type InvRow = { id: string; email: string; status: string; created_by: string; expires_at: number; version: number }
/** single source of truth for who may revoke an invite (used by the single and the batch endpoint) */
async function revokeOne(
  env: PlatformEnv,
  now: number,
  actor: string,
  isSuper: boolean,
  id: string,
  version: number | null,
  extra: Record<string, unknown> = {},
) {
  const inv = await env.DB.prepare(
    'SELECT id, email, status, created_by, expires_at, version FROM invites WHERE id = ?',
  )
    .bind(id)
    .first<InvRow>()
  if (!inv || inv.email.startsWith('deleted:')) return { id, ok: false, reason: 'not_found' }
  if (!isSuper && inv.created_by !== actor) return { id, ok: false, reason: 'forbidden' }
  if (inv.status !== 'pending') return { id, ok: false, reason: 'not_pending' }
  if (version !== null && version !== inv.version) return { id, ok: false, reason: 'stale_version' }
  const r = await env.DB.prepare(
    `UPDATE invites SET status = 'revoked', version = version + 1 WHERE id = ? AND status = 'pending' AND version = ?`,
  )
    .bind(id, inv.version)
    .run()
  if (!r.meta?.changes) return { id, ok: false, reason: 'stale_version' }
  await audit(env, now, actor, isSuper ? 'super' : 'reviewer', 'invite.revoke', id, {
    email: maskEmail(inv.email),
    ...extra,
  })
  return { id, ok: true }
}

const PAGE_MAX = 100
function paging(url: URL) {
  const size = Math.min(PAGE_MAX, Math.max(5, Number(url.searchParams.get('size')) || 20))
  const page = Math.max(1, Number(url.searchParams.get('page')) || 1)
  return { size, page, offset: (page - 1) * size }
}
const like = (q: string) => '%' + q.replace(/[\\%_]/g, (c) => '\\' + c) + '%'

export async function handleAdminPlatform(req: Request, url: URL, c: AdminCtx): Promise<Response | null> {
  const p = url.pathname
  const { env, now } = c
  const isSuper = c.role === 'super'
  const isAdmin = c.role === 'super' || c.role === 'reviewer'
  if (!isAdmin) return fail(403, 'forbidden', '需要管理员权限')
  const needSuper = () => (isSuper ? null : fail(403, 'forbidden', '需要超级管理员权限'))
  const actor = c.me.email
  const body = req.method === 'POST' ? await readJson(req, 200_000) : null
  if (req.method === 'POST' && !body) return fail(400, 'bad_request')

  /* -------------------- me / overview -------------------- */
  if (p === '/api/admin/whoami' && req.method === 'GET') {
    const unread = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM admin_notices n WHERE n.handled_at IS NULL AND (n.audience = 'reviewer' OR ? = 1)
         AND NOT EXISTS (SELECT 1 FROM admin_notice_reads r WHERE r.notice_id = n.id AND r.email = ?)`,
    )
      .bind(isSuper ? 1 : 0, actor)
      .first<{ n: number }>()
    return json({
      ok: true,
      email: actor,
      role: c.role,
      owner: isOwner(env, actor),
      unread: unread?.n ?? 0,
      mailConfigured: mailConfigured(env),
      accessConfigured: !!env.CF_ACCESS_TOKEN,
    })
  }

  if (p === '/api/admin/overview' && req.method === 'GET') {
    const days = Math.min(180, Math.max(7, Number(url.searchParams.get('days')) || 30))
    const since = now - days * DAY
    const [apps, inv, appTrend] = await env.DB.batch([
      env.DB.prepare(`SELECT status, COUNT(*) AS n FROM applications WHERE email NOT LIKE 'deleted:%' GROUP BY status`),
      env.DB.prepare(`SELECT status, COUNT(*) AS n FROM invites GROUP BY status`),
      env.DB.prepare(
        `SELECT date((created_at + 28800000)/1000, 'unixepoch') AS d, COUNT(*) AS n, SUM(status='approved') AS approved, SUM(status='rejected') AS rejected
           FROM applications WHERE created_at >= ? GROUP BY d ORDER BY d`,
      ).bind(since),
    ])
    const out: Record<string, unknown> = {
      ok: true,
      days,
      applications: Object.fromEntries((apps.results as { status: string; n: number }[]).map((x) => [x.status, x.n])),
      invites: Object.fromEntries((inv.results as { status: string; n: number }[]).map((x) => [x.status, x.n])),
      applicationTrend: appTrend.results,
    }
    if (isSuper) {
      const [mem, pro, active, refTrend, aiTrend, outbox] = await env.DB.batch([
        env.DB.prepare(`SELECT status, COUNT(*) AS n FROM members GROUP BY status`),
        env.DB.prepare(
          `SELECT SUM(tier='pro') AS pro, SUM(permanent=1) AS permanent, SUM(suspended=1) AS suspended FROM pro_state ps JOIN members m ON m.email = ps.email WHERE m.status='active'`,
        ),
        env.DB.prepare(
          `SELECT date((last_login_at + 28800000)/1000, 'unixepoch') AS d, COUNT(*) AS n FROM members WHERE last_login_at >= ? GROUP BY d ORDER BY d`,
        ).bind(since),
        env.DB.prepare(
          `SELECT date((created_at + 28800000)/1000, 'unixepoch') AS d, COUNT(*) AS n,
                  SUM(source IN ('referral','referral_manual')) AS referral, SUM(state='held') AS held
             FROM pro_grants WHERE created_at >= ? AND source <> 'legacy' GROUP BY d ORDER BY d`,
        ).bind(since),
        env.DB.prepare(
          `SELECT day AS d, SUM(requests) AS n FROM ai_usage_daily WHERE day >= ? GROUP BY day ORDER BY day`,
        ).bind(new Date(since).toISOString().slice(0, 10)),
        env.DB.prepare(`SELECT status, COUNT(*) AS n FROM mail_outbox GROUP BY status`),
      ])
      out.members = Object.fromEntries((mem.results as { status: string; n: number }[]).map((x) => [x.status, x.n]))
      out.pro = pro.results[0]
      out.lastLoginTrend = active.results
      out.grantTrend = refTrend.results
      out.aiTrend = aiTrend.results
      out.mail = Object.fromEntries((outbox.results as { status: string; n: number }[]).map((x) => [x.status, x.n]))
      const acc = await env.DB.prepare(`SELECT access_state, COUNT(*) AS n FROM members GROUP BY access_state`).all<{
        access_state: string
        n: number
      }>()
      out.access = Object.fromEntries(acc.results.map((x) => [x.access_state, x.n]))
    }
    return json(out)
  }

  /* -------------------- applications (reviewer+) -------------------- */
  if (p === '/api/admin/applications' && req.method === 'GET') {
    const { size, offset, page } = paging(url)
    const status = url.searchParams.get('status') || ''
    const q = (url.searchParams.get('q') || '').trim().toLowerCase()
    const from = Number(url.searchParams.get('from')) || 0
    const to = Number(url.searchParams.get('to')) || 0
    const sort = url.searchParams.get('sort') === 'old' ? 'ASC' : 'DESC'
    const where = ["a.email NOT LIKE 'deleted:%'"]
    const args: unknown[] = []
    if (['pending', 'approved', 'rejected'].includes(status)) {
      where.push('a.status = ?')
      args.push(status)
    }
    if (q) {
      where.push("a.email LIKE ? ESCAPE '\\'")
      args.push(like(q))
    }
    if (from) {
      where.push('a.created_at >= ?')
      args.push(from)
    }
    if (to) {
      where.push('a.created_at < ?')
      args.push(to)
    }
    const w = 'WHERE ' + where.join(' AND ')
    const [rows, cnt] = await env.DB.batch([
      env.DB.prepare(
        `SELECT a.id, a.email, a.note, a.status, a.created_at, a.decided_at, a.decided_by, a.version, a.reject_public,
                ${isSuper ? 'a.reject_internal' : 'NULL AS reject_internal'},
                (r.id IS NOT NULL) AS referred, r.flags AS refFlags
           FROM applications a LEFT JOIN referrals r ON r.application_id = a.id
           ${w} ORDER BY a.created_at ${sort} LIMIT ? OFFSET ?`,
      ).bind(...args, size, offset),
      env.DB.prepare(`SELECT COUNT(*) AS n FROM applications a ${w}`).bind(...args),
    ])
    return json({ ok: true, page, size, total: (cnt.results[0] as { n: number }).n, rows: rows.results })
  }

  if (p === '/api/admin/applications/decide' && req.method === 'POST') {
    const items = Array.isArray(body!.items) ? (body!.items as { id: unknown; version: unknown }[]) : []
    const decision = body!.decision
    if (!items.length || items.length > 100 || (decision !== 'approve' && decision !== 'reject'))
      return fail(400, 'bad_request')
    const internal = cleanText(body!.internal, 1000)
    const pub = cleanText(body!.publicNote, 500)
    if (decision === 'reject' && !internal) return fail(400, 'reason_required', '拒绝必须填写内部原因')
    const results: { id: string; ok: boolean; reason?: string }[] = []
    for (const it of items) {
      const id = typeof it.id === 'string' ? it.id : ''
      const ver = Number(it.version)
      const a = await env.DB.prepare('SELECT * FROM applications WHERE id = ?')
        .bind(id)
        .first<{ id: string; email: string; status: string; version: number }>()
      if (!a) {
        results.push({ id, ok: false, reason: 'not_found' })
        continue
      }
      // atomic: only one decision can ever win (status + version guard)
      const r = await env.DB.prepare(
        `UPDATE applications SET status = ?, decided_at = ?, decided_by = ?, reject_internal = ?, reject_public = ?, version = version + 1
          WHERE id = ? AND status = 'pending' AND version = ?`,
      )
        .bind(
          decision === 'approve' ? 'approved' : 'rejected',
          now,
          actor,
          decision === 'reject' ? internal : null,
          decision === 'reject' ? pub : null,
          id,
          ver,
        )
        .run()
      if (!r.meta?.changes) {
        results.push({ id, ok: false, reason: a.status !== 'pending' ? 'already_decided' : 'stale_version' })
        continue
      }
      if (decision === 'approve') {
        await admitMember(env, now, a.email, 'application', actor)
        await env.DB.prepare(
          `UPDATE referrals SET status = 'approved', version = version + 1 WHERE application_id = ? AND status = 'applied'`,
        )
          .bind(id)
          .run()
        // a pending invite for the same address is superseded
        await env.DB.prepare(
          `UPDATE invites SET status = 'revoked', version = version + 1 WHERE email = ? AND status = 'pending'`,
        )
          .bind(a.email)
          .run()
        await enqueueMail(env, a.email, 'apply_approved', {}, 'apply_approved:' + id, now)
      } else {
        await env.DB.prepare(
          `UPDATE referrals SET status = 'rejected', version = version + 1 WHERE application_id = ? AND status = 'applied'`,
        )
          .bind(id)
          .run()
        await enqueueMail(
          env,
          a.email,
          'apply_rejected',
          { publicNote: pub, reapplyAt: now + REAPPLY_COOLDOWN },
          'apply_rejected:' + id,
          now,
        )
      }
      await handleNotices(env, now, 'app:' + id, actor)
      await audit(env, now, actor, c.role, 'application.' + decision, id, { email: maskEmail(a.email) })
      results.push({ id, ok: true })
    }
    c.bg(syncAccess(env, now, { fetchImpl: c.fetchImpl }))
    c.bg(drainOutbox(env, now, { fetchImpl: c.fetchImpl }))
    return json({ ok: true, results })
  }

  /* -------------------- invites (reviewer+) -------------------- */
  if (p === '/api/admin/invites' && req.method === 'GET') {
    const { size, offset, page } = paging(url)
    const status = url.searchParams.get('status') || ''
    const q = (url.searchParams.get('q') || '').trim().toLowerCase()
    const where = ["email NOT LIKE 'deleted:%'"]
    const args: unknown[] = []
    if (['pending', 'accepted', 'expired', 'revoked'].includes(status)) {
      where.push('status = ?')
      args.push(status)
    }
    if (q) {
      where.push("email LIKE ? ESCAPE '\\'")
      args.push(like(q))
    }
    const w = 'WHERE ' + where.join(' AND ')
    const [rows, cnt] = await env.DB.batch([
      env.DB.prepare(
        `SELECT id, email, status, created_by, created_at, expires_at, accepted_at, version FROM invites ${w} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      ).bind(...args, size, offset),
      env.DB.prepare(`SELECT COUNT(*) AS n FROM invites ${w}`).bind(...args),
    ])
    return json({ ok: true, page, size, total: (cnt.results[0] as { n: number }).n, rows: rows.results })
  }

  if (p === '/api/admin/invites' && req.method === 'POST') {
    const raw = (
      Array.isArray(body!.emails)
        ? body!.emails
        : typeof body!.emails === 'string'
          ? String(body!.emails).split(/[\s,;，；]+/)
          : []
    ).filter((r: unknown) => !(typeof r === 'string' && !r.trim()))
    const cap = isSuper ? INVITE_BATCH_SUPER : INVITE_BATCH_REVIEWER
    if (!raw.length) return fail(400, 'bad_request')
    if (raw.length > cap) return fail(400, 'too_many', `一次最多 ${cap} 个邮箱（本次 ${raw.length} 个），请分批发送`)
    // more than 20 in one go: the operator must type the exact count (checked here, not only in the UI)
    if (raw.length > INVITE_CONFIRM_OVER && Number(body!.confirmCount) !== raw.length)
      return fail(400, 'confirm_count', `一次超过 ${INVITE_CONFIRM_OVER} 个邀请，需要输入邀请人数 ${raw.length} 确认`)
    const results: { email: string; ok: boolean; reason?: string }[] = []
    const seen = new Set<string>()
    const todo: string[] = []
    for (const r of raw) {
      const email = normEmail(r)
      if (!email) {
        results.push({ email: String(r).slice(0, 80), ok: false, reason: 'bad_email' })
        continue
      }
      if (seen.has(email)) continue
      seen.add(email)
      if (isReservedEmail(email)) {
        results.push({ email, ok: false, reason: 'reserved_email' })
        continue
      }
      const m = await getMember(env, email)
      if (m && m.status === 'active') {
        results.push({ email, ok: false, reason: 'already_member' })
        continue
      }
      if (m && (m.status === 'revoked' || m.status === 'closing')) {
        results.push({ email, ok: false, reason: m.status === 'closing' ? 'closing' : 'revoked' })
        continue
      }
      todo.push(email)
    }
    // reviewer daily quota (Beijing day), reserved atomically for the whole batch: all or nothing, never truncated
    const win = bjDayWin(now)
    if (!isSuper && todo.length) {
      const q = await reserveDaily(env, actor, win, todo.length)
      if (!q.ok)
        return json(
          {
            ok: false,
            error: 'daily_limit',
            reason: `今日邀请额度不足：今天已用 ${q.used} / ${INVITE_DAILY_REVIEWER}，本次需要 ${todo.length}。本次没有发出任何邀请。`,
            used: q.used,
            limit: INVITE_DAILY_REVIEWER,
            requested: todo.length,
          },
          429,
        )
    }
    let unused = 0
    for (const email of todo) {
      const tok = token(24)
      const id = rid('inv')
      try {
        await env.DB.prepare(
          `INSERT INTO invites (id, email, token_hash, status, created_by, created_at, expires_at) VALUES (?, ?, ?, 'pending', ?, ?, ?)`,
        )
          .bind(id, email, await sha256hex('inv:' + tok), actor, now, now + INVITE_TTL)
          .run()
      } catch (e) {
        if (/UNIQUE/.test(String((e as Error).message))) {
          results.push({ email, ok: false, reason: 'pending_exists' })
          unused++
          continue
        }
        if (!isSuper) await releaseDaily(env, actor, win, unused + (todo.length - todo.indexOf(email)))
        throw e
      }
      await enqueueMail(env, email, 'invite', { token: tok, expiresAt: now + INVITE_TTL }, 'invite:' + id, now)
      await audit(env, now, actor, c.role, 'invite.create', id, { email: maskEmail(email) })
      results.push({ email, ok: true })
    }
    if (!isSuper) await releaseDaily(env, actor, win, unused)
    c.bg(drainOutbox(env, now, { fetchImpl: c.fetchImpl }))
    return json({ ok: true, results })
  }

  if (p === '/api/admin/invites/resend' && req.method === 'POST') {
    // expired → resend (reviewer: own only); pending → fresh token (reviewer: own only);
    // revoked → re-invite, super only (the revoked row and its token stay dead). Reserved test domains: never.
    const id = String(body!.id || '')
    const inv = await env.DB.prepare(
      'SELECT id, email, status, created_by, expires_at, version FROM invites WHERE id = ?',
    )
      .bind(id)
      .first<InvRow>()
    if (!inv || inv.email.startsWith('deleted:')) return fail(404, 'not_found')
    if (isReservedEmail(inv.email)) return fail(409, 'reserved_email', '测试保留域名的邀请不能重新发送')
    if (inv.status === 'accepted') return fail(409, 'accepted', '邀请已被接受')
    const expired = inv.status === 'expired' || (inv.status === 'pending' && inv.expires_at <= now)
    const kind = inv.status === 'revoked' ? 'reinvite_revoked' : expired ? 'resend_expired' : 'resend_pending'
    if (kind === 'reinvite_revoked' && !isSuper) return fail(403, 'forbidden', '已作废的邀请只有超级管理员可以重新发起')
    if (kind !== 'reinvite_revoked' && !isSuper && inv.created_by !== actor)
      return fail(403, 'forbidden', '只能重新发送自己发出的邀请')
    const m = await getMember(env, inv.email)
    if (m && m.status === 'active') return fail(409, 'already_member', '已是成员')
    const win = bjDayWin(now)
    if (!isSuper) {
      const q = await reserveDaily(env, actor, win, 1)
      if (!q.ok)
        return json(
          {
            ok: false,
            error: 'daily_limit',
            reason: `今日邀请额度已用完（${q.used} / ${INVITE_DAILY_REVIEWER}）`,
            used: q.used,
            limit: INVITE_DAILY_REVIEWER,
          },
          429,
        )
    }
    // compare-and-set on the old row: a revoked row only bumps its version (status stays revoked, token stays dead)
    const r =
      kind === 'reinvite_revoked'
        ? await env.DB.prepare(
            `UPDATE invites SET version = version + 1 WHERE id = ? AND version = ? AND status = 'revoked'`,
          )
            .bind(id, inv.version)
            .run()
        : await env.DB.prepare(
            `UPDATE invites SET status = 'revoked', version = version + 1 WHERE id = ? AND version = ? AND status = ?`,
          )
            .bind(id, inv.version, inv.status)
            .run()
    if (!r.meta?.changes) {
      if (!isSuper) await releaseDaily(env, actor, win, 1)
      return fail(409, 'stale_version', '状态已变化，请刷新')
    }
    const tok = token(24)
    const nid = rid('inv')
    try {
      await env.DB.prepare(
        `INSERT INTO invites (id, email, token_hash, status, created_by, created_at, expires_at) VALUES (?, ?, ?, 'pending', ?, ?, ?)`,
      )
        .bind(nid, inv.email, await sha256hex('inv:' + tok), actor, now, now + INVITE_TTL)
        .run()
    } catch (e) {
      if (!isSuper) await releaseDaily(env, actor, win, 1)
      if (/UNIQUE/.test(String((e as Error).message))) return fail(409, 'pending_exists', '该邮箱已有待接受的邀请')
      throw e
    }
    await enqueueMail(env, inv.email, 'invite', { token: tok, expiresAt: now + INVITE_TTL }, 'invite:' + nid, now)
    await audit(env, now, actor, c.role, 'invite.' + kind, nid, { previous: id, email: maskEmail(inv.email) })
    c.bg(drainOutbox(env, now, { fetchImpl: c.fetchImpl }))
    return json({ ok: true, id: nid, kind })
  }

  if (p === '/api/admin/invites/revoke' && req.method === 'POST') {
    const id = String(body!.id || '')
    const ver = body!.version === undefined || body!.version === null ? null : Number(body!.version)
    const r = await revokeOne(env, now, actor, isSuper, id, ver)
    if (!r.ok && r.reason === 'forbidden') return fail(403, 'forbidden', '只能作废自己发出的邀请')
    if (!r.ok && r.reason === 'not_found') return fail(404, 'not_found')
    if (!r.ok && r.reason === 'stale_version') return fail(409, 'stale_version', '状态已变化，请刷新')
    return json({ ok: true, changed: r.ok })
  }

  if (p === '/api/admin/invites/revoke-batch' && req.method === 'POST') {
    const items = Array.isArray(body!.items) ? (body!.items as { id: unknown; version: unknown }[]) : []
    if (!items.length) return fail(400, 'bad_request')
    if (items.length > INVITE_REVOKE_BATCH_MAX)
      return fail(400, 'too_many', `一次最多作废 ${INVITE_REVOKE_BATCH_MAX} 个邀请`)
    if (Number(body!.confirmCount) !== items.length)
      return fail(400, 'confirm_count', `需要输入作废数量 ${items.length} 确认`)
    const batch = rid('rvb')
    const results: { id: string; ok: boolean; reason?: string }[] = []
    const seen = new Set<string>()
    for (const it of items) {
      const id = typeof it.id === 'string' ? it.id : ''
      if (!id || seen.has(id)) continue
      seen.add(id)
      const ver = Number(it.version)
      if (!Number.isInteger(ver)) {
        results.push({ id, ok: false, reason: 'bad_request' })
        continue
      }
      results.push(await revokeOne(env, now, actor, isSuper, id, ver, { batch }))
    }
    const done = results.filter((r) => r.ok).length
    await audit(env, now, actor, c.role, 'invite.revoke_batch', batch, {
      requested: items.length,
      revoked: done,
      failed: results.length - done,
    })
    return json({ ok: true, batch, revoked: done, results })
  }

  /* -------------------- notices (reviewer+, filtered by audience) -------------------- */
  if (p === '/api/admin/notices' && req.method === 'GET') {
    const { size, offset, page } = paging(url)
    const state = url.searchParams.get('state') || 'open'
    const where = [`(n.audience = 'reviewer' OR ? = 1)`]
    const args: unknown[] = [isSuper ? 1 : 0]
    if (state === 'open') where.push('n.handled_at IS NULL')
    if (state === 'handled') where.push('n.handled_at IS NOT NULL')
    const w = 'WHERE ' + where.join(' AND ')
    const [rows, cnt] = await env.DB.batch([
      env.DB.prepare(
        `SELECT n.id, n.kind, n.ref, n.title, n.body, n.created_at, n.handled_at, n.handled_by,
                EXISTS (SELECT 1 FROM admin_notice_reads r WHERE r.notice_id = n.id AND r.email = ?) AS read
           FROM admin_notices n ${w} ORDER BY n.created_at DESC LIMIT ? OFFSET ?`,
      ).bind(actor, ...args, size, offset),
      env.DB.prepare(`SELECT COUNT(*) AS n FROM admin_notices n ${w}`).bind(...args),
    ])
    return json({ ok: true, page, size, total: (cnt.results[0] as { n: number }).n, rows: rows.results })
  }
  if (p === '/api/admin/notices/read' && req.method === 'POST') {
    const ids = (Array.isArray(body!.ids) ? body!.ids : [])
      .filter((x): x is string => typeof x === 'string')
      .slice(0, 200)
    for (const part of chunks(ids, 40))
      await env.DB.batch(
        part.map((id) =>
          env.DB.prepare('INSERT OR IGNORE INTO admin_notice_reads (notice_id, email, read_at) VALUES (?, ?, ?)').bind(
            id,
            actor,
            now,
          ),
        ),
      )
    return json({ ok: true })
  }
  if (p === '/api/admin/notices/handle' && req.method === 'POST') {
    const id = String(body!.id || '')
    const n = await env.DB.prepare('SELECT audience FROM admin_notices WHERE id = ?')
      .bind(id)
      .first<{ audience: string }>()
    if (!n || (n.audience === 'super' && !isSuper)) return fail(404, 'not_found')
    await env.DB.prepare('UPDATE admin_notices SET handled_at = ?, handled_by = ? WHERE id = ? AND handled_at IS NULL')
      .bind(now, actor, id)
      .run()
    return json({ ok: true })
  }

  /* ==================== everything below: super only ==================== */
  const deny = needSuper()
  if (deny) return deny

  if (p === '/api/admin/members' && req.method === 'GET') {
    const { size, offset, page } = paging(url)
    const where: string[] = []
    const args: unknown[] = []
    const status = url.searchParams.get('status') || ''
    const tier = url.searchParams.get('tier') || ''
    const role = url.searchParams.get('role') || ''
    const group = url.searchParams.get('group') || ''
    const tag = url.searchParams.get('tag') || ''
    const access = url.searchParams.get('access') || ''
    const q = (url.searchParams.get('q') || '').trim().toLowerCase()
    if (['active', 'revoked', 'closing'].includes(status)) {
      where.push('m.status = ?')
      args.push(status)
    }
    if (tier === 'pro') where.push(`ps.tier = 'pro'`)
    if (tier === 'standard') where.push(`(ps.tier IS NULL OR ps.tier = 'standard')`)
    if (tier === 'suspended') where.push(`ps.suspended = 1`)
    if (['user', 'reviewer', 'super'].includes(role)) {
      where.push('m.role = ?')
      args.push(role)
    }
    if (['ok', 'pending', 'failed'].includes(access)) {
      where.push('m.access_state = ?')
      args.push(access)
    }
    if (group) {
      where.push('EXISTS (SELECT 1 FROM member_group_links g WHERE g.email = m.email AND g.group_id = ?)')
      args.push(group)
    }
    if (tag) {
      where.push('EXISTS (SELECT 1 FROM member_tags t WHERE t.email = m.email AND t.tag = ?)')
      args.push(tag)
    }
    if (q) {
      where.push("m.email LIKE ? ESCAPE '\\'")
      args.push(like(q))
    }
    if (url.searchParams.get('retain') === '1') where.push('m.long_retain = 1')
    const w = where.length ? 'WHERE ' + where.join(' AND ') : ''
    const sortKey = url.searchParams.get('sort') || 'login'
    const order =
      sortKey === 'created'
        ? 'm.created_at DESC'
        : sortKey === 'email'
          ? 'm.email ASC'
          : sortKey === 'until'
            ? 'ps.until IS NULL, ps.until ASC'
            : 'm.last_login_at IS NULL, m.last_login_at DESC'
    const [rows, cnt] = await env.DB.batch([
      env.DB.prepare(
        `SELECT m.email, m.account_id, m.role, m.status, m.source, m.created_at, m.activated_at, m.last_login_at, m.long_retain,
                m.delete_after, m.delete_reason, m.access_state, m.access_error, m.note, m.version,
                ps.tier, ps.permanent, ps.until, ps.suspended, ps.paused_ms,
                (SELECT group_concat(g.group_id) FROM member_group_links g WHERE g.email = m.email) AS groups,
                (SELECT group_concat(t.tag) FROM member_tags t WHERE t.email = m.email) AS tags
           FROM members m LEFT JOIN pro_state ps ON ps.email = m.email ${w} ORDER BY ${order} LIMIT ? OFFSET ?`,
      ).bind(...args, size, offset),
      env.DB.prepare(`SELECT COUNT(*) AS n FROM members m LEFT JOIN pro_state ps ON ps.email = m.email ${w}`).bind(
        ...args,
      ),
    ])
    const ownerSet = (rows.results as { email: string }[]).map((r) => ({ ...r, owner: isOwner(env, r.email) }))
    return json({ ok: true, page, size, total: (cnt.results[0] as { n: number }).n, rows: ownerSet })
  }

  if (p === '/api/admin/member' && req.method === 'GET') {
    const email = normEmail(url.searchParams.get('email'))
    if (!email) return fail(400, 'bad_request')
    const m = await getMember(env, email)
    if (!m) return fail(404, 'not_found')
    const ent = await entitlementOf(env, email, now)
    const ledger = await loadLedger(env, email)
    const [groups, tags, refs, apps] = await env.DB.batch([
      env.DB.prepare('SELECT group_id FROM member_group_links WHERE email = ?').bind(email),
      env.DB.prepare('SELECT tag FROM member_tags WHERE email = ?').bind(email),
      env.DB.prepare(
        'SELECT id, referee_email, status, review, flags, created_at, activated_at FROM referrals WHERE referrer_email = ? ORDER BY created_at DESC LIMIT 100',
      ).bind(email),
      env.DB.prepare(
        'SELECT id, status, created_at, decided_at FROM applications WHERE email = ? ORDER BY created_at DESC LIMIT 10',
      ).bind(email),
    ])
    return json({
      ok: true,
      member: { ...m, owner: isOwner(env, email) },
      pro: { ...ent, usage: undefined },
      ledger: ledger.grants.map((g) => ({ ...g, usage: ent.usage[g.id] ?? null })),
      suspensions: ledger.suspensions,
      groups: groups.results.map((x) => (x as { group_id: string }).group_id),
      tags: tags.results.map((x) => (x as { tag: string }).tag),
      referrals: (refs.results as { referee_email: string }[]).map((r) => ({
        ...r,
        referee_email: maskEmail(r.referee_email),
      })),
      applications: apps.results,
    })
  }

  if (p === '/api/admin/member/stats' && req.method === 'GET') {
    // learning statistics only — never answers, subjective text or AI conversation content
    const email = normEmail(url.searchParams.get('email'))
    const m = email ? await getMember(env, email) : null
    if (!m) return fail(404, 'not_found')
    if (!m.account_id) return json({ ok: true, empty: true })
    return json({ ok: true, ...(await learningStats(env, [m.account_id], now)) })
  }

  if (p === '/api/admin/stats' && req.method === 'GET') {
    const group = url.searchParams.get('group') || ''
    const ids = group
      ? await env.DB.prepare(
          `SELECT m.account_id FROM members m JOIN member_group_links g ON g.email = m.email WHERE g.group_id = ? AND m.account_id IS NOT NULL`,
        )
          .bind(group)
          .all<{ account_id: string }>()
      : await env.DB.prepare(`SELECT account_id FROM members WHERE account_id IS NOT NULL AND status = 'active'`).all<{
          account_id: string
        }>()
    return json({
      ok: true,
      members: ids.results.length,
      ...(await learningStats(
        env,
        ids.results.map((x) => x.account_id),
        now,
      )),
    })
  }

  if (p === '/api/admin/member/action' && req.method === 'POST') {
    const email = normEmail(body!.email)
    const action = String(body!.action || '')
    const m = email ? await getMember(env, email) : null
    if (!email || !m) return fail(404, 'not_found')
    const owner = isOwner(env, email)
    const reason = cleanText(body!.reason, 500)
    switch (action) {
      case 'revoke': {
        if (owner || email === actor) return fail(409, 'protected', '不能停用最高管理员或自己')
        if (!(body!.confirm === true)) return fail(400, 'confirm_required')
        const ok = await setStatus(env, now, email, 'revoked', 'admin_revoke')
        if (!ok) return fail(409, 'state', '当前状态不能停用')
        if (m.role !== 'user')
          await env.DB.prepare(`UPDATE members SET role = 'user' WHERE email = ?`).bind(email).run()
        if (m.account_id) await env.DB.prepare('DELETE FROM ai_admins WHERE account_id = ?').bind(m.account_id).run()
        await enqueueMail(env, email, 'access_revoked', { deleteAfter: now + 7 * DAY }, `revoked:${email}:${now}`, now)
        await audit(env, now, actor, 'super', 'member.revoke', maskEmail(email), { reason })
        break
      }
      case 'restore': {
        if (m.status !== 'revoked' && m.status !== 'closing') return fail(409, 'state', '账号没有停用')
        if (m.status === 'closing') return fail(409, 'self_close', '用户主动注销需要用户本人撤销')
        const ok = await setStatus(env, now, email, 'active', null)
        if (!ok) return fail(409, 'state')
        await audit(env, now, actor, 'super', 'member.restore', maskEmail(email), { reason })
        break
      }
      case 'role': {
        const role = String(body!.role || '')
        if (!['user', 'reviewer', 'super'].includes(role)) return fail(400, 'bad_request')
        if (owner) return fail(409, 'protected', '最高管理员的身份不能修改')
        if (email === actor) return fail(409, 'protected', '不能修改自己的身份')
        if (m.status !== 'active') return fail(409, 'state', '账号未启用')
        if (!(body!.confirm === true)) return fail(400, 'confirm_required')
        const r = await env.DB.prepare(
          'UPDATE members SET role = ?, version = version + 1 WHERE email = ? AND version = ?',
        )
          .bind(role, email, Number(body!.version ?? m.version))
          .run()
        if (!r.meta?.changes) return fail(409, 'stale_version', '状态已变化，请刷新')
        if (m.account_id) {
          if (role === 'super')
            await env.DB.prepare('INSERT OR IGNORE INTO ai_admins (account_id, created_at, note) VALUES (?, ?, ?)')
              .bind(m.account_id, now, 'platform')
              .run()
          else await env.DB.prepare('DELETE FROM ai_admins WHERE account_id = ?').bind(m.account_id).run()
        }
        await audit(env, now, actor, 'super', 'member.role', maskEmail(email), { from: m.role, to: role })
        break
      }
      case 'retain': {
        const on = body!.on === true
        if (!(body!.confirm === true)) return fail(400, 'confirm_required')
        await env.DB.prepare(
          `UPDATE members SET long_retain = ?, retain_cleared_at = CASE WHEN ? = 0 THEN ? ELSE retain_cleared_at END,
             inactive_warned_at = CASE WHEN ? = 0 THEN NULL ELSE inactive_warned_at END, version = version + 1 WHERE email = ?`,
        )
          .bind(on ? 1 : 0, on ? 1 : 0, now, on ? 1 : 0, email)
          .run()
        await audit(env, now, actor, 'super', on ? 'member.retain_on' : 'member.retain_off', maskEmail(email), {
          reason,
        })
        break
      }
      case 'note': {
        await env.DB.prepare('UPDATE members SET note = ? WHERE email = ?')
          .bind(cleanText(body!.note, 1000), email)
          .run()
        await audit(env, now, actor, 'super', 'member.note', maskEmail(email))
        break
      }
      case 'labels': {
        const groups = (Array.isArray(body!.groups) ? body!.groups : [])
          .filter((x): x is string => typeof x === 'string')
          .slice(0, 20)
        const tags = (Array.isArray(body!.tags) ? body!.tags : [])
          .map((x) => cleanText(x, 30))
          .filter((x): x is string => !!x)
          .slice(0, 20)
        await env.DB.batch([
          env.DB.prepare('DELETE FROM member_group_links WHERE email = ?').bind(email),
          env.DB.prepare('DELETE FROM member_tags WHERE email = ?').bind(email),
          ...groups.map((g) =>
            env.DB.prepare(
              'INSERT OR IGNORE INTO member_group_links (email, group_id) SELECT ?, id FROM member_groups WHERE id = ?',
            ).bind(email, g),
          ),
          ...tags.map((t) =>
            env.DB.prepare('INSERT OR IGNORE INTO member_tags (email, tag) VALUES (?, ?)').bind(email, t),
          ),
        ])
        await audit(env, now, actor, 'super', 'member.labels', maskEmail(email))
        break
      }
      default:
        return fail(400, 'bad_request')
    }
    c.bg(syncAccess(env, now, { fetchImpl: c.fetchImpl }))
    c.bg(drainOutbox(env, now, { fetchImpl: c.fetchImpl }))
    return json({ ok: true, member: await getMember(env, email) })
  }

  if (p === '/api/admin/members/bulk' && req.method === 'POST') {
    const emails = (Array.isArray(body!.emails) ? body!.emails : [])
      .map(normEmail)
      .filter((x): x is string => !!x)
      .slice(0, 200)
    const group = typeof body!.group === 'string' ? body!.group : ''
    const op = String(body!.op || '')
    if (!emails.length || !group || !['add', 'remove'].includes(op)) return fail(400, 'bad_request')
    for (const part of chunks(emails, 40))
      await env.DB.batch(
        part.map((e) =>
          op === 'add'
            ? env.DB.prepare(
                'INSERT OR IGNORE INTO member_group_links (email, group_id) SELECT m.email, g.id FROM members m, member_groups g WHERE m.email = ? AND g.id = ?',
              ).bind(e, group)
            : env.DB.prepare('DELETE FROM member_group_links WHERE email = ? AND group_id = ?').bind(e, group),
        ),
      )
    await audit(env, now, actor, 'super', 'members.bulk_group', group, { op, n: emails.length })
    return json({ ok: true, n: emails.length })
  }

  if (p === '/api/admin/groups' && req.method === 'GET') {
    const r = await env.DB.prepare(
      `SELECT g.id, g.name, g.created_at, (SELECT COUNT(*) FROM member_group_links l WHERE l.group_id = g.id) AS n FROM member_groups g ORDER BY g.name`,
    ).all()
    const tags = await env.DB.prepare(
      `SELECT tag, COUNT(*) AS n FROM member_tags GROUP BY tag ORDER BY n DESC LIMIT 100`,
    ).all()
    return json({ ok: true, groups: r.results, tags: tags.results })
  }
  if (p === '/api/admin/groups' && req.method === 'POST') {
    const op = String(body!.op || '')
    if (op === 'create') {
      const name = cleanText(body!.name, 40)
      if (!name) return fail(400, 'bad_request')
      try {
        await env.DB.prepare('INSERT INTO member_groups (id, name, created_at) VALUES (?, ?, ?)')
          .bind(rid('grp', 6), name, now)
          .run()
      } catch {
        return fail(409, 'exists', '分组已存在')
      }
    } else if (op === 'rename') {
      const name = cleanText(body!.name, 40)
      if (!name) return fail(400, 'bad_request')
      await env.DB.prepare('UPDATE member_groups SET name = ? WHERE id = ?')
        .bind(name, String(body!.id || ''))
        .run()
    } else if (op === 'delete') {
      const id = String(body!.id || '')
      await env.DB.batch([
        env.DB.prepare('DELETE FROM member_group_links WHERE group_id = ?').bind(id),
        env.DB.prepare('DELETE FROM member_groups WHERE id = ?').bind(id),
      ])
    } else return fail(400, 'bad_request')
    await audit(env, now, actor, 'super', 'group.' + op, String(body!.id || body!.name || ''))
    return json({ ok: true })
  }

  /* -------------------- Pro -------------------- */
  if (p === '/api/admin/pro' && req.method === 'POST') {
    const email = normEmail(body!.email)
    const action = String(body!.action || '')
    const m = email ? await getMember(env, email) : null
    if (!email || !m) return fail(404, 'not_found')
    if (m.status !== 'active' && action !== 'lift') return fail(409, 'state', '账号未启用')
    if (body!.confirm !== true) return fail(400, 'confirm_required', '需要二次确认')
    const reason = cleanText(body!.reason, 500)
    // Grants that add time must carry a request-bound idempotency key: a retried or doubled
    // request (same key, same content) adds time once; same key + other content is refused.
    const needsIdem =
      action === 'grant' ||
      (action === 'adjust' &&
        !(body!.source === 'referral_manual' && typeof body!.referralId === 'string' && body!.referralId))
    const idemOk = typeof body!.idem === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(body!.idem)
    if (needsIdem && !idemOk) return fail(400, 'idem_required', '缺少或无效的幂等键 idem（8–64 位字母、数字、_ 或 -）')
    const idem = idemOk ? 'adm:' + body!.idem : null
    const fp = needsIdem
      ? await sha256hex(
          JSON.stringify([
            email,
            action,
            body!.kind === 'permanent' ? 'permanent' : 'days',
            body!.days ?? null,
            body!.until ?? null,
            body!.source ?? null,
            body!.referralId ?? null,
            reason ?? null,
          ]),
        )
      : null
    const conflict = () => fail(409, 'idem_conflict', '这个幂等键已用于另一项不同的授权请求')
    switch (action) {
      case 'grant': {
        const kind = body!.kind === 'permanent' ? 'permanent' : 'days'
        let ms = 0
        if (kind === 'days') {
          if (typeof body!.until === 'number') {
            const cur = await entitlementOf(env, email, now)
            const base = cur.until ?? now
            ms = Math.round(body!.until - base)
            if (ms <= 0) return fail(400, 'bad_until', '到期时间必须晚于当前到期时间')
          } else {
            const days = Number(body!.days)
            if (!Number.isFinite(days) || days <= 0 || days > 3650) return fail(400, 'bad_days')
            ms = Math.round(days * DAY)
          }
        }
        const g = await addGrant(env, now, {
          email,
          source: 'admin',
          kind,
          durationMs: ms,
          reason,
          by: actor,
          idem,
          fp,
        })
        if (g.conflict) return conflict()
        await audit(env, now, actor, 'super', g.created ? 'pro.grant' : 'pro.grant_replay', maskEmail(email), {
          kind,
          days: ms / DAY,
          reason,
          grant: g.id,
          created: g.created,
        })
        break
      }
      case 'revoke_admin': {
        const n = await revokeAdminPro(env, now, email, actor)
        await audit(env, now, actor, 'super', 'pro.revoke_admin', maskEmail(email), { grants: n, reason })
        break
      }
      case 'suspend': {
        const mode = body!.mode === 'continue' ? 'continue' : 'freeze'
        const ok = await suspendPro(env, now, email, mode, actor, reason)
        if (!ok) return fail(409, 'already', '已经处于暂停中')
        await audit(env, now, actor, 'super', 'pro.suspend', maskEmail(email), { mode, reason })
        break
      }
      case 'lift': {
        const ok = await liftSuspension(env, now, email, actor)
        if (!ok) return fail(409, 'not_suspended', '没有进行中的暂停')
        await audit(env, now, actor, 'super', 'pro.lift', maskEmail(email), { reason })
        break
      }
      case 'adjust': {
        // manual top-up: 'referral_manual' (推荐补发) vs 'admin' (直接赠送)
        if (!reason) return fail(400, 'reason_required', '必须填写原因')
        const kind = body!.source === 'referral_manual' ? 'referral_manual' : 'admin'
        const days = Number(body!.days)
        if (!Number.isFinite(days) || days <= 0 || days > 3650) return fail(400, 'bad_days')
        let refId: string | null = null
        if (kind === 'referral_manual') {
          refId = typeof body!.referralId === 'string' ? body!.referralId : null
          if (refId) {
            const r = await payReferral(env, now, refId, { manual: true, by: actor })
            await audit(env, now, actor, 'super', 'pro.referral_reissue', maskEmail(email), { refId, reason, ...r })
            break
          }
        }
        const g = await addGrant(env, now, {
          email,
          source: kind,
          kind: 'days',
          durationMs: days * DAY,
          reason,
          by: actor,
          refId,
          idem,
          fp,
        })
        if (g.conflict) return conflict()
        await audit(env, now, actor, 'super', g.created ? 'pro.adjust' : 'pro.adjust_replay', maskEmail(email), {
          source: kind,
          days,
          reason,
          grant: g.id,
          created: g.created,
        })
        break
      }
      case 'correct': {
        // correct a wrong grant: revoke only its unused part (history stays)
        if (!reason) return fail(400, 'reason_required', '必须填写原因')
        const gid = String(body!.grantId || '')
        const own = await env.DB.prepare('SELECT 1 AS x FROM pro_grants WHERE id = ? AND email = ?')
          .bind(gid, email)
          .first()
        if (!own) return fail(404, 'not_found')
        const ok = await revokeGrant(env, now, gid, '纠错：' + reason)
        await audit(env, now, actor, 'super', 'pro.correct', maskEmail(email), { grant: gid, reason, changed: ok })
        break
      }
      default:
        return fail(400, 'bad_request')
    }
    const ent = await refreshPro(env, email, now)
    return json({ ok: true, pro: { ...ent, usage: undefined } })
  }

  /* -------------------- referrals & appeals -------------------- */
  if (p === '/api/admin/referrals' && req.method === 'GET') {
    const { size, offset, page } = paging(url)
    const where: string[] = []
    const args: unknown[] = []
    const st = url.searchParams.get('status') || ''
    const review = url.searchParams.get('review') || ''
    const q = (url.searchParams.get('q') || '').trim().toLowerCase()
    if (['applied', 'approved', 'rejected', 'rewarded', 'held', 'void'].includes(st)) {
      where.push('r.status = ?')
      args.push(st)
    }
    if (['pending', 'legit', 'invalid'].includes(review)) {
      where.push('r.review = ?')
      args.push(review)
    }
    if (url.searchParams.get('flagged') === '1') where.push("r.flags IS NOT NULL AND r.flags <> '[]'")
    if (q) {
      where.push("(r.referrer_email LIKE ? ESCAPE '\\' OR r.referee_email LIKE ? ESCAPE '\\')")
      args.push(like(q), like(q))
    }
    const w = where.length ? 'WHERE ' + where.join(' AND ') : ''
    const [rows, cnt] = await env.DB.batch([
      env.DB.prepare(
        `SELECT r.id, r.referrer_email, r.referee_email, r.status, r.flags, r.review, r.reviewed_by, r.reviewed_at, r.created_at, r.activated_at, r.grant_id, r.version,
                g.state AS grant_state, (SELECT status FROM appeals a WHERE a.referral_id = r.id) AS appeal
           FROM referrals r LEFT JOIN pro_grants g ON g.id = r.grant_id ${w} ORDER BY r.created_at DESC LIMIT ? OFFSET ?`,
      ).bind(...args, size, offset),
      env.DB.prepare(`SELECT COUNT(*) AS n FROM referrals r ${w}`).bind(...args),
    ])
    return json({ ok: true, page, size, total: (cnt.results[0] as { n: number }).n, rows: rows.results })
  }

  if (p === '/api/admin/referrals/review' && req.method === 'POST') {
    const id = String(body!.id || '')
    const verdict = body!.verdict
    const note = cleanText(body!.note, 500)
    if (verdict !== 'legit' && verdict !== 'invalid') return fail(400, 'bad_request')
    if (body!.confirm !== true) return fail(400, 'confirm_required')
    const r = await env.DB.prepare('SELECT * FROM referrals WHERE id = ?').bind(id).first<{
      id: string
      referrer_email: string
      grant_id: string | null
      status: string
      version: number
      review: string | null
    }>()
    if (!r) return fail(404, 'not_found')
    const u = await env.DB.prepare(
      'UPDATE referrals SET review = ?, reviewed_by = ?, reviewed_at = ?, version = version + 1 WHERE id = ? AND version = ?',
    )
      .bind(verdict, actor, now, id, Number(body!.version ?? r.version))
      .run()
    if (!u.meta?.changes) return fail(409, 'stale_version', '状态已变化，请刷新')
    if (verdict === 'legit') {
      if (r.grant_id) {
        const susp = await env.DB.prepare('SELECT 1 AS x FROM pro_suspensions WHERE email = ? AND ended_at IS NULL')
          .bind(r.referrer_email)
          .first()
        if (!susp) {
          await env.DB.prepare(`UPDATE pro_grants SET state = 'active', starts_at = ? WHERE id = ? AND state = 'held'`)
            .bind(now, r.grant_id)
            .run()
          await env.DB.prepare(`UPDATE referrals SET status = 'rewarded' WHERE id = ? AND status = 'held'`)
            .bind(id)
            .run()
          await refreshPro(env, r.referrer_email, now)
        }
      }
    } else {
      if (r.grant_id) await revokeGrant(env, now, r.grant_id, '推荐复核：违规' + (note ? '，' + note : ''))
      await env.DB.prepare(`UPDATE referrals SET status = 'void' WHERE id = ?`).bind(id).run()
    }
    await handleNotices(env, now, id, actor)
    await audit(env, now, actor, 'super', 'referral.review', id, { verdict, note })
    return json({ ok: true })
  }

  if (p === '/api/admin/appeals' && req.method === 'GET') {
    const { size, offset, page } = paging(url)
    const st = url.searchParams.get('status') || ''
    const w = ['open', 'upheld', 'denied'].includes(st) ? 'WHERE a.status = ?' : ''
    const args = w ? [st] : []
    const [rows, cnt] = await env.DB.batch([
      env.DB.prepare(
        `SELECT a.*, r.referee_email, r.status AS referral_status, r.flags FROM appeals a JOIN referrals r ON r.id = a.referral_id ${w} ORDER BY a.created_at DESC LIMIT ? OFFSET ?`,
      ).bind(...args, size, offset),
      env.DB.prepare(`SELECT COUNT(*) AS n FROM appeals a ${w}`).bind(...args),
    ])
    return json({ ok: true, page, size, total: (cnt.results[0] as { n: number }).n, rows: rows.results })
  }

  if (p === '/api/admin/appeals/decide' && req.method === 'POST') {
    const id = String(body!.id || '')
    const verdict = body!.verdict
    if (verdict !== 'upheld' && verdict !== 'denied') return fail(400, 'bad_request')
    if (body!.confirm !== true) return fail(400, 'confirm_required')
    const note = cleanText(body!.note, 500)
    const a = await env.DB.prepare('SELECT * FROM appeals WHERE id = ?')
      .bind(id)
      .first<{ id: string; referral_id: string; email: string; status: string }>()
    if (!a) return fail(404, 'not_found')
    const u = await env.DB.prepare(
      `UPDATE appeals SET status = ?, decided_at = ?, decided_by = ?, decision_note = ? WHERE id = ? AND status = 'open'`,
    )
      .bind(verdict, now, actor, note, id)
      .run()
    if (!u.meta?.changes) return fail(409, 'already', '申诉已处理')
    if (verdict === 'upheld') {
      const old = await env.DB.prepare(
        `SELECT g.id, g.state, g.revoked_unused_ms, g.duration_ms FROM referrals r JOIN pro_grants g ON g.id = r.grant_id WHERE r.id = ?`,
      )
        .bind(a.referral_id)
        .first<{ id: string; state: string; revoked_unused_ms: number | null; duration_ms: number }>()
      // restore exactly what the revocation took away (all of it if it was still held)
      const give = old ? (old.revoked_unused_ms ?? old.duration_ms) : 7 * DAY
      if (give > 0)
        await addGrant(env, now, {
          email: a.email,
          source: 'referral',
          kind: 'days',
          durationMs: give,
          reason: '申诉成功，恢复推荐奖励',
          by: actor,
          refId: a.referral_id,
          idem: 'appeal:' + a.id,
        })
      await env.DB.prepare(
        `UPDATE referrals SET review = 'legit', status = 'rewarded', version = version + 1 WHERE id = ?`,
      )
        .bind(a.referral_id)
        .run()
    }
    await handleNotices(env, now, 'appeal:' + id, actor)
    await audit(env, now, actor, 'super', 'appeal.' + verdict, id, { note })
    return json({ ok: true })
  }

  /* -------------------- settings -------------------- */
  if (p === '/api/admin/settings' && req.method === 'GET')
    return json({ ok: true, settings: await getSettings(env), defaults: DEFAULT_TEXTS })
  if (p === '/api/admin/settings' && req.method === 'POST') {
    const changes: [string, string][] = []
    if (body!.applications_open === true || body!.applications_open === false)
      changes.push(['applications_open', body!.applications_open ? '1' : '0'])
    const texts = (body!.texts && typeof body!.texts === 'object' ? body!.texts : {}) as Record<string, unknown>
    for (const k of Object.keys(DEFAULT_TEXTS)) {
      if (!(k in texts)) continue
      if (texts[k] === null) {
        changes.push([k, DEFAULT_TEXTS[k]]) // restore default
        continue
      }
      const v =
        typeof texts[k] === 'string' ? (texts[k] as string).slice(0, k === 'text.announcement' ? 1000 : 600) : null
      if (v === null) return fail(400, 'bad_request')
      changes.push([k, v])
    }
    if (!changes.length) return fail(400, 'bad_request')
    await env.DB.batch(
      changes.map(([k, v]) =>
        env.DB.prepare(
          `INSERT INTO site_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
        ).bind(k, v, now, actor),
      ),
    )
    await audit(env, now, actor, 'super', 'settings.update', changes.map((x) => x[0]).join(','))
    return json({ ok: true, settings: await getSettings(env) })
  }

  /* -------------------- audit -------------------- */
  if (p === '/api/admin/audit' && req.method === 'GET') {
    const { size, offset, page } = paging(url)
    const where: string[] = []
    const args: unknown[] = []
    const action = url.searchParams.get('action') || ''
    const q = (url.searchParams.get('q') || '').trim().toLowerCase()
    const from = Number(url.searchParams.get('from')) || 0
    const to = Number(url.searchParams.get('to')) || 0
    if (action) {
      where.push("action LIKE ? ESCAPE '\\'")
      args.push(action.replace(/[\\%_]/g, (x) => '\\' + x) + '%')
    }
    if (q) {
      where.push("(actor LIKE ? ESCAPE '\\' OR target LIKE ? ESCAPE '\\')")
      args.push(like(q), like(q))
    }
    if (from) {
      where.push('at >= ?')
      args.push(from)
    }
    if (to) {
      where.push('at < ?')
      args.push(to)
    }
    const w = where.length ? 'WHERE ' + where.join(' AND ') : ''
    const [rows, cnt] = await env.DB.batch([
      env.DB.prepare(
        `SELECT id, at, actor, actor_role, action, target, detail FROM audit_log ${w} ORDER BY at DESC, id DESC LIMIT ? OFFSET ?`,
      ).bind(...args, size, offset),
      env.DB.prepare(`SELECT COUNT(*) AS n FROM audit_log ${w}`).bind(...args),
    ])
    return json({ ok: true, page, size, total: (cnt.results[0] as { n: number }).n, rows: rows.results })
  }

  /* -------------------- export (CSV, logged) -------------------- */
  if (p === '/api/admin/export' && req.method === 'GET') {
    const type = url.searchParams.get('type')
    let header: string[]
    let rows: unknown[][]
    if (type === 'rewards') {
      const from = Number(url.searchParams.get('from')) || 0
      const to = Number(url.searchParams.get('to')) || now + DAY
      const source = url.searchParams.get('source') || ''
      const args: unknown[] = [from, to]
      let extra = ''
      if (['admin', 'referral', 'referral_manual', 'legacy'].includes(source)) {
        extra = ' AND source = ?'
        args.push(source)
      }
      const r = await env.DB.prepare(
        `SELECT id, email, source, kind, duration_ms, state, created_at, created_by, reason, revoked_at, revoked_unused_ms FROM pro_grants WHERE created_at >= ? AND created_at < ?${extra} ORDER BY created_at LIMIT 5000`,
      )
        .bind(...args)
        .all<Record<string, unknown>>()
      header = [
        'grant_id',
        'email',
        'source',
        'kind',
        'days',
        'state',
        'created_at',
        'created_by',
        'reason',
        'revoked_at',
        'revoked_unused_days',
      ]
      rows = r.results.map((x) => [
        x.id,
        x.email,
        x.source,
        x.kind,
        x.kind === 'days' ? Number(x.duration_ms) / DAY : '',
        x.state,
        new Date(Number(x.created_at)).toISOString(),
        x.created_by,
        x.reason,
        x.revoked_at ? new Date(Number(x.revoked_at)).toISOString() : '',
        x.revoked_unused_ms ? Number(x.revoked_unused_ms) / DAY : '',
      ])
    } else if (type === 'members') {
      const r = await env.DB.prepare(
        `SELECT m.email, m.role, m.status, m.created_at, m.last_login_at, ps.tier, ps.permanent, ps.until FROM members m LEFT JOIN pro_state ps ON ps.email = m.email ORDER BY m.created_at LIMIT 5000`,
      ).all<Record<string, unknown>>()
      header = ['email', 'role', 'status', 'created_at', 'last_login_at', 'tier', 'permanent', 'pro_until']
      rows = r.results.map((x) => [
        x.email,
        x.role,
        x.status,
        new Date(Number(x.created_at)).toISOString(),
        x.last_login_at ? new Date(Number(x.last_login_at)).toISOString() : '',
        x.tier || 'standard',
        x.permanent ? 'yes' : '',
        x.until ? new Date(Number(x.until)).toISOString() : '',
      ])
    } else return fail(400, 'bad_request')
    await audit(env, now, actor, 'super', 'export.' + type, String(rows.length), { query: url.search.slice(0, 300) })
    const csv = '\uFEFF' + [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n')
    return new Response(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="exampilot-${type}-${new Date(now).toISOString().slice(0, 10)}.csv"`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  }

  /* -------------------- maintenance -------------------- */
  if (p === '/api/admin/access/sync' && req.method === 'POST') {
    if (body!.full === true)
      await env.DB.prepare(`UPDATE members SET access_state = 'pending' WHERE access_state <> 'pending'`).run()
    const r = await syncAccess(env, now, { fetchImpl: c.fetchImpl, full: body!.full === true })
    await audit(env, now, actor, 'super', 'access.sync_manual', null, {
      error: r.error ?? null,
      added: r.added.length,
      removed: r.removed.length,
    })
    return json({ ok: !r.error, ...r, added: r.added.map(maskEmail), removed: r.removed.map(maskEmail) })
  }
  if (p === '/api/admin/deletions/reconcile' && req.method === 'POST') {
    // after restoring a D1 backup: re-delete every account the separate ledger says is gone
    const ids = await reconcileDeletions(env, now)
    await audit(env, now, actor, 'super', 'deletions.reconcile', String(ids.length))
    return json({ ok: true, repurged: ids.length, ledger: !!env.DELETIONS_DB })
  }
  if (p === '/api/admin/mail/retry' && req.method === 'POST') {
    await releaseHeld(env, now)
    // Only mail that failed at the provider is retried. Mail retired by a policy (test address,
    // not on the staging allow-list, created before real sending was switched on, stale,
    // cancelled, probes) stays dead: a manual retry must never resurrect it.
    const cut = mailCutoff(env)
    await env.DB.prepare(
      `UPDATE mail_outbox SET status = 'queued', next_at = ?
        WHERE template <> 'otp' AND created_at >= ? AND ? > 0
          AND (status = 'failed' OR (status = 'dead' AND COALESCE(last_error, '') NOT IN (${RETIRED_REASONS.map(() => '?').join(',')})))`,
    )
      .bind(now, cut, cut, ...RETIRED_REASONS)
      .run()
    const r = await drainOutbox(env, now, { fetchImpl: c.fetchImpl, limit: 50 })
    await audit(env, now, actor, 'super', 'mail.retry', null, r)
    return json({ ok: true, ...r })
  }
  if (p === '/api/admin/mail' && req.method === 'GET') {
    const { size, offset, page } = paging(url)
    const st = url.searchParams.get('status') || ''
    const w = ['queued', 'sending', 'sent', 'failed', 'dead', 'held'].includes(st) ? 'WHERE status = ?' : ''
    const args = w ? [st] : []
    const [rows, cnt] = await env.DB.batch([
      env.DB.prepare(
        `SELECT id, to_email, template, status, attempts, last_error, created_at, sent_at FROM mail_outbox ${w} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      ).bind(...args, size, offset),
      env.DB.prepare(`SELECT COUNT(*) AS n FROM mail_outbox ${w}`).bind(...args),
    ])
    return json({
      ok: true,
      page,
      size,
      total: (cnt.results[0] as { n: number }).n,
      rows: (rows.results as { to_email: string }[]).map((r) => ({ ...r, to_email: maskEmail(r.to_email) })),
      configured: mailConfigured(env),
    })
  }

  /* -------------------- staging-only lifecycle lab (super only) -------------------- */
  // Isolated test accounts at @lab.exampilot.invalid; time is simulated by moving only
  // those accounts' own timestamps. The server clock and real accounts are never touched.
  if (env.PLATFORM_STAGE === 'staging' && p === '/api/admin/test/lab' && req.method === 'POST') {
    const deny = needSuper()
    if (deny) return deny
    const op = String(body!.op || '')
    const runs = (Array.isArray(body!.runs) ? body!.runs : [])
      .filter((x): x is string => typeof x === 'string' && /^\d{6}$/.test(x))
      .slice(0, 20)
    let r: unknown
    if (op === 'scenarios') r = { ok: true, scenarios: LAB_SCENARIOS }
    else if (op === 'seed') r = { ok: true, ...(await labSeed(env, now, actor)) }
    else if (op === 'shift') r = await labShift(env, now, normEmail(body!.email) || '', Number(body!.days))
    else if (op === 'tick') r = await labTick(env, now, runs)
    else if (op === 'status') r = { ok: true, ...(await labStatus(env, now, runs)) }
    else if (op === 'clear') r = await labClear(env, now, runs)
    else if (op === 'admit') {
      // staging-only: admit a named tester through the real admission path (member row + Access sync),
      // for when invitation mail cannot be delivered yet. Role is changed separately via member/action.
      const email = normEmail(body!.email)
      if (!email) return fail(400, 'bad_request')
      if ((await getMember(env, email))?.status === 'active') return fail(409, 'state', '已经是成员')
      await admitMember(env, now, email, 'invite', actor)
      const sync = await syncAccess(env, now, { fetchImpl: c.fetchImpl })
      r = { ok: true, email, access: { ran: sync.ran, added: sync.added.length, error: sync.error ?? null } }
    } else return fail(400, 'bad_request')
    await audit(env, now, actor, 'super', 'test.lab.' + op, null, { runs })
    return json(r)
  }

  return null
}

/** Aggregates only (counts, rates, per-qid tallies) — no answer text or AI content. */
export async function learningStats(env: PlatformEnv, accountIds: string[], now: number) {
  if (!accountIds.length) return { attempts: 0, correct: 0, graded: 0, qids: [], daily: [], mocks: [], ai: [] }
  const since = now - 90 * DAY
  const out = {
    attempts: 0,
    correct: 0,
    graded: 0,
    qids: [] as unknown[],
    daily: [] as unknown[],
    mocks: [] as unknown[],
    ai: [] as unknown[],
  }
  const qmap = new Map<string, { n: number; c: number; w: number }>()
  const dmap = new Map<string, number>()
  const mocks: unknown[] = []
  const amap = new Map<string, number>()
  for (const part of chunks(accountIds, 40)) {
    const qs = part.map(() => '?').join(',')
    const [att, day, mk, ai] = await env.DB.batch([
      env.DB.prepare(
        `SELECT json_extract(body, '$.h.qid') AS qid, COUNT(*) AS n,
                SUM(json_extract(body, '$.h.isCorrect') = 1) AS c, SUM(json_extract(body, '$.h.isCorrect') = 0) AS w
           FROM ops WHERE account_id IN (${qs}) AND kind = 'attempt' GROUP BY qid`,
      ).bind(...part),
      env.DB.prepare(
        `SELECT date((json_extract(body, '$.h.submittedAt') + 28800000)/1000, 'unixepoch') AS d, COUNT(*) AS n
           FROM ops WHERE account_id IN (${qs}) AND kind = 'attempt' AND json_extract(body, '$.h.submittedAt') >= ? GROUP BY d`,
      ).bind(...part, since),
      env.DB.prepare(
        `SELECT json_extract(body, '$.run.endedAt') AS at, json_extract(body, '$.run.score') AS score, json_extract(body, '$.run.maxScore') AS max
           FROM ops WHERE account_id IN (${qs}) AND kind = 'mock' ORDER BY at DESC LIMIT 200`,
      ).bind(...part),
      env.DB.prepare(
        `SELECT day AS d, SUM(requests) AS n FROM ai_usage_daily WHERE account_id IN (${qs}) AND day >= ? GROUP BY day`,
      ).bind(...part, new Date(since).toISOString().slice(0, 10)),
    ])
    for (const r of att.results as { qid: string; n: number; c: number; w: number }[]) {
      const x = qmap.get(r.qid) || { n: 0, c: 0, w: 0 }
      x.n += r.n
      x.c += r.c || 0
      x.w += r.w || 0
      qmap.set(r.qid, x)
    }
    for (const r of day.results as { d: string; n: number }[]) dmap.set(r.d, (dmap.get(r.d) || 0) + r.n)
    mocks.push(...mk.results)
    for (const r of ai.results as { d: string; n: number }[]) amap.set(r.d, (amap.get(r.d) || 0) + r.n)
  }
  for (const [, x] of qmap) {
    out.attempts += x.n
    out.correct += x.c
    out.graded += x.c + x.w
  }
  out.qids = [...qmap].map(([qid, x]) => [qid, x.n, x.c, x.w])
  out.daily = [...dmap].sort().map(([d, n]) => ({ d, n }))
  out.mocks = mocks
  out.ai = [...amap].sort().map(([d, n]) => ({ d, n }))
  return out
}
