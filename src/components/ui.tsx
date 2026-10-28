import { type ReactNode, useState, useEffect, useRef, useCallback, useMemo, type CSSProperties } from 'react'

/* ============================================================================
 * Primitives
 * ========================================================================== */

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`card ${className}`}>{children}</div>
}

export function CardPad({
  children,
  className = '',
  style,
}: {
  children: ReactNode
  className?: string
  style?: CSSProperties
}) {
  return (
    <div className={`card card-pad ${className}`} style={style}>
      {children}
    </div>
  )
}

export function Stat({
  value,
  label,
  hint,
  tone,
  featured,
}: {
  value: ReactNode
  label: string
  hint?: string
  tone?: 'ok' | 'bad' | 'warn' | 'accent'
  /** the one headline metric of a row gets more visual weight; the rest stay quiet */
  featured?: boolean
}) {
  return (
    <CardPad className={`stat-card ${featured ? 'stat-featured' : ''}`}>
      <div className={`stat-num ${tone ? `tone-${tone}` : ''}`}>{value}</div>
      <div className="stat-label">{label}</div>
      {hint && <div className="stat-hint">{hint}</div>}
    </CardPad>
  )
}

export function Bar({ value, tone = 'accent' }: { value: number; tone?: 'accent' | 'ok' | 'bad' | 'warn' }) {
  const pct = Math.max(0, Math.min(100, Math.round(value * 100)))
  return (
    <div className={`bar ${tone === 'accent' ? '' : tone}`} role="presentation">
      <span style={{ width: `${pct}%` }} />
    </div>
  )
}

export function Tag({
  children,
  tone = 'plain',
}: {
  children: ReactNode
  tone?: 'plain' | 'ok' | 'bad' | 'warn' | 'accent'
}) {
  const cls = tone === 'plain' ? 'tag' : `tag tag-${tone}`
  return <span className={cls}>{children}</span>
}

export function PageHead({ title, desc, extra }: { title: string; desc?: string; extra?: ReactNode }) {
  return (
    <div className="page-head row-between">
      <div>
        <h1 className="page-title">{title}</h1>
        {desc && <p className="page-desc">{desc}</p>}
      </div>
      {extra}
    </div>
  )
}

/** Small line-art glyph used to make empty states legible rather than bare. */
function EmptyGlyph() {
  return (
    <svg className="empty-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M7 9h10M7 13h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

export function Empty({ text, children }: { text: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <EmptyGlyph />
      <div>{text}</div>
      {children && <div style={{ marginTop: 14 }}>{children}</div>}
    </div>
  )
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="loading" role="status" aria-live="polite">
      <div className="col" style={{ alignItems: 'center', gap: 10 }}>
        <div className="spinner" />
        {label && <span className="muted-2">{label}</span>}
      </div>
    </div>
  )
}

export function useToast() {
  const [msg, setMsg] = useState<string | null>(null)
  useEffect(() => {
    if (!msg) return
    const t = setTimeout(() => setMsg(null), 2600)
    return () => clearTimeout(t)
  }, [msg])
  const el = msg ? (
    <div className="toast" role="status" aria-live="polite">
      {msg}
    </div>
  ) : null
  return { toast: setMsg, el }
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="muted-2">{hint}</span>}
    </label>
  )
}

/* ============================================================================
 * Skeletons
 *
 * A skeleton is only mounted once the load has already exceeded a short
 * threshold, so a fast local read never flashes a placeholder. See `useDeferred`
 * below — the decision lives there rather than in each page.
 * ========================================================================== */

export function Sk({
  w,
  h = 12,
  r,
  className = '',
  style,
}: {
  w?: number | string
  h?: number
  r?: number
  className?: string
  style?: CSSProperties
}) {
  return (
    <div
      className={`sk ${className}`}
      style={{ width: w ?? '100%', height: h, borderRadius: r, ...style }}
      aria-hidden="true"
    />
  )
}

/** Skeleton matching the metrics row on Home / Diagnosis. */
export function SkStats({ n = 4 }: { n?: number }) {
  return (
    <div className="grid grid-4" aria-hidden="true">
      {Array.from({ length: n }, (_, i) => (
        <div className="card card-pad stat-card" key={i}>
          <Sk w="55%" h={26} r={6} />
          <Sk w="70%" h={11} r={4} style={{ marginTop: 8 }} />
        </div>
      ))}
    </div>
  )
}

/** Skeleton matching a list of rows (history, bank, wrong bank). */
export function SkList({ rows = 6, h = 44 }: { rows?: number; h?: number }) {
  return (
    <div className="col" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <Sk key={i} h={h} r={8} />
      ))}
    </div>
  )
}

/** Skeleton matching a table: header strip plus body rows. */
export function SkTable({ rows = 8 }: { rows?: number }) {
  return (
    <div aria-hidden="true">
      <Sk h={32} r={6} />
      <div style={{ marginTop: 8 }} className="col">
        {Array.from({ length: rows }, (_, i) => (
          <Sk key={i} h={34} r={6} />
        ))}
      </div>
    </div>
  )
}

/* ============================================================================
 * Deferred loading
 *
 * `useDeferred` reports `showSkeleton` only after `delay` has elapsed while
 * still loading. Loads that finish sooner render content directly, so the
 * skeleton never flashes for a fast IndexedDB read.
 * ========================================================================== */

export function useDeferred(loading: boolean, delay = 140): boolean {
  const [past, setPast] = useState(false)
  useEffect(() => {
    if (!loading) {
      setPast(false)
      return
    }
    const t = setTimeout(() => setPast(true), delay)
    return () => clearTimeout(t)
  }, [loading, delay])
  return loading && past
}

/* ============================================================================
 * Staggered reveal
 * ========================================================================== */

/**
 * Wrap children to stagger their entrance. Each direct child gets an incrementing
 * `--i` index consumed by the CSS `animation-delay`, so the sequence is driven
 * entirely by CSS and needs no timers.
 */
export function Reveal({
  children,
  className = '',
  enabled = true,
}: {
  children: ReactNode
  className?: string
  enabled?: boolean
}) {
  const items = useMemo(() => (Array.isArray(children) ? children : [children]), [children])
  if (!enabled) return <div className={className}>{children}</div>
  return (
    <div className={`reveal ${className}`}>
      {items.map((child, i) => (
        <div key={i} style={{ ['--i' as string]: i }}>
          {child}
        </div>
      ))}
    </div>
  )
}

/* ============================================================================
 * Infinite list
 *
 * Pagination is real: the caller supplies a page loader that must query by
 * offset/limit, and this hook guarantees a single in-flight request, ordered
 * appends and a full reset whenever the query key changes.
 * ========================================================================== */

export interface Page<T> {
  items: T[]
  hasMore: boolean
}

export function useInfiniteList<T>(
  key: string,
  load: (offset: number, limit: number) => Promise<Page<T>>,
  pageSize = 50,
) {
  const [items, setItems] = useState<T[]>([])
  const [hasMore, setHasMore] = useState(true)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Guards: one request at a time, and a generation so a stale response from a
  // previous query can never land in the new list.
  const busy = useRef(false)
  const gen = useRef(0)
  // Read the current length without making callbacks depend on it, so `loadMore`
  // keeps a stable identity across appends.
  const lenRef = useRef(0)
  lenRef.current = items.length

  /**
   * Fetch one page at an explicit offset.
   *
   * Taking the offset as a parameter rather than reading `items.length` is what
   * makes a first-page reload possible: the caller can ask for offset 0 while the
   * list still holds rows (a refresh), or while it is empty (a retry after a
   * failure). `offset === 0` replaces the list; anything else appends.
   */
  const run = useCallback(
    async (offset: number) => {
      if (busy.current) return
      const myGen = gen.current
      busy.current = true
      setLoading(true)
      try {
        const page = await load(offset, pageSize)
        if (myGen !== gen.current) return
        setItems((prev) => (offset === 0 ? page.items : [...prev, ...page.items]))
        setHasMore(page.hasMore)
        setError(null)
      } catch (e) {
        if (myGen !== gen.current) return
        setError(e instanceof Error ? e.message : String(e))
        setHasMore(false)
      } finally {
        if (myGen === gen.current) {
          busy.current = false
          setLoading(false)
        }
      }
    },
    [load, pageSize],
  )

  // Held in a ref so the effect below can call the latest `run` without taking a
  // dependency on it: `load` identity changes when filters change, and depending
  // on it here would fire the initial load twice per filter change.
  const runRef = useRef(run)
  runRef.current = run

  // Bumping this restarts the list. Needed because clearing state alone does not
  // reload: after a first-page failure `items.length` is already 0, so an effect
  // keyed on it would never run again and "retry" would be a dead button.
  const [resetToken, setResetToken] = useState(0)

  // First page: on mount, whenever the query key changes, and on an explicit
  // reset. The generation bump invalidates any in-flight request, and the list is
  // cleared so stale rows cannot survive a filter change.
  useEffect(() => {
    gen.current += 1
    busy.current = false
    setItems([])
    setHasMore(true)
    setError(null)
    void runRef.current(0)
  }, [key, resetToken])

  /** Load the next page. */
  const loadMore = useCallback(() => run(lenRef.current), [run])

  /** Discard everything and re-request the first page. Works after a failure. */
  const reset = useCallback(() => {
    setResetToken((t) => t + 1)
  }, [])

  return { items, hasMore, loading, error, loadMore, reset, retry: reset }
}

/**
 * Sentinel that calls `onHit` when it scrolls within `rootMargin` of the
 * viewport. `rootMargin` defaults to 300px so the next page is already in
 * flight before the user reaches the bottom.
 */
export function InfiniteSentinel({
  onHit,
  disabled,
  rootMargin = '300px',
}: {
  onHit: () => void
  disabled?: boolean
  rootMargin?: string
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  const cb = useRef(onHit)
  cb.current = onHit

  useEffect(() => {
    const el = ref.current
    if (!el || disabled) return
    if (typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) cb.current()
      },
      { rootMargin },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [disabled, rootMargin])

  return <div className="list-sentinel" ref={ref} aria-hidden="true" />
}

/** Footer for an infinite list: skeleton rows while loading, then "到底啦". */
export function ListFoot({ loading, done }: { loading: boolean; done: boolean }) {
  if (loading) {
    return (
      <div className="list-foot" aria-live="polite">
        <div className="typing" aria-hidden="true">
          <i />
          <i />
          <i />
        </div>
        <span>正在加载更多…</span>
      </div>
    )
  }
  if (done) return <div className="list-foot list-foot-done">到底啦</div>
  return <div className="list-foot" />
}

/* ============================================================================
 * Typing dots
 * ========================================================================== */

/** Three staggered breathing dots, used while an AI request is in flight. */
export function TypingDots({ label }: { label?: string }) {
  return (
    <span className="row" style={{ gap: 8 }}>
      <span className="typing" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      {label && <span className="muted-2">{label}</span>}
      <span className="sr-only" role="status" aria-live="polite">
        {label ?? '处理中'}
      </span>
    </span>
  )
}

/* ============================================================================
 * Confirmation dialog
 *
 * Replaces window.confirm for destructive actions: it is styled, accessible and
 * keeps the page interactive (a native confirm blocks the JS thread and cannot
 * be themed). Focus is moved to the dialog and restored on close, and Escape
 * cancels — matching the behaviour users expect from a system dialog.
 * ========================================================================== */

export interface ConfirmOptions {
  title: string
  body?: string
  confirmLabel?: string
  cancelLabel?: string
  /** Renders the confirm button with destructive styling. */
  danger?: boolean
}

export function useConfirm() {
  const [pending, setPending] = useState<(ConfirmOptions & { resolve: (v: boolean) => void }) | null>(null)
  const restoreFocus = useRef<HTMLElement | null>(null)

  const ask = useCallback((opts: ConfirmOptions) => {
    restoreFocus.current = document.activeElement as HTMLElement | null
    return new Promise<boolean>((resolve) => setPending({ ...opts, resolve }))
  }, [])

  const settle = useCallback((v: boolean) => {
    setPending((cur) => {
      cur?.resolve(v)
      return null
    })
    // Return focus to whatever the user was on before the dialog opened.
    setTimeout(() => restoreFocus.current?.focus(), 0)
  }, [])

  const el = pending ? (
    <ConfirmDialog {...pending} onCancel={() => settle(false)} onConfirm={() => settle(true)} />
  ) : null

  return { confirm: ask, confirmEl: el }
}

function ConfirmDialog({
  title,
  body,
  confirmLabel = '确定',
  cancelLabel = '取消',
  danger,
  onCancel,
  onConfirm,
}: ConfirmOptions & { onCancel: () => void; onConfirm: () => void }) {
  const confirmRef = useRef<HTMLButtonElement | null>(null)
  const dialogRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    confirmRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onCancel()
        return
      }
      /*
       * Trap Tab inside the dialog.
       *
       * `aria-modal="true"` is a promise that the rest of the page is inert. It
       * was not: Tab walked straight out into the page behind, so a keyboard
       * user could focus and activate controls the dialog was supposedly
       * blocking.
       */
      if (e.key !== 'Tab') return
      const focusables = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])',
      )
      if (!focusables || focusables.length === 0) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const active = document.activeElement
      if (!e.shiftKey && active === last) {
        e.preventDefault()
        first.focus()
      } else if (e.shiftKey && (active === first || !dialogRef.current?.contains(active))) {
        e.preventDefault()
        last.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onCancel])

  return (
    <div className="dialog-backdrop" role="presentation" onClick={onCancel}>
      <div
        ref={dialogRef}
        className="dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        aria-describedby={body ? 'dialog-body' : undefined}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="dialog-title" id="dialog-title">
          {title}
        </h2>
        {body && (
          <p className="dialog-body" id="dialog-body">
            {body}
          </p>
        )}
        <div className="dialog-actions">
          <button className="btn" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button ref={confirmRef} className={`btn ${danger ? 'btn-danger-solid' : 'btn-primary'}`} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * Progress ring (SVG). The number in the middle is the real value from the first
 * frame; only the arc eases in (stroke-dashoffset, compositor-friendly). Under
 * reduced motion the arc is drawn at once.
 */
export function Ring({
  value,
  size = 112,
  stroke = 9,
  label,
  sub,
  inner,
}: {
  value: number
  size?: number
  stroke?: number
  label: ReactNode
  sub?: ReactNode
  /** optional second, inner arc (e.g. mastered inside coverage) */
  inner?: number
}) {
  const v = Math.max(0, Math.min(1, value))
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const r2 = r - stroke - 3
  const c2 = 2 * Math.PI * r2
  const iv = inner === undefined ? null : Math.max(0, Math.min(1, inner))
  const [drawn, setDrawn] = useState(false)
  useEffect(() => {
    const t = requestAnimationFrame(() => setDrawn(true))
    return () => cancelAnimationFrame(t)
  }, [])
  return (
    <div className="ring" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle className="ring-track" cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} fill="none" />
        <circle
          className="ring-arc"
          cx={size / 2}
          cy={size / 2}
          r={r}
          strokeWidth={stroke}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={drawn ? c * (1 - v) : c}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
        {iv !== null && (
          <>
            <circle
              className="ring-track ring-track-in"
              cx={size / 2}
              cy={size / 2}
              r={r2}
              strokeWidth={stroke - 3}
              fill="none"
            />
            <circle
              className="ring-arc ring-arc-in"
              cx={size / 2}
              cy={size / 2}
              r={r2}
              strokeWidth={stroke - 3}
              fill="none"
              strokeLinecap="round"
              strokeDasharray={c2}
              strokeDashoffset={drawn ? c2 * (1 - iv) : c2}
              transform={`rotate(-90 ${size / 2} ${size / 2})`}
            />
          </>
        )}
      </svg>
      <div className="ring-center">
        <span className="ring-label">{label}</span>
        {sub && <span className="ring-sub">{sub}</span>}
      </div>
    </div>
  )
}
