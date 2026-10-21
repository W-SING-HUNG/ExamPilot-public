import { useEffect, useMemo, useState, useRef } from 'react'
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
import { APP_NAME, APP_DESC } from './lib/meta'
import { Spinner } from './components/ui'
import { ErrorBoundary } from './components/ErrorBoundary'
import { FloatingAiAssistant } from './components/FloatingAiAssistant'
import { useActiveSession, useSessionGuard } from './components/useSessionGuard'

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

const NAV_BOTTOM: NavEntry[] = [{ r: 'settings', label: '设置', match: ['ai', 'io'] }]

const ALL_ITEMS = [...NAV_TOP.flatMap((g) => g.items), ...NAV_BOTTOM]

/** Which entry should look active for the current route. */
function activeEntryFor(route: RouteName): RouteName {
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
  const active = activeEntryFor(route)
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
      <div role="group" aria-label="设置" className="nav-bottom">
        {NAV_BOTTOM.map((it) => (
          <NavLink key={it.r} item={it} active={active === it.r} nav={nav} onPicked={onPicked} />
        ))}
      </div>
    </>
  )
}

function ThemeApplier({ theme }: { theme: string }) {
  useEffect(() => {
    const apply = () => {
      const t =
        theme === 'auto' ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : theme
      document.documentElement.dataset.theme = t
    }
    apply()
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [theme])
  return null
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

  const activeRoute = activeEntryFor(route)
  const currentLabel = ALL_ITEMS.find((i) => i.r === activeRoute)?.label ?? APP_NAME

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
        {activeSession && <span className="topbar-live">答题中</span>}
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
        return <AiPage params={params} />
      case 'settings':
        return <SettingsPage params={params} />
      case 'bank':
        return <BankPage params={params} />
      default:
        return <Home nav={guardedNav} params={params} />
    }
  }, [route, params])

  return (
    <>
      <ThemeApplier theme={settings.theme} />
      <a className="skip-link" href="#main-content">
        跳到主要内容
      </a>
      <div className="app-shell">
        <aside className="sidebar">
          <div className="brand">
            <span className="brand-title">{APP_NAME}</span>
            <span className="brand-sub">{APP_DESC}</span>
          </div>
          <nav className="nav" aria-label="主导航">
            <NavItems route={route} nav={guardedNav} />
          </nav>
        </aside>
        <div style={{ minWidth: 0 }}>
          <MobileNav route={route} nav={guardedNav} activeSession={activeSession} />
          <main className="main" id="main-content" tabIndex={-1}>
            {!ready ? (
              <Spinner label="正在载入题库与学习记录…" />
            ) : (
              <ErrorBoundary key={route}>
                <div className="page">{current}</div>
                {/* 全局常驻专业 AI 悬浮小窗口 */}
                <FloatingAiAssistant />
              </ErrorBoundary>
            )}
          </main>
        </div>
      </div>
      {confirmEl}
    </>
  )
}
