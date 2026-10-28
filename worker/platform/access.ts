/**
 * Cloudflare Access login allow-list, kept in step with members.
 *
 * Only ever touches ONE policy (ACCESS_POLICY_ID) and only `{ email: { email } }`
 * include rules:
 *   GET policy → compute the diff against D1 → PUT the full include list → GET again
 *   and verify. Rules of any other type (everyone, email domain, groups …) make the
 *   sync stop without writing ("unexpected_rule"): we never widen or rewrite them.
 * E-mails that are not members are left alone (manual entries survive). Owners
 * (SUPER_OWNERS) are never removed. A D1 job lock serialises concurrent syncs.
 * members.access_state: ok | pending | failed — the admin UI shows it, and a
 * failure is retried by cron. "开通成功" is only shown once both D1 and Access agree.
 */
import { HOUR, chunks, isUndeliverable, rid, superOwners, type PlatformEnv } from './util'

type Rule = Record<string, unknown>
interface Policy {
  id: string
  name: string
  decision: string
  include: Rule[]
  exclude?: Rule[]
  require?: Rule[]
  [k: string]: unknown
}

export function accessConfigured(env: PlatformEnv): boolean {
  return !!(env.CF_ACCESS_TOKEN && env.ACCESS_ACCOUNT_ID && env.ACCESS_POLICY_ID)
}

function ruleEmail(r: Rule): string | null {
  const e = (r as { email?: { email?: unknown } }).email
  if (e && typeof e === 'object' && typeof e.email === 'string' && Object.keys(r).length === 1)
    return e.email.trim().toLowerCase()
  return null
}

/**
 * Reusable policies live at /access/policies/{id}; a policy that belongs to a single
 * application (reusable:false) is written through /access/apps/{app}/policies/{id}.
 */
async function cf(
  env: PlatformEnv,
  method: string,
  body: unknown,
  fetchImpl: typeof fetch,
  appId?: string | null,
): Promise<Policy> {
  const base = `https://api.cloudflare.com/client/v4/accounts/${env.ACCESS_ACCOUNT_ID}`
  const url = appId
    ? `${base}/access/apps/${appId}/policies/${env.ACCESS_POLICY_ID}`
    : `${base}/access/policies/${env.ACCESS_POLICY_ID}`
  const r = await fetchImpl(url, {
    method,
    headers: { Authorization: `Bearer ${env.CF_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const j = (await r.json().catch(() => null)) as {
    success?: boolean
    result?: Policy
    errors?: { message?: string }[]
  } | null
  if (!r.ok || !j?.success || !j.result)
    throw new Error(`cloudflare ${method} ${r.status}: ${j?.errors?.map((e) => e.message).join('; ') || 'no result'}`)
  return j.result
}

async function lock(env: PlatformEnv, name: string, now: number, ttl = 60_000): Promise<string | null> {
  const holder = rid('lk', 6)
  await env.DB.prepare('DELETE FROM job_locks WHERE name = ? AND until < ?').bind(name, now).run()
  const r = await env.DB.prepare('INSERT OR IGNORE INTO job_locks (name, holder, until) VALUES (?, ?, ?)')
    .bind(name, holder, now + ttl)
    .run()
  return r.meta?.changes ? holder : null
}
async function unlock(env: PlatformEnv, name: string, holder: string) {
  await env.DB.prepare('DELETE FROM job_locks WHERE name = ? AND holder = ?').bind(name, holder).run()
}

export interface SyncResult {
  ran: boolean
  added: string[]
  removed: string[]
  error?: string
}

/**
 * Bring the Access policy in line with members whose access_state is pending/failed
 * (or every member when full=true). Idempotent; safe to call from many places.
 */
export async function syncAccess(
  env: PlatformEnv,
  now: number,
  opts: { fetchImpl?: typeof fetch; full?: boolean } = {},
): Promise<SyncResult> {
  const doFetch = opts.fetchImpl ?? fetch
  const rows = await env.DB.prepare(
    opts.full
      ? `SELECT email, status FROM members`
      : `SELECT email, status FROM members WHERE access_state IN ('pending','failed')`,
  ).all<{ email: string; status: string }>()
  // lab / reserved-domain test rows never touch the real Access policy
  const fake = rows.results.filter((r) => isUndeliverable(r.email)).map((r) => r.email)
  for (const part of chunks(fake, 90))
    await env.DB.prepare(
      `UPDATE members SET access_state = 'ok', access_error = NULL, access_attempts = 0 WHERE email IN (${part.map(() => '?').join(',')})`,
    )
      .bind(...part)
      .run()
  rows.results = rows.results.filter((r) => !isUndeliverable(r.email))
  if (!rows.results.length) return { ran: false, added: [], removed: [] }
  if (!accessConfigured(env)) {
    await env.DB.prepare(
      `UPDATE members SET access_error = 'Access 自动授权尚未配置（缺少 CF_ACCESS_TOKEN）' WHERE access_state IN ('pending','failed')`,
    ).run()
    return { ran: false, added: [], removed: [], error: 'not_configured' }
  }
  const holder = await lock(env, 'access-sync', now)
  if (!holder) return { ran: false, added: [], removed: [], error: 'locked' }
  const owners = superOwners(env)
  const targets = rows.results.map((r) => r.email)
  try {
    const pol = await cf(env, 'GET', null, doFetch)
    const appScoped = pol.reusable === false ? String(pol.app_id || env.ACCESS_APP_ID || '') : ''
    if (pol.reusable === false && !appScoped) throw new Error('app_unknown: 策略属于单个应用但缺少 app id')
    if (appScoped && env.ACCESS_APP_ID && appScoped !== env.ACCESS_APP_ID)
      throw new Error('app_mismatch: 策略不属于配置的 Access 应用，已停止')
    const current: string[] = []
    for (const r of pol.include || []) {
      const e = ruleEmail(r)
      if (!e) throw new Error('unexpected_rule: 策略里有非邮箱规则，已停止自动修改')
      current.push(e)
    }
    const have = new Set(current)
    const want = new Set(current)
    const added: string[] = []
    const removed: string[] = []
    for (const m of rows.results) {
      const allow = m.status === 'active'
      if (allow && !have.has(m.email)) {
        want.add(m.email)
        added.push(m.email)
      }
      if (!allow && have.has(m.email) && !owners.has(m.email)) {
        want.delete(m.email)
        removed.push(m.email)
      }
    }
    if (added.length || removed.length) {
      if (want.size === 0) throw new Error('refuse_empty: 不会把白名单清空')
      const body: Record<string, unknown> = {
        name: pol.name,
        decision: pol.decision,
        include: [...want].map((email) => ({ email: { email } })),
        exclude: pol.exclude ?? [],
        require: pol.require ?? [],
      }
      for (const k of [
        'session_duration',
        'approval_required',
        'isolation_required',
        'purpose_justification_required',
        'purpose_justification_prompt',
        'approval_groups',
      ]) {
        if (pol[k] !== undefined && pol[k] !== null) body[k] = pol[k]
      }
      await cf(env, 'PUT', body, doFetch, appScoped || null)
      // verify
      const after = await cf(env, 'GET', null, doFetch, appScoped || null)
      const got = new Set((after.include || []).map(ruleEmail).filter((x): x is string => !!x))
      for (const e of added) if (!got.has(e)) throw new Error(`verify_failed: ${e} 未出现在策略中`)
      for (const e of removed) if (got.has(e)) throw new Error(`verify_failed: ${e} 仍在策略中`)
      for (const e of current)
        if (!removed.includes(e) && !got.has(e)) throw new Error(`verify_failed: 现有用户 ${e} 丢失`)
    }
    // Optional: end the removed users' live Access sessions. Cloudflare only offers this per user
    // ACROSS ALL applications of the organization (it would also sign the same person out of the
    // other ExamPilot app), so it is off unless ACCESS_REVOKE_SESSIONS=1. The Worker gate checks
    // the member's current standing on every request either way, so a live session alone never
    // reaches protected content.
    if (removed.length && env.ACCESS_REVOKE_SESSIONS === '1') {
      let okN = 0
      for (const email of removed) {
        try {
          const r = await doFetch(
            `https://api.cloudflare.com/client/v4/accounts/${env.ACCESS_ACCOUNT_ID}/access/organizations/revoke_user`,
            {
              method: 'POST',
              headers: { Authorization: `Bearer ${env.CF_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ email }),
            },
          )
          const j = (await r.json().catch(() => null)) as { success?: boolean } | null
          if (r.ok && j?.success) okN++
        } catch {
          /* best effort: the Worker gate already refuses this member */
        }
      }
      await env.DB.prepare(
        `INSERT INTO audit_log (at, actor, actor_role, action, target, detail) VALUES (?, 'system', 'system', 'access.revoke_sessions', ?, ?)`,
      )
        .bind(now, String(removed.length), JSON.stringify({ requested: removed.length, revoked: okN }))
        .run()
    }
    // Only rows whose status is still what this sync acted on become 'ok'
    // (a member revoked meanwhile stays pending and is handled by the next run).
    const act = rows.results.filter((r) => r.status === 'active').map((r) => r.email)
    const inact = rows.results.filter((r) => r.status !== 'active').map((r) => r.email)
    for (const [list, cond] of [
      [act, "status = 'active'"],
      [inact, "status <> 'active'"],
    ] as const) {
      for (const part of chunks(list, 90))
        await env.DB.prepare(
          `UPDATE members SET access_state = 'ok', access_error = NULL, access_attempts = 0 WHERE email IN (${part.map(() => '?').join(',')}) AND ${cond}`,
        )
          .bind(...part)
          .run()
    }
    if (added.length || removed.length)
      await env.DB.prepare(
        `INSERT INTO audit_log (at, actor, actor_role, action, target, detail) VALUES (?, 'system', 'system', 'access.sync', ?, ?)`,
      )
        .bind(
          now,
          String(added.length + removed.length),
          JSON.stringify({ added: added.length, removed: removed.length }),
        )
        .run()
    return { ran: true, added, removed }
  } catch (e) {
    const msg = String((e as Error).message || e).slice(0, 300)
    for (const part of chunks(targets, 90))
      await env.DB.prepare(
        `UPDATE members SET access_state = 'failed', access_error = ?, access_attempts = access_attempts + 1 WHERE email IN (${part.map(() => '?').join(',')}) AND access_state IN ('pending','failed')`,
      )
        .bind(msg, ...part)
        .run()
    if (/unexpected_rule|refuse_empty|app_mismatch|app_unknown/.test(msg))
      await env.DB.prepare(
        `INSERT OR IGNORE INTO admin_notices (id, audience, kind, title, body, created_at, dedupe_key) VALUES (?, 'super', 'access_alert', 'Access 自动授权已暂停', ?, ?, ?)`,
      )
        .bind(rid('nt'), msg, now, 'access-alert:' + Math.floor(now / (6 * HOUR)))
        .run()
    return { ran: true, added: [], removed: [], error: msg }
  } finally {
    await unlock(env, 'access-sync', holder)
  }
}
