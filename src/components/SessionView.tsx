import { useEffect, useRef, type ReactNode } from 'react'
import { useAiUsable } from '../lib/ai-access'
import type { SessionResult } from '../lib/session-outcome'

/* ============================================================================
 * Session shell
 *
 * Every practice route has the same three phases, and the audit's biggest
 * finding was that they used to be one long scroll: the config cards stayed
 * mounted above the questions, so starting a session left the user staring at
 * "复习方法说明" with the first question 1–2 screens below.
 *
 * The shell makes the phase explicit. In `running` the configure tree is not
 * merely hidden — it is not rendered — so there is nothing above the question
 * to scroll past, and the question anchor starts at the top of the content area.
 * ========================================================================== */

export type SessionPhase = 'configure' | 'running' | 'summary'

export function SessionShell({ children }: { children: ReactNode }) {
  return <div className="session">{children}</div>
}

/**
 * Header for the answering phase: where you are, how far in, and one obvious
 * way out. Sticky, so the counts stay visible while reading a long stem.
 */
export function RunnerShell({ children, sticky = true }: { children: ReactNode; sticky?: boolean }) {
  const ref = useRef<HTMLDivElement | null>(null)

  // Land the user on the question when the running phase mounts. Without this
  // the viewport keeps the scroll offset it had on the configure screen, which
  // was measured putting the first question below the fold at every size.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const top = el.getBoundingClientRect().top
    if (top < 0 || top > 96) {
      el.scrollIntoView({ block: 'start', behavior: 'auto' })
    }
    // Focus the region so keyboard users start here, not at the page header.
    el.focus({ preventScroll: true })
  }, [])

  return (
    <div
      ref={ref}
      className={`runner-shell ${sticky ? 'is-sticky' : ''}`}
      tabIndex={-1}
      role="region"
      aria-label="答题区"
    >
      {children}
    </div>
  )
}

/* ============================================================================
 * Summary
 * ========================================================================== */

function fmtDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  if (m === 0) return `${s} 秒`
  return `${m} 分 ${s} 秒`
}

export function SessionSummary({
  result,
  title,
  subtitle,
  onRestart,
  onExit,
  exitLabel = '返回',
  onReviewWrong,
}: {
  result: SessionResult
  title: string
  subtitle?: string
  onRestart: () => void
  onExit: () => void
  exitLabel?: string
  onReviewWrong?: () => void
}) {
  const aiOn = useAiUsable()
  const { total, answered, correct, wrong, unscored, unanswered, accuracy, durationMs } = result
  const pct = accuracy === null ? null : Math.round(accuracy * 100)

  return (
    <div className="summary" role="region" aria-label="本组结果">
      <div className="card card-pad summary-head">
        <h2 className="summary-title">{title}</h2>
        {subtitle && <p className="page-desc">{subtitle}</p>}

        <div className="summary-grid">
          <div className="summary-metric">
            <span className="summary-num">{answered}</span>
            <span className="summary-label">已作答</span>
            <span className="summary-hint">共 {total} 题</span>
          </div>
          <div className="summary-metric tone-ok">
            <span className="summary-num">{correct}</span>
            <span className="summary-label">正确</span>
            <span className="summary-hint">自动评分</span>
          </div>
          <div className="summary-metric tone-bad">
            <span className="summary-num">{wrong}</span>
            <span className="summary-label">错误</span>
            <span className="summary-hint">自动评分</span>
          </div>
          <div className="summary-metric tone-uns">
            <span className="summary-num">{unscored}</span>
            <span className="summary-label">未自动评分</span>
            <span className="summary-hint">主观题</span>
          </div>
          <div className="summary-metric">
            <span className="summary-num">{unanswered}</span>
            <span className="summary-label">未作答</span>
            <span className="summary-hint">跳过或未提交</span>
          </div>
          <div className="summary-metric">
            <span className="summary-num">{pct === null ? '—' : `${pct}%`}</span>
            <span className="summary-label">正确率</span>
            <span className="summary-hint">仅统计自动评分题</span>
          </div>
        </div>

        <div className="summary-foot">
          <span className="muted-2">用时 {fmtDuration(durationMs)}</span>
        </div>
      </div>

      <div className="card card-pad summary-advice">
        <h2 className="card-title">下一步建议</h2>
        <ul className="summary-advice-list">
          {wrong > 0 && (
            <li>
              本次有 <b>{wrong}</b> 道题答错，建议立刻进入错题本复刷，间隔越短记忆修正效果越好。
            </li>
          )}
          {unscored > 0 && (
            <li>
              有 <b>{unscored}</b> 道主观题未自动评分——这是题库本身的限制，不代表答错。
              {aiOn ? '可回到题目使用「AI 参考评阅」自评结构。' : '可回到题目对照答题结构自评。'}
            </li>
          )}
          {unanswered > 0 && (
            <li>
              <b>{unanswered}</b> 道题未作答，不计入对错；如果时间不够，可以先把它们过一遍再补。
            </li>
          )}
          {wrong === 0 && unscored === 0 && unanswered === 0 && (
            <li>本组全部正确，可以进入下一组或做一次全真模拟检验综合表现。</li>
          )}
          {wrong === 0 && answered > 0 && (
            <li>本组没有错误，建议扩大覆盖范围（分章练习 / 专项训练）而不是重复已经会做的题。</li>
          )}
        </ul>
        <div className="btn-row" style={{ marginTop: 14 }}>
          {onReviewWrong && wrong > 0 && (
            <button className="btn btn-primary" onClick={onReviewWrong}>
              去错题本复刷（{wrong}）
            </button>
          )}
          <button className="btn" onClick={onRestart}>
            再来一组
          </button>
          <button className="btn btn-ghost" onClick={onExit}>
            {exitLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
