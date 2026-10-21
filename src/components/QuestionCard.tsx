import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from 'react'
import type { Question } from '../lib/types'
import { TYPE_LABEL } from '../lib/bank'
import { answerText } from '../lib/scoring'
import { Tag } from './ui'
import { triggerFloatingAi } from './FloatingAiAssistant'

interface Props {
  q: Question
  /** current selection, controlled by parent so mock-exam persistence works */
  value: string | null
  onChange: (v: string | null) => void
  /** show correctness feedback */
  reveal?: boolean
  isCorrect?: boolean | null
  /** display the answer block after submit */
  showAnswer?: boolean
  /** subjective mode: free text area */
  freeText?: boolean
  /** focused after submit so the outcome is announced, not only coloured */
  bannerRef?: RefObject<HTMLDivElement>
}

export function QuestionCard({
  q,
  value,
  onChange,
  reveal = false,
  isCorrect = null,
  showAnswer = false,
  freeText = false,
  bannerRef,
}: Props) {
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([])
  const isSingle = q.type === 'single'
  const isMulti = q.type === 'multi'

  const selected = useMemo(() => {
    if (q.type === 'judge') return value
    return value ?? ''
  }, [value, q.type])

  const answerSet = useMemo(() => {
    if (q.type !== 'single' && q.type !== 'multi') return new Set<string>()
    return new Set(String(q.answerNorm ?? '').split(''))
  }, [q.answerNorm, q.type])
  const chosenSet = useMemo(() => new Set((selected ?? '').split('')), [selected])

  /**
   * Roving tabindex for single choice.
   *
   * Only the active option sits in the tab order and the arrow keys move
   * between options — the standard radio-group model. Previously a four-option
   * question cost four tab stops and the arrow keys did nothing.
   */
  const [focusIdx, setFocusIdx] = useState(0)
  const optionCount = q.options.length

  useEffect(() => {
    if (q.type !== 'single') return
    const sel = String(selected ?? '')
    if (!sel) return
    const i = q.options.findIndex((_, idx) => String.fromCharCode(65 + idx) === sel)
    if (i >= 0) setFocusIdx(i)
  }, [q.id, q.options, q.type, selected])

  const moveFocus = useCallback(
    (delta: number) => {
      if (optionCount === 0) return
      const next = (focusIdx + delta + optionCount) % optionCount
      setFocusIdx(next)
      optionRefs.current[next]?.focus()
      if (q.type === 'single' && !reveal) onChange(String.fromCharCode(65 + next))
    },
    [focusIdx, onChange, optionCount, q.type, reveal],
  )

  const onGroupKeyDown = (e: ReactKeyboardEvent) => {
    if (reveal) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
      e.preventDefault()
      moveFocus(1)
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
      e.preventDefault()
      moveFocus(-1)
    }
  }

  const head = (
    <>
      <div className="q-stem">{q.stem}</div>
      <div className="q-meta">
        <Tag tone="accent">{TYPE_LABEL[q.type]}</Tag>
        <Tag>{q.chapter}</Tag>
        <Tag>原题 {q.bankNo}</Tag>
        {q.pageStart && (
          <Tag>
            PDF 第 {q.pageStart}
            {q.pageEnd && q.pageEnd !== q.pageStart ? `–${q.pageEnd}` : ''} 页
          </Tag>
        )}
        {q.isFlagged && <Tag tone="warn">{q.flagReason || '需人工确认'}</Tag>}
      </div>
    </>
  )

  /**
   * Three distinct outcomes, three distinct messages. A subjective question has
   * no auto grade, so it must never be presented as either right or wrong.
   */
  const bannerTone = isCorrect === true ? 'ok' : isCorrect === false ? 'bad' : 'warn'
  const bannerText =
    isCorrect === true ? '回答正确' : isCorrect === false ? '回答错误' : '本题未自动评分（主观题无标准答案）'

  return (
    <div className="card card-pad">
      {head}
      {reveal && (
        <div
          ref={bannerRef}
          tabIndex={-1}
          className={`result-banner ${bannerTone}`}
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          <span>{bannerText}</span>
          {showAnswer && q.hasOfficialAnswer && (
            <span style={{ fontWeight: 400 }}>
              正确答案：<b>{answerText(q)}</b>
            </span>
          )}
        </div>
      )}

      {freeText || q.type === 'short' || q.type === 'material' ? (
        <textarea
          className="textarea"
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value || null)}
          placeholder="请作答：建议分点书写，先列核心概念，再结合材料分析……"
          disabled={reveal}
          aria-label="主观题作答"
        />
      ) : q.type === 'judge' ? (
        <div className="judge-row">
          {[
            ['正确', 'true'],
            ['错误', 'false'],
          ].map(([label, v]) => {
            const isSel = selected === v
            const cls = reveal
              ? v === (q.answerNorm ? 'true' : 'false')
                ? 'correct'
                : isSel
                  ? 'wrong'
                  : ''
              : isSel
                ? 'selected'
                : ''
            return (
              <button key={v} className={`judge-btn ${cls}`} onClick={() => onChange(v)} disabled={reveal}>
                {label}
              </button>
            )
          })}
        </div>
      ) : (
        <div role={isSingle ? 'radiogroup' : 'group'} aria-label="选项" onKeyDown={onGroupKeyDown}>
          {q.options.map((opt, i) => {
            const key = String.fromCharCode(65 + i)
            const isSel = chosenSet.has(key)
            let cls = ''
            if (reveal) {
              if (answerSet.has(key)) cls = 'correct'
              else if (isSel) cls = 'wrong'
            } else if (isSel) cls = 'selected'
            const stateLabel = reveal ? (answerSet.has(key) ? '（正确答案）' : isSel ? '（你的选择，错误）' : '') : ''
            return (
              <button
                key={key}
                ref={(el) => {
                  optionRefs.current[i] = el
                }}
                type="button"
                className={`opt ${cls}`}
                // Radio semantics for single, checkbox for multi. Never both:
                // aria-pressed on a checkbox role is contradictory.
                aria-checked={isSingle || isMulti ? isSel : undefined}
                role={isSingle ? 'radio' : isMulti ? 'checkbox' : undefined}
                tabIndex={isSingle ? (i === focusIdx ? 0 : -1) : 0}
                onClick={() => {
                  if (reveal) return
                  if (isSingle) {
                    setFocusIdx(i)
                    onChange(key)
                  } else {
                    const cur = new Set((value ?? '').split(''))
                    if (cur.has(key)) cur.delete(key)
                    else cur.add(key)
                    onChange(Array.from(cur).sort().join(''))
                  }
                }}
                disabled={reveal}
              >
                <span className="opt-key" aria-hidden="true">
                  {key}
                </span>
                <span className="opt-text">
                  {opt}
                  {stateLabel && <span className="sr-only">{stateLabel}</span>}
                </span>
              </button>
            )
          })}
        </div>
      )}

      {reveal && (
        <div className="btn-row" style={{ marginTop: 14, flexWrap: 'wrap', gap: 8 }}>
          <button
            className="ai-btn-trigger"
            onClick={() => {
              let optStr = ''
              if (q.type === 'judge') {
                optStr = '【判断题，无需选项】'
              } else if (Array.isArray(q.options) && q.options.length > 0) {
                optStr = q.options.map((o, i) => `${String.fromCharCode(65 + i)}. ${o}`).join('\n')
              }

              const normAnswerStr =
                q.answerNorm === true ? '正确' : q.answerNorm === false ? '错误' : q.answerNorm || '无标准答案'

              let normUserAnswer = '未作答'
              if (value === 'true') normUserAnswer = '正确'
              else if (value === 'false') normUserAnswer = '错误'
              else if (value) normUserAnswer = String(value)

              const contextPrompt =
                `【题目详情】\n` +
                `章节：${q.chapter}（题型：${q.type === 'judge' ? '判断题' : q.type === 'single' ? '单选题' : q.type === 'multi' ? '多选题' : '主观题'}）\n` +
                `题干：${q.stem}\n` +
                (q.type !== 'judge' && optStr ? `选项：\n${optStr}\n` : '') +
                `题库标准答案：${normAnswerStr}\n` +
                `我的作答：${normUserAnswer}\n\n` +
                `请为我详细分析本题知识点、判断依据及各选项（若为判断题则直接分析对错判定依据与常考陷阱）。`

              triggerFloatingAi(contextPrompt, q.stem.slice(0, 15))
            }}
            title="点击直接在右下角常驻悬浮 AI 窗口中开始解析与连续提问"
          >
            <span aria-hidden="true">✨</span>
            <span>AI 题目答疑 / 深度解析（悬浮窗）</span>
          </button>
          {!q.hasOfficialAnswer && <Tag tone="warn">本题题库无标准答案，AI 仅作参考</Tag>}
        </div>
      )}
    </div>
  )
}
