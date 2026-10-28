/* eslint-disable @typescript-eslint/no-explicit-any -- admin/account API JSON is rendered as-is; the Worker is the source of truth */
/**
 * Web-edition UI kit: tabs, data table, drawer, confirm dialog, small SVG charts.
 * No dependencies. Everything is keyboard operable and themed by the existing
 * design tokens (so Standard / Pro and light / dark keep their own look).
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import './kit.css'

/* ------------------------------------------------------------------ api */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public body?: unknown,
  ) {
    super(message)
  }
}
export async function api<T = any>(method: 'GET' | 'POST', url: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'X-ExamPilot-Client': '1' }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  let res: Response
  try {
    res = await fetch(url, {
      method,
      headers,
      credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
    })
  } catch {
    throw new ApiError(0, 'offline', '网络连接失败，请检查网络后重试')
  }
  if (res.type === 'opaqueredirect' || res.status === 401)
    throw new ApiError(401, 'session', '登录已失效，请刷新页面重新登录')
  const text = await res.text()
  let j: any
  try {
    j = JSON.parse(text)
  } catch {
    if (res.ok) return text as unknown as T
    throw new ApiError(res.status, 'server', `服务暂时不可用（HTTP ${res.status}）`)
  }
  if (!res.ok || j?.ok === false)
    throw new ApiError(res.status, j?.error || 'error', j?.reason || j?.message || `请求失败（HTTP ${res.status}）`, j)
  return j as T
}

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<{ loading: boolean; data: T | null; error: string | null }>({
    loading: true,
    data: null,
    error: null,
  })
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let alive = true
    setState((s) => ({ ...s, loading: true, error: null }))
    fn().then(
      (data) => alive && setState({ loading: false, data, error: null }),
      (e: Error) => alive && setState((s) => ({ loading: false, data: s.data, error: e.message || String(e) })),
    )
    return () => {
      alive = false
    }
  }, [...deps, tick])
  return { ...state, reload: useCallback(() => setTick((t) => t + 1), []) }
}

/* ------------------------------------------------------------------ format */
export const fmtDate = (ms?: number | null, withTime = true) =>
  ms
    ? new Date(ms).toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        ...(withTime ? { hour: '2-digit', minute: '2-digit', hour12: false } : {}),
      })
    : '—'
export function fmtLeft(ms: number) {
  if (ms <= 0) return '已到期'
  const d = Math.floor(ms / 86_400_000)
  const h = Math.floor((ms % 86_400_000) / 3_600_000)
  return d > 0 ? `${d} 天 ${h} 小时` : `${h} 小时 ${Math.max(1, Math.floor((ms % 3_600_000) / 60_000))} 分`
}

/* ------------------------------------------------------------------ tabs */
export interface TabDef {
  id: string
  label: ReactNode
  badge?: number
}
export function Tabs({
  tabs,
  value,
  onChange,
  label,
  compact,
}: {
  tabs: TabDef[]
  value: string
  onChange: (id: string) => void
  label: string
  compact?: boolean
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const idx = Math.max(
    0,
    tabs.findIndex((t) => t.id === value),
  )
  const move = (n: number) => {
    const i = (n + tabs.length) % tabs.length
    onChange(tabs[i].id)
    refs.current[i]?.focus()
  }
  return (
    <div className={`wk-tabs ${compact ? 'wk-tabs-compact' : ''}`} role="tablist" aria-label={label}>
      {tabs.map((t, i) => (
        <button
          key={t.id}
          ref={(el) => {
            refs.current[i] = el
          }}
          role="tab"
          type="button"
          id={`tab-${t.id}`}
          aria-selected={t.id === value}
          aria-controls={`panel-${t.id}`}
          tabIndex={t.id === value ? 0 : -1}
          className={`wk-tab ${t.id === value ? 'on' : ''}`}
          onClick={() => onChange(t.id)}
          onKeyDown={(e) => {
            const to =
              e.key === 'ArrowRight'
                ? idx + 1
                : e.key === 'ArrowLeft'
                  ? idx - 1
                  : e.key === 'Home'
                    ? 0
                    : e.key === 'End'
                      ? tabs.length - 1
                      : null
            if (to !== null) {
              e.preventDefault()
              move(to)
            }
          }}
        >
          {t.label}
          {!!t.badge && (
            <span className="wk-badge" aria-label={`${t.badge} 条待处理`}>
              {t.badge > 99 ? '99+' : t.badge}
            </span>
          )}
        </button>
      ))}
    </div>
  )
}
export function TabPanel({ id, children }: { id: string; children: ReactNode }) {
  return (
    <div role="tabpanel" id={`panel-${id}`} aria-labelledby={`tab-${id}`} className="wk-panel" tabIndex={-1}>
      {children}
    </div>
  )
}

/* ------------------------------------------------------------------ segmented */
export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  label,
}: {
  options: { v: T; label: string }[]
  value: T
  onChange: (v: T) => void
  label: string
}) {
  return (
    <div className="wk-seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={String(o.v)}
          type="button"
          role="radio"
          aria-checked={o.v === value}
          className={o.v === value ? 'on' : ''}
          onClick={() => onChange(o.v)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/* ------------------------------------------------------------------ states */
export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="wk-empty" role="status">
      <b>{title}</b>
      {children && <div>{children}</div>}
    </div>
  )
}
export function Notice({
  tone = 'info',
  children,
  action,
}: {
  tone?: 'info' | 'ok' | 'bad' | 'warn'
  children: ReactNode
  action?: ReactNode
}) {
  return (
    <div className={`wk-notice wk-${tone}`} role={tone === 'bad' ? 'alert' : 'status'}>
      <div>{children}</div>
      {action}
    </div>
  )
}
export function Loading({ label = '加载中…' }: { label?: string }) {
  return (
    <div className="wk-loading" role="status" aria-live="polite">
      <span className="wk-spin" aria-hidden="true" />
      {label}
    </div>
  )
}

/* ------------------------------------------------------------------ table */
export interface Col<T> {
  key: string
  label: string
  render: (row: T) => ReactNode
  sort?: (row: T) => string | number
  /** hidden in the stacked mobile card (still in the detail drawer) */
  minor?: boolean
  align?: 'right'
  width?: string
}
export interface TableProps<T> {
  rows: T[]
  cols: Col<T>[]
  rowKey: (r: T) => string
  caption: string
  onRow?: (r: T) => void
  /** client mode: rows are all rows; server mode: rows are the current page */
  total?: number
  page?: number
  size?: number
  onPage?: (p: number) => void
  onSize?: (s: number) => void
  sort?: { key: string; dir: 'asc' | 'desc' }
  onSort?: (key: string) => void
  selectable?: boolean
  selected?: Set<string>
  onSelect?: (s: Set<string>) => void
  empty?: ReactNode
  loading?: boolean
}
export function DataTable<T>(p: TableProps<T>) {
  const server = p.total !== undefined
  const [cSort, setCSort] = useState<{ key: string; dir: 'asc' | 'desc' } | null>(null)
  const [cPage, setCPage] = useState(1)
  const [cSize, setCSize] = useState(20)
  const sort = server ? p.sort : cSort
  const size = server ? (p.size ?? 20) : cSize
  const page = server ? (p.page ?? 1) : cPage
  const sorted = useMemo(() => {
    if (server || !cSort) return p.rows
    const col = p.cols.find((c) => c.key === cSort.key)
    if (!col?.sort) return p.rows
    const k = col.sort
    return [...p.rows].sort((a, b) => {
      const x = k(a)
      const y = k(b)
      const r = x < y ? -1 : x > y ? 1 : 0
      return cSort.dir === 'asc' ? r : -r
    })
  }, [server, cSort, p.rows, p.cols])
  const total = server ? p.total! : sorted.length
  const pages = Math.max(1, Math.ceil(total / size))
  // keep the client page in range when the filter shrinks the set
  useEffect(() => {
    if (!server && cPage > pages) setCPage(pages)
  }, [server, cPage, pages])
  const visible = server ? p.rows : sorted.slice((page - 1) * size, page * size)
  const setPage = (n: number) => {
    if (server) p.onPage?.(n)
    else setCPage(n)
  }
  const toggleSort = (key: string) => {
    if (server) return p.onSort?.(key)
    setCSort((s) => (s?.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' }))
  }
  const sel = p.selected ?? new Set<string>()
  const allOnPage = visible.length > 0 && visible.every((r) => sel.has(p.rowKey(r)))
  return (
    <div className="wk-table-wrap">
      <table className="wk-table">
        <caption className="sr-only">{p.caption}</caption>
        <thead>
          <tr>
            {p.selectable && (
              <th className="wk-sel">
                <input
                  type="checkbox"
                  aria-label="选择本页全部"
                  checked={allOnPage}
                  onChange={() => {
                    const n = new Set(sel)
                    for (const r of visible) {
                      if (allOnPage) n.delete(p.rowKey(r))
                      else n.add(p.rowKey(r))
                    }
                    p.onSelect?.(n)
                  }}
                />
              </th>
            )}
            {p.cols.map((c) => (
              <th
                key={c.key}
                style={{ width: c.width, textAlign: c.align }}
                aria-sort={sort?.key === c.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}
              >
                {c.sort || (server && p.onSort) ? (
                  <button type="button" className="wk-th-btn" onClick={() => toggleSort(c.key)}>
                    {c.label}
                    <span aria-hidden="true">{sort?.key === c.key ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ' ↕'}</span>
                  </button>
                ) : (
                  c.label
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {visible.map((r) => {
            const k = p.rowKey(r)
            return (
              <tr key={k} className={p.onRow ? 'wk-click' : ''} onClick={p.onRow ? () => p.onRow!(r) : undefined}>
                {p.selectable && (
                  <td className="wk-sel" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      aria-label="选择"
                      checked={sel.has(k)}
                      onChange={() => {
                        const n = new Set(sel)
                        if (n.has(k)) n.delete(k)
                        else n.add(k)
                        p.onSelect?.(n)
                      }}
                    />
                  </td>
                )}
                {p.cols.map((c, i) => (
                  <td
                    key={c.key}
                    data-label={c.label}
                    className={`${c.minor ? 'wk-minor' : ''} ${i === 0 ? 'wk-first' : ''}`}
                    style={{ textAlign: c.align }}
                  >
                    {i === 0 && p.onRow ? (
                      <button
                        type="button"
                        className="wk-row-btn"
                        onClick={(e) => {
                          e.stopPropagation()
                          p.onRow!(r)
                        }}
                      >
                        {c.render(r)}
                      </button>
                    ) : (
                      c.render(r)
                    )}
                  </td>
                ))}
              </tr>
            )
          })}
        </tbody>
      </table>
      {p.loading && <Loading />}
      {!p.loading && total === 0 && (p.empty ?? <Empty title="没有符合条件的记录" />)}
      {total > 0 && (
        <nav className="wk-pager" aria-label={`${p.caption} 分页`}>
          <span className="wk-pager-info">
            共 {total} 条 · 第 {page}/{pages} 页
          </span>
          <button type="button" disabled={page <= 1} onClick={() => setPage(1)} aria-label="第一页">
            «
          </button>
          <button type="button" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            上一页
          </button>
          <button type="button" disabled={page >= pages} onClick={() => setPage(page + 1)}>
            下一页
          </button>
          <label className="wk-pager-size">
            每页
            <select
              value={size}
              onChange={(e) => {
                const s = Number(e.target.value)
                if (server) p.onSize?.(s)
                else {
                  setCSize(s)
                  setCPage(1)
                }
              }}
            >
              {[10, 20, 50, 100].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        </nav>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ toolbar */
export function Toolbar({ children }: { children: ReactNode }) {
  return <div className="wk-toolbar">{children}</div>
}
export function SearchBox({
  value,
  onChange,
  label,
  placeholder,
}: {
  value: string
  onChange: (v: string) => void
  label: string
  placeholder?: string
}) {
  const [v, setV] = useState(value)
  useEffect(() => setV(value), [value])
  useEffect(() => {
    const t = setTimeout(() => v !== value && onChange(v), 250)
    return () => clearTimeout(t)
  }, [v, value, onChange])
  return (
    <label className="wk-search">
      <span className="sr-only">{label}</span>
      <input type="search" value={v} placeholder={placeholder || label} onChange={(e) => setV(e.target.value)} />
    </label>
  )
}
export function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  options: { v: string; label: string }[]
}) {
  return (
    <label className="wk-select">
      <span className="wk-select-l">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o.v} value={o.v}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  )
}

/* ------------------------------------------------------------------ dialogs */
function useFocusTrap(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const prev = document.activeElement as HTMLElement | null
    const el = ref.current
    const focusables = () =>
      [
        ...(el?.querySelectorAll<HTMLElement>('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])') ??
          []),
      ].filter((x) => !x.hasAttribute('disabled'))
    setTimeout(() => (focusables()[0] ?? el)?.focus(), 0)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
      if (e.key === 'Tab') {
        const f = focusables()
        if (!f.length) return
        const first = f[0]
        const last = f[f.length - 1]
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    document.addEventListener('keydown', onKey, true)
    const ov = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.body.style.overflow = ov
      prev?.focus?.()
    }
  }, [open, onClose])
  return ref
}

export function Drawer({
  open,
  title,
  onClose,
  children,
  footer,
}: {
  open: boolean
  title: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
}) {
  const ref = useFocusTrap(open, onClose)
  const id = useId()
  if (!open) return null
  return (
    <div className="wk-overlay" onClick={onClose}>
      <div
        ref={ref}
        className="wk-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="wk-drawer-h">
          <h2 id={id}>{title}</h2>
          <button type="button" className="wk-x" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </header>
        <div className="wk-drawer-b">{children}</div>
        {footer && <footer className="wk-drawer-f">{footer}</footer>}
      </div>
    </div>
  )
}

export interface ConfirmOpts {
  title: string
  body?: ReactNode
  confirmLabel?: string
  danger?: boolean
  /** text the user must type to enable the button */
  typeToConfirm?: string
  /** a required/optional reason field */
  reason?: 'required' | 'optional'
  reasonLabel?: string
}
export function ConfirmDialog({
  opts,
  onDone,
}: {
  opts: ConfirmOpts | null
  onDone: (r: { ok: boolean; reason?: string }) => void
}) {
  const [typed, setTyped] = useState('')
  const [reason, setReason] = useState('')
  const close = useCallback(() => onDone({ ok: false }), [onDone])
  const ref = useFocusTrap(!!opts, close)
  const id = useId()
  useEffect(() => {
    setTyped('')
    setReason('')
  }, [opts])
  if (!opts) return null
  const ok =
    (!opts.typeToConfirm || typed.trim() === opts.typeToConfirm) &&
    (opts.reason !== 'required' || reason.trim().length > 0)
  return (
    <div className="wk-overlay wk-center" onClick={close}>
      <div
        ref={ref}
        className="wk-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={id}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id={id}>{opts.title}</h2>
        {opts.body && <div className="wk-dialog-body">{opts.body}</div>}
        {opts.reason && (
          <label className="wk-field">
            {opts.reasonLabel || '原因'}
            {opts.reason === 'required' ? '（必填）' : '（选填）'}
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} rows={3} />
          </label>
        )}
        {opts.typeToConfirm && (
          <label className="wk-field">
            请输入「{opts.typeToConfirm}」确认
            <input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
          </label>
        )}
        <div className="wk-dialog-actions">
          <button type="button" className="btn" onClick={close}>
            取消
          </button>
          <button
            type="button"
            className={`btn ${opts.danger ? 'btn-danger' : 'btn-primary'}`}
            disabled={!ok}
            onClick={() => onDone({ ok: true, reason: reason.trim() || undefined })}
          >
            {opts.confirmLabel || '确认'}
          </button>
        </div>
      </div>
    </div>
  )
}
/** imperative confirm: const [dlg, confirm] = useConfirm(); if ((await confirm({...})).ok) … */
export function useConfirm(): [ReactNode, (o: ConfirmOpts) => Promise<{ ok: boolean; reason?: string }>] {
  const [state, setState] = useState<{
    opts: ConfirmOpts
    resolve: (r: { ok: boolean; reason?: string }) => void
  } | null>(null)
  const confirm = useCallback(
    (opts: ConfirmOpts) => new Promise<{ ok: boolean; reason?: string }>((resolve) => setState({ opts, resolve })),
    [],
  )
  const node = (
    <ConfirmDialog
      opts={state?.opts ?? null}
      onDone={(r) => {
        state?.resolve(r)
        setState(null)
      }}
    />
  )
  return [node, confirm]
}

/* ------------------------------------------------------------------ charts */
export interface Point {
  label: string
  value: number
  /** secondary series (optional) */
  value2?: number
  key?: string
}

/** Bar chart: each bar is a button (click / Enter = select, shows exact value). */
/** Width of a chart's box in CSS px, so SVG charts draw 1:1 instead of scaling text up. */
function useBoxWidth<T extends HTMLElement>(dep: unknown) {
  const ref = useRef<T | null>(null)
  const [w, setW] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver((es) => setW(Math.round(es[0]?.contentRect.width ?? 0)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [dep])
  return [ref, w] as const
}

export function BarChart({
  data,
  label,
  selected,
  onSelect,
  height = 160,
  unit = '',
  horizontal,
  limit,
}: {
  data: Point[]
  label: string
  selected?: string | null
  onSelect?: (key: string | null) => void
  height?: number
  unit?: string
  horizontal?: boolean
  /** horizontal only: show this many rows until "显示全部" (selected row always shown) */
  limit?: number
}) {
  const [hover, setHover] = useState<number | null>(null)
  const [all, setAll] = useState(false)
  const [boxRef, boxW] = useBoxWidth<HTMLElement>(`${data.length}${horizontal ? 'h' : 'v'}`)
  const max = Math.max(1, ...data.map((d) => d.value + (d.value2 ?? 0)))
  if (!data.length) return <Empty title="暂无数据" />
  if (horizontal) {
    const cut = !all && limit && data.length > limit
    const rows = cut ? data.filter((d, i) => i < limit || (d.key ?? d.label) === selected) : data
    return (
      <div className="wk-hbars" role="group" aria-label={label}>
        {rows.map((d, i) => {
          const k = d.key ?? d.label
          const on = selected === k
          return (
            <button
              key={k}
              type="button"
              className={`wk-hbar ${on ? 'on' : ''}`}
              aria-pressed={onSelect ? on : undefined}
              onClick={() => onSelect?.(on ? null : k)}
              title={`${d.label}：${d.value}${unit}`}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
            >
              <span className="wk-hbar-l">{d.label}</span>
              <span className="wk-hbar-track">
                <span className="wk-hbar-fill" style={{ width: `${(d.value / max) * 100}%` }} />
              </span>
              <span className="wk-hbar-v">
                {d.value}
                {unit}
              </span>
            </button>
          )
        })}
        {limit && data.length > limit && (
          <button
            type="button"
            className="btn btn-sm btn-ghost wk-more"
            aria-expanded={all}
            onClick={() => setAll((v) => !v)}
          >
            {all ? '收起' : `显示全部 ${data.length} 项`}
          </button>
        )}
      </div>
    )
  }
  const W = Math.max(boxW || 280, data.length * 22)
  const bw = (W - 20) / data.length
  return (
    <figure className="wk-chart" aria-label={label} ref={boxRef}>
      <svg viewBox={`0 0 ${W} ${height + 22}`} role="group" aria-label={label} className="wk-svg">
        <line x1="0" x2={W} y1={height} y2={height} className="wk-axis" />
        {data.map((d, i) => {
          const k = d.key ?? d.label
          const h = (d.value / max) * (height - 14)
          const h2 = ((d.value2 ?? 0) / max) * (height - 14)
          const on = selected === k
          const x = 10 + i * bw
          return (
            <g
              key={k}
              tabIndex={0}
              role="button"
              aria-pressed={onSelect ? on : undefined}
              aria-label={`${d.label}：${d.value}${unit}${d.value2 !== undefined ? `，另 ${d.value2}` : ''}`}
              className={`wk-bar ${on ? 'on' : ''}`}
              onClick={() => onSelect?.(on ? null : k)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onSelect?.(on ? null : k)
                }
              }}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
              onFocus={() => setHover(i)}
              onBlur={() => setHover(null)}
            >
              <rect x={x} y={0} width={bw} height={height} className="wk-hit" />
              <rect
                x={x + bw * 0.15}
                y={height - h}
                width={bw * 0.7}
                height={Math.max(h, d.value ? 1 : 0)}
                className="wk-bar-fill"
                rx="2"
              />
              {!!h2 && (
                <rect
                  x={x + bw * 0.15}
                  y={height - h - h2}
                  width={bw * 0.7}
                  height={h2}
                  className="wk-bar-fill2"
                  rx="2"
                />
              )}
              {(data.length <= 14 || i % Math.ceil(data.length / 10) === 0) && (
                <text x={x + bw / 2} y={height + 15} textAnchor="middle" className="wk-tick">
                  {d.label}
                </text>
              )}
            </g>
          )
        })}
      </svg>
      <figcaption className="wk-tip" aria-live="polite">
        {hover !== null && data[hover]
          ? `${data[hover].label}：${data[hover].value}${unit}${data[hover].value2 !== undefined ? ` · ${data[hover].value2}` : ''}`
          : '\u00a0'}
      </figcaption>
    </figure>
  )
}

/** Line chart (one series, optional %); points are keyboard-focusable. */
export function LineChart({
  data,
  label,
  height = 150,
  unit = '',
  max: maxIn,
  onSelect,
  selected,
}: {
  data: Point[]
  label: string
  height?: number
  unit?: string
  max?: number
  onSelect?: (k: string | null) => void
  selected?: string | null
}) {
  const [hover, setHover] = useState<number | null>(null)
  const [boxRef, boxW] = useBoxWidth<HTMLElement>(data.length)
  if (!data.length) return <Empty title="暂无数据" />
  // draw in real pixels so text and dots keep their size on wide screens
  const W = Math.max(boxW || 280, data.length * 26)
  const max = maxIn ?? Math.max(1, ...data.map((d) => d.value))
  const x = (i: number) => (data.length === 1 ? W / 2 : 14 + (i * (W - 28)) / (data.length - 1))
  const y = (v: number) => height - 8 - (v / max) * (height - 22)
  const path = data.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(d.value).toFixed(1)}`).join(' ')
  return (
    <figure className="wk-chart" aria-label={label} ref={boxRef}>
      <svg viewBox={`0 0 ${W} ${height + 22}`} className="wk-svg" role="group" aria-label={label}>
        <line x1="0" x2={W} y1={height - 8} y2={height - 8} className="wk-axis" />
        <path d={path} className="wk-line" />
        {data.map((d, i) => {
          const k = d.key ?? d.label
          return (
            <g
              key={k}
              tabIndex={0}
              role={onSelect ? 'button' : 'img'}
              aria-label={`${d.label}：${d.value}${unit}`}
              aria-pressed={onSelect ? selected === k : undefined}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
              onFocus={() => setHover(i)}
              onBlur={() => setHover(null)}
              onClick={() => onSelect?.(selected === k ? null : k)}
              onKeyDown={(e) => {
                if (onSelect && (e.key === 'Enter' || e.key === ' ')) {
                  e.preventDefault()
                  onSelect(selected === k ? null : k)
                }
              }}
              className={`wk-pt ${selected === k ? 'on' : ''}`}
            >
              <circle cx={x(i)} cy={y(d.value)} r="10" className="wk-hit" />
              <circle cx={x(i)} cy={y(d.value)} r={hover === i || selected === k ? 4.5 : 3} className="wk-dot" />
              {(data.length <= 12 || i % Math.ceil(data.length / 8) === 0 || i === data.length - 1) && (
                <text x={x(i)} y={height + 15} textAnchor="middle" className="wk-tick">
                  {d.label}
                </text>
              )}
            </g>
          )
        })}
      </svg>
      <figcaption className="wk-tip" aria-live="polite">
        {hover !== null && data[hover] ? `${data[hover].label}：${data[hover].value}${unit}` : '\u00a0'}
      </figcaption>
    </figure>
  )
}

/** Progress ring. */
export function Ring({ value, label, sub, size = 92 }: { value: number; label: string; sub?: string; size?: number }) {
  const v = Math.max(0, Math.min(1, value))
  const r = 40
  const c = 2 * Math.PI * r
  return (
    <div className="wk-ring" role="img" aria-label={`${label} ${Math.round(v * 100)}%${sub ? '，' + sub : ''}`}>
      <svg viewBox="0 0 100 100" width={size} height={size} aria-hidden="true">
        <circle cx="50" cy="50" r={r} className="wk-ring-bg" />
        <circle
          cx="50"
          cy="50"
          r={r}
          className="wk-ring-fg"
          strokeDasharray={`${c * v} ${c}`}
          transform="rotate(-90 50 50)"
        />
        <text x="50" y="55" textAnchor="middle" className="wk-ring-t">
          {Math.round(v * 100)}%
        </text>
      </svg>
      <div>
        <div className="wk-ring-l">{label}</div>
        {sub && <div className="wk-ring-s">{sub}</div>}
      </div>
    </div>
  )
}

/** Day buckets in Asia/Shanghai for the last n days (oldest first). */
export function lastDays(n: number, now = Date.now()) {
  const out: string[] = []
  for (let i = n - 1; i >= 0; i--) out.push(new Date(now - i * 86_400_000 + 8 * 3_600_000).toISOString().slice(0, 10))
  return out
}
export const dayKey = (ms: number) => new Date(ms + 8 * 3_600_000).toISOString().slice(0, 10)
export const shortDay = (d: string) => d.slice(5).replace('-', '/')
