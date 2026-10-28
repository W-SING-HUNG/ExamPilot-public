/**
 * Public endpoints served by the welcome Worker (NOT behind Access):
 *   GET  /api/public/config            texts, open/paused, Turnstile site key
 *   GET  /api/public/ref?t=            is a referral link usable (no owner info)
 *   POST /api/public/otp               send a one-time code (Turnstile + rate limits)
 *   POST /api/public/verify            check the code → short-lived signed cookie
 *   GET  /api/public/me                what this verified e-mail can do / its status
 *   POST /api/public/apply             submit an application
 *   POST /api/public/invite/accept     accept an admin invitation (token from the mail)
 *   POST /api/public/restore           cancel a self-close during the 7-day window
 *   POST /api/public/logout
 * Nothing here reveals whether an e-mail exists before the person proved they own it.
 * Nothing here can reach the learning data or the protected app.
 */
import {
  REAPPLY_COOLDOWN,
  addGrant,
  admitMember,
  audit,
  canonicalEmail,
  getMember,
  getSettings,
  handleNotices,
  notice,
  referralFlags,
  setStatus,
} from './core'
import { syncAccess } from './access'
import { drainOutbox, enqueueMail, mailConfigured } from './mail'
import {
  DAY,
  cleanText,
  fail,
  hmac,
  json,
  maskEmail,
  normEmail,
  otpCode,
  readJson,
  rid,
  sha256hex,
  timingSafeEq,
  type PlatformEnv,
} from './util'

export interface PublicDeps {
  now?: () => number
  fetchImpl?: typeof fetch
  waitUntil?: (p: Promise<unknown>) => void
}

const OTP_TTL = 10 * 60_000
const SESSION_TTL = 30 * 60_000
const COOKIE = 'ep_pv'

async function ipKey(env: PlatformEnv, req: Request) {
  const ip = req.headers.get('CF-Connecting-IP') || 'unknown'
  return (await sha256hex('ip:' + ip + ':' + (env.PLATFORM_SECRET || ''))).slice(0, 24)
}

/** fixed-window counter; returns true when over the limit */
export async function overLimit(env: PlatformEnv, key: string, now: number, windowMin: number, max: number) {
  const win = Math.floor(now / 60_000 / windowMin) * windowMin
  await env.DB.prepare(
    'INSERT INTO rate_buckets (key, win, n) VALUES (?, ?, 1) ON CONFLICT(key, win) DO UPDATE SET n = n + 1',
  )
    .bind(key, win)
    .run()
  const r = await env.DB.prepare('SELECT n FROM rate_buckets WHERE key = ? AND win = ?')
    .bind(key, win)
    .first<{ n: number }>()
  return (r?.n ?? 0) > max
}

/** Turnstile server check. Returns null when the token is good, otherwise a short reason (Cloudflare error codes are not secret). */
export async function turnstileProblem(
  env: PlatformEnv,
  tokenV: unknown,
  req: Request,
  doFetch: typeof fetch,
): Promise<string | null> {
  if (!env.TURNSTILE_SECRET) return env.PLATFORM_STAGE === 'test' ? null : 'not_configured' // only the unit tests may skip it
  if (typeof tokenV !== 'string' || !tokenV || tokenV.length > 2048) return 'missing_token'
  const form = new FormData()
  form.append('secret', env.TURNSTILE_SECRET)
  form.append('response', tokenV)
  const ip = req.headers.get('CF-Connecting-IP')
  if (ip) form.append('remoteip', ip)
  try {
    const r = await doFetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form })
    const j = (await r.json()) as { success?: boolean; hostname?: string; 'error-codes'?: string[] }
    if (!j.success) return (j['error-codes'] || []).join(',') || 'rejected'
    // with a real key: the token must have been issued on our own welcome host
    // TURNSTILE_HOSTNAME is a strict comma-separated allow-list of our own welcome hosts (exact, case-insensitive);
    // the token must also have been issued on the very host this request arrived at (the URL host is set by
    // Cloudflare routing, never taken from Origin or other client headers).
    if (env.TURNSTILE_HOSTNAME) {
      const allow = env.TURNSTILE_HOSTNAME.split(',')
        .map((h) => h.trim().toLowerCase())
        .filter(Boolean)
      const got = String(j.hostname || '').toLowerCase()
      if (!allow.includes(got) || got !== new URL(req.url).hostname.toLowerCase()) return 'hostname_mismatch'
    }
    return null
  } catch {
    return 'siteverify_unreachable'
  }
}
export async function verifyTurnstile(
  env: PlatformEnv,
  tokenV: unknown,
  req: Request,
  doFetch: typeof fetch,
): Promise<boolean> {
  return (await turnstileProblem(env, tokenV, req, doFetch)) === null
}

/* ---------- signed session cookie: "<email>|<exp>|<sig>" (base64url) ---------- */
async function makeSession(env: PlatformEnv, email: string, now: number) {
  const exp = now + SESSION_TTL
  const payload = `${email}|${exp}`
  const sig = await hmac(env, 'pv:' + payload)
  return btoa(unescape(encodeURIComponent(`${payload}|${sig}`)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}
async function readSession(env: PlatformEnv, req: Request, now: number): Promise<string | null> {
  const c = req.headers.get('Cookie') || ''
  const m = c.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([A-Za-z0-9_-]+)`))
  if (!m) return null
  try {
    const raw = decodeURIComponent(escape(atob(m[1].replace(/-/g, '+').replace(/_/g, '/'))))
    const [email, exp, sig] = raw.split('|')
    if (!email || !exp || !sig) return null
    if (Number(exp) < now) return null
    const want = await hmac(env, 'pv:' + `${email}|${exp}`)
    if (!timingSafeEq(sig, want)) return null
    return normEmail(email)
  } catch {
    return null
  }
}
function cookieHeader(value: string, maxAgeS: number) {
  return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeS}`
}

function csrfOk(req: Request) {
  const origin = req.headers.get('Origin')
  const host = new URL(req.url).host
  return (origin === `https://${host}` || origin === `http://${host}`) && req.headers.get('X-ExamPilot-Public') === '1'
}

export async function handlePublic(req: Request, env: PlatformEnv, deps: PublicDeps = {}): Promise<Response> {
  const now = deps.now ? deps.now() : Date.now()
  const doFetch = deps.fetchImpl ?? fetch
  const url = new URL(req.url)
  const path = url.pathname
  const bg = (p: Promise<unknown>) => (deps.waitUntil ? deps.waitUntil(p.catch(() => {})) : p.catch(() => {}))

  if (req.method === 'POST') {
    if (!csrfOk(req)) return fail(403, 'forbidden_origin')
    if (!(req.headers.get('Content-Type') || '').startsWith('application/json')) return fail(415, 'bad_request')
  }
  const ipk = await ipKey(env, req)
  if (await overLimit(env, 'req:' + ipk, now, 1, 120)) return fail(429, 'rate_limited', '请求太频繁，请稍后再试')

  try {
    if (path === '/api/public/config' && req.method === 'GET') {
      const s = await getSettings(env)
      return json({
        ok: true,
        open: s.applications_open === '1',
        texts: {
          title: s['text.apply_title'],
          intro: s['text.apply_intro'],
          paused: s['text.apply_paused'],
          success: s['text.apply_success'],
          announcement: s['text.announcement'],
        },
        turnstileSiteKey: env.TURNSTILE_SITEKEY || null,
        appUrl: env.APP_URL || null,
      })
    }

    if (path === '/api/public/ref' && req.method === 'GET') {
      const t = url.searchParams.get('t') || ''
      if (!/^[A-Za-z0-9_-]{16,64}$/.test(t)) return json({ ok: true, valid: false })
      const l = await env.DB.prepare(`SELECT status FROM referral_links WHERE token = ?`)
        .bind(t)
        .first<{ status: string }>()
      return json({ ok: true, valid: l?.status === 'active' })
    }

    if (path === '/api/public/otp' && req.method === 'POST') {
      const b = await readJson(req)
      if (!b) return fail(400, 'bad_request')
      const email = normEmail(b.email)
      const purpose = String(b.purpose || '')
      if (!email) return fail(400, 'bad_email', '邮箱格式不正确')
      if (!['apply', 'status', 'invite', 'restore'].includes(purpose)) return fail(400, 'bad_request')
      const tsWhy = await turnstileProblem(env, b.turnstile, req, doFetch)
      if (tsWhy)
        return json(
          {
            ok: false,
            error: 'turnstile',
            reason: '人机验证未通过，请重试',
            ...(env.PLATFORM_STAGE === 'staging' ? { detail: tsWhy } : {}),
          },
          400,
        )
      // never claim a code was sent when no mail provider is connected (unit tests read codes from the outbox)
      if (!mailConfigured(env) && env.PLATFORM_STAGE !== 'test')
        return fail(503, 'mail_unavailable', '邮件服务暂未接通，验证码暂时无法发送。请稍后再试。')
      const ek = (await sha256hex('em:' + email)).slice(0, 24)
      if ((await overLimit(env, 'otp-ip:' + ipk, now, 60, 20)) || (await overLimit(env, 'otp-em:' + ek, now, 60, 5)))
        return fail(429, 'rate_limited', '验证码发送太频繁，请稍后再试')
      if (await overLimit(env, 'otp-em1:' + ek, now, 1, 1)) return fail(429, 'rate_limited', '请等 1 分钟后再发送')
      // the minute bucket above resets on the clock minute; also hold a true 60 s gap since the last code
      const lastOtp = await env.DB.prepare(
        `SELECT MAX(created_at) m FROM email_otps WHERE email = ? AND purpose <> 'close'`,
      )
        .bind(email)
        .first<{ m: number | null }>()
      if (lastOtp?.m && now - lastOtp.m < 60_000) return fail(429, 'rate_limited', '请等 1 分钟后再发送')
      const code = otpCode()
      const id = rid('otp')
      const hash = await hmac(env, `otp:${id}:${email}:${code}`)
      // only the newest code is valid: retire earlier unused ones for this address
      await env.DB.prepare(
        `UPDATE email_otps SET used_at = ? WHERE email = ? AND used_at IS NULL AND purpose <> 'close'`,
      )
        .bind(now, email)
        .run()
      await env.DB.prepare(
        'INSERT INTO email_otps (id, email, purpose, code_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
        .bind(id, email, purpose, hash, now, now + OTP_TTL)
        .run()
      await enqueueMail(env, email, 'otp', { code, purpose }, 'otp:' + id, now)
      if (env.PLATFORM_STAGE !== 'test' || mailConfigured(env)) {
        // the code is handed to the provider before we answer: "sent" means the provider accepted it
        const d = await drainOutbox(env, now, { fetchImpl: doFetch, dedupeKey: 'otp:' + id })
        if (!d.sent) {
          await env.DB.prepare('UPDATE email_otps SET used_at = ? WHERE id = ?').bind(now, id).run()
          await env.DB.prepare(
            `UPDATE mail_outbox SET status = 'dead', params = CASE WHEN template = 'otp' THEN '{"scrubbed":true}' ELSE params END, last_error = COALESCE(last_error, 'not_sent') WHERE dedupe_key = ? AND status <> 'sent'`,
          )
            .bind('otp:' + id)
            .run()
          if (d.deferred) return fail(503, 'mail_quota', '今天的邮件发送额度已用完，请明天再试。')
          if (d.dropped) return fail(400, 'reserved_email', '这个邮箱地址无法接收邮件')
          return fail(503, 'mail_failed', '验证码发送失败，请稍后再试。')
        }
      }
      // same answer whether or not the address is known
      return json({ ok: true, sent: true, ttlSec: OTP_TTL / 1000 })
    }

    if (path === '/api/public/verify' && req.method === 'POST') {
      const b = await readJson(req)
      if (!b) return fail(400, 'bad_request')
      const email = normEmail(b.email)
      const code = typeof b.code === 'string' ? b.code.trim() : ''
      if (!email || !/^\d{6}$/.test(code)) return fail(400, 'bad_code', '验证码不正确')
      const ek = (await sha256hex('em:' + email)).slice(0, 24)
      if (await overLimit(env, 'verify:' + ek, now, 10, 10))
        return fail(429, 'rate_limited', '尝试次数太多，请稍后再试')
      const rows = await env.DB.prepare(
        `SELECT id, code_hash, attempts FROM email_otps WHERE email = ? AND purpose <> 'close' AND used_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 3`,
      )
        .bind(email, now)
        .all<{ id: string; code_hash: string; attempts: number }>()
      for (const r of rows.results) {
        if (r.attempts >= 5) continue
        const want = await hmac(env, `otp:${r.id}:${email}:${code}`)
        if (timingSafeEq(want, r.code_hash)) {
          const u = await env.DB.prepare('UPDATE email_otps SET used_at = ? WHERE id = ? AND used_at IS NULL')
            .bind(now, r.id)
            .run()
          if (!u.meta?.changes) break
          const s = await makeSession(env, email, now)
          return json({ ok: true, email }, 200, { 'Set-Cookie': cookieHeader(s, SESSION_TTL / 1000) })
        }
      }
      for (const r of rows.results)
        await env.DB.prepare('UPDATE email_otps SET attempts = attempts + 1 WHERE id = ?').bind(r.id).run()
      return fail(400, 'bad_code', '验证码不正确或已过期')
    }

    if (path === '/api/public/logout' && req.method === 'POST')
      return json({ ok: true }, 200, { 'Set-Cookie': cookieHeader('', 0) })

    // ---- everything below needs a verified e-mail ----
    const email = await readSession(env, req, now)
    if (!email) return fail(401, 'not_verified', '请先验证邮箱')

    if (path === '/api/public/me' && req.method === 'GET')
      return json({ ok: true, ...(await statusOf(env, email, now)) })

    if (path === '/api/public/apply' && req.method === 'POST') {
      const b = await readJson(req)
      if (!b) return fail(400, 'bad_request')
      const s = await getSettings(env)
      if (s.applications_open !== '1') return fail(409, 'paused', s['text.apply_paused'])
      const note = cleanText(b.note, 500)
      const m = await getMember(env, email)
      if (m && m.status === 'active') return fail(409, 'already_member', '这个邮箱已经可以登录学习站')
      if (m && m.status === 'closing') return fail(409, 'closing', '这个账号正在注销冷静期，可以先撤销注销')
      if (m && m.status === 'revoked') return fail(409, 'revoked', '这个账号的访问已被停用，请联系管理员')
      const last = await env.DB.prepare(
        `SELECT status, decided_at FROM applications WHERE email = ? ORDER BY created_at DESC LIMIT 1`,
      )
        .bind(email)
        .first<{ status: string; decided_at: number | null }>()
      if (last?.status === 'pending') return fail(409, 'pending_exists', '你已有一份待审核的申请')
      if (last?.status === 'rejected' && last.decided_at && now < last.decided_at + REAPPLY_COOLDOWN)
        return fail(409, 'cooldown', '申请未通过后需要等 7 天才能再次申请', {
          reapplyAt: last.decided_at + REAPPLY_COOLDOWN,
        })
      // referral (optional)
      let link: { id: string; owner_email: string } | null = null
      const refT = typeof b.ref === 'string' ? b.ref : ''
      if (refT) {
        if (!/^[A-Za-z0-9_-]{16,64}$/.test(refT)) return fail(400, 'bad_ref', '推荐链接无效')
        link = await env.DB.prepare(`SELECT id, owner_email FROM referral_links WHERE token = ? AND status = 'active'`)
          .bind(refT)
          .first()
        if (!link) return fail(409, 'bad_ref', '推荐链接已失效，可以去掉推荐继续申请')
        if (b.consent !== true) return fail(400, 'consent', '使用推荐链接需要同意向推荐人展示脱敏信息')
        if (link.owner_email === email || canonicalEmail(link.owner_email) === canonicalEmail(email))
          return fail(409, 'self_ref', '不能使用自己的推荐链接')
        const owner = await getMember(env, link.owner_email)
        if (!owner || owner.status !== 'active') return fail(409, 'bad_ref', '推荐链接已失效，可以去掉推荐继续申请')
      }
      const id = rid('app')
      try {
        await env.DB.prepare(
          `INSERT INTO applications (id, email, note, status, referral_link_id, created_at) VALUES (?, ?, ?, 'pending', ?, ?)`,
        )
          .bind(id, email, note, link?.id ?? null, now)
          .run()
      } catch (e) {
        if (/UNIQUE/.test(String((e as Error).message))) return fail(409, 'pending_exists', '你已有一份待审核的申请')
        throw e
      }
      if (link) {
        const prior = await env.DB.prepare('SELECT 1 AS x FROM referrals WHERE referee_email = ?').bind(email).first()
        if (!prior) {
          const flags = await referralFlags(env, now, link.id, link.owner_email)
          await env.DB.prepare(
            `INSERT OR IGNORE INTO referrals (id, referee_email, referrer_email, link_id, application_id, status, flags, created_at) VALUES (?, ?, ?, ?, ?, 'applied', ?, ?)`,
          )
            .bind(rid('ref'), email, link.owner_email, link.id, id, flags.length ? JSON.stringify(flags) : null, now)
            .run()
        }
      }
      await enqueueMail(env, email, 'apply_received', { at: now }, 'apply_received:' + id, now)
      await notice(env, now, {
        audience: 'reviewer',
        kind: 'application',
        title: '新的加入申请',
        body: maskEmail(email),
        ref: 'app:' + id,
        dedupe: 'app:' + id,
      })
      await audit(env, now, 'public', 'public', 'application.submit', id, { referral: !!link })
      bg(drainOutbox(env, now, { limit: 5, fetchImpl: doFetch }))
      return json({ ok: true, id, ...(await statusOf(env, email, now)) })
    }

    if (path === '/api/public/invite/accept' && req.method === 'POST') {
      const b = await readJson(req)
      const t = typeof b?.token === 'string' ? b.token : ''
      if (!/^[A-Za-z0-9_-]{20,64}$/.test(t)) return fail(400, 'bad_invite', '邀请链接无效')
      const th = await sha256hex('inv:' + t)
      const inv = await env.DB.prepare('SELECT * FROM invites WHERE token_hash = ?').bind(th).first<{
        id: string
        email: string
        status: string
        expires_at: number
        version: number
      }>()
      // same message for "no such invite" and "invite for someone else"
      if (!inv || inv.email !== email) return fail(404, 'bad_invite', '邀请无效，或这封邀请不是发给当前验证的邮箱')
      if (inv.status === 'accepted') return json({ ok: true, already: true, ...(await statusOf(env, email, now)) })
      if (inv.status !== 'pending' || inv.expires_at <= now)
        return fail(410, 'invite_expired', '邀请已过期，请联系管理员重新发送')
      const r = await env.DB.prepare(
        `UPDATE invites SET status = 'accepted', accepted_at = ?, version = version + 1 WHERE id = ? AND status = 'pending' AND version = ? AND expires_at > ?`,
      )
        .bind(now, inv.id, inv.version, now)
        .run()
      if (!r.meta?.changes) return json({ ok: true, already: true, ...(await statusOf(env, email, now)) })
      await admitMember(env, now, email, 'invite', 'public')
      // a pending application for the same e-mail is settled by the invite
      const app = await env.DB.prepare(`SELECT id FROM applications WHERE email = ? AND status = 'pending'`)
        .bind(email)
        .first<{ id: string }>()
      if (app) {
        await env.DB.prepare(
          `UPDATE applications SET status = 'approved', decided_at = ?, decided_by = 'invite', version = version + 1 WHERE id = ? AND status = 'pending'`,
        )
          .bind(now, app.id)
          .run()
        await env.DB.prepare(`UPDATE referrals SET status = 'approved' WHERE application_id = ? AND status = 'applied'`)
          .bind(app.id)
          .run()
        await handleNotices(env, now, 'app:' + app.id, 'invite')
      }
      await handleNotices(env, now, 'inv:' + inv.id, 'public')
      await enqueueMail(env, email, 'account_ready', {}, 'account_ready:' + email + ':' + inv.id, now)
      await audit(env, now, 'public', 'public', 'invite.accept', inv.id)
      bg(syncAccess(env, now, { fetchImpl: doFetch }))
      bg(drainOutbox(env, now, { limit: 5, fetchImpl: doFetch }))
      return json({ ok: true, ...(await statusOf(env, email, now)) })
    }

    if (path === '/api/public/restore' && req.method === 'POST') {
      const m = await getMember(env, email)
      if (!m || m.status !== 'closing' || m.delete_reason !== 'self_close')
        return fail(409, 'not_closing', '这个账号不在注销冷静期内')
      if (!m.delete_after || m.delete_after <= now) return fail(410, 'too_late', '冷静期已结束')
      const ok = await setStatus(env, now, email, 'active', null)
      if (!ok) return fail(409, 'not_closing', '状态已变化，请刷新')
      await audit(env, now, 'public', 'public', 'member.close_cancelled', maskEmail(email))
      await enqueueMail(env, email, 'close_cancelled', {}, `close_cancelled:${email}:${now}`, now)
      bg(drainOutbox(env, now, { limit: 5, fetchImpl: doFetch }))
      await handleNotices(env, now, 'member:' + email, 'public')
      bg(syncAccess(env, now, { fetchImpl: doFetch }))
      return json({ ok: true, ...(await statusOf(env, email, now)) })
    }

    return fail(404, 'not_found')
  } catch (e) {
    void e
    return fail(503, 'server_error', '服务暂时不可用，请稍后再试')
  }
}

export async function statusOf(env: PlatformEnv, email: string, now: number) {
  const m = await getMember(env, email)
  const apps = await env.DB.prepare(
    `SELECT id, status, created_at, decided_at, reject_public FROM applications WHERE email = ? ORDER BY created_at DESC LIMIT 5`,
  )
    .bind(email)
    .all<{ id: string; status: string; created_at: number; decided_at: number | null; reject_public: string | null }>()
  const last = apps.results[0]
  const s = await getSettings(env)
  const cooldownUntil = last?.status === 'rejected' && last.decided_at ? last.decided_at + REAPPLY_COOLDOWN : null
  return {
    email,
    member: m
      ? {
          status: m.status,
          canLogin: m.status === 'active' && m.access_state === 'ok',
          accessPending: m.status === 'active' && m.access_state !== 'ok',
          deleteAfter: m.status === 'closing' ? m.delete_after : null,
          canRestore: m.status === 'closing' && m.delete_reason === 'self_close' && (m.delete_after ?? 0) > now,
        }
      : null,
    applications: apps.results.map((a) => ({
      status: a.status,
      createdAt: a.created_at,
      decidedAt: a.decided_at,
      publicNote: a.reject_public,
    })),
    canApply:
      s.applications_open === '1' &&
      (!m || m.status === 'deleted') &&
      last?.status !== 'pending' &&
      !(cooldownUntil && now < cooldownUntil),
    reapplyAt: cooldownUntil && now < cooldownUntil ? cooldownUntil : null,
    open: s.applications_open === '1',
  }
}

// referral grant helper is re-exported for tests
export { addGrant, DAY }
