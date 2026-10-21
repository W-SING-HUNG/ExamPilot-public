import { useEffect, useRef, useState } from 'react'

/**
 * Route table.
 *
 * After the architecture consolidation the *navigation* has seven entries, but
 * the route table is deliberately larger: every page that used to be reachable
 * directly keeps its own hash route so that
 *
 *   - existing bookmarks and deep links (`#/practice?chapter=第一章`) keep working,
 *   - `HistoryPage`, `BankPage`, `DataIO`, `AiPage` stay addressable as standalone
 *     screens while being *entered* from their new homes,
 *   - and the automated suites that navigate by route name continue to exercise
 *     the real page rather than a redirect.
 *
 * `NAV_ROUTES` is the only thing the sidebar renders.
 */
export type RouteName =
  | 'home'
  | 'plan'
  | 'practice'
  | 'special'
  | 'subjective'
  | 'wrong'
  | 'mock'
  | 'settings'
  // Detail / sub screens, reached from the consolidated entries above.
  | 'diagnosis'
  | 'history'
  | 'bank'
  | 'io'
  | 'ai'

/** Routes that own a sidebar entry, in display order. */
export const NAV_ROUTES: RouteName[] = ['home', 'plan', 'practice', 'subjective', 'wrong', 'mock', 'settings']

/**
 * Legacy route aliases kept for deep links.
 *
 * Currently EMPTY on purpose.
 *
 * `special` (专项训练) is handled by its own route component (pages/Special.tsx)
 * which renders 自由刷题 in 按题型 mode. An alias here would have rewritten the
 * route BEFORE the component could run, leaving that component unreachable —
 * dead code with a shadow implementation. One mechanism only.
 */
export const LEGACY_ALIASES: Record<string, { route: RouteName; params?: Record<string, string> }> = {}

interface RouteState {
  route: RouteName
  params: Record<string, string>
}

function parse(): RouteState {
  const h = window.location.hash.replace(/^#\/?/, '')
  const [path, qs] = h.split('?')
  let route = (path || 'home') as RouteName
  const params: Record<string, string> = {}
  if (qs)
    for (const kv of qs.split('&')) {
      const [k, v] = kv.split('=')
      if (k) params[decodeURIComponent(k)] = decodeURIComponent(v ?? '')
    }

  const alias = LEGACY_ALIASES[route]
  if (alias) {
    route = alias.route
    if (alias.params) Object.assign(params, alias.params)
  }
  return { route, params }
}

function scrollToTop(): void {
  const main = document.getElementById('main-content')
  if (main && typeof main.scrollTo === 'function') main.scrollTop = 0
  if (typeof window.scrollTo === 'function') window.scrollTo({ top: 0, left: 0, behavior: 'auto' })
}

/**
 * Reading position memory, keyed by location.hash.
 *
 * Every route renders into the same document, so without explicit handling the
 * browser keeps the previous page's offset. The audit measured landing 1376px
 * into a page whose heading was 1376px above the viewport.
 *
 * Chrome also restores the scroll offset itself on same-document navigations,
 * and it does so *after* our handler runs — which is why scrolling to the top on
 * hashchange alone was not enough. Taking `scrollRestoration` over as `manual`
 * makes the behaviour deterministic: forward navigation starts at the top, and
 * back/forward restores the offset we recorded for that entry.
 */
const positions = new Map<string, number>()

function rememberPosition(): void {
  positions.set(window.location.hash || '#/home', window.scrollY)
}

export function useRoute(): [
  RouteName,
  (r: RouteName, params?: Record<string, string>) => void,
  Record<string, string>,
] {
  const [state, setState] = useState<RouteState>(parse)
  const fromHistory = useRef(false)

  useEffect(() => {
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual'

    const onPop = () => {
      fromHistory.current = true
    }
    const onScroll = () => rememberPosition()
    const onHash = () => {
      const next = parse()
      setState(next)
      if (fromHistory.current) {
        fromHistory.current = false
        const saved = positions.get(window.location.hash)
        // Restore the offset the user left this entry at; a first visit starts
        // at the top.
        window.scrollTo({ top: saved ?? 0, left: 0, behavior: 'auto' })
        return
      }
      scrollToTop()
    }
    window.addEventListener('popstate', onPop)
    window.addEventListener('hashchange', onHash)
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      window.removeEventListener('popstate', onPop)
      window.removeEventListener('hashchange', onHash)
      window.removeEventListener('scroll', onScroll)
    }
  }, [])

  const nav = (r: RouteName, p?: Record<string, string>) => {
    const qs = p && Object.keys(p).length ? '?' + new URLSearchParams(p).toString() : ''
    const nextHash = `/${r}${qs}`
    if (window.location.hash === `#${nextHash}`) return
    rememberPosition()
    fromHistory.current = false
    window.location.hash = nextHash
    setState({ route: r, params: p ?? {} })
    // Do it here too: the reset must not depend on hashchange ordering.
    scrollToTop()
  }

  return [state.route, nav, state.params]
}
