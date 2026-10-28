import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Question } from '../lib/types'
import { QuestionCard } from './QuestionCard'
import { AiGradePanel } from './AiQaPanel'
import { useAiUsable } from '../lib/ai-access'
import { Bar, Tag } from './ui'
import { useStore } from '../store/StoreContext'
import { summarise, type Outcome, type SessionResult } from '../lib/session-outcome'
import { clearDraft, saveDraft, type SessionDraft } from '../lib/session-draft'
import { setActiveSession } from '../store/session-guard'

export interface RunnerHandle {
  /** Reserved for parent-driven control (e.g. mock-exam timer callbacks). */
  readonly _brand?: unique symbol
}

interface Props {
  questions: Question[]
  mode: string
  sessionId: string
  /** mock mode: no per-question history write until submit-all */
  deferred?: boolean
  /** answer map controlled externally (mock exam) */
  answers?: Record<string, string | null>
  onAnswer?: (qid: string, v: string | null) => void
  /**
   * Called exactly once when the session ends, with the real tally of what
   * happened. Receives a partial result when the user ends early.
   */
  onFinish?: (result: SessionResult) => void
  finishLabel?: string
  /** used for AI-review persistence */
  saveAiReview?: (qid: string, answer: string, result: unknown) => Promise<void>
  /** Draft to resume from (reload recovery). */
  restore?: SessionDraft | null
  /** Where the session came from, shown in the header. */
  contextLabel?: string
}

/**
 * The answering surface.
 *
 * Design rules enforced here (and covered by tests):
 *  - A question's outcome is recorded once. Once recorded the question is
 *    read-only, so navigating back and submitting again can never double-count
 *    an attempt.
 *  - `correct`, `wrong` and `unscored` are three distinct outcomes. An
 *    un-scored subjective answer is never counted as wrong.
 *  - Skipping and ending early are always available; ending early still
 *    produces a real summary of the work already persisted.
 *  - The session is mirrored into a draft on every change so a reload cannot
 *    silently destroy it.
 */
export function QuestionRunner({
  questions,
  mode,
  sessionId,
  deferred = false,
  answers,
  onAnswer,
  onFinish,
  finishLabel = '完成训练',
  saveAiReview,
  restore = null,
  contextLabel,
}: Props) {
  // AI entry points render only when this account may use AI (always on desktop).
  const aiOn = useAiUsable()
  const { submitAnswer, saveSubjectiveAttempt } = useStore()

  const [idx, setIdx] = useState(() => Math.min(restore?.idx ?? 0, Math.max(0, questions.length - 1)))
  const [local, setLocal] = useState<Record<string, string | null>>(() => ({
    ...(restore?.answers ?? {}),
    ...(answers ?? {}),
  }))
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>(() => ({ ...(restore?.outcomes ?? {}) }))
  const [skipped, setSkipped] = useState<string[]>(() => [...(restore?.skipped ?? [])])
  const [submitting, setSubmitting] = useState(false)
  const [announce, setAnnounce] = useState('')
  const startedAt = useRef(restore?.startedAt ?? Date.now())
  const anchorRef = useRef<HTMLDivElement | null>(null)
  const bannerRef = useRef<HTMLDivElement | null>(null)
  const firstRender = useRef(true)

  const q = questions[Math.min(idx, questions.length - 1)]
  const value = local[q.id] ?? null
  const outcome = outcomes[q.id]
  const revealed = outcome !== undefined

  /* ---------- session lifecycle --------------------------------------- */

  useEffect(() => {
    setActiveSession(mode)
    return () => setActiveSession(null)
  }, [mode])

  const setValue = useCallback(
    (v: string | null) => {
      if (outcomes[q.id] !== undefined) return // locked: already submitted
      if (deferred) {
        onAnswer?.(q.id, v)
        return
      }
      setLocal((prev) => ({ ...prev, [q.id]: v }))
    },
    [deferred, onAnswer, outcomes, q.id],
  )

  // Mirror the in-flight state into the draft. Learning records are untouched
  // here: the draft only remembers where the user was.
  useEffect(() => {
    saveDraft({
      mode,
      sessionId,
      qids: questions.map((x) => x.id),
      idx,
      answers: local,
      outcomes,
      skipped,
      startedAt: startedAt.current,
    })
  }, [mode, sessionId, questions, idx, local, outcomes, skipped])

  const finish = useCallback(() => {
    const result = summarise({
      total: questions.length,
      outcomes,
      skipped,
      durationMs: Date.now() - startedAt.current,
    })
    clearDraft(mode, sessionId)
    setActiveSession(null)
    onFinish?.(result)
  }, [mode, onFinish, outcomes, questions.length, skipped, sessionId])

  /* ---------- per-question submit ------------------------------------- */

  const submit = async () => {
    if (!q || revealed || submitting) return
    setSubmitting(true)
    try {
      if (q.type === 'short' || q.type === 'material') {
        const ans = value ?? ''
        if (!deferred) await saveSubjectiveAttempt(q, ans, mode, sessionId, !!saveAiReview)
        setOutcomes((r) => ({ ...r, [q.id]: 'unscored' }))
        setAnnounce('本题未自动评分，已记录你的作答')
        return
      }
      if (deferred) {
        setOutcomes((r) => ({ ...r, [q.id]: 'unscored' }))
        return
      }
      const out = await submitAnswer(q, value, mode, sessionId, !!saveAiReview)
      const next: Outcome = out.isCorrect === true ? 'correct' : out.isCorrect === false ? 'wrong' : 'unscored'
      setOutcomes((r) => ({ ...r, [q.id]: next }))
      setAnnounce(next === 'correct' ? '回答正确' : next === 'wrong' ? '回答错误' : '本题未自动评分')
    } finally {
      setSubmitting(false)
    }
  }

  // Move focus to the feedback once it appears, so a keyboard or screen-reader
  // user is told the outcome instead of being silently advanced.
  useEffect(() => {
    if (!revealed) return
    const el = bannerRef.current
    if (el) el.focus()
  }, [revealed, idx])

  /* ---------- navigation ---------------------------------------------- */

  const goTo = useCallback(
    (next: number) => {
      const clamped = Math.max(0, Math.min(questions.length - 1, next))
      setIdx(clamped)
      setAnnounce('')
    },
    [questions.length],
  )

  const advance = () => {
    if (idx + 1 >= questions.length) finish()
    else goTo(idx + 1)
  }

  const skip = () => {
    if (!revealed) setSkipped((s) => (s.includes(q.id) ? s : [...s, q.id]))
    if (idx + 1 >= questions.length) finish()
    else goTo(idx + 1)
  }

  // Keep the question itself in view and focused when the index changes. This
  // is what makes "下一题" land on the next question instead of leaving the
  // viewport wherever the previous question happened to be.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false
      return
    }
    const el = anchorRef.current
    if (!el) return
    const top = el.getBoundingClientRect().top
    if (top < 0 || top > 120) el.scrollIntoView({ block: 'start', behavior: 'auto' })
    el.focus({ preventScroll: true })
  }, [idx])

  /* ---------- derived counters ---------------------------------------- */

  const stats = useMemo(() => {
    const vals = Object.values(outcomes)
    const correct = vals.filter((v) => v === 'correct').length
    const wrong = vals.filter((v) => v === 'wrong').length
    const unscored = vals.filter((v) => v === 'unscored').length
    return { done: correct + wrong + unscored, correct, wrong, unscored }
  }, [outcomes])

  if (!q) return null
  const isSubjective = q.type === 'short' || q.type === 'material'
  const isLast = idx + 1 >= questions.length
  const progress = questions.length ? stats.done / questions.length : 0

  return (
    <div className="runner">
      <div className="runner-bar">
        <div className="runner-bar-main">
          <span className="runner-pos">
            第 <b>{idx + 1}</b> / {questions.length} 题
          </span>
          {contextLabel && <Tag tone="plain">{contextLabel}</Tag>}
          {skipped.length > 0 && <Tag tone="warn">已跳过 {skipped.length}</Tag>}
        </div>
        <div className="runner-counts">
          <span>已答 {stats.done}</span>
          <span className="c-ok">对 {stats.correct}</span>
          <span className="c-bad">错 {stats.wrong}</span>
          <span className="c-uns">未评 {stats.unscored}</span>
        </div>
        <div className="runner-actions">
          <button type="button" className="btn btn-sm btn-ghost" onClick={finish}>
            结束本组
          </button>
        </div>
      </div>

      <Bar value={progress} tone="accent" />

      <div
        className="progress-dots"
        role="group"
        aria-label={`答题进度：共 ${questions.length} 题，已答 ${stats.done} 题`}
      >
        {questions.map((qq, i) => {
          const o = outcomes[qq.id]
          const cls = o === 'correct' ? 'ok' : o === 'wrong' ? 'bad' : o === 'unscored' ? 'uns' : ''
          const stateText =
            o === 'correct' ? '正确' : o === 'wrong' ? '错误' : o === 'unscored' ? '未自动评分' : '未作答'
          return (
            <i
              key={qq.id}
              className={`${cls} ${i === idx ? 'cur' : ''}`}
              role="img"
              aria-label={`第 ${i + 1} 题：${stateText}`}
            />
          )
        })}
      </div>

      <div ref={anchorRef} tabIndex={-1} className="runner-anchor">
        <QuestionCard
          q={q}
          value={value}
          onChange={setValue}
          reveal={revealed}
          isCorrect={outcome === 'correct' ? true : outcome === 'wrong' ? false : null}
          showAnswer
          bannerRef={bannerRef}
        />
      </div>

      {revealed && isSubjective && aiOn && (
        <div style={{ marginTop: 12 }}>
          <AiGradePanel q={q} userAnswer={value ?? ''} sessionId={sessionId} />
        </div>
      )}

      <div className="runner-foot">
        <button type="button" className="btn" onClick={() => goTo(idx - 1)} disabled={idx === 0 || submitting}>
          上一题
        </button>

        {!revealed ? (
          <>
            <button className="btn btn-primary btn-lg" onClick={() => void submit()} disabled={!value || submitting}>
              {submitting ? '正在提交…' : '提交答案'}
            </button>
            <button type="button" className="btn" onClick={skip} disabled={submitting}>
              跳过本题
            </button>
            <span className="muted-2">
              {isSubjective
                ? aiOn
                  ? '主观题不自动评分，提交后可使用 AI 参考评阅'
                  : '主观题不自动评分，提交后对照答题结构自评'
                : '选择答案后提交，立即查看结果'}
            </span>
          </>
        ) : (
          <>
            <button className="btn btn-primary btn-lg" onClick={advance} disabled={submitting}>
              {isLast ? finishLabel : '下一题'}
            </button>
            {!isLast && (
              <button type="button" className="btn" onClick={skip} disabled={submitting}>
                跳过本题
              </button>
            )}
            <span className="muted-2">
              {outcome === 'unscored' ? '本题未自动评分，已记录作答' : '本题已记录，答案不可修改'}
            </span>
          </>
        )}
      </div>

      {/* Announced to assistive tech; visually hidden because the banner above
          already shows the same words. */}
      <span className="sr-only" role="status" aria-live="polite">
        {announce}
      </span>
    </div>
  )
}
