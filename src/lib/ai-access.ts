/**
 * Who may see and use AI in this browser.
 *
 * Desktop edition: unchanged — AI is always available (the local proxy decides
 * whether a gateway is configured).
 *
 * Web edition: the server decides. Until GET /api/ai/status has answered
 * `allowed: true` for the signed-in account, every AI entry point stays hidden
 * and every AI call short-circuits without a network request. So an account
 * without permission never sees AI (not even for a frame), and a revoked
 * permission hides AI again as soon as the server says so.
 */
import { useSyncExternalStore } from 'react'
import { AI_ENABLED, IS_WEB_EDITION, WEB_EDITION_MARKER } from './edition'

export interface AiAccess {
  /**
   * pending: not answered yet (treated as "no").
   * unknown: the server could not be asked (5xx / timeout / offline / session) and this
   *          browser holds no earlier confirmation for this account — AI stays hidden,
   *          a recoverable notice with a retry is shown (never assumed granted).
   */
  state: 'pending' | 'granted' | 'denied' | 'unknown'
  /** may manage other accounts' AI permission (independent of `state`) */
  admin: boolean
  /** a gateway is configured on the server */
  configured: boolean
  model: string
  /**
   * N01-8: why the last status check could not be answered. null = the last check was
   * a real answer. While set, `state` is what we knew before (or 'unknown').
   */
  issue?: AiIssue | null
  /** granted only from this browser's earlier confirmation for the same account (not yet re-verified) */
  cached?: boolean
  /** web platform: 'user' | 'reviewer' | 'super' (admin center access; never authorises anything) */
  role?: string
  /** web platform: Pro state for display (countdown, read-only AI history) */
  pro?: {
    tier: string
    permanent: boolean
    until: number | null
    remainingMs: number
    suspended: boolean
    paused: boolean
  } | null
  /** the account itself is stopped (revoked / closing): reason text from the server */
  blocked?: string | null
}
export type AiIssue = 'server' | 'timeout' | 'offline' | 'session'

let access: AiAccess = IS_WEB_EDITION
  ? { state: 'pending', admin: false, configured: false, model: '', issue: null, cached: false }
  : { state: AI_ENABLED ? 'granted' : 'denied', admin: false, configured: true, model: '', issue: null, cached: false }

const listeners = new Set<() => void>()
function set(next: AiAccess) {
  if (JSON.stringify(next) === JSON.stringify(access)) return
  access = next
  applyTier()
  for (const l of listeners) l()
}

/**
 * Visual identity, derived ONLY from the server's answer (web edition):
 *   pending  → neutral (Standard look, no AI, no Pro chrome) until /api/ai/status answers
 *   pro      → the server said allowed:true (an ai_grants row is enabled)
 *   standard → anything else, including errors and timeouts
 * It is a presentation hint; every AI call is still authorised by the Worker.
 * Admin is independent: an admin without a grant is Standard.
 */
export type Tier = 'pending' | 'standard' | 'pro'
export function tierOf(a: AiAccess): Tier {
  return a.state === 'granted' ? 'pro' : a.state === 'pending' ? 'pending' : 'standard'
}
function applyTier() {
  if (!IS_WEB_EDITION || typeof document === 'undefined') return
  const tier = tierOf(access)
  document.documentElement.dataset.tier = tier
  if (tier === 'pro') loadProSerif()
}

/** Pro typography (Noto Serif SC subset) — fetched only once the server confirmed Pro. */
function loadProSerif() {
  const href = (window as Window & { __EP_SERIF__?: string }).__EP_SERIF__
  if (!href || typeof document.head?.appendChild !== 'function' || document.getElementById('ep-serif')) return
  const l = document.createElement('link')
  l.id = 'ep-serif'
  l.rel = 'stylesheet'
  l.href = href
  document.head.appendChild(l)
}

export function getAiAccess(): AiAccess {
  return access
}
/** True only when AI may be shown and called right now. */
export function aiUsable(): boolean {
  return access.state === 'granted'
}

/**
 * The server refused an AI call with a definitive "no grant" (403 AI_FORBIDDEN):
 * hide AI immediately. A permission check that merely failed is never routed here.
 */
export function markAiForbidden() {
  if (!IS_WEB_EDITION) return
  clearCache()
  set({ ...access, state: 'denied', issue: null, cached: false })
}

/* ---- N01-8: last confirmed grant, per account, in this browser only ----
 * Used ONLY to keep an already-confirmed Pro account's look and AI entry points while
 * the status endpoint is temporarily unreachable. It never authorises anything: every
 * AI call is checked by the Worker, and a 403 AI_FORBIDDEN clears it at once. */
const CACHE_KEY = 'exampilot.aiAccess.v1'
const CACHE_MAX_AGE = 7 * 24 * 3600_000
interface Cached {
  acct: string
  admin: boolean
  configured: boolean
  model: string
  at: number
}
let account = ''
function readCache(): Cached | null {
  try {
    const c = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null') as Cached | null
    if (!c || typeof c.acct !== 'string' || typeof c.at !== 'number') return null
    if (Date.now() - c.at > CACHE_MAX_AGE || c.at > Date.now() + 60_000) return null
    return c
  } catch {
    return null
  }
}
function writeCache(a: AiAccess) {
  if (!account) return
  try {
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({ acct: account, admin: a.admin, configured: a.configured, model: a.model, at: Date.now() }),
    )
  } catch {
    /* storage full / blocked: nothing to keep */
  }
}
function clearCache() {
  try {
    localStorage.removeItem(CACHE_KEY)
  } catch {
    /* ignore */
  }
}

/**
 * The verified account id (from GET /api/sync/me, independent of /api/ai/status).
 * A cached confirmation is only ever used for this exact account.
 */
export function setAiAccount(id: string) {
  if (!IS_WEB_EDITION || !id) return
  account = id
  const c = readCache()
  if (c && c.acct !== id) clearCache()
  if (access.state === 'granted' && !access.cached && !access.issue) writeCache(access)
  else if (access.state === 'unknown') applyFailure(access.issue ?? 'server')
}

let lastFailure: AiIssue | null = null
function applyFailure(issue: AiIssue) {
  lastFailure = issue
  if (access.state === 'denied') return // a known "no" stays quiet; nothing of AI to keep
  if (access.state === 'granted') {
    // An answer we already had stays; only the notice changes, and we keep asking.
    set({ ...access, issue })
    scheduleRetry()
    return
  }
  // pending / unknown: only an earlier confirmation for this very account keeps Pro.
  const c = account ? readCache() : null
  if (c && c.acct === account)
    set({ state: 'granted', admin: c.admin, configured: c.configured, model: c.model, issue, cached: true })
  else set({ state: 'unknown', admin: false, configured: false, model: '', issue, cached: false })
  scheduleRetry()
}

let retryTimer: ReturnType<typeof setTimeout> | null = null
let retryN = 0
const RETRY_STEPS = [3000, 10_000, 30_000, 60_000]
function scheduleRetry() {
  if (retryTimer || typeof window === 'undefined') return
  const d = RETRY_STEPS[Math.min(retryN, RETRY_STEPS.length - 1)]
  retryN++
  retryTimer = setTimeout(() => {
    retryTimer = null
    void refreshAiAccess(true)
  }, d)
}
function stopRetry() {
  if (retryTimer) clearTimeout(retryTimer)
  retryTimer = null
  retryN = 0
}

let inflight: Promise<void> | null = null
let lastCheck = 0

/** Ask the server (web edition only). A failure is never read as "no permission". */
export function refreshAiAccess(force = false): Promise<void> {
  if (!IS_WEB_EDITION) return Promise.resolve()
  if (inflight) return inflight
  if (!force && !access.issue && Date.now() - lastCheck < 30_000) return Promise.resolve()
  lastCheck = Date.now()
  inflight = (async () => {
    let timedOut = false
    try {
      // Bounded: a hung request must not keep the app on its neutral boot screen.
      const ctrl = new AbortController()
      const timer = setTimeout(() => {
        timedOut = true
        ctrl.abort()
      }, 6000)
      const res = await fetch('/api/ai/status', {
        headers: { 'X-ExamPilot-Client': '1' },
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'manual',
        signal: ctrl.signal,
      }).finally(() => clearTimeout(timer))
      if (res.type === 'opaqueredirect' || res.status === 401 || (res.status >= 300 && res.status < 400)) {
        // Cloudflare Access session expired: not an answer about the grant.
        applyFailure('session')
        return
      }
      if (res.status === 403) {
        const b = (await res.json().catch(() => null)) as { code?: string; reason?: string } | null
        if (b && (b.code === 'ACCOUNT_REVOKED' || b.code === 'ACCOUNT_CLOSING')) {
          stopRetry()
          clearCache()
          set({
            state: 'denied',
            admin: false,
            configured: false,
            model: '',
            issue: null,
            cached: false,
            role: 'user',
            pro: null,
            blocked: b.reason || '账号已停用',
          })
          return
        }
      }
      const ct = res.headers.get('content-type') || ''
      const j = (res.ok && ct.includes('application/json') ? await res.json().catch(() => null) : null) as {
        ok?: boolean
        allowed?: boolean
        admin?: boolean
        configured?: boolean
        model?: string
        role?: string
        pro?: AiAccess['pro']
      } | null
      if (!j || j.ok !== true || typeof j.allowed !== 'boolean') {
        // 5xx, an HTML error page, 503 status_unavailable: the server could not answer.
        applyFailure('server')
        return
      }
      stopRetry()
      lastFailure = null
      const next: AiAccess = {
        state: j.allowed ? 'granted' : 'denied',
        admin: j.admin === true,
        configured: j.configured === true,
        model: typeof j.model === 'string' ? j.model : '',
        issue: null,
        cached: false,
        role: typeof j.role === 'string' ? j.role : 'user',
        pro: j.pro ?? null,
        blocked: null,
      }
      if (next.state === 'granted') writeCache(next)
      else clearCache() // an explicit "no" (revoked or never granted)
      set(next)
    } catch {
      const offline = typeof navigator !== 'undefined' && navigator.onLine === false
      applyFailure(timedOut ? 'timeout' : offline ? 'offline' : 'server')
    } finally {
      inflight = null
    }
  })()
  return inflight
}

/** Last failure kind, for diagnostics/tests. */
export function lastAiIssue(): AiIssue | null {
  return lastFailure
}

export function useAiAccess(): AiAccess {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    getAiAccess,
    getAiAccess,
  )
}

/** Hook form of `aiUsable()` for rendering decisions. */
export function useAiUsable(): boolean {
  return useAiAccess().state === 'granted'
}

if (IS_WEB_EDITION && typeof window !== 'undefined') {
  document.documentElement.dataset.edition = WEB_EDITION_MARKER
  applyTier()
  // Weak machines get the lite motion set (see theme.css §8).
  const nav = navigator as Navigator & { deviceMemory?: number }
  if ((nav.hardwareConcurrency && nav.hardwareConcurrency <= 4) || (nav.deviceMemory && nav.deviceMemory <= 4))
    document.documentElement.dataset.lite = '1'
  void refreshAiAccess(true)
  // A permission change by the admin reaches open tabs on the next focus.
  window.addEventListener('focus', () => void refreshAiAccess())
  // Back online: ask again at once instead of waiting for the next retry step.
  window.addEventListener('online', () => {
    if (access.issue || access.state === 'unknown') void refreshAiAccess(true)
  })
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void refreshAiAccess()
  })
}
