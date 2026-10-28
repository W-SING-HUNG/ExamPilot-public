import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useSync } from '../sync/CloudStore'
import { ProBadge } from './Brand'

/**
 * One-time "欢迎使用 ExamPilot Pro".
 *
 * Shown only when ALL hold: the server says this account is Pro (the parent mounts
 * us only for tier 'pro'), the account's synced settings say it was never shown,
 * and this device has completed at least one sync (so a second device that has not
 * pulled yet cannot replay it). Closing it (button, Esc, backdrop) records
 * `proWelcomed: true` as a synced settings op, so no other device shows it again.
 * Revoking Pro deletes nothing; re-granting later does not replay it.
 */
export function ProWelcome() {
  const sync = useSync()
  const [closed, setClosed] = useState(false)
  const btnRef = useRef<HTMLButtonElement | null>(null)
  const show = !!sync && !sync.proWelcomed && sync.status.lastSyncedAt != null && !closed

  useEffect(() => {
    if (!show) return
    // fix4: a real modal. The whole app (pages, nav, the floating AI launcher and an
    // already-open AI window) becomes inert — no clicks, no keyboard focus, hidden from
    // assistive tech — not just visually covered. The dialog itself lives in a portal
    // outside #root, so it stays interactive.
    const root = document.getElementById('root')
    const hadInert = root?.hasAttribute('inert') ?? false
    root?.setAttribute('inert', '')
    root?.setAttribute('aria-hidden', 'true')
    const prev = document.activeElement as HTMLElement | null
    const t = setTimeout(() => btnRef.current?.focus(), 60)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
      if (e.key === 'Tab') {
        // keep focus inside the dialog (two buttons: cycle between them)
        const items = [...document.querySelectorAll<HTMLElement>('.welcome-card button')]
        if (items.length === 0) return
        e.preventDefault()
        const i = items.indexOf(document.activeElement as HTMLElement)
        const n = e.shiftKey ? (i <= 0 ? items.length - 1 : i - 1) : (i + 1) % items.length
        items[n].focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      clearTimeout(t)
      document.removeEventListener('keydown', onKey)
      if (!hadInert) root?.removeAttribute('inert')
      root?.removeAttribute('aria-hidden')
      prev?.focus?.()
    }
  }, [show])

  if (!show) return null
  function close() {
    setClosed(true)
    void sync?.markProWelcomed().catch(() => {
      /* offline: the op is queued by the engine and pushed later */
    })
  }

  return createPortal(
    <div className="welcome-backdrop" role="presentation" onClick={close}>
      <div
        className="welcome-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pro-welcome-title"
        aria-describedby="pro-welcome-desc"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="welcome-badge">
          <ProBadge size="lg" />
        </div>
        <h2 id="pro-welcome-title" className="welcome-title">
          欢迎使用 ExamPilot Pro
        </h2>
        <p id="pro-welcome-desc" className="welcome-desc">
          你的账号已开通 AI 能力：题目 AI 答疑、主观题参考评阅、AI
          助手，记录随账号在手机和电脑间同步。学习记录与之前完全一致。
        </p>
        <ul className="welcome-list">
          <li>做题时点题卡上的「AI 答疑」</li>
          <li>主观题提交后可「提交 AI 评阅」获取参考分</li>
          <li>右下角的 AI 助手随时提问</li>
        </ul>
        <button ref={btnRef} type="button" className="btn btn-primary btn-lg btn-block" onClick={close}>
          开始使用
        </button>
        <button type="button" className="btn btn-ghost btn-sm welcome-skip" onClick={close}>
          跳过
        </button>
      </div>
    </div>,
    document.body,
  )
}
