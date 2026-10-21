import { useMemo, useState } from 'react'
import { useStore } from '../store/StoreContext'
import { allQuestions, objectiveQuestions, subjectiveQuestions, chapterOrder, TYPE_LABEL } from '../lib/bank'
import { computeDiagnosis, groupActivity } from '../lib/analysis'
import { isDue } from '../lib/scheduler'
import { Bar, CardPad, PageHead, Stat, Tag, Empty, Reveal, SkStats, useDeferred } from '../components/ui'
import type { RouteName } from '../store/router'

/** A labelled progress row, used three times on the overview. */
function ProgressLine({
  label,
  value,
  tone,
  text,
}: {
  label: string
  value: number
  tone: 'accent' | 'ok' | 'warn'
  text: string
}) {
  return (
    <div>
      <div className="row-between" style={{ marginBottom: 6 }}>
        <span className="muted" style={{ fontSize: 13 }}>
          {label}
        </span>
        <span className="muted-2" style={{ fontVariantNumeric: 'tabular-nums' }}>
          {text}
        </span>
      </div>
      <Bar value={value} tone={tone} />
    </div>
  )
}

/**
 * 学习总览 — the single entry for "where am I and what should I do next".
 *
 * Two views live here rather than two sidebar entries:
 *   - 学习概览: today's task, progress, key numbers, resume.
 *   - 详细诊断: the full per-chapter / per-type diagnosis table, weak-point
 *     ranking, top mistakes and next-step advice (previously a separate page).
 *
 * Practice history is no longer a sidebar entry; it is reached from here so the
 * full record page (search, filter, export) is still one click away.
 */
export function Home({
  nav,
  params,
}: {
  nav: (r: RouteName, p?: Record<string, string>) => void | Promise<void>
  params: Record<string, string>
}) {
  const { records, history, mocks, ready } = useStore()
  const view: 'overview' | 'detail' = params.view === 'detail' ? 'detail' : 'overview'

  const diag = useMemo(() => computeDiagnosis(allQuestions, records), [records])
  const activity = useMemo(() => groupActivity(history, 7), [history])
  const todayCount = activity[activity.length - 1]?.count ?? 0

  // Due-ness uses the scheduler's own predicate so this counter can never
  // disagree with the plan or the review queue about what counts as overdue.
  const dueCount = useMemo(() => {
    const now = Date.now()
    let n = 0
    for (const q of objectiveQuestions) {
      const r = records.get(q.id)
      if (r && isDue(r, now)) n++
    }
    return n
  }, [records])

  const neverTouched = useMemo(
    () => objectiveQuestions.filter((q) => !records.get(q.id) || records.get(q.id)!.attempts === 0).length,
    [records],
  )

  const masteredRatio = objectiveQuestions.length ? diag.overall.ourMastered / objectiveQuestions.length : 0
  const coverage = diag.overall.coverage
  const showSkeleton = useDeferred(!ready)

  if (showSkeleton) {
    return (
      <>
        <PageHead title="学习总览" desc="正在读取题库与学习记录…" />
        <SkStats n={4} />
        <div className="grid grid-2" style={{ marginTop: 14 }}>
          <CardPad>
            <div className="sk sk-title" />
            <div className="sk sk-line w-80" />
            <div className="sk sk-line w-60" />
            <div className="sk sk-block" style={{ marginTop: 12 }} />
          </CardPad>
          <CardPad>
            <div className="sk sk-title" />
            <div className="sk sk-line w-80" />
            <div className="sk sk-line w-60" />
            <div className="sk sk-block" style={{ marginTop: 12 }} />
          </CardPad>
        </div>
      </>
    )
  }

  return (
    <>
      <PageHead
        title="学习总览"
        desc="以 100 分为目标：题库全覆盖、错题清零、主观题有结构。先看数据，再练薄弱环节。"
        extra={
          <div className="btn-row">
            <button className="btn btn-primary" onClick={() => nav('plan')}>
              开始今日复习
            </button>
            <button className="btn" onClick={() => nav('practice')}>
              自由刷题
            </button>
          </div>
        }
      />

      {/* Two views of the same page. Not stacked sections: only one is mounted. */}
      <div className="view-switch" role="tablist" aria-label="学习总览视图">
        <button
          role="tab"
          aria-selected={view === 'overview'}
          className={`btn btn-sm ${view === 'overview' ? 'btn-primary' : ''}`}
          onClick={() => void nav('home')}
        >
          学习概览
        </button>
        <button
          role="tab"
          aria-selected={view === 'detail'}
          className={`btn btn-sm ${view === 'detail' ? 'btn-primary' : ''}`}
          onClick={() => void nav('home', { view: 'detail' })}
        >
          详细诊断
        </button>
        <button className="btn btn-sm btn-ghost" style={{ marginLeft: 'auto' }} onClick={() => void nav('history')}>
          查看练习历史
        </button>
      </div>

      {view === 'overview' ? (
        <OverviewView
          nav={nav}
          dueCount={dueCount}
          todayCount={todayCount}
          neverTouched={neverTouched}
          coverage={coverage}
          masteredRatio={masteredRatio}
          diag={diag}
          activity={activity}
          historyLength={history.length}
          mocks={mocks}
        />
      ) : (
        <DetailView diag={diag} nav={nav} />
      )}
    </>
  )
}

/* ============================================================================
 * View 1 — 学习概览
 * ========================================================================== */

function OverviewView({
  nav,
  dueCount,
  todayCount,
  neverTouched,
  coverage,
  masteredRatio,
  diag,
  activity,
  historyLength,
  mocks,
}: {
  nav: (r: RouteName, p?: Record<string, string>) => void | Promise<void>
  dueCount: number
  todayCount: number
  neverTouched: number
  coverage: number
  masteredRatio: number
  diag: ReturnType<typeof computeDiagnosis>
  activity: ReturnType<typeof groupActivity>
  historyLength: number
  mocks: { graded: boolean }[]
}) {
  return (
    <>
      <Reveal>
        <div className="grid grid-4" style={{ marginBottom: 14 }}>
          <Stat
            value={`${Math.round(coverage * 100)}%`}
            label="题库覆盖率"
            hint={`${diag.overall.attempted} / ${objectiveQuestions.length} 道已练`}
            tone="accent"
          />
          <Stat
            value={diag.overall.correctRate ? `${Math.round(diag.overall.correctRate * 100)}%` : '—'}
            label="客观题正确率"
            hint={`对 ${diag.overall.correct} · 错 ${diag.overall.wrong}`}
          />
          <Stat value={diag.overall.ourMastered} label="已掌握题目" hint={`目标 ${objectiveQuestions.length}`} />
          <Stat
            value={dueCount}
            label="今日待复习"
            hint={`今日已答 ${todayCount} 题`}
            tone={dueCount > 0 ? 'warn' : undefined}
          />
        </div>

        <div className="grid grid-2">
          <CardPad>
            <div className="card-title">复习完成度（题库覆盖）</div>
            <div className="col" style={{ gap: 14 }}>
              <ProgressLine
                label="已练题目"
                value={coverage}
                tone="accent"
                text={`${diag.overall.attempted} / ${objectiveQuestions.length}`}
              />
              <ProgressLine
                label="掌握题目"
                value={masteredRatio}
                tone="ok"
                text={`${diag.overall.ourMastered} / ${objectiveQuestions.length}`}
              />
              <ProgressLine
                label="主观题训练"
                value={subjectiveQuestions.length ? diag.overall.subjectiveAttempted / subjectiveQuestions.length : 0}
                tone="warn"
                text={`${diag.overall.subjectiveAttempted} / ${subjectiveQuestions.length}`}
              />
            </div>
            <div className="divider" />
            <div className="muted">
              还有 <b>{neverTouched}</b> 道客观题从未练过。先用「自由刷题」扩大覆盖，再用「错题本」定点清除。
            </div>
            <div className="btn-row" style={{ marginTop: 14 }}>
              <button className="btn btn-primary" onClick={() => nav('practice')}>
                自由刷题
              </button>
              <button className="btn" onClick={() => nav('subjective')}>
                主观题训练
              </button>
              <button className="btn" onClick={() => nav('wrong')}>
                错题本
              </button>
            </div>
          </CardPad>

          <CardPad>
            <div className="card-title">近 7 天学习记录</div>
            {todayCount === 0 && historyLength === 0 && mocks.length === 0 ? (
              <Empty text="还没有练习记录，开始第一组练习吧。">
                <button className="btn btn-primary" onClick={() => nav('plan')}>
                  生成复习计划
                </button>
              </Empty>
            ) : (
              <>
                {historyLength === 0 ? (
                  <div className="muted" style={{ marginBottom: 8 }}>
                    还没有练习题目的记录；已有 {mocks.length} 场模拟考试。
                  </div>
                ) : (
                  <div className="col" style={{ gap: 10 }}>
                    {activity.map((d) => (
                      <div key={d.date} className="row-between">
                        <span className="muted" style={{ width: 76, fontFamily: 'var(--mono)', fontSize: 12 }}>
                          {d.date.slice(5)}
                        </span>
                        <div style={{ flex: 1, margin: '0 12px' }}>
                          <Bar value={d.count / Math.max(20, ...activity.map((x) => x.count), 1)} tone="accent" />
                        </div>
                        <span className="muted-2" style={{ width: 56, textAlign: 'right' }}>
                          {d.count} 题
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                <div className="divider" />
                <div className="row-between">
                  <span className="muted">已完成模拟考试</span>
                  <span className="row" style={{ gap: 8 }}>
                    <b style={{ fontVariantNumeric: 'tabular-nums' }}>{mocks.filter((m) => m.graded).length}</b>
                    <span className="muted-2">场</span>
                    {mocks.length > 0 && (
                      <button className="btn btn-sm" onClick={() => nav('mock')}>
                        查看模拟成绩
                      </button>
                    )}
                  </span>
                </div>
              </>
            )}
          </CardPad>
        </div>
      </Reveal>

      {diag.weakPoints.length > 0 && (
        <CardPad style={{ marginTop: 14 }}>
          <div className="row-between" style={{ marginBottom: 12 }}>
            <div className="card-title" style={{ margin: 0 }}>
              需优先处理的薄弱环节
            </div>
            <button className="btn btn-sm" onClick={() => void nav('home', { view: 'detail' })}>
              查看完整诊断
            </button>
          </div>
          <div className="grid grid-3">
            {diag.weakPoints.slice(0, 3).map((w) => (
              <div key={w.chapter} className="chapter-item" style={{ cursor: 'default' }}>
                <div style={{ minWidth: 0 }}>
                  <div className="ci-name">{w.chapter}</div>
                  <div className="ci-sub">{w.detail}</div>
                </div>
                <Tag tone={w.kind === 'uncovered' ? 'warn' : 'bad'}>{w.kind === 'uncovered' ? '未覆盖' : '待清除'}</Tag>
              </div>
            ))}
          </div>
        </CardPad>
      )}

      <CardPad style={{ marginTop: 14 }}>
        <div className="card-title">题库信息</div>
        <div className="muted">
          共 {allQuestions.length} 题：单选 {diag.types[0].total} · 多选 {diag.types[1].total} · 判断{' '}
          {diag.types[2].total} · 简答 {diag.types[3].total} · 材料分析 {diag.types[4].total}；{chapterOrder.length}{' '}
          个章节。数据来自指定 PDF，原始题干/选项/答案均未改动。
        </div>
      </CardPad>
    </>
  )
}

/* ============================================================================
 * View 2 — 详细诊断 (was the standalone 学习诊断 page)
 * ========================================================================== */

type WeakPointKind = 'weak' | 'uncovered'

const KIND_LABEL: Record<WeakPointKind, { text: string; tone: 'bad' | 'warn' }> = {
  weak: { text: '待清除', tone: 'bad' },
  uncovered: { text: '未覆盖', tone: 'warn' },
}

function DetailView({
  diag,
  nav,
}: {
  diag: ReturnType<typeof computeDiagnosis>
  nav: (r: RouteName, p?: Record<string, string>) => void | Promise<void>
}) {
  const { records, history } = useStore()
  const activity = useMemo(() => groupActivity(history, 30), [history])
  const [tab, setTab] = useState<'chapter' | 'type' | 'activity'>('chapter')

  const perQuestionWrong = useMemo(() => {
    const list: { qid: string; stem: string; chapter: string; type: string; wrong: number }[] = []
    for (const q of objectiveQuestions) {
      const r = records.get(q.id)
      if (r && r.wrongCount > 0)
        list.push({ qid: q.id, stem: q.stem.split('\n')[0], chapter: q.chapter, type: q.type, wrong: r.wrongCount })
    }
    return list.sort((a, b) => b.wrong - a.wrong)
  }, [records])

  return (
    <>
      <div className="card-title" style={{ marginBottom: 6 }}>
        学习诊断与薄弱点分析
      </div>
      <div className="callout" style={{ marginBottom: 14 }}>
        全部指标来自真实作答数据：覆盖率、正确率、错误次数与复习间隔。系统不生成预测分数，也不虚构掌握率。
      </div>

      <div className="grid grid-4" style={{ marginBottom: 14 }}>
        <CardPad>
          <div className="stat-num">{diag.overall.attempted}</div>
          <div className="stat-label">已练客观题</div>
        </CardPad>
        <CardPad>
          <div className="stat-num">{diag.overall.correct + diag.overall.wrong}</div>
          <div className="stat-label">累计客观题作答</div>
        </CardPad>
        <CardPad>
          <div className="stat-num">{diag.overall.wrong}</div>
          <div className="stat-label">累计答错</div>
        </CardPad>
        <CardPad>
          <div className="stat-num">
            {diag.overall.correctRate ? Math.round(diag.overall.correctRate * 100) + '%' : '—'}
          </div>
          <div className="stat-label">客观题正确率</div>
        </CardPad>
      </div>

      <CardPad>
        <div className="btn-row" style={{ marginBottom: 14 }}>
          {(
            [
              ['chapter', '按章节'],
              ['type', '按题型'],
              ['activity', '学习活动'],
            ] as const
          ).map(([k, l]) => (
            <button key={k} className={`btn btn-sm ${tab === k ? 'btn-primary' : ''}`} onClick={() => setTab(k)}>
              {l}
            </button>
          ))}
        </div>

        {tab === 'chapter' && (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>章节</th>
                  <th>题量</th>
                  <th>已练</th>
                  <th title="已练客观题 / 本章客观题总数">覆盖率</th>
                  <th>作答</th>
                  <th>答错</th>
                  <th>正确率</th>
                  <th>掌握</th>
                  <th>难点</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {diag.chapters.map((c) => (
                  <tr key={c.chapter}>
                    <td>
                      <b>{c.chapter}</b>
                    </td>
                    <td title={`客观题 ${c.objectiveTotal} 道 · 主观题 ${c.subjectiveTotal} 道`}>
                      {c.total}
                      {c.subjectiveTotal > 0 && <span className="muted-2">（主 {c.subjectiveTotal}）</span>}
                    </td>
                    <td>{c.attempted}</td>
                    <td>
                      <div className="row" style={{ gap: 8 }}>
                        <div style={{ width: 64 }}>
                          <Bar
                            value={c.coverage}
                            tone={c.coverage > 0.8 ? 'ok' : c.coverage > 0.4 ? 'accent' : 'bad'}
                          />
                        </div>
                        <span>{Math.round(c.coverage * 100)}%</span>
                      </div>
                    </td>
                    <td>{c.correct + c.wrong}</td>
                    <td style={{ color: c.wrong ? 'var(--bad)' : undefined }}>{c.wrong}</td>
                    <td>{c.correct + c.wrong ? Math.round(c.correctRate * 100) + '%' : '—'}</td>
                    <td>{c.mastered}</td>
                    <td style={{ color: c.struggling ? 'var(--bad)' : undefined }}>{c.struggling}</td>
                    <td>
                      <button
                        className="btn btn-sm"
                        onClick={() => void nav('practice', { mode: 'chapter', chapter: c.chapter })}
                      >
                        练习
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {tab === 'type' && (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>题型</th>
                  <th>题量</th>
                  <th>已练</th>
                  <th>覆盖率</th>
                  <th>作答</th>
                  <th>正确率</th>
                  <th>掌握</th>
                  <th>难点</th>
                </tr>
              </thead>
              <tbody>
                {diag.types.map((t) => (
                  <tr key={t.type}>
                    <td>
                      <b>{t.label}</b>
                    </td>
                    <td>{t.total}</td>
                    <td>{t.attempted}</td>
                    <td>
                      <div className="row" style={{ gap: 8 }}>
                        <div style={{ width: 64 }}>
                          <Bar value={t.coverage} tone={t.coverage > 0.8 ? 'ok' : 'accent'} />
                        </div>
                        <span>{Math.round(t.coverage * 100)}%</span>
                      </div>
                    </td>
                    <td>{t.correct + t.wrong}</td>
                    <td>
                      {t.correct + t.wrong
                        ? Math.round(t.correctRate * 100) + '%'
                        : t.type === 'short' || t.type === 'material'
                          ? 'AI 参考评阅'
                          : '—'}
                    </td>
                    <td>{t.mastered}</td>
                    <td>{t.struggling}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {tab === 'activity' && (
          <>
            <div className="col" style={{ gap: 6 }}>
              {activity
                .slice()
                .reverse()
                .map((d) => (
                  <div key={d.date} className="row-between">
                    <span className="muted" style={{ width: 90, fontFamily: 'var(--mono)', fontSize: 12 }}>
                      {d.date}
                    </span>
                    <div style={{ flex: 1, margin: '0 10px' }}>
                      <Bar value={d.count / Math.max(20, ...activity.map((x) => x.count), 1)} tone="accent" />
                    </div>
                    <span className="muted-2" style={{ width: 110, textAlign: 'right' }}>
                      {d.count} 题（对 {d.correct} / 错 {d.wrong}）
                    </span>
                  </div>
                ))}
            </div>
            <div className="divider" />
            <div className="muted">
              主观题训练进度：{diag.overall.subjectiveAttempted} / {subjectiveQuestions.length} 道已训练。
            </div>
          </>
        )}
      </CardPad>

      <CardPad style={{ marginTop: 14 }}>
        <div className="card-title">薄弱点排序（基于真实数据）</div>
        {diag.weakPoints.length === 0 ? (
          <Empty text="暂无足够数据生成薄弱点排序，先完成一些练习。" />
        ) : (
          <>
            <div className="muted" style={{ marginBottom: 10 }}>
              排序分两类，互不混排：「待清除」为已练但覆盖率或正确率不足的章节，按掌握指数升序在前；「未覆盖」为尚未开始练习的章节，
              按未练题量降序补足剩余名额。未覆盖章节没有正确率数据，因此不参与掌握指数比较。
            </div>
            <div className="grid grid-2">
              {diag.weakPoints.map((w, i) => (
                <div key={w.chapter} className="card card-pad row-between" style={{ boxShadow: 'none' }}>
                  <div>
                    <div className="row" style={{ gap: 8 }}>
                      <b>
                        {i + 1}. {w.chapter}
                      </b>
                      {w.kind === 'weak' ? (
                        <Tag tone={w.score < 50 ? 'bad' : w.score < 70 ? 'warn' : 'ok'}>掌握指数 {w.score}</Tag>
                      ) : null}
                      <Tag tone={KIND_LABEL[w.kind].tone}>{KIND_LABEL[w.kind].text}</Tag>
                    </div>
                    <div className="muted-2" style={{ marginTop: 4 }}>
                      {w.detail}
                    </div>
                  </div>
                  <button
                    className="btn btn-sm"
                    onClick={() => void nav('practice', { mode: 'chapter', chapter: w.chapter })}
                  >
                    练习
                  </button>
                </div>
              ))}
            </div>
          </>
        )}
      </CardPad>

      <CardPad style={{ marginTop: 14 }}>
        <div className="card-title">高频错误题目 TOP 15</div>
        {perQuestionWrong.length === 0 ? (
          <Empty text="还没有错题记录。" />
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>章节</th>
                  <th>题型</th>
                  <th>题干</th>
                  <th>答错次数</th>
                  <th>最近状态</th>
                </tr>
              </thead>
              <tbody>
                {perQuestionWrong.slice(0, 15).map((w) => {
                  const r = records.get(w.qid)!
                  return (
                    <tr key={w.qid}>
                      <td>{w.chapter}</td>
                      <td>
                        <Tag>{TYPE_LABEL[w.type as keyof typeof TYPE_LABEL] ?? w.type}</Tag>
                      </td>
                      <td style={{ maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {w.stem}
                      </td>
                      <td>
                        <b style={{ color: 'var(--bad)' }}>{w.wrong}</b>
                      </td>
                      <td>
                        <Tag tone={r.status === 'struggling' ? 'bad' : r.status === 'mastered' ? 'ok' : 'warn'}>
                          {r.status === 'struggling' ? '难点' : r.status === 'mastered' ? '已掌握' : '巩固中'}
                        </Tag>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardPad>

      <CardPad style={{ marginTop: 14 }}>
        <div className="card-title">下一步建议</div>
        <div className="col" style={{ gap: 8 }}>
          {diag.overall.coverage < 0.6 && (
            <Advice
              text={`题库覆盖率仅 ${Math.round(diag.overall.coverage * 100)}%：先用自由刷题把未做题目补齐，避免只刷错题。`}
              action={{ label: '自由刷题', route: 'practice' }}
              nav={nav}
            />
          )}
          {diag.types.find((t) => t.type === 'multi')!.correctRate < 0.7 &&
            diag.types.find((t) => t.type === 'multi')!.attempted > 0 && (
              <Advice
                text="多选题正确率偏低：多选必须选项集合完全一致，错选漏选都判错。建议专项训练并逐项核对选项。"
                action={{ label: '多选专项', route: 'practice', params: { mode: 'type', type: 'multi' } }}
                nav={nav}
              />
            )}
          {diag.overall.subjectiveAttempted < 3 && (
            <Advice
              text="主观题训练不足：简答与材料题需要练习答题结构与采分点组织，建议每天至少 1 题。"
              action={{ label: '主观题训练', route: 'subjective' }}
              nav={nav}
            />
          )}
          {diag.weakPoints.length > 0 && (
            <Advice
              text={`优先补强：${diag.weakPoints
                .slice(0, 3)
                .map((w) => w.chapter)
                .join('、')}。`}
              action={{ label: '复习计划', route: 'plan' }}
              nav={nav}
            />
          )}
          {diag.weakPoints.length === 0 && diag.overall.coverage > 0.9 && (
            <Advice
              text="覆盖良好，可进入全真模拟考试检验整体表现与时间分配。"
              action={{ label: '全真模拟', route: 'mock' }}
              nav={nav}
            />
          )}
        </div>
      </CardPad>
    </>
  )
}

function Advice({
  text,
  action,
  nav,
}: {
  text: string
  action: { label: string; route: RouteName; params?: Record<string, string> }
  nav: (r: RouteName, p?: Record<string, string>) => void | Promise<void>
}) {
  return (
    <div className="row-between">
      <span className="muted" style={{ flex: 1 }}>
        • {text}
      </span>
      <button className="btn btn-sm" onClick={() => void nav(action.route, action.params)}>
        {action.label}
      </button>
    </div>
  )
}
