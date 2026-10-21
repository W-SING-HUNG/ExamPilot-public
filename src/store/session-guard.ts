/**
 * Live session guard.
 *
 * A practice session is state that lives outside the URL, and the app's router
 * is a bare hash listener with no guard hook. Rather than rewrite the router,
 * the running session registers itself here, and the two places that can
 * discard it — route navigation and tab close — consult it first.
 *
 * This is deliberately a tiny module-level registry, not React context: the
 * router is not a component, and the guard must be readable from a plain
 * event handler.
 */

type Listener = (active: string | null) => void

let activeMode: string | null = null
const listeners = new Set<Listener>()

export function setActiveSession(mode: string | null): void {
  if (activeMode === mode) return
  activeMode = mode
  for (const l of listeners) l(mode)
}

export function getActiveSession(): string | null {
  return activeMode
}

export function subscribeActiveSession(fn: Listener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
