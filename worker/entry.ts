/**
 * exampilot-class Worker: the built web app (inlined) + the sync API.
 *
 * Cloudflare Access sits in front of the whole hostname: every request that
 * reaches this code already passed Access. The API additionally verifies the
 * Access token itself (worker/auth.ts) — it never trusts the edge implicitly.
 */
import { handleApi } from './api'
import { handleAi, aiAllowed, type AiEnv } from './ai'
import { handleMedia, mediaSweep, type MediaEnv } from './media'
import { handlePlatform, runCron, type ProtectedEnv } from './platform/http'
import { verifyAccessJwt, type AuthConfig } from './auth'
import { memberStanding } from './platform/core'
import type { PlatformEnv } from './platform/util'
// Generated at deploy time from dist-web/ by tools/web/deploy-web.mjs --embed.
import { FILES } from './assets.generated.js'

const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  svg: 'image/svg+xml',
  json: 'application/json; charset=utf-8',
}
const SEC0 = {
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Cache-Control': 'private, no-store',
}

/**
 * D-06: security headers for every response; the HTML document also gets a CSP.
 * index.html carries two tiny inline scripts (theme bootstrap, serif URL): they are
 * allowed by their SHA-256 hash, computed once per isolate from the embedded
 * file, so no 'unsafe-inline' is needed for scripts.
 */
const HARDEN = {
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=(), payment=(), usb=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
}
const SEC = { ...SEC0, ...HARDEN }
let cspPromise: Promise<string> | null = null
async function sha256b64(text: string) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return btoa(String.fromCharCode(...new Uint8Array(d)))
}
export function buildCsp(html: string): Promise<string> {
  const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1])
  return Promise.all(inline.map(sha256b64)).then((hashes) =>
    [
      "default-src 'self'",
      `script-src 'self' ${hashes.map((h) => `'sha256-${h}'`).join(' ')}`.trim(),
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "manifest-src 'self'",
      "worker-src 'self'",
    ].join('; '),
  )
}

/**
 * Read-only build identity (as of v4: the deployed version could not be told
 * apart from the client). Behind Access like every path. Carries only the
 * Cloudflare version id/tag, the git commit and the build time — no config.
 */
type VersionEnv = { CF_VERSION?: { id?: string; tag?: string }; BUILD_COMMIT?: string; BUILD_TIME?: string }
export function versionResponse(env: VersionEnv): Response {
  const body = {
    ok: true,
    version: env.CF_VERSION?.id ?? null,
    tag: env.CF_VERSION?.tag || null,
    commit: env.BUILD_COMMIT ?? null,
    builtAt:
      env.BUILD_TIME && /^\d+$/.test(env.BUILD_TIME)
        ? new Date(Number(env.BUILD_TIME)).toISOString()
        : (env.BUILD_TIME ?? null),
  }
  return new Response(JSON.stringify(body), {
    headers: { ...SEC, 'Content-Type': 'application/json; charset=utf-8' },
  })
}

/**
 * Static files (the question bank bundle) and /api/version: Access token for THIS app (team + aud)
 * AND the member's CURRENT standing in D1, checked on every request (2026-10-26).
 * An Access session outlives a revocation (up to its 24h lifetime), so the token alone is never enough.
 * Same rule as the API gate (platform/core.ts gate): only an active member whose learning account is
 * active may read; revoked, closing (deletion cool-down) and deleted members are refused. A valid
 * token with no member row (hand-added to Access, never logged in) is allowed exactly like the API
 * gate does, unless that address was deleted (deletion_log). Any lookup failure fails CLOSED.
 */
export type StaticVerdict = { ok: true; email: string } | { ok: false; status: 401 | 403 | 503; code: string }
export async function staticGate(
  req: Request,
  env: { ACCESS_TEAM_DOMAIN?: string; ACCESS_AUD?: string; DB?: unknown },
  extra: Partial<AuthConfig> = {},
): Promise<StaticVerdict> {
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return { ok: false, status: 503, code: 'AUTH_UNCONFIGURED' }
  let email: string
  try {
    email = (
      await verifyAccessJwt(req.headers.get('Cf-Access-Jwt-Assertion'), {
        teamDomain: env.ACCESS_TEAM_DOMAIN,
        aud: env.ACCESS_AUD,
        ...extra,
      })
    ).email
  } catch {
    return { ok: false, status: 401, code: 'SESSION' }
  }
  try {
    const v = await memberStanding(env as unknown as PlatformEnv, email)
    return v === 'ok' ? { ok: true, email } : { ok: false, status: 403, code: v }
  } catch {
    return { ok: false, status: 503, code: 'DB' }
  }
}
const DENY_TEXT: Record<string, string> = {
  SESSION: '登录已失效，请刷新页面重新登录。',
  ACCOUNT_REVOKED: '账号访问已停用。如有疑问请联系管理员。',
  ACCOUNT_CLOSING: '账号正在注销冷静期，已停用。可在欢迎页撤销注销。',
  ACCOUNT_DELETED: '账号已注销。',
  DB: '服务暂时不可用，请稍后再试。',
  AUTH_UNCONFIGURED: '服务暂时不可用，请稍后再试。',
}
const safeUrl = (u: unknown) =>
  typeof u === 'string' && /^https:\/\/[a-z0-9.-]+(\/[A-Za-z0-9/_-]*)?$/.test(u) ? u.replace(/\/$/, '') : ''
const DENIED = (v: Extract<StaticVerdict, { ok: false }>, html: boolean, welcome?: unknown) => {
  const w = safeUrl(welcome)
  const next = !w
    ? ''
    : v.code === 'ACCOUNT_CLOSING'
      ? `<p><a href="${w}/account">撤销注销</a></p>`
      : v.code === 'SESSION'
        ? `<p><a href="/">重新登录</a></p>`
        : `<p>还没有受邀或账号已停用？<a href="${w}/apply">申请加入</a> · <a href="${w}/status">查询申请状态</a></p>`
  return new Response(
    html
      ? `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ExamPilot</title><body style="font:16px/1.6 system-ui,sans-serif;max-width:32em;margin:15vh auto;padding:0 1em;color:#333"><h1 style="font-size:20px">无法访问</h1><p>${DENY_TEXT[v.code] || '无法访问。'}</p>${next}`
      : JSON.stringify({ ok: false, error: 'unauthenticated', code: v.code, reason: DENY_TEXT[v.code] || '' }),
    {
      status: v.status,
      headers: { ...SEC, 'Content-Type': html ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8' },
    },
  )
}

/** weak per-isolate ETag cache: hashed assets revalidate through the gate (no-cache) and get a cheap 304 */
const etags = new Map<string, string>()
async function etagOf(p: string, body: string) {
  let e = etags.get(p)
  if (!e) {
    const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body))
    e = '"' + [...new Uint8Array(d).slice(0, 12)].map((b) => b.toString(16).padStart(2, '0')).join('') + '"'
    etags.set(p, e)
  }
  return e
}

function withSec(r: Response): Response {
  const h = new Headers(r.headers)
  for (const [k, v] of Object.entries(SEC)) if (!h.has(k)) h.set(k, v)
  return new Response(r.body, { status: r.status, headers: h })
}

let lastSweep = 0
export default {
  async scheduled(_ev: unknown, env: AiEnv, ctx: { waitUntil(p: Promise<unknown>): void }) {
    ctx.waitUntil(runCron(env as unknown as ProtectedEnv, Date.now()))
  },
  async fetch(req: Request, env: AiEnv, ctx?: { waitUntil(p: Promise<unknown>): void }): Promise<Response> {
    const url = new URL(req.url)
    if (url.pathname.startsWith('/api/')) {
      if (url.pathname === '/api/version' && req.method === 'GET') {
        const v = await staticGate(req, env as never)
        return v.ok ? versionResponse(env as unknown as VersionEnv) : DENIED(v, false)
      }
      if (url.pathname.startsWith('/api/sync/')) return handleApi(req, env)
      if (url.pathname.startsWith('/api/me/') || url.pathname.startsWith('/api/admin/')) {
        const r = await handlePlatform(req, env as unknown as ProtectedEnv, {
          waitUntil: ctx ? (p) => ctx.waitUntil(p) : undefined,
        })
        if (r) return withSec(r)
      }
      if (url.pathname.startsWith('/api/ai/images')) {
        const r = await handleMedia(req, env as unknown as ProtectedEnv & MediaEnv, {
          aiAllowed: (acc, now) => aiAllowed(env as never, acc, now),
        })
        if (r) {
          if (req.method === 'POST' && ctx && Date.now() - lastSweep > 30 * 60_000) {
            lastSweep = Date.now()
            ctx.waitUntil(mediaSweep(env as never, Date.now()).catch(() => {}))
          }
          return r
        }
      }
      if (url.pathname.startsWith('/api/ai/') || url.pathname.startsWith('/api/admin/'))
        return handleAi(req, env, { waitUntil: ctx ? (p) => ctx.waitUntil(p) : undefined })
      return new Response('Not Found', { status: 404, headers: SEC })
    }
    if (req.method !== 'GET' && req.method !== 'HEAD')
      return new Response('Method Not Allowed', { status: 405, headers: SEC })
    const v = await staticGate(req, env as never)
    if (!v.ok)
      return DENIED(
        v,
        !(url.pathname.startsWith('/assets/') || /\.[a-z0-9]+$/i.test(url.pathname)) || url.pathname.endsWith('.html'),
        (env as { WELCOME_URL?: string }).WELCOME_URL,
      )
    let p = url.pathname
    if (p === '/') p = '/index.html'
    let body = (FILES as Record<string, string>)[p]
    if (body === undefined) {
      if (p.startsWith('/assets/') || p.includes('.')) return new Response('Not Found', { status: 404, headers: SEC })
      p = '/index.html'
      body = (FILES as Record<string, string>)[p]
    }
    // Content-hashed build assets never change under the same name: let the browser
    // keep them (still `private`: everything here sits behind Access).
    // Every load must pass the gate again: no long-lived browser cache. Hashed assets carry an ETag,
    // so a revalidation that passes the gate costs a 304, and one that fails it gets the 403.
    const tag = await etagOf(p, body)
    const cache = { 'Cache-Control': 'private, no-cache', ETag: tag, Vary: 'Cookie' }
    if (req.headers.get('If-None-Match') === tag)
      return new Response(null, { status: 304, headers: { ...SEC, ...cache } })
    const ext = p.split('.').pop() || ''
    const csp: Record<string, string> = {}
    if (ext === 'html') {
      cspPromise ??= buildCsp((FILES as Record<string, string>)['/index.html'] || '')
      csp['Content-Security-Policy'] = await cspPromise
    }
    return new Response(req.method === 'HEAD' ? null : body, {
      headers: { ...SEC, ...cache, ...csp, 'Content-Type': TYPES[ext] || 'application/octet-stream' },
    })
  },
}
