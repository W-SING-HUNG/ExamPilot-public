/**
 * 学习总览 web dashboard: today's tasks, range-switchable practice trend, chapter
 * mastery chart that links into practice / wrong book. All numbers come from the
 * real records (groupActivity / computeDiagnosis); nothing is estimated.
 */
import { useMemo, useState } from 'react'
import { groupActivity, type computeDiagnosis } from '../lib/analysis'
import { TYPE_LABEL } from '../lib/bank'
import { useStore } from '../store/StoreContext'
import type { RouteName } from '../store/router'
import { BarChart, LineChart, Segmented } from './kit'

type Nav = (r: RouteName, p?: Record<string, string>) => void | Promise<void>

export function WebDashboard({
  diag,
  nav,
}: {
  diag: ReturnType<typeof computeDiagnosis>
  nav: Nav
  dueCount?: number
}) {
  const { history } = useStore()
  const [days, setDays] = useState<7 | 30 | 90>(7)
  const [metric, setMetric] = useState<'count' | 'rate'>('count')
  const [chMetric, setChMetric] = useState<'coverage' | 'rate'>('rate')
  const [selCh, setSelCh] = useState<string | null>(null)
  const act = useMemo(() => groupActivity(history, days), [history, days])
  const activeDays = act.filter((d) => d.count > 0).length
  const total = act.reduce((s, d) => s + d.count, 0)
  const chapters = diag.chapters.filter((c) => c.objectiveTotal > 0)
  // weakest first, so the collapsed view shows what needs work
  const chData = [...chapters]
    .sort((a, b) =>
      chMetric === 'coverage'
        ? a.coverage - b.coverage
        : (a.attempted ? a.correctRate : 2) - (b.attempted ? b.correctRate : 2),
    )
    .map((c) => ({
      label: c.chapter,
      key: c.chapter,
      value: chMetric === 'coverage' ? Math.round(c.coverage * 100) : c.attempted ? Math.round(c.correctRate * 100) : 0,
    }))
  const sel = chapters.find((c) => c.chapter === selCh)
  return (
    <section className="web-dash" aria-label="学习趋势与章节掌握">
      <div className="wk-grid" style={{ marginTop: 12 }}>
        <div className="wk-box">
          <div className="wk-box-h">
            <h3>练习趋势</h3>
            <span className="wk-actions">
              <Segmented
                label="指标"
                value={metric}
                onChange={setMetric}
                options={[
                  { v: 'count', label: '题数' },
                  { v: 'rate', label: '正确率' },
                ]}
              />
              <Segmented
                label="时间范围"
                value={days}
                onChange={setDays}
                options={[
                  { v: 7, label: '7 天' },
                  { v: 30, label: '30 天' },
                  { v: 90, label: '90 天' },
                ]}
              />
            </span>
          </div>
          {metric === 'count' ? (
            <BarChart
              label={`近 ${days} 天每日作答题数`}
              unit=" 题"
              data={act.map((d) => ({ label: d.date.slice(5), key: d.date, value: d.count }))}
              onSelect={(k) => k && void nav('history')}
            />
          ) : (
            <LineChart
              label={`近 ${days} 天每日客观题正确率`}
              unit="%"
              max={100}
              data={act
                .filter((d) => d.correct + d.wrong > 0)
                .map((d) => ({
                  label: d.date.slice(5),
                  key: d.date,
                  value: Math.round((d.correct / (d.correct + d.wrong)) * 100),
                }))}
            />
          )}
          <p className="wk-muted" style={{ margin: 0 }}>
            近 {days} 天共作答 {total} 题，活跃 {activeDays} 天。点柱子查看练习历史。
          </p>
        </div>
        <div className="wk-box">
          <div className="wk-box-h">
            <h3>章节掌握（薄弱在前）</h3>
            <Segmented
              label="章节指标"
              value={chMetric}
              onChange={setChMetric}
              options={[
                { v: 'rate', label: '正确率' },
                { v: 'coverage', label: '覆盖率' },
              ]}
            />
          </div>
          <BarChart
            horizontal
            limit={6}
            label="各章节掌握情况（薄弱在前）"
            unit="%"
            data={chData}
            selected={selCh}
            onSelect={setSelCh}
          />
          {sel ? (
            <div className="wk-notice wk-info" style={{ marginTop: 8 }}>
              <span>
                {sel.chapter}：练过 {sel.attempted}/{sel.objectiveTotal}，对 {sel.correct} 错 {sel.wrong}
              </span>
              <span className="wk-actions">
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  onClick={() => void nav('practice', { chapter: sel.chapter })}
                >
                  练这一章
                </button>
                {sel.wrong > 0 && (
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => void nav('wrong', { chapter: sel.chapter })}
                  >
                    这一章的错题
                  </button>
                )}
              </span>
            </div>
          ) : (
            <p className="wk-muted" style={{ margin: 0 }}>
              点一个章节，直接去练习或看错题。
            </p>
          )}
        </div>
        <div className="wk-box">
          <div className="wk-box-h">
            <h3>题型正确率</h3>
          </div>
          <BarChart
            horizontal
            label="题型正确率"
            unit="%"
            data={diag.types
              .filter((t) => t.type !== 'short' && t.type !== 'material')
              .map((t) => ({
                label: TYPE_LABEL[t.type],
                key: t.type,
                value: t.attempted ? Math.round(t.correctRate * 100) : 0,
              }))}
            onSelect={(k) => k && void nav('practice', { mode: 'type', type: k })}
          />
          <p className="wk-muted" style={{ margin: 0 }}>
            点题型进入按题型练习。
          </p>
        </div>
      </div>
    </section>
  )
}
