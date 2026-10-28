import { useEffect, useMemo, useRef, useState } from 'react'
import { IS_WEB_EDITION } from '../lib/edition'
import { useStore } from '../store/StoreContext'
import { allQuestions, chapterOrder, TYPE_LABEL, questionById } from '../lib/bank'
import { ChapterPicker } from '../components/ChapterPicker'
import { computeDiagnosis } from '../lib/analysis'
import { selectQuestions } from '../lib/scheduler'
import { QuestionRunner } from '../components/QuestionRunner'
import { Bar, CardPad, PageHead, Tag } from '../components/ui'
import { RunnerShell, SessionShell, SessionSummary, type SessionPhase } from '../components/SessionView'
import { BankLookup } from './BankLookup'
import { clearDraft, loadDraft, type SessionDraft } from '../lib/session-draft'
import type { SessionResult } from '../lib/session-outcome'
import type { Question, QuestionType } from '../lib/types'
import type { RouteName } from '../store/router'

type PracticeMode = 'chapter' | 'type' | 'custom'
type View = 'practice' | 'lookup'

const ALL_TYPES: QuestionType[] = ['single', 'multi', 'judge']

/**
 * 自由刷题 — the single place to start a practice set.
 *
 * Consolidates what used to be two near-identical pages (分章练习 by chapter,
 * 专项训练 by type) plus the read-only 题库查阅 page.
 *
 * The three modes are presets over ONE filter engine rather than three code
 * paths: 按章节 scrolls the chapter selector into view, 按题型 does the same for
 * the type selector, 自定义 exposes every filter at once. All three keep the
 * full "chapter × type × count" capability the old pages had.
 *
 * 查阅题库 lives behind a view switch so browsing NEVER writes an attempt —
 * it renders a separate read-only component.
 */
export function Practice({
  nav,
  params,
}: {
  nav: (r: RouteName, p?: Record<string, string>) => void | Promise<void>
  params: Record<string, string>
}) {
  const { records, ready } = useStore()

  const initialMode = (params.mode as PracticeMode) || 'chapter'
  const [mode, setMode] = useState<PracticeMode>(
    initialMode === 'type' || initialMode === 'custom' ? initialMode : 'chapter',
  )
  const [view, setView] = useState<View>(params.view === 'lookup' ? 'lookup' : 'practice')

  // Filters. `chapters` empty = all chapters; `types` empty = all objective types.
  const [chapters, setChapters] = useState<string[]>(() => (params.chapter ? [params.chapter] : []))
  const [types, setTypes] = useState<QuestionType[]>(() =>
    params.type ? [params.type as QuestionType] : [...ALL_TYPES],
  )
  const [count, setCount] = useState(10)

  const [phase, setPhase] = useState<SessionPhase>('configure')
  const [session, setSession] = useState<Question[] | null>(null)
  const [sessionId, setSessionId] = useState('')
  const startRef = useRef<HTMLButtonElement | null>(null)
  const [result, setResult] = useState<SessionResult | null>(null)
  // Draft mode name stays 'practice' so drafts written by the old 分章练习 page
  // (and the legacy `exampilot_practice_session` key) still resume here.
  const [draft, setDraft] = useState<SessionDraft | null>(() => loadDraft('practice'))

  useEffect(() => {
    if (params.chapter) setChapters([params.chapter])
    if (params.type) setTypes([params.type as QuestionType])
    if (params.mode === 'type' || params.mode === 'custom' || params.mode === 'chapter') setMode(params.mode)
    if (params.view === 'lookup') setView('lookup')
  }, [params.chapter, params.type, params.mode, params.view])

  const diag = useMemo(() => computeDiagnosis(allQuestions, records), [records])

  /** The full filter engine — identical for all three modes. */
  const pool = useMemo(() => {
    const typesToUse = types.length > 0 ? types : ALL_TYPES
    return allQuestions.filter(
      (q) => typesToUse.includes(q.type) && (chapters.length === 0 || chapters.includes(q.chapter)),
    )
  }, [chapters, types])

  /**
   * 按章节 mode works on objective questions only.
   *
   * Subjective questions cannot be auto-graded, so mixing them into a normal
   * practice set would put un-scored items in a graded run. The old 分章练习 page
   * filtered to single/multi/judge for exactly this reason; that behaviour is
   * preserved here.
   */
  const objectivePool = useMemo(() => pool.filter((q) => q.type !== 'short' && q.type !== 'material'), [pool])

  const activeChapterStat = chapters.length === 1 ? diag.chapters.find((c) => c.chapter === chapters[0]) : null

  /** What the current mode will actually draw from. */
  const effectivePool = mode === 'chapter' ? objectivePool : pool

  const begin = (questions: Question[], id: string) => {
    setSession(questions)
    setSessionId(id)
    setResult(null)
    setPhase('running')
  }

  const start = () => {
    const usable = mode === 'chapter' ? objectivePool : pool
    if (usable.length === 0) return
    const picked = selectQuestions({
      pool: usable,
      records,
      now: Date.now(),
      count: Math.min(count, usable.length),
    })
    begin(picked, `s-${Date.now()}`)
  }

  const resume = (d: SessionDraft) => {
    const qs = d.qids.map((id) => questionById.get(id)).filter((q): q is Question => !!q)
    if (qs.length === 0) {
      clearDraft('practice')
      setDraft(null)
      return
    }
    begin(qs, d.sessionId)
  }

  const backToConfig = () => {
    setSession(null)
    setSessionId('')
    setResult(null)
    setDraft(loadDraft('practice'))
    setPhase('configure')
  }

  const toggleChapter = (ch: string) =>
    setChapters((prev) => (prev.includes(ch) ? prev.filter((c) => c !== ch) : [...prev, ch]))
  const toggleType = (t: QuestionType) =>
    setTypes((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]))

  if (!ready) return null

  /* ---------------- running ---------------- */
  if (phase === 'running' && session) {
    const label = chapters.length === 1 ? chapters[0] : types.length === 1 ? TYPE_LABEL[types[0]] : '自由刷题'
    return (
      <SessionShell>
        <PageHead title="自由刷题" desc="专注答题：提交后立即看到结果，可随时跳过或结束本组。" />
        <RunnerShell>
          <QuestionRunner
            questions={session}
            mode="practice"
            sessionId={sessionId}
            restore={draft && draft.sessionId === sessionId ? draft : null}
            contextLabel={`${label} · 自由刷题`}
            onFinish={(r) => {
              setResult(r)
              setPhase('summary')
            }}
            finishLabel="完成本组"
          />
        </RunnerShell>
      </SessionShell>
    )
  }

  /* ---------------- summary ---------------- */
  if (phase === 'summary' && result) {
    return (
      <SessionShell>
        <PageHead title="本组练习完成" desc="结果来自真实作答记录；未自动评分的题目不计为错误。" />
        <SessionSummary
          result={result}
          title="本组结束"
          subtitle={result.answered === 0 ? '本组还没有提交任何作答。' : undefined}
          onRestart={backToConfig}
          onExit={backToConfig}
          exitLabel="返回配置"
          onReviewWrong={() => void nav('wrong')}
        />
      </SessionShell>
    )
  }

  /* ---------------- configure ---------------- */
  return (
    <SessionShell>
      <PageHead title="自由刷题" desc="按章节、按题型或自定义范围抽题练习；也可切换到题库查阅，只读查看题目与答案。" />

      {/* Practice vs read-only lookup. Browsing the bank never records an attempt. */}
      <div className="view-switch" role="tablist" aria-label="自由刷题视图">
        <button
          role="tab"
          aria-selected={view === 'practice'}
          className={`btn btn-sm ${view === 'practice' ? 'btn-primary' : ''}`}
          onClick={() => {
            // This is a view tab, not the start action. It used to do nothing visible
            // when the view was already open. Now it always lands the
            // user on the real start button: scroll to it, focus it and flash it once.
            setView('practice')
            requestAnimationFrame(() => {
              const b = startRef.current
              if (!b) return
              b.scrollIntoView({ behavior: 'smooth', block: 'center' })
              b.focus({ preventScroll: true })
              b.classList.remove('attn')
              void b.offsetWidth
              b.classList.add('attn')
            })
          }}
        >
          练习设置
        </button>
        <button
          role="tab"
          aria-selected={view === 'lookup'}
          className={`btn btn-sm ${view === 'lookup' ? 'btn-primary' : ''}`}
          onClick={() => setView('lookup')}
        >
          查阅题库
        </button>
      </div>

      {view === 'lookup' ? (
        <BankLookup />
      ) : (
        <>
          {draft && (
            <CardPad className="resume-banner">
              <div className="row-between">
                <div>
                  <div className="card-title" style={{ margin: 0 }}>
                    有一组未完成的练习
                  </div>
                  <div className="muted-2">
                    上次进度 {Math.min(draft.idx + 1, draft.qids.length)} / {draft.qids.length} 题 · 已答{' '}
                    {Object.keys(draft.outcomes).length} 题
                  </div>
                </div>
                <div className="btn-row">
                  <button className="btn btn-primary" onClick={() => resume(draft)}>
                    继续上次
                  </button>
                  <button
                    className="btn btn-ghost"
                    onClick={() => {
                      clearDraft('practice')
                      setDraft(null)
                    }}
                  >
                    放弃
                  </button>
                </div>
              </div>
            </CardPad>
          )}

          {/* Quick modes: presets over the same filters. */}
          <div className="view-switch" role="tablist" aria-label="出题方式">
            {(
              [
                ['chapter', '按章节'],
                ['type', '按题型'],
                ['custom', '自定义'],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                role="tab"
                aria-selected={mode === k}
                className={`btn btn-sm ${mode === k ? 'btn-primary' : ''}`}
                onClick={() => setMode(k)}
              >
                {label}
              </button>
            ))}
          </div>

          <CardPad>
            {mode !== 'type' && (
              <>
                <div className="card-title">
                  章节{chapters.length === 0 ? '（不选 = 全部章节）' : `（已选 ${chapters.length} 个）`}
                </div>
                <ChapterPicker
                  total={chapterOrder.length}
                  summary={chapters.length === 0 ? '当前：全部章节' : `已选：${chapters.join('、')}`}
                  style={{ marginBottom: 12 }}
                >
                  <button
                    className={`btn btn-sm ${chapters.length === 0 ? 'btn-primary' : ''}`}
                    onClick={() => setChapters([])}
                  >
                    全部章节
                  </button>
                  {chapterOrder.map((ch) => (
                    <button
                      key={ch}
                      className={`btn btn-sm ${chapters.includes(ch) ? 'btn-primary' : ''}`}
                      aria-pressed={chapters.includes(ch)}
                      onClick={() => toggleChapter(ch)}
                    >
                      {ch}
                    </button>
                  ))}
                </ChapterPicker>
                {activeChapterStat && (
                  <div className="row-between" style={{ marginBottom: 14 }}>
                    <div className="muted">
                      {activeChapterStat.chapter}：{activeChapterStat.total} 题（单选 {activeChapterStat.single} · 多选{' '}
                      {activeChapterStat.multi} · 判断 {activeChapterStat.judge}
                      {activeChapterStat.subjectiveTotal > 0 ? ` · 主观 ${activeChapterStat.subjectiveTotal}` : ''}）
                    </div>
                    <div className="row" style={{ gap: 12 }}>
                      <span className="muted-2">覆盖 {Math.round(activeChapterStat.coverage * 100)}%</span>
                      <span className="muted-2">
                        正确率{' '}
                        {activeChapterStat.attempted ? Math.round(activeChapterStat.correctRate * 100) + '%' : '—'}
                      </span>
                      <span className="muted-2">掌握 {activeChapterStat.mastered}</span>
                    </div>
                  </div>
                )}
              </>
            )}

            {mode !== 'chapter' && (
              <>
                <div className="card-title">题型</div>
                <div className="btn-row" style={{ marginBottom: 14 }}>
                  {ALL_TYPES.map((t) => (
                    <button
                      key={t}
                      className={`btn btn-sm ${types.includes(t) ? 'btn-primary' : ''}`}
                      aria-pressed={types.includes(t)}
                      onClick={() => toggleType(t)}
                    >
                      {TYPE_LABEL[t]}
                    </button>
                  ))}
                  {types.length === 0 && <Tag tone="warn">未选题型 = 全部</Tag>}
                </div>
              </>
            )}

            <div className="card-title">每组题量</div>
            <div className="btn-row" style={{ marginBottom: 4 }}>
              {[5, 10, 20, 30, 50, 100].map((n) => (
                <button
                  key={n}
                  className={`btn btn-sm ${count === n ? 'btn-primary' : ''}`}
                  aria-pressed={count === n}
                  onClick={() => setCount(n)}
                >
                  {n} 题
                </button>
              ))}
              <span className="muted-2">符合条件 {effectivePool.length} 题</span>
            </div>

            <div className="divider" />
            <div className="btn-row">
              {/*
                The label follows the mode so the button says what it will do:
                按章节 → "开始练习", 按题型 → "开始专项训练", 自定义 → "开始刷题".
                All three call the same start().
              */}
              <button
                ref={startRef}
                className="btn btn-primary btn-lg"
                onClick={start}
                disabled={effectivePool.length === 0}
              >
                {IS_WEB_EDITION || mode === 'chapter'
                  ? `开始练习（${Math.min(count, effectivePool.length)} 题）`
                  : mode === 'type'
                    ? `开始专项训练（${Math.min(count, effectivePool.length)} 题）`
                    : `开始刷题（${Math.min(count, effectivePool.length)} 题）`}
              </button>
              <button className="btn" onClick={() => void nav('wrong')}>
                去看错题本
              </button>
            </div>
            {effectivePool.length === 0 && (
              <div className="muted" style={{ marginTop: 8, color: 'var(--warn)' }}>
                当前筛选下没有题目，请调整章节或题型。
              </div>
            )}
          </CardPad>

          {mode === 'chapter' && activeChapterStat && (
            <CardPad style={{ marginTop: 14 }}>
              <div className="card-title">本章各题型掌握情况</div>
              <div className="col" style={{ gap: 10 }}>
                {ALL_TYPES.map((t) => {
                  const list = allQuestions.filter((q) => q.chapter === activeChapterStat.chapter && q.type === t)
                  const recs = list.map((q) => records.get(q.id)).filter(Boolean)
                  const attempted = recs.filter((r) => r!.attempts > 0).length
                  const ok = recs.reduce((s, r) => s + r!.correctCount, 0)
                  const bad = recs.reduce((s, r) => s + r!.wrongCount, 0)
                  return (
                    <div key={t}>
                      <div className="row-between" style={{ marginBottom: 4 }}>
                        <span style={{ fontSize: 13.5 }}>{TYPE_LABEL[t]}</span>
                        <span className="muted-2">
                          {attempted}/{list.length} 已练 · 对 {ok} 错 {bad}
                        </span>
                      </div>
                      <Bar value={list.length ? attempted / list.length : 0} tone="accent" />
                    </div>
                  )
                })}
              </div>
            </CardPad>
          )}
        </>
      )}
    </SessionShell>
  )
}
