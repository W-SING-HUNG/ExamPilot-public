import { useEffect, useLayoutEffect, useMemo, useState, useRef } from 'react'
import { useStore } from './store/StoreContext'
import { useRoute, type RouteName } from './store/router'
import { Home } from './pages/Home'
import { Practice } from './pages/Practice'
import { Special } from './pages/Special'
import { Subjective } from './pages/Subjective'
import { WrongBank } from './pages/WrongBank'
import { Plan } from './pages/Plan'
import { MockExam } from './pages/MockExam'
import { Diagnosis } from './pages/Diagnosis'
import { HistoryPage } from './pages/HistoryPage'
import { DataIO } from './pages/DataIO'
import { AiPage } from './pages/AiPage'
import { SettingsPage } from './pages/SettingsPage'
import { BankPage } from './pages/BankPage'
import { APP_NAME, APP_DESC, BRAND } from './lib/meta'
import { IS_WEB_EDITION } from './lib/edition'
import { Spinner } from './components/ui'
import { ErrorBoundary } from './components/ErrorBoundary'
import { FloatingAiAssistant } from './components/FloatingAiAssistant'
import { useActiveSession, useSessionGuard } from './components/useSessionGuard'
import { AI_ENABLED } from './lib/edition'
import { useAiAccess } from './lib/ai-access'
import { lazy, Suspense } from 'react'
import { AiRecords } from './web/AiRecords'
const AdminCenter = lazy(() => import('./web/admin/AdminCenter'))
import { SyncBadge, SyncNotices } from './sync/SyncUI'
import { ProfilePage } from './pages/ProfilePage'
import { ProWelcome } from './components/ProWelcome'
import { BrandMark } from './components/Brand'
import { tierOf } from './lib/ai-access'

interface NavEntry {
  r: RouteName
  label: string
  /** Sub-screens highlight their parent entry instead of nothing. */
  match?: RouteName[]
}

/**
 * Navigation — seven entries.
 *
 * Consolidated from thirteen. The reduction is in *entries*, not capabilities:
 *   学习诊断      → 学习总览 的「详细诊断」视图
 *   分章练习+专项训练 → 自由刷题（按章节 / 按题型 / 自定义）
 *   题库查阅      → 自由刷题 的「查阅题库」视图
 *   练习历史      → 学习总览 的「查看练习历史」
 *   AI 助手+导入导出 → 设置
 *
 * The superseded routes still exist as hash routes (see store/router.ts) so old
 * links resolve; `match` keeps the parent entry highlighted while on them.
 */
const NAV_TOP: { group: string; items: NavEntry[] }[] = [
  {
    group: '学习',
    items: [
      { r: 'home', label: '学习总览', match: ['diagnosis', 'history'] },
      { r: 'plan', label: '复习计划' },
    ],
  },
  {
    group: '训练',
    items: [
      { r: 'practice', label: '自由刷题', match: ['special', 'bank'] },
      { r: 'subjective', label: '主观题训练' },
      { r: 'wrong', label: '错题本' },
      { r: 'mock', label: '全真模拟' },
    ],
  },
]

const NAV_BOTTOM: NavEntry[] = IS_WEB_EDITION
  ? [
      { r: 'profile', label: '个人中心' },
      { r: 'settings', label: '设置', match: ['ai', 'io'] },
    ]
  : [{ r: 'settings', label: '设置', match: ['ai', 'io'] }]

const ALL_ITEMS = [...NAV_TOP.flatMap((g) => g.items), ...NAV_BOTTOM]

/** Web edition: entries that exist only for accounts the server allows (never a locked teaser). */
function useAiNavItems(): NavEntry[] {
  const access = useAiAccess()
  if (!IS_WEB_EDITION) return []
  const out: NavEntry[] = []
  // Standard accounts keep a read-only view of their own AI history (Pro ended).
  if (access.state === 'granted' || access.pro?.tier === 'standard' || access.pro?.suspended)
    out.push({ r: 'ai', label: 'AI 记录' })
  if (access.role === 'super' || access.role === 'reviewer' || access.admin) out.push({ r: 'admin', label: '管理中心' })
  return out
}

/** Which entry should look active for the current route. */
function activeEntryFor(route: RouteName, extra: NavEntry[] = []): RouteName {
  if (extra.some((i) => i.r === route)) return route
  const own = ALL_ITEMS.find((i) => i.r === route)
  if (own) return own.r
  const parent = ALL_ITEMS.find((i) => i.match?.includes(route))
  return parent?.r ?? route
}

function NavLink({
  item,
  active,
  nav,
  onPicked,
}: {
  item: NavEntry
  active: boolean
  nav: (r: RouteName) => void | Promise<void>
  onPicked?: () => void
}) {
  return (
    <a
      href={`#/${item.r}`}
      className={`nav-item ${active ? 'active' : ''}`}
      aria-current={active ? 'page' : undefined}
      onClick={(e) => {
        // Keep real anchor semantics (new tab / middle click / copy link), but
        // route the plain click through the leave-guard.
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return
        e.preventDefault()
        void nav(item.r)
        onPicked?.()
      }}
    >
      {item.label}
    </a>
  )
}

function NavItems({
  route,
  nav,
  onPicked,
  withGroups = true,
}: {
  route: RouteName
  nav: (r: RouteName) => void | Promise<void>
  onPicked?: () => void
  withGroups?: boolean
}) {
  const aiItems = useAiNavItems()
  const active = activeEntryFor(route, aiItems)
  return (
    <>
      {NAV_TOP.map((g) => (
        <div key={g.group} role="group" aria-label={g.group}>
          {withGroups && <div className="nav-group">{g.group}</div>}
          {g.items.map((it) => (
            <NavLink key={it.r} item={it} active={active === it.r} nav={nav} onPicked={onPicked} />
          ))}
        </div>
      ))}
      {aiItems.length > 0 && (
        <div role="group" aria-label="AI">
          {withGroups && <div className="nav-group">AI</div>}
          {aiItems.map((it) => (
            <NavLink key={it.r} item={it} active={active === it.r} nav={nav} onPicked={onPicked} />
          ))}
        </div>
      )}
      <div role="group" aria-label="设置" className="nav-bottom">
        {NAV_BOTTOM.map((it) => (
          <NavLink key={it.r} item={it} active={active === it.r} nav={nav} onPicked={onPicked} />
        ))}
      </div>
    </>
  )
}

/** Web edition: the last chosen preference, read by the pre-paint script in index.html. */
const THEME_HINT_KEY = 'ep-theme'

function ThemeApplier({ theme }: { theme: string }) {
  const first = useRef(true)
  useEffect(() => {
    const resolve = () =>
      theme === 'auto' ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : theme
    const apply = (animate: boolean) => {
      const t = resolve()
      const root = document.documentElement
      if (root.dataset.theme === t) return
      // A soft cross-fade between light and dark where the browser supports View
      // Transitions; an instant switch otherwise and under reduced motion. Never a
      // per-element "transition: all", which would animate hundreds of nodes.
      const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown }
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      if (animate && !reduce && IS_WEB_EDITION && typeof doc.startViewTransition === 'function') {
        doc.startViewTransition(() => {
          root.dataset.theme = t
        })
      } else root.dataset.theme = t
    }
    apply(!first.current)
    first.current = false
    if (IS_WEB_EDITION) {
      try {
        localStorage.setItem(THEME_HINT_KEY, theme)
      } catch {
        /* private mode: the hint is only a first-paint optimisation */
      }
    }
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onSys = () => apply(true)
    mq.addEventListener('change', onSys)
    return () => mq.removeEventListener('change', onSys)
  }, [theme])
  return null
}

/**
 * Sliding selection indicator for the desktop rail. It measures the active entry
 * and moves with transform only (GPU-friendly, no layout animation).
 */
function NavIndicator({ route }: { route: string }) {
  const ref = useRef<HTMLSpanElement | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    const nav = el?.parentElement
    if (!el || !nav) return
    let raf = 0
    const place = () => {
      raf = 0
      const a = nav.querySelector<HTMLElement>('.nav-item.active')
      if (!a) {
        el.style.opacity = '0'
        return
      }
      // offsetTop is relative to the nearest positioned ancestor (.nav); the groups
      // are static, so this is the item's position inside the rail.
      el.style.opacity = '1'
      el.style.height = a.offsetHeight + 'px'
      el.style.transform = `translateY(${a.offsetTop}px)`
    }
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(place)
    }
    place()
    // Entries appear later (AI items once the server answers) and fonts can load
    // after first paint: re-measure on any of those, not only on route changes.
    const ro = new ResizeObserver(schedule)
    ro.observe(nav)
    for (const it of nav.querySelectorAll('.nav-item')) ro.observe(it)
    const mo = new MutationObserver(() => {
      for (const it of nav.querySelectorAll('.nav-item')) ro.observe(it)
      schedule()
    })
    mo.observe(nav, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] })
    void document.fonts?.ready.then(schedule)
    window.addEventListener('resize', schedule)
    return () => {
      ro.disconnect()
      mo.disconnect()
      window.removeEventListener('resize', schedule)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [route])
  return <span ref={ref} className="nav-indicator" aria-hidden="true" data-route={route} />
}

/** Collapsible navigation for tablet and phone, with Escape-to-close. */
function MobileNav({
  route,
  nav,
  activeSession,
}: {
  route: RouteName
  nav: (r: RouteName) => void | Promise<void>
  activeSession: string | null
}) {
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
        btnRef.current?.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  // Lock the page behind the drawer, otherwise a wheel gesture scrolls the
  // content underneath and the user loses their place.
  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [open])

  // Keep Tab inside the drawer while it is open.
  const onMenuKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'Tab') return
    const items = menuRef.current?.querySelectorAll<HTMLElement>('a[href], button:not([disabled])')
    if (!items || items.length === 0) return
    const first = items[0]
    const last = items[items.length - 1]
    const active = document.activeElement
    if (!e.shiftKey && active === last) {
      e.preventDefault()
      first.focus()
    } else if (e.shiftKey && (active === first || active === btnRef.current)) {
      e.preventDefault()
      last.focus()
    }
  }

  const topTier = tierOf(useAiAccess())
  const aiItems = useAiNavItems()
  const activeRoute = activeEntryFor(route, aiItems)
  const currentLabel = [...ALL_ITEMS, ...aiItems].find((i) => i.r === activeRoute)?.label ?? APP_NAME

  return (
    <>
      <header className="topbar">
        <button
          ref={btnRef}
          type="button"
          className="btn btn-ghost btn-sm topbar-menu-btn"
          aria-expanded={open}
          aria-controls="mobile-menu"
          aria-label={open ? '关闭导航菜单' : '打开导航菜单'}
          onClick={() => setOpen((v) => !v)}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            {open ? (
              <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            ) : (
              <path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            )}
          </svg>
        </button>
        <span className="topbar-title">{currentLabel}</span>
        {IS_WEB_EDITION && topTier === 'pro' && (
          <span className="pro-chip" aria-label="ExamPilot Pro">
            Pro
          </span>
        )}
        {activeSession && <span className="topbar-live">答题中</span>}
        {IS_WEB_EDITION && <SyncBadge compact />}
      </header>
      {open && (
        <>
          <div className="mobile-menu-scrim" role="presentation" onClick={() => setOpen(false)} />
          <nav className="mobile-menu" id="mobile-menu" aria-label="主导航" ref={menuRef} onKeyDown={onMenuKeyDown}>
            <NavItems route={route} nav={nav} onPicked={() => setOpen(false)} />
          </nav>
        </>
      )}
    </>
  )
}

export function App() {
  const { ready, settings } = useStore()
  const [route, nav, params] = useRoute()
  const { confirmLeave, confirmEl } = useSessionGuard()
  const activeSession = useActiveSession()
  const aiAccess = useAiAccess()
  const tier = IS_WEB_EDITION ? tierOf(aiAccess) : 'standard'

  // 学习专注模式: while an answering session or a timed exam is live, decorative
  // motion (sheen, ambient light, entrance motion) is switched off by CSS.
  useEffect(() => {
    if (!IS_WEB_EDITION) return
    const root = document.documentElement
    if (activeSession) root.dataset.focus = '1'
    else delete root.dataset.focus
  }, [activeSession])

  // Every navigation control goes through here so a live answering session is
  // never discarded silently. Resolves true immediately when nothing is running.
  const guardedNav = async (r: RouteName, p?: Record<string, string>) => {
    if (!(await confirmLeave())) return
    nav(r, p)
  }

  const current = useMemo(() => {
    switch (route) {
      case 'practice':
        return <Practice nav={guardedNav} params={params} />
      case 'special':
        return <Special nav={guardedNav} params={params} />
      case 'subjective':
        return <Subjective params={params} />
      case 'wrong':
        return <WrongBank nav={guardedNav} params={params} />
      case 'plan':
        return <Plan params={params} />
      case 'mock':
        return <MockExam nav={guardedNav} params={params} />
      case 'diagnosis':
        return <Diagnosis nav={guardedNav} params={params} />
      case 'history':
        return <HistoryPage params={params} />
      case 'io':
        return <DataIO params={params} />
      case 'ai':
        // Web edition: AI 记录 (chat + review history) for permitted accounts; there is
        // no gateway settings page on the website. Everyone else lands on settings.
        if (IS_WEB_EDITION)
          return aiAccess.state === 'granted' || aiAccess.state === 'denied' ? (
            <AiRecords />
          ) : (
            <SettingsPage params={params} />
          )
        return AI_ENABLED ? <AiPage params={params} /> : <SettingsPage params={params} />
      case 'admin':
        return IS_WEB_EDITION && (aiAccess.admin || aiAccess.role === 'super' || aiAccess.role === 'reviewer') ? (
          <Suspense fallback={<Spinner />}>
            <AdminCenter />
          </Suspense>
        ) : (
          <Home nav={guardedNav} params={params} />
        )
      case 'profile':
        return IS_WEB_EDITION ? <ProfilePage nav={guardedNav} /> : <Home nav={guardedNav} params={params} />
      case 'settings':
        return <SettingsPage params={params} />
      case 'bank':
        return <BankPage params={params} />
      default:
        return <Home nav={guardedNav} params={params} />
    }
  }, [route, params, aiAccess.state, aiAccess.admin, aiAccess.role])

  return (
    <>
      <ThemeApplier theme={settings.theme} />
      <a className="skip-link" href="#main-content">
        跳到主要内容
      </a>
      <div className="app-shell">
        <aside className="sidebar">
          <div className="brand">
            {IS_WEB_EDITION ? (
              <BrandMark tier={tier} />
            ) : (
              <>
                <span className="brand-title">{APP_NAME}</span>
                <span className="brand-sub">{APP_DESC}</span>
              </>
            )}
          </div>
          {IS_WEB_EDITION && <SyncBadge />}
          <nav className="nav" aria-label="主导航">
            {IS_WEB_EDITION && <NavIndicator route={route} />}
            <NavItems route={route} nav={guardedNav} />
          </nav>
          {IS_WEB_EDITION && (
            <div className="brand-foot">
              <div>{BRAND.positioning}</div>
              <div>开发与维护：{BRAND.maintainer}</div>
              <div>{BRAND.copyright}</div>
              <div>
                GitHub：
                <a href={BRAND.repoUrl} target="_blank" rel="noopener noreferrer">
                  {BRAND.github}
                </a>
              </div>
            </div>
          )}
        </aside>
        <div style={{ minWidth: 0 }}>
          <MobileNav route={route} nav={guardedNav} activeSession={activeSession} />
          <main className="main" id="main-content" tabIndex={-1}>
            {!ready || tier === 'pending' ? (
              // Neutral boot state: no identity, no AI, no Pro chrome until the server
              // has answered who this account is (bounded by a 6 s timeout).
              <div className="boot-neutral">
                <Spinner label="正在载入题库与学习记录…" />
              </div>
            ) : (
              <ErrorBoundary key={route}>
                {IS_WEB_EDITION && <SyncNotices />}
                {IS_WEB_EDITION && aiAccess.blocked && (
                  <div className="result-banner bad" role="alert" style={{ marginBottom: 12 }}>
                    {aiAccess.blocked}
                  </div>
                )}
                <div className="page">{current}</div>
                {/* 全局常驻专业 AI 悬浮小窗口 */}
                {!IS_WEB_EDITION && AI_ENABLED && <FloatingAiAssistant />}
              </ErrorBoundary>
            )}
            {/* Web edition: outside the per-route boundary so an answer keeps streaming
                while the user moves between pages; only for permitted accounts. */}
            {IS_WEB_EDITION && ready && aiAccess.state === 'granted' && (
              <ErrorBoundary>
                <FloatingAiAssistant />
              </ErrorBoundary>
            )}
            {IS_WEB_EDITION && ready && tier === 'pro' && !activeSession && (
              <ErrorBoundary>
                <ProWelcome />
              </ErrorBoundary>
            )}
            {IS_WEB_EDITION && (
              <footer className="app-foot">
                <div>
                  {BRAND.en} {BRAND.zh} · {BRAND.positioning} · 开发与维护：{BRAND.maintainer}
                </div>
                <div>
                  {BRAND.copyright} · GitHub：
                  <a href={BRAND.repoUrl} target="_blank" rel="noopener noreferrer">
                    {BRAND.github}
                  </a>
                </div>
              </footer>
            )}
          </main>
        </div>
      </div>
      {confirmEl}
    </>
  )
}
