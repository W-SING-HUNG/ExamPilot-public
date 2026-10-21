import { useMemo, useState } from 'react'
import { useStore } from '../store/StoreContext'
import { objectiveQuestions, subjectiveQuestions, allQuestions, questionById } from '../lib/bank'
import { buildPlan } from '../lib/plan'
import { computeDiagnosis } from '../lib/analysis'
import { isDue } from '../lib/scheduler'
import { QuestionRunner } from '../components/QuestionRunner'
import { CardPad, PageHead, Empty, Stat, Tag, Reveal } from '../components/ui'
import { RunnerShell, SessionShell, SessionSummary, type SessionPhase } from '../components/SessionView'
import { clearDraft, loadDraft, type SessionDraft } from '../lib/session-draft'
import type { SessionResult } from '../lib/session-outcome'
import type { Question } from '../lib/types'

export function Plan({ params: _params }: { params: Record<string, string> }) {
  const { records, ready } = useStore()
  const [phase, setPhase] = useState<SessionPhase>('configure')
  const [session, setSession] = useState<Question[] | null>(null)
  const [sessionId, setSessionId] = useState('')
  const [result, setResult] = useState<SessionResult | null>(null)
  const [size, setSize] = useState(20)
  const [draft, setDraft] = useState<SessionDraft | null>(() => loadDraft('plan'))
  const [showMethod, setShowMethod] = useState(false)

  const diag = useMemo(() => computeDiagnosis(allQuestions, records), [records])

  const now = Date.now()
  const dueCount = objectiveQuestions.filter((q) => {
    const r = records.get(q.id)
    return r ? isDue(r, now) : false
  }).length
  const freshCount = objectiveQuestions.filter((q) => (records.get(q.id)?.attempts ?? 0) === 0).length

  const plan = useMemo(() => {
    if (!ready) return null
    return buildPlan({
      objective: objectiveQuestions,
      subjective: subjectiveQuestions,
      records,
      now,
      size,
    })
  }, [records, size, ready, now])

  if (!ready) return null

  const objectiveCount = plan?.questions.filter((q) => q.type !== 'short' && q.type !== 'material').length ?? 0
  const subjectiveCount = (plan?.questions.length ?? 0) - objectiveCount

  /** Materialise a resumable draft back into a runnable session. */
  const resumeFromDraft = (d: SessionDraft) => {
    const qs = d.qids.map((id) => questionById.get(id)).filter((q): q is Question => !!q)
    if (qs.length === 0) {
      clearDraft('plan')
      setDraft(null)
      return
    }
    setSession(qs)
    setSessionId(d.sessionId)
    setPhase('running')
  }

  const start = (questions: Question[]) => {
    setSession(questions)
    setSessionId(`s-${Date.now()}`)
    setResult(null)
    setPhase('running')
  }

  const onFinish = (r: SessionResult) => {
    setResult(r)
    setPhase('summary')
  }

  const backToConfig = () => {
    setSession(null)
    setSessionId('')
    setResult(null)
    setDraft(loadDraft('plan'))
    setPhase('configure')
  }

  /* ---------------- running: the answering surface owns the screen ------- */
  if (phase === 'running' && session) {
    return (
      <SessionShell>
        <PageHead title="今日复习" desc="专注答题：提交后立即看到结果，可随时跳过或结束本组。" />
        <RunnerShell>
          <QuestionRunner
            questions={session}
            mode="plan"
            sessionId={sessionId}
            restore={draft && draft.sessionId === sessionId ? draft : null}
            contextLabel="复习计划"
            onFinish={onFinish}
            finishLabel="完成今日任务"
          />
        </RunnerShell>
      </SessionShell>
    )
  }

  /* ---------------- summary -------------------------------------------- */
  if (phase === 'summary' && result) {
    return (
      <SessionShell>
        <PageHead title="今日复习完成" desc="本组结果来自真实作答记录，未评分的题目不计为错误。" />
        <SessionSummary
          result={result}
          title="本组结束"
          subtitle={result.answered === 0 ? '本组还没有提交任何作答。' : undefined}
          onRestart={backToConfig}
          onExit={backToConfig}
          exitLabel="返回计划"
        />
      </SessionShell>
    )
  }

  /* ---------------- configure ------------------------------------------ */
  return (
    <SessionShell>
      <PageHead
        title="智能复习计划"
        desc="按间隔复习、错题再测与覆盖均衡三类原则生成当日任务：到期复习优先，错题再测其次，未做题目补漏。"
      />

      {draft && (
        <CardPad className="resume-banner">
          <div className="row-between">
            <div>
              <div className="card-title" style={{ margin: 0 }}>
                有一组未完成的复习
              </div>
              <div className="muted-2">
                上次进度 {Math.min(draft.idx + 1, draft.qids.length)} / {draft.qids.length} 题 · 已答{' '}
                {Object.keys(draft.outcomes).length} 题
              </div>
            </div>
            <div className="btn-row">
              <button className="btn btn-primary" onClick={() => resumeFromDraft(draft)}>
                继续上次
              </button>
              <button
                className="btn btn-ghost"
                onClick={() => {
                  clearDraft('plan')
                  setDraft(null)
                }}
              >
                放弃
              </button>
            </div>
          </div>
        </CardPad>
      )}

      <Reveal>
        <div className="grid grid-3" style={{ marginBottom: 14 }}>
          <Stat
            value={dueCount}
            label="今日到期复习"
            hint="已到复习时间、需要重做"
            tone={dueCount > 0 ? 'warn' : undefined}
          />
          <Stat
            value={diag.weakPoints.length}
            label="薄弱章节"
            hint="已练但覆盖或正确率不足"
            tone={diag.weakPoints.length ? 'bad' : undefined}
          />
          <Stat value={freshCount} label="从未练过的题目" hint="覆盖缺口" tone={freshCount ? 'accent' : undefined} />
        </div>

        <CardPad>
          {/*
            The task-size chips and the primary action come FIRST.
            On a phone the three stat cards alone filled the first screen, so the
            one control the page exists for sat 1.6 screens down. Leading with
            "how many" + "start" answers "what do I do now" immediately; the
            statistics and the preview follow as supporting detail.
          */}
          <div className="card-title">今日任务量（客观题）</div>
          <div className="btn-row" style={{ marginBottom: 16 }}>
            {[10, 20, 30, 50].map((n) => (
              <button
                key={n}
                className={`btn btn-sm ${size === n ? 'btn-primary' : ''}`}
                aria-pressed={size === n}
                onClick={() => setSize(n)}
              >
                {n} 题
              </button>
            ))}
          </div>

          {plan && plan.questions.length > 0 ? (
            <>
              <div className="btn-row" style={{ marginBottom: 6 }}>
                <button className="btn btn-primary btn-lg" onClick={() => start(plan.questions)}>
                  开始今日复习（{plan.questions.length} 题）
                </button>
              </div>
              <div className="muted-2" style={{ marginBottom: 16 }}>
                客观题 {objectiveCount} 题{subjectiveCount > 0 ? ` + 主观题 ${subjectiveCount} 题` : ''} ·
                进入后即专注答题，配置与预览会自动收起。
              </div>

              <div className="divider" />
              <div className="card-title">
                计划预览（客观题 {objectiveCount} 题{subjectiveCount > 0 ? ` + 主观题 ${subjectiveCount} 题` : ''}）
              </div>
              {plan.shortfall > 0 && (
                <div className="muted" style={{ marginBottom: 12, color: 'var(--warn)' }}>
                  题库客观题仅 {objectiveQuestions.length} 道，不足以排满 {size} 道；已按实际可用数量生成，不重复出题。
                </div>
              )}
              {plan.deferredDue > 0 && (
                <div className="muted" style={{ marginBottom: 12 }}>
                  还有 {plan.deferredDue} 道到期题目未排入今日任务，将按到期顺序顺延到后续计划。
                </div>
              )}
              {objectiveCount === 0 && (
                <div className="muted" style={{ marginBottom: 12 }}>
                  客观题已全部练完且暂无到期复习，以下为主观题书写训练。
                </div>
              )}
              <div className="col" style={{ gap: 0 }}>
                {plan.questions.slice(0, 5).map((q, i) => (
                  <div
                    key={q.id}
                    className="row-between"
                    style={{ borderBottom: '1px solid var(--border)', padding: '9px 0' }}
                  >
                    <span className="muted preview-stem" style={{ fontSize: 13, minWidth: 0 }}>
                      {i + 1}. [{q.chapter}] {q.stem.split('\n')[0].slice(0, 50)}
                    </span>
                    <Tag tone={q.type === 'short' || q.type === 'material' ? 'warn' : 'plain'}>
                      {q.type === 'short' || q.type === 'material' ? '主观题' : '客观题'}
                    </Tag>
                  </div>
                ))}
              </div>
              {plan.questions.length > 5 && (
                <div className="muted-2" style={{ paddingTop: 8 }}>
                  另外 {plan.questions.length - 5} 题将在开始后依次出现（共 {plan.questions.length} 题）。
                </div>
              )}
            </>
          ) : (
            <Empty text="题库已全部练完且无到期复习，可进入模拟考试检验。" />
          )}
        </CardPad>

        <CardPad style={{ marginTop: 14 }}>
          <div className="row-between" style={{ marginBottom: showMethod ? 12 : 0 }}>
            <div className="card-title" style={{ margin: 0 }}>
              复习方法说明
            </div>
            <button
              className="btn btn-sm btn-ghost"
              aria-expanded={showMethod}
              onClick={() => setShowMethod((v) => !v)}
            >
              {showMethod ? '收起' : '展开'}
            </button>
          </div>
          {showMethod && (
            <div className="col" style={{ gap: 10 }}>
              <MethodRow title="主动回忆" desc="先作答再看解析，避免被动浏览；主观题要求完整书写而不是列要点。" />
              <MethodRow title="间隔复习" desc="答对后按 1→2→4 天递增间隔再次出现，答错立即回到最短间隔。" />
              <MethodRow
                title="错题再测"
                desc="答错且累计 3 次以上标记为难点；连续答对后自动恢复为巩固中，不会永久停留在难点。"
              />
              <MethodRow title="混合练习" desc="章节、题型混合抽取，避免短期重复同一知识块造成的“熟练错觉”。" />
              <MethodRow title="覆盖均衡" desc="每次任务都包含未做题目，防止只刷错题导致大量题目从未覆盖。" />
              <MethodRow
                title="主观题训练"
                desc="每天额外安排 1 道主观题书写练习，不计入客观题任务量；间隔比客观题短，且不自动判定掌握。"
              />
            </div>
          )}
        </CardPad>
      </Reveal>
    </SessionShell>
  )
}

function MethodRow({ title, desc }: { title: string; desc: string }) {
  return (
    <div className="row-between" style={{ alignItems: 'flex-start', gap: 12 }}>
      <b style={{ fontSize: 13.5, width: 92, flex: 'none' }}>{title}</b>
      <span className="muted" style={{ flex: 1, minWidth: 0 }}>
        {desc}
      </span>
    </div>
  )
}
