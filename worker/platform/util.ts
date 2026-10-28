/** Small shared helpers for the platform modules (no I/O except crypto). */
import type { D1Database } from '../api'

export interface PlatformEnv {
  DB: D1Database
  /** comma-separated e-mails that are always super admins and can never be demoted/revoked */
  SUPER_OWNERS?: string
  /** pepper for OTP / token hashes (Worker Secret) */
  PLATFORM_SECRET?: string
  MAIL_PROVIDER?: string // 'brevo' | 'outbox'
  BREVO_API_KEY?: string
  MAIL_FROM?: string
  MAIL_FROM_NAME?: string
  /** ms epoch; mail created before it is never sent (set when real sending is switched on) */
  MAIL_SEND_AFTER?: string
  MAIL_DAILY_CAP?: string
  /** comma-separated exact recipients allowed to receive real mail (required on staging) */
  MAIL_ALLOWLIST?: string
  CF_ACCESS_TOKEN?: string
  ACCESS_ACCOUNT_ID?: string
  ACCESS_POLICY_ID?: string
  ACCESS_APP_ID?: string
  /** AI chat image store (its own free D1); absent = images are not kept */
  MEDIA_DB?: D1Database
  /** '1' = after removing someone from the allow-list also end their Access sessions (organization-wide!) */
  ACCESS_REVOKE_SESSIONS?: string
  TURNSTILE_SECRET?: string
  TURNSTILE_SITEKEY?: string
  /** when set, siteverify must report this hostname (real keys only) */
  TURNSTILE_HOSTNAME?: string
  WELCOME_URL?: string
  APP_URL?: string
  /** 'staging' | 'production' — destructive test helpers only exist on staging */
  PLATFORM_STAGE?: string
  /** separate D1 holding the deletion ledger (survives a Time Travel restore of DB) */
  DELETIONS_DB?: D1Database
}

export const DAY = 86_400_000
export const HOUR = 3_600_000

export function normEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const e = raw.trim().toLowerCase()
  if (e.length < 3 || e.length > 254) return null
  // conservative: one @, non-empty local/domain, domain has a dot, no spaces/control/quotes/angle brackets
  if (!/^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(e)) return null
  if (e.includes('..')) return null
  return e
}

export function rid(prefix: string, bytes = 12): string {
  const b = new Uint8Array(bytes)
  crypto.getRandomValues(b)
  return prefix + '_' + [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
}

export function token(bytes = 24): string {
  const b = new Uint8Array(bytes)
  crypto.getRandomValues(b)
  return btoa(String.fromCharCode(...b))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

export function otpCode(): string {
  const b = new Uint32Array(1)
  // rejection sampling for a uniform 6-digit code
  for (;;) {
    crypto.getRandomValues(b)
    if (b[0] < 4_294_000_000) return String(b[0] % 1_000_000).padStart(6, '0')
  }
}

export async function sha256hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('')
}

export function pepper(env: PlatformEnv): string {
  return env.PLATFORM_SECRET || 'exampilot-dev-pepper'
}

export async function hmac(env: PlatformEnv, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(pepper(env)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg))
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

export function timingSafeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let x = 0
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return x === 0
}

export function maskEmail(e: string): string {
  const [l, d] = e.split('@')
  if (!d) return '***'
  const lm = l.length <= 2 ? l[0] + '*' : l[0] + '*'.repeat(Math.min(6, l.length - 2)) + l[l.length - 1]
  const parts = d.split('.')
  const dm = parts[0].length <= 2 ? parts[0] : parts[0][0] + '*'.repeat(Math.min(4, parts[0].length - 1))
  return `${lm}@${[dm, ...parts.slice(1)].join('.')}`
}

/** Isolated lifecycle-lab accounts (staging only). Never mailed, never put in Access. */
export const LAB_DOMAIN = 'lab.exampilot.invalid'
export function isLabEmail(e: string | null | undefined) {
  return !!e && e.toLowerCase().endsWith('@' + LAB_DOMAIN)
}
/** Reserved / test domains (RFC 2606/6761) — mail to them is never handed to a provider. */
export function isReservedEmail(e: string | null | undefined) {
  if (!e) return false
  const d = e.toLowerCase().split('@')[1] || ''
  return /(^|\.)(invalid|test|example|localhost)$/.test(d) || /(^|\.)example\.(com|net|org)$/.test(d)
}

/**
 * Addresses that must never reach a mail provider, or an Access policy, even when
 * the product accepts them at the API layer.
 *
 * `isReservedEmail` answers a different question — "may an invitation be issued
 * for this address at all" — and test fixtures deliberately use an accepted but
 * unroutable namespace so the invitation flow can be exercised end to end. This
 * predicate is the second half of that arrangement: the address is accepted, and
 * then it can never leave the system.
 */
export function isUndeliverable(e: string | null | undefined) {
  if (!e) return false
  if (isReservedEmail(e)) return true
  const d = e.toLowerCase().split('@')[1] || ''
  // example.edu and friends: accepted by the invite flow, resolved by nobody.
  return /(^|\.)example\.[a-z]{2,}$/.test(d)
}

export function superOwners(env: PlatformEnv): Set<string> {
  return new Set(
    String(env.SUPER_OWNERS || '')
      .split(',')
      .map((x) => normEmail(x))
      .filter((x): x is string => !!x),
  )
}

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
}
export function json(body: unknown, status = 200, extra?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers: extra ? { ...JSON_HEADERS, ...extra } : JSON_HEADERS })
}
export function fail(status: number, error: string, reason?: string, extra?: Record<string, unknown>): Response {
  return json({ ok: false, error, ...(reason ? { reason } : {}), ...(extra || {}) }, status)
}

/** Clip and strip control characters from free text. */
export function cleanText(v: unknown, max: number): string | null {
  if (v === undefined || v === null) return null
  if (typeof v !== 'string') return null
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim()
  if (!s) return null
  return s.slice(0, max)
}

export async function readJson(req: Request, maxBytes = 32_000): Promise<Record<string, unknown> | null> {
  const len = Number(req.headers.get('Content-Length') || '0')
  if (len > maxBytes) return null
  const t = await req.text()
  if (t.length > maxBytes) return null
  try {
    const v = JSON.parse(t)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

/** CSV cell that cannot be interpreted as a spreadsheet formula. */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v)
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function chunks<T>(xs: T[], n: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n))
  return out
}
