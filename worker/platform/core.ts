/**
 * Platform domain logic: members, gate, Pro ledger, referrals, lifecycle.
 * Every state change is a conditional UPDATE / INSERT with a uniqueness or version
 * guard, so retries, double clicks and two admins at once cannot apply it twice.
 */
import { purgeAccountImages } from '../media'
import { computeEntitlement, type Entitlement, type GrantRow, type SuspensionRow } from './entitlement'
import { enqueueMail } from './mail'
import { DAY, HOUR, chunks, maskEmail, rid, sha256hex, superOwners, type PlatformEnv } from './util'

export type Role = 'user' | 'reviewer' | 'super'
export interface Member {
  email: string
  account_id: string | null
  role: Role
  status: 'active' | 'revoked' | 'closing' | 'deleted'
  source: string
  created_at: number
  activated_at: number | null
  last_login_at: number | null
  long_retain: number
  retain_cleared_at: number | null
  status_at: number | null
  delete_after: number | null
  delete_reason: string | null
  inactive_warned_at: number | null
  access_state: string
  access_error: string | null
  note: string | null
  version: number
}

export const REVOKE_GRACE = 7 * DAY
export const REAPPLY_COOLDOWN = 7 * DAY
export const INVITE_TTL = 7 * DAY
export const REFERRAL_REWARD = 7 * DAY

/* ------------------------------ audit / notices ------------------------------ */
export async function audit(
  env: PlatformEnv,
  now: number,
  actor: string,
  role: string,
  action: string,
  target: string | null,
  detail?: Record<string, unknown>,
) {
  await env.DB.prepare(
    'INSERT INTO audit_log (at, actor, actor_role, action, target, detail) VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(now, actor, role, action, target, detail ? JSON.stringify(detail).slice(0, 2000) : null)
    .run()
}

export async function notice(
  env: PlatformEnv,
  now: number,
  n: { audience: 'reviewer' | 'super'; kind: string; title: string; body?: string; ref?: string; dedupe?: string },
) {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO admin_notices (id, audience, kind, ref, title, body, created_at, dedupe_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(rid('nt'), n.audience, n.kind, n.ref ?? null, n.title, n.body ?? null, now, n.dedupe ?? null)
    .run()
}

/** Mark notices about one subject handled (e.g. the application got decided). */
export async function handleNotices(env: PlatformEnv, now: number, ref: string, by: string) {
  await env.DB.prepare('UPDATE admin_notices SET handled_at = ?, handled_by = ? WHERE ref = ? AND handled_at IS NULL')
    .bind(now, by, ref)
    .run()
}

/* ------------------------------ settings ------------------------------ */
export const DEFAULT_TEXTS: Record<string, string> = {
  'text.apply_title': '申请加入 ExamPilot',
  'text.apply_intro': 'ExamPilot 目前是邀请制。留下邮箱并验证后即可提交申请，审核结果会发到你的邮箱。',
  'text.apply_paused': '新申请暂时关闭。已提交的申请不受影响，审核结果仍会通过邮件通知。',
  'text.apply_success': '申请已提交。审核结果会发到你的邮箱，也可以随时回到这里查询状态。',
  'text.announcement': '',
}
export async function getSettings(env: PlatformEnv): Promise<Record<string, string>> {
  const r = await env.DB.prepare('SELECT key, value FROM site_settings').all<{ key: string; value: string }>()
  const out: Record<string, string> = { applications_open: '1', ...DEFAULT_TEXTS }
  for (const x of r.results) out[x.key] = x.value
  return out
}

/* ------------------------------ members & gate ------------------------------ */
export async function getMember(env: PlatformEnv, email: string): Promise<Member | null> {
  return env.DB.prepare('SELECT * FROM members WHERE email = ?').bind(email).first<Member>()
}

export function isOwner(env: PlatformEnv, email: string) {
  return superOwners(env).has(email)
}
export function effectiveRole(env: PlatformEnv, m: Member | null): Role {
  if (!m) return 'user'
  if (isOwner(env, m.email)) return 'super'
  return m.role
}

export type GateResult =
  { ok: true; member: Member; firstActivation: boolean } | { ok: false; status: number; code: string; reason: string }

/** deletion_log tag for an address (same derivation as purgeMember) */
export async function deletedTag(email: string) {
  return 'deleted:' + (await sha256hex('member:' + email)).slice(0, 16)
}
/**
 * Current standing of an Access-verified e-mail, for the static-file / version gate.
 * One indexed read in the common case (member row + its learning account); never writes.
 * 'ok' = active member with an active (or not yet created) learning account,
 * or no row at all for an address that was never deleted (the API gate would admit it).
 */
export async function memberStanding(
  env: PlatformEnv,
  email: string,
): Promise<'ok' | 'ACCOUNT_REVOKED' | 'ACCOUNT_CLOSING' | 'ACCOUNT_DELETED'> {
  const r = await env.DB.prepare(
    `SELECT m.status AS ms, a.status AS ast FROM members m LEFT JOIN accounts a ON a.id = m.account_id WHERE m.email = ?`,
  )
    .bind(email)
    .first<{ ms: string; ast: string | null }>()
  if (r) {
    if (r.ms === 'closing') return 'ACCOUNT_CLOSING'
    if (r.ms === 'deleted') return 'ACCOUNT_DELETED'
    if (r.ms !== 'active') return 'ACCOUNT_REVOKED'
    if (r.ast && r.ast !== 'active') return 'ACCOUNT_REVOKED'
    return 'ok'
  }
  if (isOwner(env, email)) return 'ok'
  const d = await env.DB.prepare('SELECT 1 AS x FROM deletion_log WHERE email_hash = ? LIMIT 1')
    .bind(await deletedTag(email))
    .first()
  return d ? 'ACCOUNT_DELETED' : 'ok'
}

/**
 * Called for EVERY protected API request after the Access token is verified.
 * Access alone is not enough: a revoked member's Access session may still be valid.
 */
export async function gate(env: PlatformEnv, email: string, now: number): Promise<GateResult> {
  let m = await getMember(env, email)
  if (!m && !isOwner(env, email)) {
    // a deleted address whose old Access session is still alive must not be re-created as a new member
    const d = await env.DB.prepare('SELECT 1 AS x FROM deletion_log WHERE email_hash = ? LIMIT 1')
      .bind(await deletedTag(email))
      .first()
    if (d) return { ok: false, status: 403, code: 'ACCOUNT_DELETED', reason: '账号已注销。' }
  }
  if (!m) {
    // Not in D1 but Access let them in: an allow-list entry added by hand in the
    // Cloudflare dashboard (or before this release). Treat as a Standard member.
    await env.DB.prepare(
      `INSERT OR IGNORE INTO members (email, role, status, source, created_at, status_at) VALUES (?, 'user', 'active', 'access', ?, ?)`,
    )
      .bind(email, now, now)
      .run()
    await audit(env, now, 'system', 'system', 'member.auto_from_access', maskEmail(email))
    m = await getMember(env, email)
    if (!m) return { ok: false, status: 503, code: 'SERVER_ERROR', reason: '数据库暂时不可用' }
  }
  if (m.status !== 'active') {
    const reason =
      m.status === 'closing'
        ? '账号正在注销冷静期，已停用。可在欢迎页撤销注销。'
        : '账号访问已停用。如有疑问请联系管理员。'
    return { ok: false, status: 403, code: m.status === 'closing' ? 'ACCOUNT_CLOSING' : 'ACCOUNT_REVOKED', reason }
  }
  let firstActivation = false
  if (!m.activated_at) {
    const r = await env.DB.prepare(
      'UPDATE members SET activated_at = ?, last_login_at = ?, inactive_warned_at = NULL WHERE email = ? AND activated_at IS NULL',
    )
      .bind(now, now, email)
      .run()
    firstActivation = !!r.meta?.changes
  } else if (!m.last_login_at || now - m.last_login_at > 10 * 60_000 || m.inactive_warned_at) {
    await env.DB.prepare('UPDATE members SET last_login_at = ?, inactive_warned_at = NULL WHERE email = ?')
      .bind(now, email)
      .run()
  }
  return { ok: true, member: m, firstActivation }
}

/** After resolveAccount: remember the account id; on first activation pay referral reward. */
export async function afterLogin(
  env: PlatformEnv,
  g: Extract<GateResult, { ok: true }>,
  accountId: string,
  now: number,
) {
  if (g.member.account_id !== accountId)
    await env.DB.prepare(
      'UPDATE members SET account_id = ? WHERE email = ? AND (account_id IS NULL OR account_id <> ?)',
    )
      .bind(accountId, g.member.email, accountId)
      .run()
  if (g.firstActivation) await onActivated(env, g.member.email, now)
}

/* ------------------------------ Pro ledger ------------------------------ */
export async function loadLedger(env: PlatformEnv, email: string) {
  const [g, s] = await env.DB.batch([
    env.DB.prepare(
      'SELECT id, kind, duration_ms, starts_at, state, revoked_at, source, reason, created_at, created_by, ref_id, revoked_unused_ms FROM pro_grants WHERE email = ? ORDER BY starts_at, id',
    ).bind(email),
    env.DB.prepare(
      'SELECT id, mode, started_at, ended_at, reason FROM pro_suspensions WHERE email = ? ORDER BY started_at',
    ).bind(email),
  ])
  return {
    grants: g.results as unknown as (GrantRow & Record<string, unknown>)[],
    suspensions: s.results as unknown as (SuspensionRow & Record<string, unknown>)[],
  }
}

export async function entitlementOf(env: PlatformEnv, email: string, now: number): Promise<Entitlement> {
  const { grants, suspensions } = await loadLedger(env, email)
  return computeEntitlement(grants, suspensions, now)
}

/** Recompute the cached projection + the ai_grants mirror (rollback compatibility). */
export async function refreshPro(env: PlatformEnv, email: string, now: number): Promise<Entitlement> {
  const e = await entitlementOf(env, email, now)
  const prev = await env.DB.prepare('SELECT until FROM pro_state WHERE email = ?')
    .bind(email)
    .first<{ until: number | null }>()
  const untilChanged = !prev || prev.until !== e.until
  await env.DB.prepare(
    `INSERT INTO pro_state (email, tier, permanent, until, until_since, paused_ms, suspended, computed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET tier = excluded.tier, permanent = excluded.permanent, until = excluded.until,
       until_since = CASE WHEN ? THEN excluded.until_since ELSE pro_state.until_since END,
       paused_ms = excluded.paused_ms, suspended = excluded.suspended, computed_at = excluded.computed_at`,
  )
    .bind(
      email,
      e.tier,
      e.permanent ? 1 : 0,
      e.until,
      now,
      e.paused ? e.remainingMs : null,
      e.suspended ? 1 : 0,
      now,
      untilChanged ? 1 : 0,
    )
    .run()
  const m = await env.DB.prepare('SELECT account_id FROM members WHERE email = ?')
    .bind(email)
    .first<{ account_id: string | null }>()
  if (m?.account_id) {
    await env.DB.prepare(
      `INSERT INTO ai_grants (account_id, enabled, updated_at, updated_by) VALUES (?, ?, ?, 'platform')
       ON CONFLICT(account_id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at, updated_by = excluded.updated_by
       WHERE ai_grants.enabled <> excluded.enabled`,
    )
      .bind(m.account_id, e.active ? 1 : 0, now)
      .run()
  }
  return e
}

/** The AI gate: computed from the ledger on every request (never from a cache). */
export async function proActive(env: PlatformEnv, email: string, now: number): Promise<boolean> {
  const m = await env.DB.prepare('SELECT status FROM members WHERE email = ?').bind(email).first<{ status: string }>()
  if (!m || m.status !== 'active') return false
  return (await entitlementOf(env, email, now)).active
}

export async function addGrant(
  env: PlatformEnv,
  now: number,
  g: {
    email: string
    source: 'admin' | 'referral' | 'referral_manual' | 'legacy'
    kind: 'permanent' | 'days'
    durationMs?: number
    reason?: string | null
    by: string
    refId?: string | null
    idem?: string | null
    held?: boolean
    fp?: string | null
  },
): Promise<{ id: string; created: boolean; conflict?: boolean }> {
  const id = rid('pg')
  const vals = [
    id,
    g.email,
    g.source,
    g.kind,
    g.kind === 'days' ? Math.max(0, Math.round(g.durationMs || 0)) : 0,
    now,
    g.held ? 'held' : 'active',
    g.reason ?? null,
    g.by,
    now,
    g.refId ?? null,
    g.idem ?? null,
  ]
  const cols = `(id, email, source, kind, duration_ms, starts_at, state, reason, created_by, created_at, ref_id, idem_key)`
  let created: boolean
  if (g.idem && g.fp) {
    // request-bound key: reserve the key with this request's fingerprint and write the grant
    // in ONE batch (a D1 transaction). The grant row is only written when the key's stored
    // fingerprint is this request's, and the UNIQUE idem_key makes a concurrent twin a no-op.
    const [res, ins] = await env.DB.batch([
      env.DB.prepare('INSERT OR IGNORE INTO admin_idem (key, fp, actor, created_at) VALUES (?, ?, ?, ?)').bind(
        g.idem,
        g.fp,
        g.by,
        now,
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO pro_grants ${cols}
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE (SELECT fp FROM admin_idem WHERE key = ?) = ?`,
      ).bind(...vals, g.idem, g.fp),
    ])
    created = !!ins.meta?.changes
    if (!created) {
      const k = await env.DB.prepare('SELECT fp FROM admin_idem WHERE key = ?').bind(g.idem).first<{ fp: string }>()
      const ex = await env.DB.prepare('SELECT id FROM pro_grants WHERE idem_key = ?')
        .bind(g.idem)
        .first<{ id: string }>()
      if (k?.fp !== g.fp) return { id: '', created: false, conflict: true }
      if (res.meta?.changes && ex) {
        // the key was used before request binding existed: never treat it as the same request
        await env.DB.prepare('DELETE FROM admin_idem WHERE key = ? AND fp = ?').bind(g.idem, g.fp).run()
        return { id: '', created: false, conflict: true }
      }
      return { id: ex?.id ?? '', created: false }
    }
  } else {
    const r = await env.DB.prepare(
      `INSERT OR IGNORE INTO pro_grants ${cols} VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(...vals)
      .run()
    created = !!r.meta?.changes
    if (!created) {
      const ex = await env.DB.prepare('SELECT id FROM pro_grants WHERE idem_key = ?')
        .bind(g.idem ?? '')
        .first<{ id: string }>()
      return { id: ex?.id ?? '', created: false }
    }
  }
  await refreshPro(env, g.email, now)
  return { id, created: true }
}

/** Revoke one grant: only its unused part disappears. */
export async function revokeGrant(env: PlatformEnv, now: number, grantId: string, note: string) {
  const g = await env.DB.prepare('SELECT email, state FROM pro_grants WHERE id = ?')
    .bind(grantId)
    .first<{ email: string; state: string }>()
  if (!g || g.state === 'revoked') return false
  const before = await entitlementOf(env, g.email, now)
  const unused = before.usage[grantId]?.remaining ?? 0
  const r = await env.DB.prepare(
    `UPDATE pro_grants SET state = 'revoked', revoked_at = ?, revoke_note = ?, revoked_unused_ms = ? WHERE id = ? AND state <> 'revoked'`,
  )
    .bind(now, note, g.state === 'held' ? null : unused, grantId)
    .run()
  if (r.meta?.changes) await refreshPro(env, g.email, now)
  return !!r.meta?.changes
}

/** 普通撤销: every admin/legacy grant, referral rewards stay. */
export async function revokeAdminPro(env: PlatformEnv, now: number, email: string, by: string) {
  const ids = await env.DB.prepare(
    `SELECT id FROM pro_grants WHERE email = ? AND source IN ('admin','legacy') AND state <> 'revoked'`,
  )
    .bind(email)
    .all<{ id: string }>()
  for (const x of ids.results) await revokeGrant(env, now, x.id, `普通撤销 by ${by}`)
  return ids.results.length
}

export async function suspendPro(
  env: PlatformEnv,
  now: number,
  email: string,
  mode: 'freeze' | 'continue',
  by: string,
  reason: string | null,
) {
  const r = await env.DB.prepare(
    `INSERT OR IGNORE INTO pro_suspensions (id, email, mode, started_at, started_by, reason) VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(rid('ps'), email, mode, now, by, reason)
    .run()
  await refreshPro(env, email, now)
  return !!r.meta?.changes
}

export async function liftSuspension(env: PlatformEnv, now: number, email: string, by: string) {
  const r = await env.DB.prepare(
    `UPDATE pro_suspensions SET ended_at = ?, ended_by = ? WHERE email = ? AND ended_at IS NULL`,
  )
    .bind(now, by, email)
    .run()
  if (!r.meta?.changes) return false
  // rewards issued during the suspension start now (unless still under review)
  await env.DB.prepare(
    `UPDATE pro_grants SET state = 'active', starts_at = ? WHERE email = ? AND state = 'held' AND source = 'referral'
       AND NOT EXISTS (SELECT 1 FROM referrals r WHERE r.id = pro_grants.ref_id AND r.review = 'pending')`,
  )
    .bind(now, email)
    .run()
  await env.DB.prepare(
    `UPDATE referrals SET status = 'rewarded' WHERE status = 'held' AND (review IS NULL OR review = 'legit')
       AND grant_id IN (SELECT id FROM pro_grants WHERE email = ? AND state = 'active')`,
  )
    .bind(email)
    .run()
  await refreshPro(env, email, now)
  return true
}

/* ------------------------------ referrals ------------------------------ */
/** gmail-style canonical form, only to detect self-referral by alias (never to merge accounts). */
export function canonicalEmail(e: string) {
  let [l, d] = e.split('@')
  l = l.split('+')[0]
  if (d === 'gmail.com' || d === 'googlemail.com') {
    l = l.replace(/\./g, '')
    d = 'gmail.com'
  }
  return `${l}@${d}`
}

export async function referralFlags(
  env: PlatformEnv,
  now: number,
  linkId: string,
  referrer: string,
): Promise<string[]> {
  const flags: string[] = []
  const burst = await env.DB.prepare('SELECT COUNT(*) AS n FROM referrals WHERE link_id = ? AND created_at > ?')
    .bind(linkId, now - DAY)
    .first<{ n: number }>()
  if ((burst?.n ?? 0) >= 5) flags.push('burst_24h')
  const rej = await env.DB.prepare(
    `SELECT SUM(status = 'rejected') AS bad, COUNT(*) AS n FROM referrals WHERE referrer_email = ?`,
  )
    .bind(referrer)
    .first<{ bad: number; n: number }>()
  if ((rej?.n ?? 0) >= 4 && (rej?.bad ?? 0) / (rej?.n || 1) >= 0.5) flags.push('many_rejected')
  const voided = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM referrals WHERE referrer_email = ? AND review = 'invalid'`,
  )
    .bind(referrer)
    .first<{ n: number }>()
  if ((voided?.n ?? 0) > 0) flags.push('prior_invalid')
  return flags
}

/**
 * Activation = the first verified login of an approved member (same event for the
 * invite path and the waitlist path). Pays the referrer once (idem 'ref:<id>').
 */
export async function onActivated(env: PlatformEnv, email: string, now: number) {
  const ref = await env.DB.prepare(`SELECT * FROM referrals WHERE referee_email = ? AND status = 'approved'`)
    .bind(email)
    .first<{
      id: string
      referrer_email: string
      flags: string | null
      review: string | null
    }>()
  if (!ref) return
  await env.DB.prepare('UPDATE referrals SET activated_at = ? WHERE id = ? AND activated_at IS NULL')
    .bind(now, ref.id)
    .run()
  await payReferral(env, now, ref.id)
}

export async function payReferral(
  env: PlatformEnv,
  now: number,
  referralId: string,
  opts: { manual?: boolean; by?: string } = {},
) {
  const ref = await env.DB.prepare('SELECT * FROM referrals WHERE id = ?').bind(referralId).first<{
    id: string
    referrer_email: string
    referee_email: string
    status: string
    review: string | null
    flags: string | null
    activated_at: number | null
  }>()
  if (!ref) return { paid: false, reason: 'not_found' }
  if (!opts.manual && (ref.status !== 'approved' || !ref.activated_at)) return { paid: false, reason: 'not_eligible' }
  const referrer = await getMember(env, ref.referrer_email)
  if (!referrer || referrer.status !== 'active') {
    // referrer left: no reward, keep the history
    await env.DB.prepare(`UPDATE referrals SET status = 'void' WHERE id = ? AND status = 'approved'`).bind(ref.id).run()
    return { paid: false, reason: 'referrer_inactive' }
  }
  const flagged = !!ref.flags && ref.flags !== '[]' && ref.review !== 'legit'
  const suspended = await env.DB.prepare('SELECT 1 AS x FROM pro_suspensions WHERE email = ? AND ended_at IS NULL')
    .bind(ref.referrer_email)
    .first()
  const held = flagged || !!suspended
  const g = await addGrant(env, now, {
    email: ref.referrer_email,
    source: opts.manual ? 'referral_manual' : 'referral',
    kind: 'days',
    durationMs: REFERRAL_REWARD,
    reason: opts.manual ? '推荐奖励补发' : '推荐奖励',
    by: opts.by || 'system',
    refId: ref.id,
    idem: 'ref:' + ref.id,
    held,
  })
  if (!g.created) return { paid: false, reason: 'already_paid' }
  await env.DB.prepare(
    `UPDATE referrals SET status = ?, grant_id = ?, review = CASE WHEN ? THEN 'pending' ELSE review END, version = version + 1 WHERE id = ?`,
  )
    .bind(held ? 'held' : 'rewarded', g.id, flagged ? 1 : 0, ref.id)
    .run()
  if (flagged)
    await notice(env, now, {
      audience: 'super',
      kind: 'referral_flagged',
      title: '推荐奖励已冻结，待复核',
      body: `推荐人 ${maskEmail(ref.referrer_email)} 的一笔奖励因异常信号被冻结：${ref.flags}`,
      ref: ref.id,
      dedupe: 'refflag:' + ref.id,
    })
  await audit(
    env,
    now,
    opts.by || 'system',
    opts.by ? 'super' : 'system',
    held ? 'referral.reward_held' : 'referral.reward',
    ref.id,
    { flagged, suspended: !!suspended },
  )
  return { paid: true, held, grantId: g.id }
}

/* ------------------------------ membership changes ------------------------------ */
/** Create (or re-activate) a member and queue the Access allow. Idempotent. */
export async function admitMember(
  env: PlatformEnv,
  now: number,
  email: string,
  source: 'invite' | 'application',
  by: string,
) {
  const m = await getMember(env, email)
  if (!m) {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO members (email, role, status, source, created_at, status_at, access_state) VALUES (?, 'user', 'active', ?, ?, ?, 'pending')`,
    )
      .bind(email, source, now, now)
      .run()
  } else if (m.status !== 'active') {
    await env.DB.prepare(
      `UPDATE members SET status = 'active', status_at = ?, delete_after = NULL, delete_reason = NULL, access_state = 'pending', version = version + 1 WHERE email = ?`,
    )
      .bind(now, email)
      .run()
  } else if (m.access_state !== 'ok') {
    await env.DB.prepare(`UPDATE members SET access_state = 'pending' WHERE email = ?`).bind(email).run()
  }
  await audit(env, now, by, by === 'public' ? 'public' : 'admin', 'member.admit', maskEmail(email), { source })
}

export async function setStatus(
  env: PlatformEnv,
  now: number,
  email: string,
  to: 'revoked' | 'closing' | 'active',
  reason: 'admin_revoke' | 'self_close' | 'inactive' | null,
): Promise<boolean> {
  if (to !== 'active' && isOwner(env, email)) return false
  const r =
    to === 'active'
      ? await env.DB.prepare(
          `UPDATE members SET status = 'active', status_at = ?, delete_after = NULL, delete_reason = NULL, inactive_warned_at = NULL,
             last_login_at = CASE WHEN delete_reason = 'inactive' THEN ? ELSE last_login_at END, access_state = 'pending', version = version + 1
           WHERE email = ? AND status IN ('revoked','closing')`,
        )
          .bind(now, now, email)
          .run()
      : await env.DB.prepare(
          `UPDATE members SET status = ?, status_at = ?, delete_after = ?, delete_reason = ?, access_state = 'pending', version = version + 1
           WHERE email = ? AND status = 'active'`,
        )
          .bind(to, now, now + REVOKE_GRACE, reason, email)
          .run()
  return !!r.meta?.changes
}

/* ------------------------------ deletion ------------------------------ */
const ACCOUNT_TABLES = [
  'ops',
  'docs',
  'clients',
  'usage_daily',
  'ai_usage_daily',
  'ai_grants',
  'ai_grant_log',
  'ai_admins',
]

/**
 * Permanently delete one member's personal data. Re-checks every precondition
 * inside the same call; never touches rows of another account.
 */
export async function purgeMember(
  env: PlatformEnv,
  now: number,
  email: string,
): Promise<{ ok: boolean; reason?: string; rows?: Record<string, number> }> {
  const m = await getMember(env, email)
  if (!m) return { ok: false, reason: 'not_found' }
  if (m.status !== 'revoked' && m.status !== 'closing') return { ok: false, reason: 'not_stopped' }
  if (!m.delete_after || m.delete_after > now) return { ok: false, reason: 'not_due' }
  if (isOwner(env, email)) return { ok: false, reason: 'owner' }
  if (m.long_retain && m.delete_reason === 'inactive') return { ok: false, reason: 'long_retain' }
  const acc = m.account_id
  // identity rows prove the account belongs to this e-mail only
  if (acc) {
    const other = await env.DB.prepare('SELECT COUNT(*) AS n FROM identities WHERE account_id = ? AND email <> ?')
      .bind(acc, email)
      .first<{ n: number }>()
    if ((other?.n ?? 0) > 0) return { ok: false, reason: 'shared_account' }
  }
  const tag = await deletedTag(email)
  const rows: Record<string, number> = {}
  const st = []
  // optimistic guard: abort if the member was restored meanwhile
  st.push(
    env.DB.prepare(
      `INSERT INTO occ_guard (ok) SELECT NULL WHERE (SELECT version FROM members WHERE email = ?) <> ?`,
    ).bind(email, m.version),
  )
  if (acc) {
    for (const t of ACCOUNT_TABLES) st.push(env.DB.prepare(`DELETE FROM ${t} WHERE account_id = ?`).bind(acc))
    st.push(env.DB.prepare('DELETE FROM identities WHERE account_id = ?').bind(acc))
    st.push(env.DB.prepare('DELETE FROM accounts WHERE id = ?').bind(acc))
  }
  st.push(env.DB.prepare('DELETE FROM member_group_links WHERE email = ?').bind(email))
  st.push(env.DB.prepare('DELETE FROM member_tags WHERE email = ?').bind(email))
  st.push(env.DB.prepare('DELETE FROM email_otps WHERE email = ?').bind(email))
  st.push(env.DB.prepare(`DELETE FROM mail_outbox WHERE to_email = ?`).bind(email))
  st.push(env.DB.prepare('DELETE FROM admin_notice_reads WHERE email = ?').bind(email))
  st.push(env.DB.prepare('DELETE FROM pro_state WHERE email = ?').bind(email))
  st.push(env.DB.prepare('DELETE FROM pro_suspensions WHERE email = ?').bind(email))
  st.push(
    env.DB.prepare(`UPDATE referral_links SET status = 'retired', owner_email = ? WHERE owner_email = ?`).bind(
      tag,
      email,
    ),
  )
  // ledgers are kept (append-only) but no longer name the person
  st.push(env.DB.prepare('UPDATE pro_grants SET email = ? WHERE email = ?').bind(tag, email))
  st.push(env.DB.prepare('UPDATE referrals SET referrer_email = ? WHERE referrer_email = ?').bind(tag, email))
  st.push(env.DB.prepare('UPDATE referrals SET referee_email = ? WHERE referee_email = ?').bind(tag, email))
  st.push(env.DB.prepare("UPDATE appeals SET email = ?, text = '[已删除]' WHERE email = ?").bind(tag, email))
  st.push(env.DB.prepare(`UPDATE applications SET email = ?, note = NULL WHERE email = ?`).bind(tag, email))
  st.push(env.DB.prepare(`UPDATE invites SET email = ? WHERE email = ?`).bind(tag, email))
  st.push(env.DB.prepare('DELETE FROM members WHERE email = ?').bind(email))
  st.push(
    env.DB.prepare(
      'INSERT INTO deletion_log (id, email_hash, account_id, reason, deleted_at, rows) VALUES (?, ?, ?, ?, ?, ?)',
    ).bind(rid('del'), tag, acc, m.delete_reason || 'unknown', now, null),
  )
  // count first (for the audit record), then delete atomically
  if (acc)
    for (const t of ['ops', 'docs']) {
      const c = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE account_id = ?`)
        .bind(acc)
        .first<{ n: number }>()
      rows[t] = c?.n ?? 0
    }
  try {
    await env.DB.batch(st)
  } catch (e) {
    if (/occ_guard/.test(String((e as Error).message))) return { ok: false, reason: 'changed' }
    throw e
  }
  await env.DB.prepare('UPDATE deletion_log SET rows = ? WHERE email_hash = ? AND deleted_at = ?')
    .bind(JSON.stringify(rows), tag, now)
    .run()
  if (acc)
    try {
      rows.ai_images = await purgeAccountImages(env, acc)
      await env.DB.prepare('UPDATE deletion_log SET rows = ? WHERE email_hash = ? AND deleted_at = ?')
        .bind(JSON.stringify(rows), tag, now)
        .run()
    } catch {
      /* the media sweep removes images of accounts that no longer exist */
    }
  if (env.DELETIONS_DB) {
    try {
      await env.DELETIONS_DB.prepare(
        'INSERT OR REPLACE INTO deletions (tag, account_id, reason, deleted_at) VALUES (?, ?, ?, ?)',
      )
        .bind(tag, acc, m.delete_reason, now)
        .run()
    } catch {
      /* the mirror is best effort; the main-DB deletion_log row exists and the audit records it */
    }
  }
  await audit(env, now, 'system', 'system', 'member.purged', tag, { reason: m.delete_reason, rows })
  return { ok: true, rows }
}

/**
 * After a D1 restore: every deletion recorded in KV must still hold. Re-deletes
 * any account that came back. Returns the account ids it had to clean again.
 */
export async function reconcileDeletions(env: PlatformEnv, now: number): Promise<string[]> {
  if (!env.DELETIONS_DB) return []
  const out: string[] = []
  const rows = await env.DELETIONS_DB.prepare(
    'SELECT tag, account_id FROM deletions WHERE account_id IS NOT NULL',
  ).all<{ tag: string; account_id: string }>()
  for (const v of rows.results) {
    const back = await env.DB.prepare('SELECT 1 AS x FROM accounts WHERE id = ?').bind(v.account_id).first()
    if (!back) continue
    const st = ACCOUNT_TABLES.map((t) => env.DB.prepare(`DELETE FROM ${t} WHERE account_id = ?`).bind(v.account_id))
    st.push(env.DB.prepare('DELETE FROM identities WHERE account_id = ?').bind(v.account_id))
    st.push(env.DB.prepare('DELETE FROM members WHERE account_id = ?').bind(v.account_id))
    st.push(env.DB.prepare('DELETE FROM accounts WHERE id = ?').bind(v.account_id))
    await env.DB.batch(st)
    out.push(v.account_id)
    await audit(env, now, 'system', 'system', 'member.repurged_after_restore', v.tag)
  }
  return out
}

/* ------------------------------ lifecycle tick (cron) ------------------------------ */
export function addMonths(ms: number, n: number) {
  const d = new Date(ms + 8 * HOUR) // calendar months in Beijing time
  const y = d.getUTCFullYear()
  const mo = d.getUTCMonth() + n
  const day = d.getUTCDate()
  const last = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate()
  const t = Date.UTC(
    y,
    mo,
    Math.min(day, last),
    d.getUTCHours(),
    d.getUTCMinutes(),
    d.getUTCSeconds(),
    d.getUTCMilliseconds(),
  )
  return t - 8 * HOUR
}

/**
 * Lifecycle rules. The cron calls it with no scope (whole database, unchanged behaviour).
 * The staging lab passes a scope: every query is narrowed to `email LIKE scope.like`, every row is
 * re-checked with scope.allow() before it is touched, and the whole-database steps (invite expiry,
 * housekeeping) are skipped.
 */
export type LifecycleScope = { like: string; allow: (email: string) => boolean }
export async function lifecycleTick(env: PlatformEnv, now: number, scope?: LifecycleScope) {
  const out = {
    invitesExpired: 0,
    proReminders: 0,
    proExpired: 0,
    inactiveWarned: 0,
    inactiveStopped: 0,
    purged: 0,
    deleteSoon: 0,
    skippedOutOfScope: 0,
  }
  const AND = scope ? ' AND email LIKE ?' : ''
  const sb = (...a: unknown[]) => (scope ? [...a, scope.like] : a)
  const ok = (email: string) => {
    if (!scope || scope.allow(email)) return true
    out.skippedOutOfScope++
    return false
  }
  // 1. expired invites (whole database; never in a scoped run)
  if (!scope) {
    const inv = await env.DB.prepare(
      `UPDATE invites SET status = 'expired', version = version + 1 WHERE status = 'pending' AND expires_at <= ?`,
    )
      .bind(now)
      .run()
    out.invitesExpired = inv.meta?.changes ?? 0
  }

  // 2. Pro: recompute rows that may have changed; reminders; expiry notice
  const pro = await env.DB.prepare(
    `SELECT email FROM pro_state WHERE tier = 'pro' AND permanent = 0 AND until IS NOT NULL AND until <= ?${AND}`,
  )
    .bind(...sb(now + 3 * DAY + HOUR))
    .all<{ email: string }>()
  for (const { email } of pro.results) {
    if (!ok(email)) continue
    const before = await env.DB.prepare('SELECT * FROM pro_state WHERE email = ?').bind(email).first<{
      until: number | null
      until_since: number | null
      remind3_for: number | null
      remind1_for: number | null
      expired_for: number | null
    }>()
    if (!before?.until) continue
    const until = before.until
    const since = before.until_since ?? 0
    const m = await getMember(env, email)
    if (!m || m.status !== 'active') continue
    if (now >= until) {
      const e = await refreshPro(env, email, now)
      if (e.tier === 'standard' && before.expired_for !== until) {
        const r = await env.DB.prepare(
          'UPDATE pro_state SET expired_for = ? WHERE email = ? AND (expired_for IS NULL OR expired_for <> ?)',
        )
          .bind(until, email, until)
          .run()
        if (r.meta?.changes) {
          await enqueueMail(env, email, 'pro_expired', { until }, `pro_expired:${email}:${until}`, now)
          await audit(env, now, 'system', 'system', 'pro.expired', maskEmail(email))
          out.proExpired++
        }
      }
      continue
    }
    // a reminder is due only if its moment came after this end date was set
    for (const [days, col, tpl] of [
      [1, 'remind1_for', 'pro_remind1'],
      [3, 'remind3_for', 'pro_remind3'],
    ] as const) {
      const at = until - days * DAY
      if (now < at || at < since) continue
      if (days === 3 && now >= until - DAY) continue // the 1-day one supersedes it
      if ((before as Record<string, unknown>)[col] === until) continue
      const r = await env.DB.prepare(
        `UPDATE pro_state SET ${col} = ? WHERE email = ? AND (${col} IS NULL OR ${col} <> ?)`,
      )
        .bind(until, email, until)
        .run()
      if (r.meta?.changes) {
        await enqueueMail(env, email, tpl, { until }, `${tpl}:${email}:${until}`, now)
        out.proReminders++
      }
    }
  }

  // 3. inactivity (6 calendar months, warn 30 days ahead; long_retain exempt)
  const act = await env.DB.prepare(
    `SELECT email, last_login_at, activated_at, created_at, inactive_warned_at, retain_cleared_at FROM members
      WHERE status = 'active' AND long_retain = 0 AND role = 'user'${AND}`,
  )
    .bind(...sb())
    .all<{
      email: string
      last_login_at: number | null
      activated_at: number | null
      created_at: number
      inactive_warned_at: number | null
      retain_cleared_at: number | null
    }>()
  for (const m of act.results) {
    if (!ok(m.email)) continue
    if (isOwner(env, m.email)) continue
    const lastSeen = Math.max(m.last_login_at ?? 0, m.activated_at ?? 0, m.created_at)
    const deadline = addMonths(lastSeen, 6)
    if (!m.inactive_warned_at) {
      if (now >= deadline - 30 * DAY) {
        const effective = Math.max(deadline, now + 30 * DAY)
        const r = await env.DB.prepare(
          "UPDATE members SET inactive_warned_at = ? WHERE email = ? AND inactive_warned_at IS NULL AND status = 'active'",
        )
          .bind(now, m.email)
          .run()
        if (r.meta?.changes) {
          await enqueueMail(
            env,
            m.email,
            'inactive_warn',
            { deadline: effective },
            `inactive_warn:${m.email}:${now}`,
            now,
          )
          out.inactiveWarned++
        }
      }
      continue
    }
    if (now >= Math.max(deadline, m.inactive_warned_at + 30 * DAY)) {
      if (await setStatus(env, now, m.email, 'revoked', 'inactive')) {
        await audit(env, now, 'system', 'system', 'member.inactive_stopped', maskEmail(m.email))
        await enqueueMail(
          env,
          m.email,
          'inactive_stopped',
          { deleteAfter: now + 7 * DAY },
          `inactive_stopped:${m.email}:${now}`,
          now,
        )
        out.inactiveStopped++
      }
    }
  }

  // 4. admins hear about deletions due in the next 24 h
  const soon = await env.DB.prepare(
    `SELECT email, delete_after, delete_reason FROM members WHERE status IN ('revoked','closing') AND delete_after BETWEEN ? AND ?${AND}`,
  )
    .bind(...sb(now, now + DAY))
    .all<{ email: string; delete_after: number; delete_reason: string }>()
  for (const m of soon.results) {
    if (!ok(m.email)) continue
    await notice(env, now, {
      audience: 'super',
      kind: 'delete_soon',
      title: '账号将在 24 小时内自动删除',
      body: `${maskEmail(m.email)}（${m.delete_reason}）`,
      ref: 'member:' + m.email,
      dedupe: `delsoon:${m.email}:${m.delete_after}`,
    })
    // and the user gets one last reminder (dedupe per deletion date)
    await enqueueMail(
      env,
      m.email,
      'delete_soon',
      { deleteAfter: m.delete_after, reason: m.delete_reason },
      `delete_soon:${m.email}:${m.delete_after}`,
      now,
    )
    out.deleteSoon++
  }

  // 5. purge what is due
  const due = await env.DB.prepare(
    `SELECT email FROM members WHERE status IN ('revoked','closing') AND delete_after <= ?${AND} LIMIT 20`,
  )
    .bind(...sb(now))
    .all<{ email: string }>()
  for (const m of due.results) {
    if (!ok(m.email)) continue
    const r = await purgeMember(env, now, m.email)
    if (r.ok) out.purged++
  }

  // 6. housekeeping (whole database; never in a scoped run)
  if (!scope) {
    await env.DB.prepare('DELETE FROM email_otps WHERE expires_at < ?')
      .bind(now - DAY)
      .run()
    await env.DB.prepare('DELETE FROM rate_buckets WHERE win < ?')
      .bind(Math.floor((now - DAY) / 60_000))
      .run()
  }
  return out
}

export { chunks }
