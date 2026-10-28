import { useEffect, useRef, useState } from 'react'
import { useAiUsable } from '../lib/ai-access'
import { useStore } from '../store/StoreContext'
import { allQuestions, chapterOrder, TYPE_LABEL } from '../lib/bank'
import { ChapterPicker } from '../components/ChapterPicker'
import { buildPaper } from '../lib/scheduler'
import { displayUserAnswer, displayCorrectAnswer } from '../lib/answer-display'
import { CardPad, PageHead, Tag, Empty, Bar, useToast, useConfirm } from '../components/ui'
import { QuestionCard } from '../components/QuestionCard'
import { AiGradePanel } from '../components/AiQaPanel'
import type { AiReview, MockConfig, MockRun, Question } from '../lib/types'
import type { RouteName } from '../store/router'
import { IS_WEB_EDITION } from '../lib/edition'
import { useSync } from '../sync/CloudStore'
import type { ExamDocBody } from '../sync/protocol'
import { questionById } from '../lib/bank'
import { MockHistoryWeb, MockReviewWeb } from '../web/MockWeb'

const DEFAULT_CONFIG: MockConfig = {
  singleCount: 20,
  multiCount: 10,
  judgeCount: 10,
  shortCount: 1,
  singleScore: 1,
  multiScore: 2,
  judgeScore: 1,
  shortScore: 15,
  durationMin: 90,
  chapters: 'all',
}

/**
 * Fit a configuration to what the installed bank can actually supply.
 *
 * The shipped defaults describe a full-size final exam (20/10/10/1), which the
 * 17-question public sample bank cannot satisfy — so a first-time user of the
 * public build could not start ANY mock exam. Rather than shrinking the paper
 * silently (that would misrepresent the exam rules), this returns an explicitly
 * reduced config that is still a real, complete paper over the available
 * questions, letting the defaults be usable out of the box.
 *
 * Rules:
 *  - never invent questions or repeat one (counts are capped to what exists);
 *  - never raise a count above the user's intent;
 *  - a type the bank cannot supply at all is left at 0 rather than blocking the
 *    whole paper, so one missing type does not make the feature unreachable.
 * Callers must only use this when there is NO saved user configuration.
 */
function fitConfigToBank(all: Question[], base: MockConfig): { config: MockConfig; reduced: boolean } {
  const byType = (t: Question['type']) => all.filter((q) => q.type === t).length
  const subjective = all.filter((q) => q.type === 'short' || q.type === 'material').length

  const cap = (want: number, have: number) => Math.max(0, Math.min(want, have))

  const next: MockConfig = {
    ...base,
    singleCount: cap(base.singleCount, byType('single')),
    multiCount: cap(base.multiCount, byType('multi')),
    judgeCount: cap(base.judgeCount, byType('judge')),
    shortCount: cap(base.shortCount, subjective),
  }
  const reduced =
    next.singleCount !== base.singleCount ||
    next.multiCount !== base.multiCount ||
    next.judgeCount !== base.judgeCount ||
    next.shortCount !== base.shortCount

  // Guarantee at least one question overall so "start" can never produce an
  // empty paper; prefer an objective question when one exists.
  if (next.singleCount + next.multiCount + next.judgeCount + next.shortCount === 0 && all.length > 0) {
    const firstObjective = all.find((q) => q.type === 'single' || q.type === 'multi' || q.type === 'judge')
    if (firstObjective) {
      if (firstObjective.type === 'single') next.singleCount = 1
      else if (firstObjective.type === 'multi') next.multiCount = 1
      else next.judgeCount = 1
    }
  }

  // Keep the score total honest for a reduced paper: scale the duration down so
  // the timer still reflects a realistic pace instead of 90 minutes for 15 items.
  const total = next.singleCount + next.multiCount + next.judgeCount + next.shortCount
  const baseTotal = base.singleCount + base.multiCount + base.judgeCount + base.shortCount
  if (reduced && baseTotal > 0 && total > 0) {
    const scaled = Math.round((base.durationMin * total) / baseTotal)
    next.durationMin = Math.max(5, Math.min(base.durationMin, scaled))
  }

  return { config: next, reduced }
}

type Phase = 'config' | 'running' | 'done'

/**
 * Saved exam configuration.
 *
 * The user configures the paper ONCE (once the real exam format is known) and
 * then reuses it. Stored on the device, not in IndexedDB: it is a UI preference,
 * not learning data, so it must survive a data reset and never participate in
 * backup/restore schemas.
 */
const CONFIG_KEY = 'exampilot.mock.config'

/** Web edition: exam rules are an account setting (synced); see CloudStore. */
let cloudConfig: { get: () => unknown; set: (c: MockConfig) => void } | null = null

function loadSavedConfig(): MockConfig | null {
  try {
    const raw = cloudConfig ? JSON.stringify(cloudConfig.get() ?? null) : localStorage.getItem(CONFIG_KEY)
    if (!raw || raw === 'null') return null
    const p = JSON.parse(raw) as Partial<MockConfig>
    // Defensive: only accept a complete, structurally valid config.
    const numKeys: (keyof MockConfig)[] = [
      'singleCount',
      'multiCount',
      'judgeCount',
      'shortCount',
      'singleScore',
      'multiScore',
      'judgeScore',
      'shortScore',
      'durationMin',
    ]
    for (const k of numKeys) {
      if (typeof p[k] !== 'number' || !Number.isFinite(p[k] as number)) return null
    }
    if (!(p.chapters === 'all' || Array.isArray(p.chapters))) return null
    return {
      singleCount: p.singleCount as number,
      multiCount: p.multiCount as number,
      judgeCount: p.judgeCount as number,
      shortCount: p.shortCount as number,
      singleScore: p.singleScore as number,
      multiScore: p.multiScore as number,
      judgeScore: p.judgeScore as number,
      shortScore: p.shortScore as number,
      durationMin: p.durationMin as number,
      chapters: p.chapters as MockConfig['chapters'],
    }
  } catch {
    return null
  }
}

function saveConfig(c: MockConfig): void {
  if (cloudConfig) {
    cloudConfig.set(c)
    return
  }
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(c))
  } catch {
    /* storage unavailable: the exam still works, it just will not be remembered */
  }
}

/**
 * Answer display for the review screen lives in `lib/answer-display.ts` so it is
 * unit-testable without React. Re-exported here for call-site convenience.
 */
export { displayUserAnswer, displayCorrectAnswer } from '../lib/answer-display'

export function MockExam({
  nav,
}: {
  nav: (r: RouteName, p?: Record<string, string>) => void | Promise<void>
  params: Record<string, string>
}) {
  const aiOn = useAiUsable()
  const { ready, submitMockRun } = useStore()
  const sync = useSync()
  if (IS_WEB_EDITION && sync) {
    cloudConfig = {
      get: () => sync.engine.state.settings.mockConfig,
      set: (c) => void sync.engine.commit('settings', { patch: { mockConfig: c } }),
    }
  }
  // A saved configuration means "start immediately"; an unsaved one means the
  // first run needs configuring.
  const [savedConfig, setSavedConfig] = useState<MockConfig | null>(() => loadSavedConfig())
  /*
   * Initial config.
   *
   * With a saved config, honour it EXACTLY — the user's exam rules are theirs.
   * With no saved config, fit the shipped full-exam defaults to the installed
   * bank so a first-time user (notably on the 17-question public sample bank)
   * can start a real, valid paper instead of hitting "题库数量不足".
   */
  const [config, setConfig] = useState<MockConfig>(() => {
    const saved = loadSavedConfig()
    if (saved) return saved
    return fitConfigToBank(allQuestions, DEFAULT_CONFIG).config
  })
  const [defaultsWereReduced] = useState<boolean>(() => {
    if (loadSavedConfig()) return false
    return fitConfigToBank(allQuestions, DEFAULT_CONFIG).reduced
  })
  /*
   * The page opens as a simple "start" card, even on first visit.
   *
   * Nine numeric inputs on load made the exam look like a configuration tool
   * rather than an exam. The rules are one click away via 设置考试规则, which is
   * what "configure once, then reuse" actually means in daily use.
   */
  const [editing, setEditing] = useState(false)
  const [phase, setPhase] = useState<Phase>('config')
  const [paper, setPaper] = useState<Question[]>([])
  const [answers, setAnswers] = useState<Record<string, string | null>>({})
  const [idx, setIdx] = useState(0)
  const [endsAt, setEndsAt] = useState(0)
  const [now, setNow] = useState(Date.now())
  const [runId, setRunId] = useState('')
  const [result, setResult] = useState<MockRun | null>(null)
  const [paperError, setPaperError] = useState<string | null>(null)
  const [aiQid, setAiQid] = useState<string | null>(null)
  const { toast, el } = useToast()
  const { confirm, confirmEl } = useConfirm()
  const submitting = useRef(false)
  const anchorRef = useRef<HTMLDivElement | null>(null)
  const firstIdx = useRef(true)

  const clock = () => (sync ? sync.serverNow() : Date.now())
  useEffect(() => {
    if (phase !== 'running') return
    const t = setInterval(() => setNow(clock()), 1000)
    return () => clearInterval(t)
  }, [phase])

  /* ---------------- web edition: the running exam lives in the account ---------------- */
  const examDoc = sync ? sync.exam.current() : undefined
  const exam = examDoc && !examDoc.deleted ? (examDoc.body as ExamDocBody | null) : null
  const examMine = !!exam && !!sync && exam.holder === sync.engine.clientId && !examDoc?.serverNote
  // One running exam per account: a second start would be refused by the server.
  const examBlocking = !!exam && exam.status === 'active' && !examMine
  const [examNotice, setExamNotice] = useState<string | null>(null)
  const restoredRef = useRef(false)

  // Opening this page refreshes the account copy right away (no poll wait).
  useEffect(() => {
    if (sync) void sync.engine.syncNow()
  }, [])

  // Resume an exam this device holds (reload, browser restart).
  useEffect(() => {
    if (!sync || restoredRef.current || phase !== 'config') return
    if (!exam || exam.status !== 'active' || !examMine) return
    const qs = exam.qids.map((id) => questionById.get(id)).filter((x): x is Question => !!x)
    if (qs.length !== exam.qids.length) return
    restoredRef.current = true
    setConfig(exam.config as MockConfig)
    setPaper(qs)
    setAnswers({ ...Object.fromEntries(exam.qids.map((id) => [id, null])), ...exam.answers })
    setIdx(Math.min(exam.idx, qs.length - 1))
    setEndsAt(exam.endsAt)
    setNow(clock())
    setRunId(exam.runId)
    setPhase('running')
  }, [sync, exam?.runId, examMine, phase])

  // Persist every change of the running exam to the account (debounced upload).
  useEffect(() => {
    if (!sync || phase !== 'running' || !exam || exam.runId !== runId || !examMine) return
    void sync.exam.save(answers, idx)
  }, [answers, idx])

  // Another device took over / submitted / the exam was reset: stop here.
  useEffect(() => {
    if (!sync || phase !== 'running' || !runId) return
    const gone = !exam || exam.runId !== runId
    if (gone || exam!.status !== 'active' || !examMine) {
      setPhase('config')
      setPaper([])
      restoredRef.current = true
      setExamNotice(
        exam && exam.runId === runId && exam.status === 'submitted'
          ? '这场考试已经交卷（可能是在另一台设备上），成绩已计入，不会重复计分。'
          : exam && exam.runId === runId && exam.status === 'active'
            ? '这场考试已在另一台设备上继续，本设备已停止作答。之后的作答以那台设备为准。'
            : '这场考试已结束或已被放弃。',
      )
      if (examDoc?.serverNote) void sync.exam.clearNote()
    }
  }, [exam?.runId, exam?.status, exam?.holder, examDoc?.serverNote, examMine])

  /*
   * The exam writes nothing until the user submits, so losing the paper to a
   * reload is by design (and is stated on the page). What must not happen is
   * losing it *silently*, which is what a plain close used to do.
   */
  useEffect(() => {
    if (phase !== 'running' || IS_WEB_EDITION) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = '考试正在进行，离开将丢失本场作答。'
      return e.returnValue
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [phase])

  // Keep the question in view on every jump, including the number pills.
  useEffect(() => {
    if (phase !== 'running') return
    if (firstIdx.current) {
      firstIdx.current = false
      return
    }
    const el = anchorRef.current
    if (!el) return
    const top = el.getBoundingClientRect().top
    if (top < 0 || top > 120) el.scrollIntoView({ block: 'start', behavior: 'auto' })
    el.focus({ preventScroll: true })
  }, [idx, phase])

  /** Ask before submitting: a misclick used to end the exam outright. */
  const confirmSubmit = async () => {
    const blank = paper.length - Object.values(answers).filter((v) => v).length
    if (blank > 0) {
      const ok = await confirm({
        title: `还有 ${blank} 题未作答，确定交卷？`,
        body: '未作答的客观题不计对错、不进入错题本；交卷后本场成绩立即写入学习记录。',
        confirmLabel: '交卷',
        cancelLabel: '继续作答',
        danger: true,
      })
      if (!ok) return
    }
    await submitAll(false)
  }

  const remaining = phase === 'running' ? Math.max(0, endsAt - now) : 0
  const mm = Math.floor(remaining / 60000)
  const ss = Math.floor((remaining % 60000) / 1000)

  const start = () => {
    const built = buildPaper(allQuestions, {
      singleCount: config.singleCount,
      multiCount: config.multiCount,
      judgeCount: config.judgeCount,
      shortCount: config.shortCount,
      chapters: config.chapters,
    })
    if (!built.ok) {
      // Explain exactly why, and never silently shrink the paper.
      toast(built.error)
      setPaperError(built.error)
      return
    }
    // Remember the paper rules so the next session starts without reconfiguring.
    saveConfig(config)
    setSavedConfig(config)
    setEditing(false)
    setPaperError(null)
    const id = `m-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    const t0 = clock()
    setPaper(built.questions)
    setAnswers(Object.fromEntries(built.questions.map((q) => [q.id, null])))
    setIdx(0)
    setEndsAt(t0 + config.durationMin * 60000)
    setNow(t0)
    setRunId(id)
    setExamNotice(null)
    restoredRef.current = true
    if (sync) {
      void sync.exam.start({
        runId: id,
        qids: built.questions.map((q) => q.id),
        config,
        durationMs: config.durationMin * 60000,
      })
    }
    setPhase('running')
  }

  // The server may shorten (never extend) the deadline; follow it.
  useEffect(() => {
    if (sync && phase === 'running' && exam && exam.runId === runId && exam.endsAt !== endsAt) setEndsAt(exam.endsAt)
  }, [exam?.endsAt])

  /**
   * Submit the exam.
   *
   * The whole submission (learning records + history + mock archive) is applied
   * by `submitMockRun` inside ONE Dexie transaction, keyed by the stable `runId`:
   *  - a failure anywhere rolls everything back (no half-persisted exam);
   *  - re-entry after success is a no-op, so double-clicking 交卷 or a timer/manual
   *    race cannot double-count attempts, correct counts or the wrong bank;
   *  - progress is read from the DB inside the transaction, not from this
   *    component's possibly stale snapshot.
   */
  const submitAll = async (auto = false) => {
    if (submitting.current) return
    if (paper.length === 0) return
    submitting.current = true
    try {
      const out = await submitMockRun({
        runId,
        paper,
        submissions: answers,
        config,
        startedAt: exam && exam.runId === runId ? exam.startedAt : endsAt - config.durationMin * 60000,
        endedAt: Math.min(clock(), endsAt),
      })
      setResult(out.run)
      setPhase('done')
      if (auto) toast('考试时间到，已自动交卷')
      else if (out.status === 'already-submitted') toast('本场考试已提交，未重复计分')
    } catch (e) {
      // Transaction rolled back: the exam stays on screen and can be retried.
      toast(`交卷失败：${(e as Error).message}。数据未写入，可安全重试。`)
    } finally {
      submitting.current = false
    }
  }

  const submitAllRef = useRef(submitAll)
  submitAllRef.current = submitAll

  useEffect(() => {
    if (phase === 'running' && remaining <= 0) void submitAllRef.current(true)
  }, [remaining, phase])

  if (!ready) return null

  const q = paper[idx]
  const answeredCount = Object.values(answers).filter((v) => v).length
  const finalScore = result?.score ?? 0

  /*
   * Announce the clock at two milestones instead of every second. Screen readers
   * need to know when time is nearly out, not to be interrupted 300 times.
   */
  const timeWarning =
    phase !== 'running'
      ? ''
      : remaining <= 60000
        ? `剩余不足 1 分钟`
        : remaining <= 5 * 60000 && remaining > 5 * 60000 - 1500
          ? '剩余 5 分钟'
          : ''

  return (
    <>
      <PageHead
        title="全真模拟考试"
        desc="题型、题量、分值与时长均可配置——未获知正式考试要求时，默认值只是模板，不代表真实考纲。成绩与练习共用同一套学习记录。"
      />

      <CardPad style={{ marginBottom: 14 }}>
        {IS_WEB_EDITION ? (
          <div className="muted-2">
            考试进行中会自动保存到你的账号：刷新页面、关闭浏览器或换一台设备登录，都可以接着作答，计时按开始时间继续，不会重置。
            同一场考试只会计分一次。
          </div>
        ) : (
          <div className="muted-2">
            限制说明：考试进行中若刷新页面或关闭标签页，本场考试的作答现场<b>不会保留</b>，需重新开始。
            交卷写入具有事务性与幂等性：失败会整体回滚，同一场考试重复提交不会重复累计学习数据。
          </div>
        )}
      </CardPad>

      {examNotice && (
        <div className="sync-notice info" role="status" style={{ marginBottom: 14 }}>
          <span>{examNotice}</span>
          <button className="btn btn-sm btn-ghost" onClick={() => setExamNotice(null)}>
            知道了
          </button>
        </div>
      )}

      {sync && phase === 'config' && exam && exam.status === 'active' && !examMine && (
        <ExamElsewhere
          exam={exam}
          serverNow={clock()}
          onTakeover={async () => {
            const r = await sync.exam.takeover(exam.runId)
            if (r === 'changed') toast('考试状态刚刚更新，请确认后再继续')
            else if (r === 'ok') {
              restoredRef.current = false
              setExamNotice(null)
              setPhase('config')
              setNow(clock())
            } else if (r === 'offline') toast('需要联网才能把考试接到本设备，请联网后再试')
            else toast('这场考试已结束或已在别处交卷，无法接续')
          }}
          onSubmitExpired={async () => {
            const qs = exam.qids.map((id) => questionById.get(id)).filter((x): x is Question => !!x)
            if (qs.length !== exam.qids.length) return
            try {
              const out = await submitMockRun({
                runId: exam.runId,
                paper: qs,
                submissions: { ...Object.fromEntries(exam.qids.map((id) => [id, null])), ...exam.answers },
                config: exam.config as MockConfig,
                startedAt: exam.startedAt,
                endedAt: exam.endsAt,
              })
              setPaper(qs)
              setConfig(exam.config as MockConfig)
              setAnswers(out.run.submissions)
              setResult(out.run)
              setPhase('done')
            } catch (e) {
              toast(`交卷失败：${(e as Error).message}`)
            }
          }}
          onAbandon={async () => {
            const ok = await confirm({
              title: '放弃这场考试？',
              body: '放弃后这场考试不计分、不写入学习记录，所有设备上都会结束。',
              confirmLabel: '放弃',
              danger: true,
            })
            if (ok) await sync.exam.abandon()
          }}
        />
      )}

      {phase === 'config' && (
        <>
          <CardPad>
            {/*
              Configure ONCE, then reuse.
              With a saved configuration the page opens as a simple "start" card;
              the nine numeric inputs only appear when the user chooses to edit
              the rules. The inputs themselves are unchanged.
            */}
            <div className="row-between" style={{ marginBottom: editing ? 12 : 0 }}>
              <div>
                <div className="card-title" style={{ margin: 0 }}>
                  {savedConfig ? '考试规则（已保存）' : '考试规则（模板）'}
                </div>
                <div className="muted-2" style={{ marginTop: 4 }}>
                  {savedConfig
                    ? `单选 ${savedConfig.singleCount} · 多选 ${savedConfig.multiCount} · 判断 ${savedConfig.judgeCount} · 主观 ${savedConfig.shortCount} · ${savedConfig.durationMin} 分钟`
                    : `单选 ${config.singleCount} · 多选 ${config.multiCount} · 判断 ${config.judgeCount} · 主观 ${config.shortCount} · ${config.durationMin} 分钟（当前为模板默认值，可直接开始；等你得知正式考试要求后，点右侧「设置考试规则」填一次，之后直接开始即可）`}
                </div>
                {!savedConfig && defaultsWereReduced && (
                  <div className="muted-2" style={{ marginTop: 4, color: 'var(--warn)' }}>
                    已按当前题库实际题量调整默认配置（题库不足以出具完整规模试卷）。这是可用的默认值，不代表真实考纲；正式考试要求明确后请自行设置。
                  </div>
                )}
              </div>
              <button className="btn btn-sm" aria-expanded={editing} onClick={() => setEditing((v) => !v)}>
                {editing ? '收起规则设置' : '设置考试规则'}
              </button>
            </div>

            {editing && (
              <>
                <div className="grid grid-3" style={{ marginTop: 12 }}>
                  <NumField
                    label="单选题数量"
                    value={config.singleCount}
                    max={allQuestions.filter((q) => q.type === 'single').length}
                    onChange={(v) => setConfig((c) => ({ ...c, singleCount: v }))}
                  />
                  <NumField
                    label="多选题数量"
                    value={config.multiCount}
                    max={allQuestions.filter((q) => q.type === 'multi').length}
                    onChange={(v) => setConfig((c) => ({ ...c, multiCount: v }))}
                  />
                  <NumField
                    label="判断题数量"
                    value={config.judgeCount}
                    max={allQuestions.filter((q) => q.type === 'judge').length}
                    onChange={(v) => setConfig((c) => ({ ...c, judgeCount: v }))}
                  />
                  <NumField
                    label="主观题数量"
                    value={config.shortCount}
                    max={allQuestions.filter((q) => q.type === 'short' || q.type === 'material').length}
                    onChange={(v) => setConfig((c) => ({ ...c, shortCount: v }))}
                  />
                  <NumField
                    label="单选每题分值"
                    value={config.singleScore}
                    max={100}
                    onChange={(v) => setConfig((c) => ({ ...c, singleScore: v }))}
                  />
                  <NumField
                    label="多选每题分值"
                    value={config.multiScore}
                    max={100}
                    onChange={(v) => setConfig((c) => ({ ...c, multiScore: v }))}
                  />
                  <NumField
                    label="判断每题分值"
                    value={config.judgeScore}
                    max={100}
                    onChange={(v) => setConfig((c) => ({ ...c, judgeScore: v }))}
                  />
                  <NumField
                    label="主观题每题分值"
                    value={config.shortScore}
                    max={100}
                    onChange={(v) => setConfig((c) => ({ ...c, shortScore: v }))}
                  />
                  <NumField
                    label="考试时长（分钟）"
                    value={config.durationMin}
                    max={300}
                    onChange={(v) => setConfig((c) => ({ ...c, durationMin: v }))}
                  />
                </div>

                <div className="card-title" style={{ marginTop: 6 }}>
                  章节范围
                </div>
                <ChapterPicker
                  total={chapterOrder.length}
                  summary={config.chapters === 'all' ? '当前：全部章节' : `已选：${config.chapters.join('、')}`}
                  legacyClassName="pill-scroll"
                >
                  <button
                    className={`btn btn-sm ${config.chapters === 'all' ? 'btn-primary' : ''}`}
                    onClick={() => setConfig((c) => ({ ...c, chapters: 'all' }))}
                  >
                    全部章节
                  </button>
                  {chapterOrder.map((ch) => (
                    <button
                      key={ch}
                      className={`btn btn-sm ${Array.isArray(config.chapters) && config.chapters.includes(ch) ? 'btn-primary' : ''}`}
                      onClick={() =>
                        setConfig((c) => {
                          const cur = c.chapters === 'all' ? [] : [...c.chapters]
                          const next = cur.includes(ch) ? cur.filter((x) => x !== ch) : [...cur, ch]
                          return { ...c, chapters: next.length ? next : 'all' }
                        })
                      }
                    >
                      {ch}
                    </button>
                  ))}
                </ChapterPicker>

                <div className="muted" style={{ marginTop: 12 }}>
                  当前配置总分：
                  <b>
                    {config.singleCount * config.singleScore +
                      config.multiCount * config.multiScore +
                      config.judgeCount * config.judgeScore +
                      config.shortCount * config.shortScore}
                  </b>{' '}
                  分（单选 {config.singleCount}×{config.singleScore} + 多选 {config.multiCount}×{config.multiScore} +
                  判断 {config.judgeCount}×{config.judgeScore} + 主观 {config.shortCount}×{config.shortScore}）
                </div>
              </>
            )}

            <div className="divider" />
            <div className="row-between">
              <div className="muted-2">
                {examBlocking
                  ? '账号里还有一场没交卷的考试，先继续作答或放弃它，才能开始新的一场。'
                  : IS_WEB_EDITION
                    ? '考试开始后会自动保存，换设备也能接着答。'
                    : '考试开始后若刷新页面，作答现场不会保留。'}
              </div>
              <button className="btn btn-primary btn-lg" onClick={start} disabled={examBlocking}>
                开始考试
              </button>
            </div>
            {paperError && (
              <div className="result-banner bad" style={{ marginTop: 12 }}>
                {paperError}
              </div>
            )}
          </CardPad>

          <CardPad style={{ marginTop: 14 }}>
            <div className="card-title">历史模拟成绩</div>
            <HistoryList />
          </CardPad>
        </>
      )}

      {phase === 'running' && q && (
        <>
          <CardPad>
            <div className="row-between" style={{ marginBottom: 12 }}>
              <div className="row" style={{ gap: 12 }}>
                <span className="muted">
                  第 {idx + 1} / {paper.length} 题
                </span>
                <Tag tone={answeredCount === paper.length ? 'ok' : 'plain'}>
                  已答 {answeredCount} / {paper.length}
                </Tag>
              </div>
              {/*
                The clock must not be an assertive live region: announcing the
                remaining time every second makes a screen reader unusable for
                the whole exam. It stays a `timer` (which is not announced
                automatically) and the milestone warnings below carry the
                announcements instead.
              */}
              <div
                className={`timer ${remaining < 5 * 60000 ? 'urgent' : ''}`}
                role="timer"
                aria-live="off"
                aria-label={`剩余时间 ${mm} 分 ${ss} 秒`}
              >
                {String(mm).padStart(2, '0')}:{String(ss).padStart(2, '0')}
              </div>
            </div>
            <span className="sr-only" role="status" aria-live="polite">
              {timeWarning}
            </span>
            <Bar value={answeredCount / paper.length} tone="accent" />
            <div
              className="progress-dots"
              role="group"
              aria-label={`试题进度：共 ${paper.length} 题，已答 ${answeredCount} 题`}
            >
              {paper.map((qq, i) => (
                <i
                  key={qq.id}
                  className={`${answers[qq.id] ? 'ok' : ''} ${i === idx ? 'cur' : ''}`}
                  role="img"
                  aria-label={`第 ${i + 1} 题：${answers[qq.id] ? '已作答' : '未作答'}`}
                />
              ))}
            </div>
          </CardPad>

          <div ref={anchorRef} tabIndex={-1} className="runner-anchor" style={{ marginTop: 14 }}>
            <QuestionCard
              q={q}
              value={answers[q.id] ?? null}
              onChange={(v) => setAnswers((a) => ({ ...a, [q.id]: v }))}
              reveal={false}
            />
          </div>

          <div className="btn-row" style={{ marginTop: 16, gap: 10 }}>
            <button className="btn" onClick={() => setIdx((i) => Math.max(0, i - 1))} disabled={idx === 0}>
              上一题
            </button>
            <button
              className="btn"
              onClick={() => setIdx((i) => Math.min(paper.length - 1, i + 1))}
              disabled={idx === paper.length - 1}
            >
              下一题
            </button>
            <button
              className="btn btn-ghost"
              onClick={() => setAnswers((a) => ({ ...a, [q.id]: null }))}
              disabled={!answers[q.id]}
            >
              清除本题
            </button>
            <span style={{ flex: 1 }} />
            {sync && (
              <button
                className="btn btn-ghost"
                onClick={async () => {
                  const ok = await confirm({
                    title: '放弃本场考试？',
                    body: '放弃后本场不计分、不写入学习记录，所有设备上都会结束。',
                    confirmLabel: '放弃',
                    cancelLabel: '继续作答',
                    danger: true,
                  })
                  if (!ok) return
                  await sync.exam.abandon()
                }}
              >
                放弃本场
              </button>
            )}
            <button className="btn btn-primary btn-lg" onClick={() => void confirmSubmit()}>
              交卷并评分
            </button>
          </div>

          <div className="muted-2" style={{ marginTop: 8 }}>
            {answeredCount < paper.length
              ? `还有 ${paper.length - answeredCount} 题未作答。未作答的客观题不计对错，也不进入错题本。`
              : '全部题目已作答，可以交卷。'}
          </div>

          <div className="pill-scroll" style={{ marginTop: 12 }}>
            {paper.map((qq, i) => (
              <button
                key={qq.id}
                className={`btn btn-sm ${i === idx ? 'btn-primary' : answers[qq.id] ? '' : 'btn-ghost'}`}
                onClick={() => setIdx(i)}
                title={qq.stem.slice(0, 40)}
              >
                {i + 1}
              </button>
            ))}
          </div>
        </>
      )}

      {phase === 'done' && result && (
        <>
          <CardPad>
            <div className="row-between" style={{ marginBottom: 12 }}>
              <div>
                <div className="card-title">考试结果</div>
                <div className="muted">
                  客观题得分{' '}
                  <b
                    style={{
                      fontSize: 26,
                      color:
                        finalScore / Math.max(1, result.objectiveMaxScore) >= 0.8
                          ? 'var(--ok)'
                          : finalScore / Math.max(1, result.objectiveMaxScore) >= 0.6
                            ? 'var(--warn)'
                            : 'var(--bad)',
                    }}
                  >
                    {finalScore}
                  </b>{' '}
                  / {result.objectiveMaxScore}（已自动评分部分，占{' '}
                  {Math.round((result.objectiveMaxScore / Math.max(1, result.maxScore)) * 100)}%）
                </div>
                {result.subjectiveMaxScore > 0 && (
                  <div className="muted" style={{ marginTop: 4 }}>
                    主观题 {result.subjectiveMaxScore} 分未自动评分（题库无标准答案），卷面总分 {result.maxScore}{' '}
                    分。当前得分率 <b>{Math.round((finalScore / Math.max(1, result.objectiveMaxScore)) * 100)}%</b>{' '}
                    仅为已判分部分的得分率，不代表完整试卷成绩。
                  </div>
                )}
              </div>
              <div className="btn-row">
                <button
                  className="btn"
                  onClick={() => {
                    setPhase('config')
                    setResult(null)
                  }}
                >
                  再考一场
                </button>
                <button className="btn btn-primary" onClick={() => nav('diagnosis')}>
                  查看诊断
                </button>
              </div>
            </div>
            <Bar
              value={finalScore / Math.max(1, result.objectiveMaxScore)}
              tone={
                finalScore / Math.max(1, result.objectiveMaxScore) >= 0.8
                  ? 'ok'
                  : finalScore / Math.max(1, result.objectiveMaxScore) >= 0.6
                    ? 'warn'
                    : 'bad'
              }
            />
            <div className="muted-2" style={{ marginTop: 8 }}>
              客观题由题库答案严格判定；未作答不计入对错，也不进入错题本；主观题未自动评分
              {aiOn ? '，可点击题目中的「AI 参考评阅」' : '，请对照答题结构自评'}。本次已作答内容计入同一套学习记录。
            </div>
          </CardPad>

          {IS_WEB_EDITION ? (
            <CardPad style={{ marginTop: 14 }}>
              <div className="card-title">逐题复盘</div>
              <MockReviewWeb
                aiReviews={[]}
                items={(paper.length
                  ? paper.map((x) => x.id)
                  : Object.keys({ ...result.submissions, ...result.perQuestion })
                ).map((qid) => ({
                  qid,
                  per: result.perQuestion[qid],
                  mine: result.submissions[qid] ?? null,
                }))}
                extra={(qq, mine) =>
                  (qq.type === 'short' || qq.type === 'material') && aiOn ? (
                    <>
                      <button
                        className="btn btn-sm"
                        style={{ marginTop: 8 }}
                        onClick={() => setAiQid(aiQid === qq.id ? null : qq.id)}
                      >
                        {aiQid === qq.id ? '收起 AI 评阅' : 'AI 参考评阅'}
                      </button>
                      {aiQid === qq.id && <AiGradePanel q={qq} userAnswer={mine ?? ''} sessionId={result.id} />}
                    </>
                  ) : null
                }
              />
            </CardPad>
          ) : (
            <CardPad style={{ marginTop: 14 }}>
              <div className="card-title">逐题复盘</div>
              <div className="col" style={{ gap: 12 }}>
                {(paper.length
                  ? paper
                  : // 交卷与“另一台设备已交卷”同时发生时 paper 可能已被清空：按本场成绩里保存的题号恢复
                    Object.keys({ ...result.submissions, ...result.perQuestion })
                      .map((id) => questionById.get(id))
                      .filter((x): x is Question => !!x)
                ).map((qq, i) => {
                  const per = result.perQuestion[qq.id]
                  const mine = result.submissions[qq.id]
                  const isSub = qq.type === 'short' || qq.type === 'material'
                  return (
                    <div key={qq.id} className="card card-pad" style={{ boxShadow: 'none' }}>
                      <div className="row-between" style={{ marginBottom: 8 }}>
                        <span className="muted">
                          第 {i + 1} 题 · {TYPE_LABEL[qq.type]} · {qq.chapter}
                        </span>
                        {isSub ? (
                          per?.unanswered ? (
                            <Tag tone="warn">主观题 · 未作答</Tag>
                          ) : (
                            <Tag tone="warn">主观题 · 未自动评分</Tag>
                          )
                        ) : per?.unanswered ? (
                          <Tag>未作答 · 不计对错</Tag>
                        ) : per?.isCorrect ? (
                          <Tag tone="ok">正确 +{per.points}</Tag>
                        ) : (
                          <Tag tone="bad">错误 0 分</Tag>
                        )}
                      </div>
                      <div className="q-stem" style={{ fontSize: 14.5 }}>
                        {qq.stem}
                      </div>
                      <div className="muted" style={{ marginTop: 6 }}>
                        你的作答：
                        <b>{displayUserAnswer(qq.type, mine)}</b>
                        {!isSub && (
                          <span style={{ marginLeft: 8 }}>
                            正确答案：
                            <b>{displayCorrectAnswer(qq.answerNorm)}</b>
                          </span>
                        )}
                      </div>
                      {isSub && aiOn && (
                        <>
                          <button
                            className="btn btn-sm"
                            style={{ marginTop: 8 }}
                            onClick={() => setAiQid(aiQid === qq.id ? null : qq.id)}
                          >
                            {aiQid === qq.id ? '收起 AI 评阅' : 'AI 参考评阅'}
                          </button>
                          {aiQid === qq.id && <AiGradePanel q={qq} userAnswer={mine ?? ''} sessionId={result.id} />}
                        </>
                      )}
                    </div>
                  )
                })}
              </div>
            </CardPad>
          )}

          {/* R-04: right after 交卷 the archive is already saved — show it here too, so the
              user (or a test) staying on #/mock sees the new row without leaving the page. */}
          <CardPad style={{ marginTop: 14 }}>
            <div className="card-title">历史模拟成绩</div>
            <HistoryList />
          </CardPad>
        </>
      )}

      {el}
      {confirmEl}
    </>
  )

  function HistoryList() {
    const { mocks, legacy, deleteMockRun, aiReviews } = useStore()
    const [viewId, setViewId] = useState<string | null>(null)
    const viewing = viewId ? mocks.find((m) => m.id === viewId) : undefined
    if (viewing && IS_WEB_EDITION) {
      const qids = Object.keys(viewing.perQuestion).length
        ? Object.keys(viewing.perQuestion)
        : Object.keys(viewing.submissions)
      return (
        <MockReviewWeb
          aiReviews={aiReviews}
          items={qids.map((qid) => ({ qid, per: viewing.perQuestion[qid], mine: viewing.submissions[qid] ?? null }))}
          header={
            <div className="row-between" style={{ marginBottom: 10, gap: 8, flexWrap: 'wrap' }}>
              <div className="muted">
                {new Date(viewing.startedAt).toLocaleString('zh-CN', { hour12: false })} · {qids.length} 题 · 客观题{' '}
                <b>{viewing.score ?? 0}</b> / {viewing.objectiveMaxScore ?? viewing.maxScore}
                {viewing.subjectiveMaxScore ? `（另 ${viewing.subjectiveMaxScore} 分主观题未自动评分）` : ''} · 只读复盘
              </div>
              <button className="btn btn-sm" onClick={() => setViewId(null)}>
                返回历史列表
              </button>
            </div>
          }
        />
      )
    }
    if (viewing) return <MockRunReview run={viewing} aiReviews={aiReviews} onBack={() => setViewId(null)} />
    const legacyNote =
      legacy.mocks > 0 ? (
        <div className="muted-2" style={{ marginTop: 8 }}>
          另有 {legacy.mocks} 场旧版演示题库的模拟考试不属于当前题库，未列出、不计入统计（仍保留在本浏览器）。
        </div>
      ) : null
    if (mocks.length === 0)
      return (
        <>
          <Empty text="还没有模拟考试记录。" />
          {legacyNote}
        </>
      )
    if (IS_WEB_EDITION)
      return (
        <>
          {legacyNote}
          <MockHistoryWeb mocks={mocks} onView={setViewId} onDelete={(id) => void deleteMockRun(id)} />
        </>
      )
    return (
      <>
        {legacyNote}
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>时间</th>
                <th>题量</th>
                <th>得分</th>
                <th>得分率</th>
                <th>时长</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {mocks.map((m) => {
                const sc = m.score ?? 0
                // Legacy runs (pre-0.2.0) have no objectiveMaxScore; fall back to maxScore.
                const graded = m.objectiveMaxScore ?? m.maxScore ?? 1
                return (
                  <tr key={m.id}>
                    <td className="code">{new Date(m.startedAt).toLocaleString('zh-CN', { hour12: false })}</td>
                    <td>{Object.keys(m.submissions).length}</td>
                    <td>
                      <b>{sc}</b> / {graded}
                      {m.subjectiveMaxScore ? <span className="muted-2"> +{m.subjectiveMaxScore} 未评分</span> : null}
                    </td>
                    <td>
                      <div className="row" style={{ gap: 8 }}>
                        <div style={{ width: 70 }}>
                          <Bar value={sc / Math.max(1, graded)} tone="accent" />
                        </div>
                        <span>{Math.round((sc / Math.max(1, graded)) * 100)}%</span>
                      </div>
                    </td>
                    <td>{Math.round(((m.endedAt ?? m.startedAt) - m.startedAt) / 60000)} 分钟</td>
                    <td>
                      <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
                        <button
                          className="btn btn-sm"
                          onClick={() => setViewId(m.id)}
                          aria-label={`查看 ${new Date(m.startedAt).toLocaleString('zh-CN', { hour12: false })} 这场的逐题复盘`}
                        >
                          查看
                        </button>
                        <button className="btn btn-sm btn-ghost" onClick={() => void deleteMockRun(m.id)}>
                          删除
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </>
    )
  }
}

function NumField({
  label,
  value,
  max,
  onChange,
}: {
  label: string
  value: number
  max: number
  onChange: (v: number) => void
}) {
  return (
    <label className="field">
      <span className="field-label">
        {label}（上限 {max}）
      </span>
      <input
        className="input"
        type="number"
        min={0}
        max={max}
        value={value}
        onChange={(e) => onChange(Math.max(0, Math.min(max, Number(e.target.value) || 0)))}
      />
    </label>
  )
}

function ExamElsewhere({
  exam,
  serverNow,
  onTakeover,
  onSubmitExpired,
  onAbandon,
}: {
  exam: ExamDocBody
  serverNow: number
  onTakeover: () => Promise<void>
  onSubmitExpired: () => Promise<void>
  onAbandon: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const left = exam.endsAt - serverNow
  const answered = Object.values(exam.answers ?? {}).filter((v) => v).length
  const run = (fn: () => Promise<void>) => async () => {
    setBusy(true)
    try {
      await fn()
    } finally {
      setBusy(false)
    }
  }
  return (
    <CardPad style={{ marginBottom: 14 }}>
      <div className="card-title">有一场没有交卷的模拟考试</div>
      <div className="muted" style={{ marginBottom: 10 }}>
        共 {exam.qids.length} 题，已答 {answered} 题。
        {left > 0
          ? `剩余约 ${Math.max(1, Math.round(left / 60000))} 分钟，计时从开始时间连续计算。它目前在另一台设备上作答。`
          : '已经到达考试时间，按截止时保存的作答交卷。'}
      </div>
      <div className="btn-row">
        {left > 0 ? (
          <button className="btn btn-primary" disabled={busy} onClick={run(onTakeover)}>
            在本设备继续作答
          </button>
        ) : (
          <button className="btn btn-primary" disabled={busy} onClick={run(onSubmitExpired)}>
            按截止时的作答交卷
          </button>
        )}
        <button className="btn btn-ghost" disabled={busy} onClick={run(onAbandon)}>
          放弃这场考试
        </button>
      </div>
    </CardPad>
  )
}

/**
 * D-03: read-only per-question review of a past mock run, built only from what the
 * run stored (its submissions and per-question results) plus the bank's own
 * answer. Nothing here changes the score; nothing is made up — a question with no
 * official answer says so, and there is no bank explanation to show.
 */
function MockRunReview({ run, aiReviews, onBack }: { run: MockRun; aiReviews: AiReview[]; onBack: () => void }) {
  const qids = Object.keys(run.perQuestion).length ? Object.keys(run.perQuestion) : Object.keys(run.submissions)
  const sc = run.score ?? 0
  const graded = run.objectiveMaxScore ?? run.maxScore ?? 1
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.scrollIntoView({ block: 'start' })
  }, [])
  return (
    <div ref={ref} tabIndex={-1} className="mock-review" aria-label="模拟考试逐题复盘">
      <div className="row-between" style={{ marginBottom: 10, gap: 8, flexWrap: 'wrap' }}>
        <div className="muted">
          {new Date(run.startedAt).toLocaleString('zh-CN', { hour12: false })} · {qids.length} 题 · 客观题 <b>{sc}</b> /{' '}
          {graded}
          {run.subjectiveMaxScore ? `（另 ${run.subjectiveMaxScore} 分主观题未自动评分）` : ''}
        </div>
        <button className="btn btn-sm" onClick={onBack}>
          返回历史列表
        </button>
      </div>
      <div className="muted-2" style={{ marginBottom: 10 }}>
        只读复盘：分数以交卷时为准，不会被修改。
      </div>
      <div className="col" style={{ gap: 12 }}>
        {qids.map((qid, i) => {
          const qq = questionById.get(qid)
          const per = run.perQuestion[qid]
          const mine = run.submissions[qid] ?? null
          if (!qq)
            return (
              <div key={qid} className="card card-pad" style={{ boxShadow: 'none' }}>
                <span className="muted">第 {i + 1} 题 · 该题已不在当前题库中，无法显示题干</span>
              </div>
            )
          const isSub = qq.type === 'short' || qq.type === 'material'
          const review = isSub && mine ? aiReviews.find((r) => r.qid === qid && r.userAnswer === mine) : undefined
          return (
            <div key={qid} className="card card-pad" style={{ boxShadow: 'none' }}>
              <div className="row-between" style={{ marginBottom: 8, gap: 8, flexWrap: 'wrap' }}>
                <span className="muted">
                  第 {i + 1} 题 · {TYPE_LABEL[qq.type]} · {qq.chapter}
                </span>
                {isSub ? (
                  per?.unanswered || !mine ? (
                    <Tag tone="warn">主观题 · 未作答</Tag>
                  ) : (
                    <Tag tone="warn">主观题 · 未自动评分</Tag>
                  )
                ) : per?.unanswered || mine === null ? (
                  <Tag>未作答 · 不计对错</Tag>
                ) : per?.isCorrect ? (
                  <Tag tone="ok">正确 +{per.points}</Tag>
                ) : (
                  <Tag tone="bad">错误 0 分</Tag>
                )}
              </div>
              <div className="q-stem" style={{ fontSize: 14.5 }}>
                {qq.stem}
              </div>
              {qq.options.length > 0 && (
                <ol className="mock-review-opts" type="A">
                  {qq.options.map((o, k) => (
                    <li key={k}>{o}</li>
                  ))}
                </ol>
              )}
              <div className="muted" style={{ marginTop: 6 }}>
                你的作答：<b style={{ whiteSpace: 'pre-wrap' }}>{displayUserAnswer(qq.type, mine)}</b>
                {!isSub && (
                  <span style={{ marginLeft: 8 }}>
                    正确答案：
                    <b>{qq.hasOfficialAnswer ? displayCorrectAnswer(qq.answerNorm) : '题库未提供'}</b>
                  </span>
                )}
              </div>
              {isSub &&
                (review ? (
                  <div className="muted-2" style={{ marginTop: 6 }}>
                    当时的 AI 参考评阅：{review.result.score} 分（仅供参考，详见「AI 记录」）
                  </div>
                ) : (
                  <div className="muted-2" style={{ marginTop: 6 }}>
                    主观题题库无标准答案{mine ? '；这场没有保存 AI 评阅' : ''}。
                  </div>
                ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}
