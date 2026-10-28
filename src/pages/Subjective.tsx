import { useEffect, useMemo, useState } from 'react'
import { useAiUsable } from '../lib/ai-access'
import { useStore } from '../store/StoreContext'
import { subjectiveQuestions, TYPE_LABEL, questionById } from '../lib/bank'
import { selectQuestions } from '../lib/scheduler'
import { QuestionRunner } from '../components/QuestionRunner'
import { CardPad, PageHead, Tag } from '../components/ui'
import { RunnerShell, SessionShell, SessionSummary, type SessionPhase } from '../components/SessionView'
import { clearDraft, loadDraft, type SessionDraft } from '../lib/session-draft'
import type { SessionResult } from '../lib/session-outcome'
import type { Question } from '../lib/types'

/** Structure hints for the two subjective types — auxiliary study reference, clearly labelled as such. */
const STRUCTURE_HINT: Record<string, string[]> = {
  short: [
    '定义句：先给出核心概念的精确定义（谁、是什么、属于什么范畴）',
    '分点展开：按教材逻辑分点作答，一点一条，避免写成整段',
    '关键词：优先使用教材原文表述，如“两个结合”“十个明确”等',
    '小结：用一句话收束，点明其地位或意义',
  ],
  material: [
    '回扣材料：先引用/概括材料中的关键信息，说明“材料说了什么”',
    '理论定位：点明材料体现的教材知识点与核心概念',
    '分层分析：按“是什么—为什么—怎么办”或“理论—材料—结论”分层',
    '结论升华：落到教材表述与实践意义上，避免只复述材料',
  ],
}

export function Subjective({ params }: { params: Record<string, string> }) {
  const aiOn = useAiUsable()
  const { records, ready } = useStore()
  const [kind, setKind] = useState<'short' | 'material'>((params.kind as 'short' | 'material') ?? 'short')
  const [count, setCount] = useState(3)
  const [phase, setPhase] = useState<SessionPhase>('configure')
  const [session, setSession] = useState<Question[] | null>(null)
  const [sessionId, setSessionId] = useState('')
  const [result, setResult] = useState<SessionResult | null>(null)
  const [draft, setDraft] = useState<SessionDraft | null>(() => loadDraft('subjective'))
  // D-02: a reload (or opening the page on another device) continues an unfinished
  // round where it stopped — same question, same typed text — like the mock exam.
  const [resumed, setResumed] = useState(false)
  useEffect(() => {
    if (!ready || resumed || phase !== 'configure' || !draft) return
    setResumed(true)
    resume(draft)
  }, [ready, draft])

  const pool = useMemo(() => subjectiveQuestions.filter((q) => q.type === kind), [kind])
  const attempted = useMemo(() => pool.filter((q) => (records.get(q.id)?.attempts ?? 0) > 0).length, [pool, records])

  const begin = (questions: Question[], id: string) => {
    setSession(questions)
    setSessionId(id)
    setResult(null)
    setPhase('running')
  }

  const start = () => {
    if (pool.length === 0) return
    const picked = selectQuestions({
      pool,
      records,
      now: Date.now(),
      count: Math.min(count, pool.length),
    })
    begin(picked, `s-${Date.now()}`)
  }

  const resume = (d: SessionDraft) => {
    const qs = d.qids.map((id) => questionById.get(id)).filter((q): q is Question => !!q)
    if (qs.length === 0) {
      clearDraft('subjective')
      setDraft(null)
      return
    }
    if (qs[0].type === 'short' || qs[0].type === 'material') setKind(qs[0].type)
    begin(qs, d.sessionId)
  }

  const backToConfig = () => {
    setSession(null)
    setSessionId('')
    setResult(null)
    setDraft(loadDraft('subjective'))
    setPhase('configure')
  }

  if (!ready) return null

  if (phase === 'running' && session) {
    return (
      <SessionShell>
        <PageHead
          title={`主观题训练 · ${TYPE_LABEL[kind]}`}
          desc={
            aiOn
              ? '主观题无自动评分：提交后记为“未自动评分”，不计为错误；可用 AI 参考评阅自评结构。'
              : '主观题无自动评分：提交后记为“未自动评分”，不计为错误；请对照答题结构参考自评。'
          }
        />
        {resumed && draft && draft.sessionId === sessionId && (
          <div className="callout" role="status" style={{ marginBottom: 12 }}>
            已恢复上次未完成的训练：第 {Math.min(draft.idx + 1, draft.qids.length)} / {draft.qids.length}{' '}
            题，作答内容已保留。
          </div>
        )}
        <RunnerShell>
          <QuestionRunner
            questions={session}
            mode="subjective"
            sessionId={sessionId}
            restore={draft && draft.sessionId === sessionId ? draft : null}
            contextLabel={TYPE_LABEL[kind]}
            onFinish={(r) => {
              setResult(r)
              setPhase('summary')
            }}
            finishLabel="完成本轮"
          />
        </RunnerShell>
      </SessionShell>
    )
  }

  if (phase === 'summary' && result) {
    return (
      <SessionShell>
        <PageHead title="本轮主观题训练完成" desc="主观题没有标准答案，本轮作答全部记为“未自动评分”。" />
        <SessionSummary
          result={result}
          title={`${TYPE_LABEL[kind]} · 本轮结束`}
          subtitle={
            result.answered === 0
              ? '本轮还没有提交任何作答。'
              : '主观题不计对错：请以「是否覆盖采分点、结构是否清晰」作为自评标准。'
          }
          onRestart={backToConfig}
          onExit={backToConfig}
          exitLabel="返回配置"
        />
      </SessionShell>
    )
  }

  return (
    <SessionShell>
      <PageHead
        title="主观题训练"
        desc="题库仅提供简答题与材料分析论述题的题干，未提供标准答案。系统不伪造官方答案；重点训练答题结构、核心概念、采分点与材料联系。"
      />

      {draft && (
        <CardPad className="resume-banner">
          <div className="row-between">
            <div>
              <div className="card-title" style={{ margin: 0 }}>
                有一轮未完成的主观题训练
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
                  clearDraft('subjective')
                  setDraft(null)
                }}
              >
                放弃
              </button>
            </div>
          </div>
        </CardPad>
      )}

      <CardPad>
        <div className="card-title">选择题型</div>
        <div className="btn-row" style={{ marginBottom: 14 }}>
          {(['short', 'material'] as const).map((k) => (
            <button
              key={k}
              className={`btn ${kind === k ? 'btn-primary' : ''}`}
              aria-pressed={kind === k}
              onClick={() => setKind(k)}
            >
              {TYPE_LABEL[k]}
            </button>
          ))}
          <span className="muted-2">
            共 {pool.length} 题 · 已训练 {attempted} 题
          </span>
        </div>

        <div className="card-title">答题结构参考（辅助学习参考，非官方答案）</div>
        <div className="ai-box">
          <ol style={{ margin: 0, paddingLeft: 20, fontSize: 13.5, lineHeight: 1.9 }}>
            {STRUCTURE_HINT[kind].map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
          <div className="muted-2" style={{ marginTop: 8 }}>
            来源：依据题型通用作答规范整理，用于组织你自己的作答，不代表题库官方答案。
          </div>
        </div>

        <div className="divider" />
        <div className="card-title">本轮题量</div>
        <div className="btn-row" style={{ marginBottom: 14 }}>
          {[1, 2, 3, 5, 8].map((n) => (
            <button
              key={n}
              className={`btn btn-sm ${count === n ? 'btn-primary' : ''}`}
              aria-pressed={count === n}
              onClick={() => setCount(n)}
            >
              {n} 题
            </button>
          ))}
          <span className="muted-2">可用 {pool.length} 题</span>
        </div>

        <button className="btn btn-primary btn-lg" onClick={start} disabled={pool.length === 0}>
          开始训练（{Math.min(count, pool.length)} 题）
        </button>
      </CardPad>

      <CardPad style={{ marginTop: 14 }}>
        <div className="card-title">本题库主观题清单</div>
        <div className="muted" style={{ marginBottom: 10 }}>
          {kind === 'short' ? '简答题' : '材料分析论述题'}共 {pool.length} 道，均未附标准答案。以下显示前 12 题。
        </div>
        <div className="col" style={{ gap: 6 }}>
          {pool.slice(0, 12).map((q) => (
            <div
              key={q.id}
              className="row-between"
              style={{ borderBottom: '1px solid var(--border)', paddingBottom: 6 }}
            >
              <span style={{ fontSize: 13.5 }}>
                {q.bankNo}. {q.stem.split('\n')[0].slice(0, 46)}…
              </span>
              <Tag>{records.get(q.id)?.attempts ? '已训练' : '未训练'}</Tag>
            </div>
          ))}
          {pool.length > 12 && <div className="muted-2">……共 {pool.length} 题，练习时随机抽取。</div>}
        </div>
      </CardPad>
    </SessionShell>
  )
}
