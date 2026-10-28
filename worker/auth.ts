/**
 * Cloudflare Access JWT verification (RS256, WebCrypto).
 *
 * Follows https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/ :
 *  - token from the `Cf-Access-Jwt-Assertion` header (set by Access on every
 *    request it lets through); the cookie is not used as the source of identity
 *  - signature checked against the team's JWKS, key chosen by `kid`
 *  - `iss` must equal the team domain, `aud` must contain this app's AUD tag,
 *    `exp` / `nbf` enforced with a small clock skew
 *  - JWKS cached in the isolate; an unknown `kid` triggers one refetch
 *    (rate-limited), which is how key rotation is picked up
 */

export interface AccessIdentity {
  email: string
  sub: string
  iat: number
  exp: number
}

export interface AuthConfig {
  teamDomain: string // https://<team>.cloudflareaccess.com
  aud: string
  /** injectable for tests; production uses global fetch */
  fetchJwks?: () => Promise<{ keys: JsonWebKey[] }>
  now?: () => number
}

type Jwk = JsonWebKey & { kid?: string; alg?: string }

interface KeyCache {
  at: number
  keys: Map<string, CryptoKey>
}
const caches = new Map<string, KeyCache>()
let lastForcedRefetch = 0

const SKEW_S = 60

function b64urlToBytes(s: string): Uint8Array {
  const pad = s.length % 4 === 2 ? '==' : s.length % 4 === 3 ? '=' : s.length % 4 === 1 ? null : ''
  if (pad === null) throw new Error('bad base64url')
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function decodeJson(part: string): Record<string, unknown> {
  const v = JSON.parse(new TextDecoder().decode(b64urlToBytes(part)))
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('bad json part')
  return v as Record<string, unknown>
}

async function loadKeys(cfg: AuthConfig, force: boolean): Promise<Map<string, CryptoKey>> {
  const cacheKey = cfg.teamDomain
  const now = Date.now()
  const c = caches.get(cacheKey)
  if (c && !force && now - c.at < 3600_000) return c.keys
  const doFetch =
    cfg.fetchJwks ??
    (async () => {
      const r = await fetch(`${cfg.teamDomain}/cdn-cgi/access/certs`, { cf: { cacheTtl: 300 } } as RequestInit)
      if (!r.ok) throw new Error('jwks fetch failed ' + r.status)
      return (await r.json()) as { keys: JsonWebKey[] }
    })
  const set = await doFetch()
  const keys = new Map<string, CryptoKey>()
  for (const k of (set.keys ?? []) as Jwk[]) {
    if (!k.kid || k.kty !== 'RSA') continue
    try {
      const key = await crypto.subtle.importKey(
        'jwk',
        { kty: 'RSA', n: k.n, e: k.e, alg: 'RS256', ext: true },
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['verify'],
      )
      keys.set(k.kid, key)
    } catch {
      /* skip malformed key */
    }
  }
  if (keys.size === 0) throw new Error('jwks empty')
  caches.set(cacheKey, { at: now, keys })
  return keys
}

export class AuthError extends Error {}

/** Verify an Access application token. Throws AuthError on any failure. */
export async function verifyAccessJwt(token: string | null, cfg: AuthConfig): Promise<AccessIdentity> {
  if (!token) throw new AuthError('missing token')
  if (token.length > 8192) throw new AuthError('token too long')
  const parts = token.split('.')
  if (parts.length !== 3) throw new AuthError('malformed token')
  let header: Record<string, unknown>, payload: Record<string, unknown>
  try {
    header = decodeJson(parts[0])
    payload = decodeJson(parts[1])
  } catch {
    throw new AuthError('malformed token')
  }
  if (header.alg !== 'RS256') throw new AuthError('unexpected alg')
  const kid = typeof header.kid === 'string' ? header.kid : ''
  if (!kid) throw new AuthError('missing kid')

  let keys = await loadKeys(cfg, false)
  let key = keys.get(kid)
  if (!key && Date.now() - lastForcedRefetch > 30_000) {
    lastForcedRefetch = Date.now()
    keys = await loadKeys(cfg, true)
    key = keys.get(kid)
  }
  if (!key) throw new AuthError('unknown kid')

  let sig: Uint8Array
  try {
    sig = b64urlToBytes(parts[2])
  } catch {
    throw new AuthError('malformed signature')
  }
  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    sig as BufferSource,
    new TextEncoder().encode(parts[0] + '.' + parts[1]),
  )
  if (!ok) throw new AuthError('bad signature')

  const now = Math.floor((cfg.now ? cfg.now() : Date.now()) / 1000)
  if (payload.iss !== cfg.teamDomain) throw new AuthError('bad issuer')
  const aud = payload.aud
  const audOk = Array.isArray(aud) ? aud.includes(cfg.aud) : aud === cfg.aud
  if (!audOk) throw new AuthError('bad audience')
  if (typeof payload.exp !== 'number' || payload.exp + SKEW_S < now) throw new AuthError('expired')
  if (typeof payload.nbf === 'number' && payload.nbf - SKEW_S > now) throw new AuthError('not yet valid')
  if (payload.type !== undefined && payload.type !== 'app') throw new AuthError('not an app token')
  const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : ''
  if (!email || !email.includes('@') || email.length > 254) throw new AuthError('no email')
  const sub = typeof payload.sub === 'string' ? payload.sub : ''
  return { email, sub, iat: Number(payload.iat ?? 0), exp: payload.exp }
}

/** test hook: forget cached keys */
export function _resetJwksCache() {
  caches.clear()
  lastForcedRefetch = 0
}
