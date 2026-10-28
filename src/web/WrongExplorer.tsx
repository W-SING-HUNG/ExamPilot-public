/**
 * 错题本 (web): distribution chart (by chapter or type) linked to a filterable,
 * paginated compact table; a row opens the full question; practice the filtered
 * set or a single question. Desktop edition keeps the original page.
 */
import { useMemo, useState } from 'react'
import { allQuestions, chapterOrder, TYPE_LABEL } from '../lib/bank'
import { displayCorrectAnswer, displayUserAnswer } from '../lib/answer-display'
import type { Question, QRecord } from '../lib/types'
import { BarChart, DataTable, Drawer, Empty, fmtDate, SearchBox, Segmented, Select, Toolbar } from './kit'

const STATUS: Record<string, string> = { struggling: '难点', learning: '巩固中', mastered: '已掌握', new: '新题' }
const LETTERS = 'ABCDEFGH'

export function WrongExplorer({
  records,
  filter,
  chapter,
  setChapter,
  onPractice,
}: {
  records: Map<string, QRecord>
  filter: 'wrong' | 'struggling' | 'all-attempted'
  chapter: string
  setChapter: (c: string) => void
  onPractice: (qs: Question[]) => void
}) {
  const [by, setBy] = useState<'chapter' | 'type'>('chapter')
  const [type, setType] = useState('')
  const [status, setStatus] = useState('')
  const [minWrong, setMinWrong] = useState('1')
  const [q, setQ] = useState('')
  const [open, setOpen] = useState<Question | null>(null)

  const base = useMemo(() => {
    const out: { q: Question; r: QRecord }[] = []
    for (const qq of allQuestions) {
      const r = records.get(qq.id)
      if (!r || r.attempts === 0) continue
      if (filter === 'wrong' && r.wrongCount === 0) continue
      if (filter === 'struggling' && r.status !== 'struggling') continue
      out.push({ q: qq, r })
    }
    return out
  }, [records, filter])

  const rows = useMemo(() => {
    const needle = q.trim()
    const mw = Number(minWrong) || 0
    return base.filter(
      ({ q: qq, r }) =>
        (!chapter || qq.chapter === chapter) &&
        (!type || qq.type === type) &&
        (!status || r.status === status) &&
        (filter !== 'wrong' || r.wrongCount >= mw) &&
        (!needle || qq.stem.includes(needle) || String(qq.bankNo) === needle),
    )
  }, [base, chapter, type, status, minWrong, q, filter])

  // the chart shows the distribution under every filter except its own dimension
  const chart = useMemo(() => {
    const m = new Map<string, number>()
    const needle = q.trim()
    for (const { q: qq, r } of base) {
      if (by === 'chapter' && type && qq.type !== type) continue
      if (by === 'type' && chapter && qq.chapter !== chapter) continue
      if (status && r.status !== status) continue
      if (needle && !qq.stem.includes(needle)) continue
      const k = by === 'chapter' ? qq.chapter : qq.type
      m.set(k, (m.get(k) || 0) + 1)
    }
    const keys = by === 'chapter' ? chapterOrder : (['single', 'multi', 'judge', 'short', 'material'] as const)
    return keys
      .filter((k) => m.get(k))
      .map((k) => ({ label: by === 'chapter' ? k : TYPE_LABEL[k as Question['type']], key: k, value: m.get(k) || 0 }))
  }, [base, by, type, chapter, status, q])

  const openRec = open ? records.get(open.id) : null
  return (
    <>
      <div className="wk-box" style={{ marginTop: 14 }}>
        <div className="wk-box-h">
          <h3>错题分布（点选即筛选下方列表）</h3>
          <Segmented
            label="分布维度"
            value={by}
            onChange={setBy}
            options={[
              { v: 'chapter', label: '按章节' },
              { v: 'type', label: '按题型' },
            ]}
          />
        </div>
        {chart.length ? (
          <BarChart
            horizontal
            limit={8}
            label={by === 'chapter' ? '各章节题数' : '各题型题数'}
            unit=" 题"
            data={chart}
            selected={by === 'chapter' ? chapter || null : type || null}
            onSelect={(k) => (by === 'chapter' ? setChapter(k || '') : setType(k || ''))}
          />
        ) : (
          <Empty title="暂无错题记录">做错的题会自动收录到这里。</Empty>
        )}
      </div>
      <div style={{ marginTop: 14 }}>
        <Toolbar>
          <SearchBox label="搜索题干或题号" value={q} onChange={setQ} />
          <Select
            label="章节"
            value={chapter}
            onChange={setChapter}
            options={[{ v: '', label: '全部章节' }, ...chapterOrder.map((c) => ({ v: c, label: c }))]}
          />
          <Select
            label="题型"
            value={type}
            onChange={setType}
            options={[{ v: '', label: '全部题型' }, ...Object.entries(TYPE_LABEL).map(([v, label]) => ({ v, label }))]}
          />
          <Select
            label="复习状态"
            value={status}
            onChange={setStatus}
            options={[
              { v: '', label: '全部' },
              { v: 'struggling', label: '难点' },
              { v: 'learning', label: '巩固中' },
              { v: 'mastered', label: '已掌握' },
            ]}
          />
          {filter === 'wrong' && (
            <Select
              label="错误次数"
              value={minWrong}
              onChange={setMinWrong}
              options={[
                { v: '1', label: '≥1 次' },
                { v: '2', label: '≥2 次' },
                { v: '3', label: '≥3 次' },
                { v: '5', label: '≥5 次' },
              ]}
            />
          )}
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={!rows.length}
            onClick={() => onPractice(rows.map((x) => x.q))}
          >
            练习筛选结果（{rows.length}）
          </button>
        </Toolbar>
        <DataTable
          caption="错题列表"
          rows={rows}
          rowKey={(x) => x.q.id}
          onRow={(x) => setOpen(x.q)}
          empty={<Empty title="当前筛选下没有题目" />}
          cols={[
            {
              key: 'stem',
              label: '题干',
              render: (x) => <span className="wrong-stem">{x.q.stem.split('\n')[0].slice(0, 60)}</span>,
            },
            {
              key: 'wrong',
              label: '答错',
              render: (x) => <b style={{ color: 'var(--bad)' }}>{x.r.wrongCount}</b>,
              sort: (x) => x.r.wrongCount,
              align: 'right',
            },
            { key: 'type', label: '题型', render: (x) => TYPE_LABEL[x.q.type], sort: (x) => x.q.type },
            { key: 'chapter', label: '章节', render: (x) => x.q.chapter, sort: (x) => x.q.chapterIndex, minor: true },
            { key: 'status', label: '状态', render: (x) => STATUS[x.r.status] ?? x.r.status, sort: (x) => x.r.status },
            {
              key: 'last',
              label: '最近作答',
              render: (x) => fmtDate(x.r.lastSeenAt, false),
              sort: (x) => x.r.lastSeenAt,
              minor: true,
            },
          ]}
        />
      </div>
      <Drawer
        open={!!open}
        title={open ? `第 ${open.bankNo} 题 · ${TYPE_LABEL[open.type]}` : ''}
        onClose={() => setOpen(null)}
        footer={
          open && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                setOpen(null)
                onPractice([open])
              }}
            >
              重练这道题
            </button>
          )
        }
      >
        {open && (
          <>
            <p className="wk-muted">{open.chapter}</p>
            <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.8 }}>{open.stem}</div>
            {open.options.length > 0 && (
              <ol style={{ listStyle: 'none', padding: 0 }}>
                {open.options.map((o, i) => (
                  <li key={i} style={{ padding: '4px 0' }}>
                    {LETTERS[i]}. {o.replace(/^[A-H][.、．]\s*/, '')}
                  </li>
                ))}
              </ol>
            )}
            <dl className="wk-dl">
              <dt>正确答案</dt>
              <dd>{displayCorrectAnswer(open.answerNorm)}</dd>
              <dt>我上次的答案</dt>
              <dd>{displayUserAnswer(open.type, openRec?.lastAnswer)}</dd>
              <dt>作答 / 答错</dt>
              <dd>
                {openRec?.attempts ?? 0} 次 / {openRec?.wrongCount ?? 0} 次
              </dd>
              <dt>复习状态</dt>
              <dd>{STATUS[openRec?.status ?? ''] ?? '—'}</dd>
            </dl>
          </>
        )}
      </Drawer>
    </>
  )
}
