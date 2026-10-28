/**
 * 复习计划 (web): future review load for 7 / 30 days, computed from each record's
 * own nextReviewAt (the existing scheduler decides it; nothing is recomputed here).
 * Overdue items count toward today. Click a day to list its questions.
 */
import { useMemo, useState } from 'react'
import { objectiveQuestions, chapterOrder, TYPE_LABEL } from '../lib/bank'
import type { QRecord } from '../lib/types'
import { BarChart, DataTable, Empty, Segmented, Select, Toolbar, dayKey, lastDays } from './kit'

export function ReviewLoad({ records }: { records: Map<string, QRecord> }) {
  const [span, setSpan] = useState<7 | 30>(7)
  const [day, setDay] = useState<string | null>(null)
  const [chapter, setChapter] = useState('')
  const now = Date.now()
  const today = dayKey(now)
  const days = useMemo(() => lastDays(span, now + (span - 1) * 86_400_000), [span, now])
  const items = useMemo(() => {
    const out: { id: string; chapter: string; type: string; stem: string; due: string; nextAt: number }[] = []
    for (const q of objectiveQuestions) {
      const r = records.get(q.id)
      if (!r || !r.nextReviewAt || r.attempts === 0) continue
      const k = r.nextReviewAt <= now ? today : dayKey(r.nextReviewAt)
      out.push({
        id: q.id,
        chapter: q.chapter,
        type: q.type,
        stem: q.stem.split('\n')[0],
        due: k,
        nextAt: r.nextReviewAt,
      })
    }
    return out
  }, [records, now, today])
  const counts = useMemo(() => {
    const m = new Map<string, number>()
    for (const it of items) if (!chapter || it.chapter === chapter) m.set(it.due, (m.get(it.due) || 0) + 1)
    return m
  }, [items, chapter])
  const rows = items
    .filter((it) => (day ? it.due === day : days.includes(it.due)) && (!chapter || it.chapter === chapter))
    .sort((a, b) => a.nextAt - b.nextAt)
  return (
    <div className="wk-box" style={{ marginTop: 14 }}>
      <div className="wk-box-h">
        <h3>未来复习负担</h3>
        <Segmented
          label="时间范围"
          value={span}
          onChange={(v) => {
            setSpan(v)
            setDay(null)
          }}
          options={[
            { v: 7, label: '7 天' },
            { v: 30, label: '30 天' },
          ]}
        />
      </div>
      <BarChart
        label={`未来 ${span} 天每日预计复习题数`}
        unit=" 题"
        selected={day}
        onSelect={setDay}
        data={days.map((d) => ({
          label: d === today ? '今天' : d.slice(5).replace('-', '/'),
          key: d,
          value: counts.get(d) || 0,
        }))}
      />
      <Toolbar>
        <Select
          label="章节"
          value={chapter}
          onChange={setChapter}
          options={[{ v: '', label: '全部章节' }, ...chapterOrder.map((c) => ({ v: c, label: c }))]}
        />
        <span className="wk-muted">
          {day
            ? `${day === today ? '今天（含已逾期）' : day} 的复习：${rows.length} 题`
            : `未来 ${span} 天共 ${rows.length} 题。点柱子只看某一天。`}
        </span>
      </Toolbar>
      <DataTable
        caption="复习任务"
        rows={rows}
        rowKey={(r) => r.id}
        empty={<Empty title="这段时间没有到期复习" />}
        cols={[
          { key: 'stem', label: '题目', render: (r) => r.stem.slice(0, 50) },
          {
            key: 'due',
            label: '到期',
            render: (r) => (r.due === today ? (r.nextAt <= now ? '已到期' : '今天') : r.due.slice(5)),
            sort: (r) => r.nextAt,
          },
          { key: 'type', label: '题型', render: (r) => TYPE_LABEL[r.type as keyof typeof TYPE_LABEL], minor: true },
          { key: 'chapter', label: '章节', render: (r) => r.chapter, minor: true },
        ]}
      />
    </div>
  )
}
