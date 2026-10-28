/**
 * Lifecycle lab (staging only, super admin only).
 *
 * Tests the time rules (7-day deletion, 6-month inactivity, Pro expiry reminders)
 * without touching the server clock or any real account:
 *  - every lab account lives at @lab.exampilot.invalid (never mailed, never put in Access);
 *  - "time travel" is done by moving ONLY that lab account's own timestamps into the
 *    past (shift), then running the normal lifecycle code at the real current time;
 *  - the lifecycle code under test is exactly the production code path (lifecycleTick).
 */
import { lifecycleTick, refreshPro, purgeMember } from './core'
import { DAY, HOUR, LAB_DOMAIN, chunks, isLabEmail, rid, sha256hex, type PlatformEnv } from './util'

const MONTH6 = (now: number) => {
  const d = new Date(now + 8 * HOUR)
  d.setUTCMonth(d.getUTCMonth() - 6)
  return d.getTime() - 8 * HOUR
}

type Scenario = { key: string; title: string; expect: string }
export const LAB_SCENARIOS: Scenario[] = [
  { key: 'del7-due', title: '停用满 7 天', expect: '执行后被删除（成员变为已删除，学习数据清空）' },
  { key: 'del6', title: '停用 6 天（差 1 天）', expect: '不删除；管理员收到「24 小时内将删除」通知' },
  {
    key: 'inactive-warn',
    title: '5 个月零 1 天未登录（距 6 个月不足 30 天）',
    expect: '发出不活跃提醒（邮件入队，status=dead/test_address）',
  },
  { key: 'inactive-stop', title: '超过 6 个月未登录，且提醒已满 30 天', expect: '被停用（原因 inactive），7 天后删除' },
  { key: 'inactive-fresh', title: '5 个月未登录', expect: '不提醒、不停用' },
  { key: 'retain', title: '7 个月未登录但已设长期保留', expect: '不提醒、不停用' },
  { key: 'pro-3d', title: 'Pro 还剩约 3 天', expect: '发出 3 天到期提醒' },
  { key: 'pro-1d', title: 'Pro 还剩约 23 小时', expect: '发出 1 天到期提醒（不再发 3 天提醒）' },
  { key: 'pro-expired', title: 'Pro 已过期 1 小时', expect: '变回 Standard，发出到期通知' },
  { key: 'pro-perm', title: '永久 Pro', expect: '保持 Pro，不提醒' },
]
export const labEmail = (key: string, run: string) => `lab-${run}-${key}@${LAB_DOMAIN}`

async function labMembers(env: PlatformEnv) {
  const r = await env.DB.prepare(`SELECT * FROM members WHERE email LIKE ?`)
    .bind('%@' + LAB_DOMAIN)
    .all<Record<string, unknown>>()
  return r.results
}

export async function labSeed(env: PlatformEnv, now: number, by: string) {
  // random 6-digit run id, unique among the lab accounts present
  let run = ''
  for (let i = 0; i < 20 && !run; i++) {
    const c = String((crypto.getRandomValues(new Uint32Array(1))[0] % 900000) + 100000)
    const hit = await env.DB.prepare('SELECT 1 FROM members WHERE email LIKE ? LIMIT 1')
      .bind(`lab-${c}-%@${LAB_DOMAIN}`)
      .first()
    if (!hit) run = c
  }
  if (!run) throw new Error('lab_run_id')
  const st: ReturnType<PlatformEnv['DB']['prepare']>[] = []
  const grants: { email: string; kind: 'days' | 'permanent'; dur: number; start: number }[] = []
  const m6 = MONTH6(now)
  for (const s of LAB_SCENARIOS) {
    const email = labEmail(s.key, run)
    let created = now - 400 * DAY
    let last: number | null = now - 2 * DAY
    let status = 'active'
    let statusAt: number | null = created
    let deleteAfter: number | null = null
    let reason: string | null = null
    let warned: number | null = null
    let retain = 0
    switch (s.key) {
      case 'del7-due':
        status = 'revoked'
        statusAt = now - 7 * DAY - 60_000
        deleteAfter = now - 60_000
        reason = 'admin_revoke'
        break
      case 'del6':
        status = 'revoked'
        statusAt = now - 6 * DAY
        deleteAfter = now + DAY - 60_000
        reason = 'admin_revoke'
        break
      case 'inactive-warn':
        last = m6 + 29 * DAY
        created = last - 30 * DAY
        break
      case 'inactive-stop':
        last = m6 - DAY
        created = last - 30 * DAY
        warned = now - 31 * DAY
        break
      case 'inactive-fresh':
        last = m6 + 31 * DAY
        created = last - 30 * DAY
        break
      case 'retain':
        last = m6 - 31 * DAY
        created = last - 30 * DAY
        retain = 1
        break
      case 'pro-3d':
        grants.push({ email, kind: 'days', dur: 30 * DAY, start: now - 27 * DAY - HOUR + 10 * 60_000 })
        break
      case 'pro-1d':
        grants.push({ email, kind: 'days', dur: 30 * DAY, start: now - 29 * DAY - HOUR })
        break
      case 'pro-expired':
        grants.push({ email, kind: 'days', dur: 30 * DAY, start: now - 30 * DAY - HOUR })
        break
      case 'pro-perm':
        grants.push({ email, kind: 'permanent', dur: 0, start: now - 10 * DAY })
        break
    }
    st.push(
      env.DB.prepare(
        `INSERT INTO members (email, role, status, source, created_at, activated_at, last_login_at, long_retain, status_at, delete_after, delete_reason, inactive_warned_at, access_state, note)
         VALUES (?, 'user', ?, 'invite', ?, ?, ?, ?, ?, ?, ?, ?, 'ok', ?)`,
      ).bind(
        email,
        status,
        created,
        created,
        last,
        retain,
        statusAt,
        deleteAfter,
        reason,
        warned,
        `生命周期实验室：${s.title}`,
      ),
    )
  }
  for (const g of grants)
    st.push(
      env.DB.prepare(
        `INSERT INTO pro_grants (id, email, source, kind, duration_ms, starts_at, state, reason, created_by, created_at) VALUES (?, ?, 'admin', ?, ?, ?, 'active', 'lifecycle lab', ?, ?)`,
      ).bind(rid('pg'), g.email, g.kind, g.dur, g.start, by, g.start),
    )
  await env.DB.batch(st)
  // project Pro, then date the end date to when the grant was made (as if granted back then)
  for (const g of grants) {
    // projected as it looked right after the grant (so an already-passed end is still 'pro' until the tick sees it)
    await refreshPro(env, g.email, g.start + 60_000)
    await env.DB.prepare('UPDATE pro_state SET until_since = ? WHERE email = ?').bind(g.start, g.email).run()
  }
  return { run, emails: LAB_SCENARIOS.map((s) => ({ ...s, email: labEmail(s.key, run) })) }
}

/** Move one lab account's timestamps `days` into the past = that account lives `days` later. */
export async function labShift(env: PlatformEnv, now: number, email: string, days: number) {
  if (!isLabEmail(email)) return { ok: false, error: 'not_lab' }
  if (!Number.isFinite(days) || days <= 0 || days > 400) return { ok: false, error: 'bad_days' }
  const d = Math.round(days * DAY)
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE members SET created_at = created_at - ?, activated_at = activated_at - ?, last_login_at = last_login_at - ?, status_at = status_at - ?,
         delete_after = delete_after - ?, inactive_warned_at = inactive_warned_at - ?, retain_cleared_at = retain_cleared_at - ?, version = version + 1 WHERE email = ?`,
    ).bind(d, d, d, d, d, d, d, email),
    env.DB.prepare(
      'UPDATE pro_grants SET starts_at = starts_at - ?, created_at = created_at - ?, revoked_at = revoked_at - ? WHERE email = ?',
    ).bind(d, d, d, email),
    env.DB.prepare(
      'UPDATE pro_suspensions SET started_at = started_at - ?, ended_at = ended_at - ? WHERE email = ?',
    ).bind(d, d, email),
    env.DB.prepare(
      'UPDATE pro_state SET until = until - ?, until_since = until_since - ?, remind3_for = remind3_for - ?, remind1_for = remind1_for - ?, expired_for = expired_for - ? WHERE email = ?',
    ).bind(d, d, d, d, d, email),
  ])
  return { ok: true, email, days }
}

/** Run the real lifecycle + mail drain at the real current time. */
/**
 * Manual tick for the lab: the same lifecycle code the cron runs, but strictly scoped to the accounts
 * of the given runs (SQL narrowed to lab-<run>-%@lab.exampilot.invalid, every row re-checked).
 * Real staging members, invites, OTPs and the mail queue of anyone else are never read or written.
 * Mail produced for lab accounts is retired in place (never handed to a provider).
 */
export async function labTick(env: PlatformEnv, now: number, runs: string[]) {
  if (!runs.length) return { ok: false as const, error: 'runs_required' }
  const per: Record<string, unknown> = {}
  let mailRetired = 0
  for (const run of runs) {
    const prefix = `lab-${run}-`
    const like = `${prefix}%@${LAB_DOMAIN}`
    per[run] = await lifecycleTick(env, now, { like, allow: (e) => isLabEmail(e) && e.startsWith(prefix) })
    const r = await env.DB.prepare(
      `UPDATE mail_outbox SET status = 'dead', last_error = 'test_address' WHERE to_email LIKE ? AND status IN ('queued','failed','held')`,
    )
      .bind(like)
      .run()
    mailRetired += r.meta?.changes ?? 0
  }
  return {
    ok: true as const,
    scope: runs.map((r) => `lab-${r}-*@${LAB_DOMAIN}`),
    lifecycle: per,
    mail: { retired: mailRetired, sent: 0 },
  }
}

export async function labStatus(env: PlatformEnv, now: number, runs: string[] = []) {
  const all = await labMembers(env)
  const ms = runs.length ? all.filter((m) => runs.some((r) => String(m.email).startsWith(`lab-${r}-`))) : all
  const emails = ms.map((m) => String(m.email))
  const pro: Record<string, unknown> = {}
  const mail: Record<string, unknown[]> = {}
  for (const part of chunks(emails, 40)) {
    if (!part.length) continue
    const qs = part.map(() => '?').join(',')
    const [ps, mo] = await env.DB.batch([
      env.DB.prepare(
        `SELECT email, tier, permanent, until, remind3_for, remind1_for, expired_for FROM pro_state WHERE email IN (${qs})`,
      ).bind(...part),
      env.DB.prepare(
        `SELECT to_email, template, status, last_error, created_at FROM mail_outbox WHERE to_email IN (${qs}) ORDER BY created_at`,
      ).bind(...part),
    ])
    for (const r of ps.results as Record<string, unknown>[]) pro[String(r.email)] = r
    for (const r of mo.results as Record<string, unknown>[])
      (mail[String(r.to_email)] ||= []).push({ template: r.template, status: r.status, last_error: r.last_error })
  }
  const notices = await env.DB.prepare(
    `SELECT kind, title, body, created_at FROM admin_notices WHERE body LIKE ? ORDER BY created_at DESC LIMIT 50`,
  )
    .bind('%.exampilot.invalid%')
    .all()
  // lab accounts that the lifecycle already deleted (their member row is gone; deletion_log keeps a hash)
  const purged: { email: string; deleted_at: number; reason: string }[] = []
  for (const run of runs)
    for (const sc of LAB_SCENARIOS) {
      const email = labEmail(sc.key, run)
      if (emails.includes(email)) continue
      const tag = 'deleted:' + (await sha256hex('member:' + email)).slice(0, 16)
      const r = await env.DB.prepare('SELECT deleted_at, reason FROM deletion_log WHERE email_hash = ?')
        .bind(tag)
        .first<{ deleted_at: number; reason: string }>()
      if (r) purged.push({ email, deleted_at: r.deleted_at, reason: r.reason })
    }
  return {
    now,
    members: ms.map((m) => ({
      email: m.email,
      scenario: String(m.email).split('@')[0].split('-').slice(2).join('-'),
      status: m.status,
      delete_reason: m.delete_reason,
      delete_after: m.delete_after,
      last_login_at: m.last_login_at,
      inactive_warned_at: m.inactive_warned_at,
      long_retain: m.long_retain,
      pro: pro[String(m.email)] ?? null,
      mail: mail[String(m.email)] ?? [],
    })),
    purged,
    notices: notices.results,
  }
}

/** Remove every lab row (including anonymised tombstones of purged lab accounts). */
export async function labClear(env: PlatformEnv, now: number, runs: string[] = []) {
  // scoped: only the named runs (lab-<run>-*). Lab rows from other runs or created by real reviewer actions
  // (e.g. an approved LABAPP application) are left alone. An empty list clears nothing.
  const clean = runs.map((r) => String(r).replace(/[^0-9a-z]/gi, '')).filter(Boolean)
  if (!clean.length) return { ok: true, removed: 0 }
  const ms = await labMembers(env)
  const emails = ms.map((m) => String(m.email)).filter((e) => clean.some((r) => e.startsWith('lab-' + r + '-')))
  // purged lab accounts: their rows are renamed to deleted:<hash>; rebuild the tags for known runs
  for (const run of clean)
    for (const s of LAB_SCENARIOS)
      emails.push('deleted:' + (await sha256hex('member:' + labEmail(s.key, run))).slice(0, 16))
  let n = 0
  for (const part of chunks(emails, 30)) {
    const qs = part.map(() => '?').join(',')
    const r = await env.DB.batch([
      env.DB.prepare(`DELETE FROM pro_grants WHERE email IN (${qs})`).bind(...part),
      env.DB.prepare(`DELETE FROM pro_state WHERE email IN (${qs})`).bind(...part),
      env.DB.prepare(`DELETE FROM pro_suspensions WHERE email IN (${qs})`).bind(...part),
      env.DB.prepare(`DELETE FROM mail_outbox WHERE to_email IN (${qs})`).bind(...part),
      env.DB.prepare(`DELETE FROM members WHERE email IN (${qs})`).bind(...part),
    ])
    n += r.reduce((a, x) => a + (x.meta?.changes ?? 0), 0)
  }
  await env.DB.prepare(`DELETE FROM admin_notices WHERE kind = 'delete_soon' AND body LIKE ?`)
    .bind('%.exampilot.invalid%')
    .run()
  void now
  return { ok: true, removed: n }
}

export { purgeMember }
