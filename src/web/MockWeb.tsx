/**
 * 模拟考试 (web): score trend + compact paged history, and a one-question-at-a-time
 * review with a number grid and filters (wrong / right / unanswered / subjective).
 * Scores are read from the saved runs; nothing is re-graded.
 */
import { useMemo, useState, type ReactNode } from 'react'
import { questionById, TYPE_LABEL } from '../lib/bank'
import { displayCorrectAnswer, displayUserAnswer } from '../lib/answer-display'
import type { AiReview, MockRun, Question } from '../lib/types'
import { DataTable, Empty, LineChart, Segmented, Select, fmtDate } from './kit'

const pct = (m: MockRun) => {
  const graded = m.objectiveMaxScore ?? m.maxScore ?? 1
  return Math.round(((m.score ?? 0) / Math.max(1, graded)) * 100)
}

export function MockHistoryWeb({
  mocks,
  onView,
  onDelete,
}: {
  mocks: MockRun[]
  onView: (id: string) => void
  onDelete: (id: string) => void
}) {
  const [range, setRange] = useState<'30' | '90' | 'all'>('all')
  const since = range === 'all' ? 0 : Date.now() - Number(range) * 86_400_000
  const rows = useMemo(
    () => mocks.filter((m) => m.startedAt >= since).sort((a, b) => b.startedAt - a.startedAt),
    [mocks, since],
  )
  const trend = [...rows].reverse().slice(-30)
  if (!mocks.length) return <Empty title="还没有模拟考试记录" />
  const best = rows.length ? Math.max(...rows.map(pct)) : 0
  const avg = rows.length ? Math.round(rows.reduce((s, m) => s + pct(m), 0) / rows.length) : 0
  return (
    <>
      <div className="wk-box-h">
        <span className="wk-muted">
          {rows.length} 场 · 平均 {avg}% · 最好 {best}%（客观题得分率）
        </span>
        <Segmented
          label="时间范围"
          value={range}
          onChange={setRange}
          options={[
            { v: '30', label: '30 天' },
            { v: '90', label: '90 天' },
            { v: 'all', label: '全部' },
          ]}
        />
      </div>
      {trend.length > 1 && (
        <LineChart
          label="模考得分率趋势（点一场查看复盘）"
          unit="%"
          max={100}
          onSelect={(k) => k && onView(k)}
          data={trend.map((m) => ({
            label: new Date(m.startedAt + 8 * 3_600_000).toISOString().slice(5, 10).replace('-', '/'),
            key: m.id,
            value: pct(m),
          }))}
        />
      )}
      <DataTable
        caption="历史模拟成绩"
        rows={rows}
        rowKey={(m) => m.id}
        onRow={(m) => onView(m.id)}
        cols={[
          { key: 'at', label: '时间', render: (m) => fmtDate(m.startedAt), sort: (m) => m.startedAt },
          {
            key: 'score',
            label: '得分',
            render: (m) => (
              <>
                <b>{m.score ?? 0}</b> / {m.objectiveMaxScore ?? m.maxScore}
                {m.subjectiveMaxScore ? <span className="wk-muted"> +{m.subjectiveMaxScore} 未评分</span> : null}
              </>
            ),
            sort: pct,
          },
          { key: 'pct', label: '得分率', render: (m) => `${pct(m)}%`, sort: pct, align: 'right' },
          { key: 'n', label: '题量', render: (m) => Object.keys(m.submissions).length, minor: true },
          {
            key: 'dur',
            label: '用时',
            render: (m) => `${Math.round(((m.endedAt ?? m.startedAt) - m.startedAt) / 60000)} 分钟`,
            minor: true,
          },
          {
            key: 'del',
            label: '',
            render: (m) => (
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={(e) => {
                  e.stopPropagation()
                  onDelete(m.id)
                }}
              >
                删除
              </button>
            ),
            minor: true,
          },
        ]}
      />
    </>
  )
}

type Filter = 'all' | 'wrong' | 'right' | 'blank' | 'subj'
export interface ReviewItem {
  qid: string
  per?: { isCorrect?: boolean | null; unanswered?: boolean; points?: number }
  mine: string | null
}

export function MockReviewWeb({
  items,
  aiReviews,
  extra,
  header,
}: {
  items: ReviewItem[]
  aiReviews: AiReview[]
  extra?: (q: Question, mine: string | null) => ReactNode
  header?: ReactNode
}) {
  const [filter, setFilter] = useState<Filter>('all')
  const [type, setType] = useState('')
  const all = items.map((it, i) => ({ ...it, n: i + 1, q: questionById.get(it.qid) }))
  const kind = (x: (typeof all)[number]): Filter => {
    const isSub = x.q && (x.q.type === 'short' || x.q.type === 'material')
    if (isSub) return 'subj'
    if (x.per?.unanswered || x.mine === null) return 'blank'
    return x.per?.isCorrect ? 'right' : 'wrong'
  }
  const shown = all.filter((x) => (filter === 'all' || kind(x) === filter) && (!type || x.q?.type === type))
  const [cur, setCur] = useState(0)
  const i = Math.min(cur, Math.max(0, shown.length - 1))
  const x = shown[i]
  const count = (f: Filter) => all.filter((y) => kind(y) === f).length
  return (
    <div className="mock-review-web">
      {header}
      <div className="wk-toolbar">
        <Segmented
          label="按结果筛选"
          value={filter}
          onChange={(v) => {
            setFilter(v)
            setCur(0)
          }}
          options={[
            { v: 'all', label: `全部 ${all.length}` },
            { v: 'wrong', label: `错误 ${count('wrong')}` },
            { v: 'right', label: `正确 ${count('right')}` },
            { v: 'blank', label: `未作答 ${count('blank')}` },
            { v: 'subj', label: `主观题 ${count('subj')}` },
          ]}
        />
        <Select
          label="题型"
          value={type}
          onChange={(v) => {
            setType(v)
            setCur(0)
          }}
          options={[{ v: '', label: '全部题型' }, ...Object.entries(TYPE_LABEL).map(([v, label]) => ({ v, label }))]}
        />
      </div>
      <nav className="mock-grid" aria-label="题号">
        {shown.map((y, k) => {
          const f = kind(y)
          return (
            <button
              key={y.qid}
              type="button"
              className={`mock-cell mc-${f} ${k === i ? 'on' : ''}`}
              aria-current={k === i ? 'true' : undefined}
              aria-label={`第 ${y.n} 题，${{ wrong: '错误', right: '正确', blank: '未作答', subj: '主观题', all: '' }[f]}`}
              onClick={() => setCur(k)}
            >
              {y.n}
            </button>
          )
        })}
      </nav>
      {!x ? (
        <Empty title="没有符合条件的题目" />
      ) : (
        <article className="wk-box" aria-live="polite" style={{ marginTop: 10 }}>
          {!x.q ? (
            <p className="wk-muted">第 {x.n} 题 · 该题已不在当前题库中，无法显示题干</p>
          ) : (
            <>
              <div className="wk-box-h">
                <span className="wk-muted">
                  第 {x.n} 题 · {TYPE_LABEL[x.q.type]} · {x.q.chapter}
                </span>
                {(() => {
                  const f = kind(x)
                  return f === 'subj' ? (
                    <span className="wk-pill warn">{x.mine ? '主观题 · 未自动评分' : '主观题 · 未作答'}</span>
                  ) : f === 'blank' ? (
                    <span className="wk-pill">未作答 · 不计对错</span>
                  ) : f === 'right' ? (
                    <span className="wk-pill ok">正确 +{x.per?.points ?? ''}</span>
                  ) : (
                    <span className="wk-pill bad">错误 0 分</span>
                  )
                })()}
              </div>
              <div className="q-stem" style={{ fontSize: 15, whiteSpace: 'pre-wrap' }}>
                {x.q.stem}
              </div>
              {x.q.options.length > 0 && (
                <ol className="mock-review-opts" type="A">
                  {x.q.options.map((o, k) => (
                    <li key={k}>{o}</li>
                  ))}
                </ol>
              )}
              <div className="muted" style={{ marginTop: 6 }}>
                你的作答：<b style={{ whiteSpace: 'pre-wrap' }}>{displayUserAnswer(x.q.type, x.mine)}</b>
                {kind(x) !== 'subj' && (
                  <span style={{ marginLeft: 8 }}>
                    正确答案：<b>{x.q.hasOfficialAnswer ? displayCorrectAnswer(x.q.answerNorm) : '题库未提供'}</b>
                  </span>
                )}
              </div>
              {kind(x) === 'subj' &&
                (() => {
                  const rv = x.mine ? aiReviews.find((r) => r.qid === x.qid && r.userAnswer === x.mine) : undefined
                  return (
                    <p className="wk-muted">
                      {rv
                        ? `当时的 AI 参考评阅：${rv.result.score} 分（仅供参考）`
                        : '主观题题库无标准答案，未自动评分。'}
                    </p>
                  )
                })()}
              {extra?.(x.q, x.mine)}
            </>
          )}
          <div className="wk-actions" style={{ justifyContent: 'space-between', marginTop: 12 }}>
            <button type="button" className="btn" disabled={i <= 0} onClick={() => setCur(i - 1)}>
              上一题
            </button>
            <span className="wk-muted">
              {i + 1} / {shown.length}
            </span>
            <button
              type="button"
              className="btn btn-primary"
              disabled={i >= shown.length - 1}
              onClick={() => setCur(i + 1)}
            >
              下一题
            </button>
          </div>
        </article>
      )}
    </div>
  )
}
