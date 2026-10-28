/**
 * Authentication + membership gate shared by every protected route
 * (/api/sync, /api/ai, /api/admin, /api/me), plus the platform router and cron.
 */
import { mediaSweep } from '../media'
import { verifyAccessJwt, AuthError, type AuthConfig } from '../auth'
import { resolveAccount, sameOrigin, type Account } from '../api'
import { afterLogin, effectiveRole, gate, lifecycleTick, refreshPro, type Member, type Role } from './core'
import { handleAdminPlatform } from './admin'
import { handleMe } from './me'
import { syncAccess } from './access'
import { drainOutbox } from './mail'
import { fail, type PlatformEnv } from './util'

export interface ProtectedEnv extends PlatformEnv {
  ACCESS_TEAM_DOMAIN: string
  ACCESS_AUD: string
  BANK_FP: string
}

export type AuthOk = { ok: true; email: string; member: Member; role: Role; account: Account }
export type AuthFail = { ok: false; status: number; error: string; code: string; reason: string }

/**
 * 1. verify the Access application token (signature, aud, iss, exp)
 * 2. the member must exist and be active (Access sessions outlive revocations)
 * 3. resolve the learning account; first login = activation
 */
export async function platformAuth(
  req: Request,
  env: ProtectedEnv,
  now: number,
  auth?: Partial<AuthConfig>,
): Promise<AuthOk | AuthFail> {
  let ident
  try {
    ident = await verifyAccessJwt(req.headers.get('Cf-Access-Jwt-Assertion'), {
      teamDomain: env.ACCESS_TEAM_DOMAIN,
      aud: env.ACCESS_AUD,
      ...auth,
    })
  } catch (e) {
    if (e instanceof AuthError)
      return {
        ok: false,
        status: 401,
        error: 'unauthenticated',
        code: 'SESSION',
        reason: '登录已失效，请刷新页面重新登录',
      }
    return { ok: false, status: 503, error: 'server_error', code: 'AUTH_UNAVAILABLE', reason: '身份校验暂时不可用' }
  }
  let g
  try {
    g = await gate(env, ident.email, now)
  } catch {
    return { ok: false, status: 503, error: 'server_error', code: 'DB', reason: '数据库暂时不可用' }
  }
  if (!g.ok) return { ok: false, status: g.status, error: 'unauthenticated', code: g.code, reason: g.reason }
  let account: Account
  try {
    account = await resolveAccount(env as never, ident.email, ident.sub, now)
    await afterLogin(env, g, account.id, now)
  } catch {
    return { ok: false, status: 503, error: 'server_error', code: 'DB', reason: '数据库暂时不可用' }
  }
  if (account.status !== 'active')
    return { ok: false, status: 403, error: 'unauthenticated', code: 'ACCOUNT_REVOKED', reason: '账号已停用' }
  const member =
    g.firstActivation || g.member.account_id !== account.id ? { ...g.member, account_id: account.id } : g.member
  return { ok: true, email: ident.email, member, role: effectiveRole(env, member), account }
}

/** /api/me/* and the new /api/admin/* routes. Returns null when the path is not ours. */
export async function handlePlatform(
  req: Request,
  env: ProtectedEnv,
  deps: {
    now?: () => number
    auth?: Partial<AuthConfig>
    fetchImpl?: typeof fetch
    waitUntil?: (p: Promise<unknown>) => void
  } = {},
): Promise<Response | null> {
  const url = new URL(req.url)
  const p = url.pathname
  if (!p.startsWith('/api/me/') && !p.startsWith('/api/admin/')) return null
  if (p === '/api/admin/ai-users' || p === '/api/admin/ai-log') return null // legacy routes stay in ai.ts
  const now = deps.now ? deps.now() : Date.now()
  if (req.headers.get('X-ExamPilot-Client') !== '1')
    return fail(
      400,
      'bad_request',
      req.headers.get('X-ExamPilot-Client') === null ? 'missing client header' : 'invalid client header',
    )
  if (req.method === 'POST') {
    if (!sameOrigin(req)) return fail(403, 'forbidden_origin')
    if (!(req.headers.get('Content-Type') || '').startsWith('application/json')) return fail(415, 'bad_request')
  } else if (req.method !== 'GET') return fail(405, 'bad_request')
  const a = await platformAuth(req, env, now, deps.auth)
  if (!a.ok) return fail(a.status, a.error, a.reason, { code: a.code })
  const bg = (pr: Promise<unknown>) => {
    const q = pr.catch(() => {})
    if (deps.waitUntil) deps.waitUntil(q)
  }
  try {
    const r = p.startsWith('/api/me/')
      ? await handleMe(req, url, { env, me: a.member, now, fetchImpl: deps.fetchImpl, bg })
      : await handleAdminPlatform(req, url, { env, me: a.member, role: a.role, now, fetchImpl: deps.fetchImpl, bg })
    return r ?? fail(404, 'not_found')
  } catch (e) {
    void e
    return fail(503, 'server_error', '服务暂时不可用')
  }
}

/** Cron: every 15 min. Each step is independent and idempotent. */
export async function runCron(env: PlatformEnv, now: number, fetchImpl?: typeof fetch) {
  const out: Record<string, unknown> = {}
  try {
    out.lifecycle = await lifecycleTick(env, now)
  } catch (e) {
    out.lifecycleError = String((e as Error).message)
  }
  try {
    // keep the cached Pro projection fresh for anything that crossed its end
    const due = await env.DB.prepare(`SELECT email FROM pro_state WHERE until IS NOT NULL AND until <= ? LIMIT 50`)
      .bind(now)
      .all<{ email: string }>()
    for (const r of due.results) await refreshPro(env, r.email, now)
    // ledger rows with no cached projection yet (e.g. grants imported by the migration)
    const missing = await env.DB.prepare(
      `SELECT DISTINCT g.email FROM pro_grants g LEFT JOIN pro_state ps ON ps.email = g.email WHERE ps.email IS NULL LIMIT 50`,
    ).all<{ email: string }>()
    for (const r of missing.results) await refreshPro(env, r.email, now)
  } catch (e) {
    out.proError = String((e as Error).message)
  }
  try {
    out.access = await syncAccess(env, now, { fetchImpl })
  } catch (e) {
    out.accessError = String((e as Error).message)
  }
  try {
    out.mail = await drainOutbox(env, now, { fetchImpl, limit: 40 })
  } catch (e) {
    out.mailError = String((e as Error).message)
  }
  try {
    out.media = await mediaSweep(env as never, now)
  } catch (e) {
    out.mediaError = String((e as Error).message)
  }
  return out
}
