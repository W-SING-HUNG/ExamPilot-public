/**
 * Web edition store: the same StoreValue the pages already use, backed by the
 * account's synced operation log instead of a per-browser database.
 *
 * Boot order (no data is shown before the account is verified by the server):
 *   1. GET /api/sync/me  → verified account id + email (from the Access token)
 *   2. open that account's own IndexedDB (exampilot-cloud-<accountId>)
 *   3. fold local data → render immediately → sync in the background
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { StoreContext, type StoreValue } from '../store/StoreContext'
import { SyncEngine, newOpId, type SyncStatus, type LocalDoc } from './engine'
import { scoreAnswer, isAnswerBlank } from '../lib/scoring'
import { questionById, bank } from '../lib/bank'
import { gradeMockSubmission } from '../lib/mock-grading'
import { attemptIdFor, aiReviewIdFor } from '../lib/session'
import { bankFingerprint } from '../lib/bank-fingerprint'
import { setDraftBackend, type DraftBackend, type SessionDraft } from '../lib/session-draft'
import type { ExamDocBody, MeResponse } from './protocol'
import type { AiReview, AppSettings, HistoryEntry, MockConfig, MockRun, QRecord, Question } from '../lib/types'
import { buildImportOps } from './legacy'
import { DEFAULT_SYNCED_SETTINGS, type AiConversation } from './fold'
import { MAX_AI_MSG_CHARS, type AiChatMsg } from './protocol'
import { setAiAccount } from '../lib/ai-access'

/* ------------------------------ sync context ------------------------------ */

export interface SyncCtx {
  engine: SyncEngine
  status: SyncStatus
  email: string
  accountId: string
  /** server-anchored clock */
  serverNow: () => number
  exam: ExamApi
  /** AI conversations of this account (synced; empty for accounts that never used AI) */
  aiChats: AiConversation[]
  aiChat: AiChatApi
  /** the one-time Pro welcome was already shown on some device of this account */
  proWelcomed: boolean
  markProWelcomed: () => Promise<void>
}

export interface AiChatApi {
  /** create or update one message (same msg.id = same message on every device) */
  putMsg: (conv: string, msg: AiChatMsg, meta?: { title?: string; kind?: 'question' | 'free' }) => Promise<void>
  deleteConv: (conv: string) => Promise<void>
}

export interface ExamApi {
  current: () => LocalDoc | undefined
  start: (input: { runId: string; qids: string[]; config: MockConfig; durationMs: number }) => Promise<void>
  save: (answers: Record<string, string | null>, idx: number) => Promise<void>
  takeover: (runId?: string) => Promise<'ok' | 'offline' | 'failed' | 'changed'>
  abandon: () => Promise<void>
  clearNote: () => Promise<void>
}

const SyncContext = createContext<SyncCtx | null>(null)
export function useSync(): SyncCtx | null {
  return useContext(SyncContext)
}

/* --------------------------------- helpers -------------------------------- */

function clientId(): string {
  let v = localStorage.getItem('exampilot.clientId')
  if (!v || !/^[A-Za-z0-9_-]{8,64}$/.test(v)) {
    const b = new Uint8Array(12)
    crypto.getRandomValues(b)
    v = 'c' + [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
    localStorage.setItem('exampilot.clientId', v)
  }
  return v
}

const browserFetch = (path: string, init: RequestInit) => fetch(path, init)

const inBank = (qid: string) => questionById.has(qid)
const mockInBank = (m: MockRun) => Object.keys(m.submissions ?? {}).every(inBank)

type BootState =
  | { phase: 'identifying' }
  | { phase: 'error'; kind: 'auth' | 'network' | 'update'; message: string }
  | { phase: 'ready'; engine: SyncEngine; email: string; accountId: string }

/* ------------------------------- provider --------------------------------- */

export function CloudStoreProvider({ children }: { children: ReactNode }) {
  const [boot, setBoot] = useState<BootState>({ phase: 'identifying' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let alive = true
    let engine: SyncEngine | null = null
    ;(async () => {
      try {
        const fp = (await bankFingerprint(bank)).hashes.full
        let me: MeResponse | null = null
        let lastErr = ''
        for (let i = 0; i < 4 && !me; i++) {
          try {
            const r = await fetch('/api/sync/me', {
              headers: { 'X-ExamPilot-Sync': '1' },
              credentials: 'same-origin',
              redirect: 'manual',
              cache: 'no-store',
            })
            if (r.type === 'opaqueredirect' || r.status === 401 || (r.status >= 300 && r.status < 400)) {
              if (alive) setBoot({ phase: 'error', kind: 'auth', message: '登录已过期，请重新验证邮箱。' })
              return
            }
            const j = (await r.json()) as MeResponse & { ok: boolean; error?: string }
            if (!j.ok) throw new Error(j.error || 'me failed')
            me = j
          } catch (e) {
            lastErr = String((e as Error).message || e)
            await new Promise((res) => setTimeout(res, 800 * (i + 1)))
          }
        }
        if (!me) {
          if (alive)
            setBoot({
              phase: 'error',
              kind: 'network',
              message: '暂时无法连接服务器，无法确认登录账号。' + (lastErr ? `（${lastErr}）` : ''),
            })
          return
        }
        if (me.bankFp !== fp) {
          if (alive)
            setBoot({ phase: 'error', kind: 'update', message: '题库版本与云端账号不一致，请刷新页面载入最新版本。' })
          return
        }
        setAiAccount(me.accountId)
        engine = new SyncEngine({
          accountId: me.accountId,
          email: me.email,
          clientId: clientId(),
          bankFp: fp,
          fetcher: browserFetch,
        })
        await engine.init()
        if (!alive) {
          engine.dispose()
          return
        }
        setBoot({ phase: 'ready', engine, email: me.email, accountId: me.accountId })
      } catch (e) {
        if (alive)
          setBoot({ phase: 'error', kind: 'network', message: '启动失败：' + String((e as Error).message || e) })
      }
    })()
    return () => {
      alive = false
      engine?.dispose()
      setDraftBackend(null)
    }
  }, [attempt])

  if (boot.phase !== 'ready') {
    return <BootScreen boot={boot} retry={() => setAttempt((x) => x + 1)} />
  }
  return (
    <ReadyProvider key={boot.accountId} engine={boot.engine} email={boot.email}>
      {children}
    </ReadyProvider>
  )
}

function BootScreen({ boot, retry }: { boot: BootState; retry: () => void }) {
  return (
    <div className="boot-screen" role="status">
      <div className="boot-card">
        <div className="boot-title">ExamPilot 习概复习系统</div>
        {boot.phase === 'identifying' ? (
          <p className="muted-2">正在确认登录账号…</p>
        ) : boot.phase === 'error' ? (
          <>
            <p>{boot.message}</p>
            <p className="muted-2">学习记录安全保存在云端和本设备，不会因此丢失。</p>
            <div className="row" style={{ gap: 8, justifyContent: 'center' }}>
              {boot.kind === 'auth' ? (
                <button className="btn btn-primary" onClick={() => window.location.reload()}>
                  重新验证
                </button>
              ) : boot.kind === 'update' ? (
                <button className="btn btn-primary" onClick={() => window.location.reload()}>
                  刷新页面
                </button>
              ) : (
                <button className="btn btn-primary" onClick={retry}>
                  重试
                </button>
              )}
            </div>
          </>
        ) : null}
      </div>
    </div>
  )
}

function ReadyProvider({ engine, email, children }: { engine: SyncEngine; email: string; children: ReactNode }) {
  const [, setTick] = useState(0)
  const stateRef = useRef(engine.state)
  const [status, setStatus] = useState<SyncStatus>(engine.status)

  useEffect(() => {
    const unsub = engine.subscribe(() => {
      stateRef.current = engine.state
      setStatus({ ...engine.status })
      setTick((x) => x + 1)
    })
    return () => {
      unsub()
    }
  }, [engine])

  // Drafts: account-wide documents, cached in memory for synchronous reads.
  // D-02: installed DURING RENDER, before any child renders. Children read their
  // draft in a useState initializer; React runs child effects before parent
  // effects, so a backend installed in useEffect was not there yet on a page
  // reload — the page fell back to (empty) sessionStorage and "lost" the session.
  const draftBackend = useMemo((): DraftBackend => {
    const loaded = new Map<string, number>()
    return {
      load(mode) {
        const d = engine.getDoc('draft.' + mode)
        if (!d || d.deleted) return null
        loaded.set(mode, d.version)
        return d.body
      },
      save(mode, draft: SessionDraft) {
        const key = 'draft.' + mode
        const d = engine.getDoc(key)
        const curBody = d?.body as SessionDraft | null | undefined
        const sameSession = !!curBody && curBody.sessionId === draft.sessionId
        let base = d?.version ?? 0
        // The local copy was replaced by another device's newer progress after
        // this page loaded it: write against what this page actually saw, so the
        // server reports a conflict instead of silently overwriting.
        if (sameSession && d?.origin === 'remote' && loaded.has(mode) && loaded.get(mode) !== d.version) {
          base = loaded.get(mode)!
        }
        loaded.delete(mode)
        void engine.putDoc(key, draft, { version: base, pendingType: 'put' })
      },
      clear(mode, sessionId) {
        loaded.delete(mode)
        void engine.deleteDoc('draft.' + mode, sessionId)
      },
    }
  }, [engine])
  setDraftBackend(draftBackend) // idempotent; must precede the children's first render
  useEffect(() => {
    setDraftBackend(draftBackend)
    return () => setDraftBackend(null)
  }, [draftBackend])

  // Exam re-grading used when the server reports a late submission.
  useEffect(() => {
    engine.setExamGrader((exam: ExamDocBody) => {
      const paper = exam.qids.map((id) => questionById.get(id)).filter((q): q is Question => !!q)
      if (paper.length !== exam.qids.length) return null
      const config = exam.config as MockConfig
      const built = buildMockOp(
        exam.runId,
        paper,
        exam.answers,
        config,
        exam.startedAt,
        exam.endsAt,
        engine.state.settings.reviewIntervalBase,
      )
      return { run: built.run, attempts: built.attempts }
    })
  }, [engine])

  const st = stateRef.current
  const settings: AppSettings = {
    theme: st.settings.theme,
    reviewIntervalBase: st.settings.reviewIntervalBase,
    studyTarget: st.settings.studyTarget,
    dailyGoalQuestions: st.settings.dailyGoalQuestions,
  }

  const scoped = useMemo(() => {
    const recs = new Map<string, QRecord>()
    for (const [k, r] of st.records) if (inBank(k)) recs.set(k, r)
    const hist = st.history.filter((h) => inBank(h.qid))
    const mks = st.mocks.filter(mockInBank)
    return {
      records: recs,
      history: hist,
      mocks: mks,
      legacy: {
        records: st.records.size - recs.size,
        history: st.history.length - hist.length,
        mocks: st.mocks.length - mks.length,
      },
    }
  }, [st])

  const submitAnswer = useCallback<StoreValue['submitAnswer']>(
    async (q, answer, mode, sessionId, usedAI = false, options) => {
      const now = Date.now()
      const blank = isAnswerBlank(q, answer)
      const isCorrect = scoreAnswer(q, answer)
      if (options?.skipPersistence) return { isCorrect, blank }
      const h: HistoryEntry = {
        id: `h-${now}-${q.id}-${Math.random().toString(36).slice(2, 7)}`,
        qid: q.id,
        mode,
        sessionId,
        answer: answer ?? null,
        isCorrect,
        submittedAt: now,
        usedAI,
      }
      await engine.commit('attempt', { h, ef: engine.state.settings.reviewIntervalBase }, 'op-' + h.id)
      return { isCorrect, blank }
    },
    [engine],
  )

  const exam = useMemo<ExamApi>(() => makeExamApi(engine), [engine])

  const value = useMemo<StoreValue>(
    () => ({
      ready: true,
      records: scoped.records,
      history: scoped.history,
      mocks: scoped.mocks,
      raw: { records: st.records, history: st.history, mocks: st.mocks },
      legacy: scoped.legacy,
      aiReviews: st.aiReviews,
      settings,
      submitAnswer,
      saveSubjectiveAttempt: async (q, answer, mode, sessionId, usedAI = false) => {
        if (engine.state.sessionAttempts.has(sessionId + '|' + q.id)) return
        const id = attemptIdFor(sessionId, q.id)
        const h: HistoryEntry = {
          id,
          qid: q.id,
          mode,
          sessionId,
          answer,
          isCorrect: null,
          submittedAt: Date.now(),
          usedAI,
        }
        await engine.commit('attempt', { h, ef: null }, 'op-' + id)
      },
      getRecord: (qid) => scoped.records.get(qid),
      saveAiReview: async (r: AiReview) => {
        await engine.commit('ai_review', { review: r, attempt: null })
      },
      saveAiReviewForQuestion: async (q, userAnswer, sessionId, provider, model, result) => {
        const id = aiReviewIdFor(sessionId, q.id)
        const created = !engine.state.aiReviews.some((r) => r.id === id)
        const now = Date.now()
        const review: AiReview = { id, qid: q.id, userAnswer, createdAt: now, provider, model, result }
        const needsAttempt = !engine.state.sessionAttempts.has(sessionId + '|' + q.id)
        const attempt: HistoryEntry | null = needsAttempt
          ? {
              id: attemptIdFor(sessionId, q.id),
              qid: q.id,
              mode: 'ai-review',
              sessionId,
              answer: userAnswer,
              isCorrect: null,
              submittedAt: now,
              usedAI: true,
            }
          : null
        await engine.commit('ai_review', { review, attempt })
        return { created }
      },
      submitMockRun: async (input) => {
        const existing = engine.state.mocks.find((m) => m.id === input.runId)
        if (existing) return { status: 'already-submitted', run: existing }
        const built = buildMockOp(
          input.runId,
          input.paper,
          input.submissions,
          input.config,
          input.startedAt,
          input.endedAt,
          engine.state.settings.reviewIntervalBase,
        )
        const examDoc = engine.getDoc('exam.current')
        const ex = examDoc?.body as ExamDocBody | null | undefined
        const leaseGen = ex && ex.runId === input.runId ? ex.leaseGen : undefined
        await engine.commit(
          'mock',
          { run: built.run, attempts: built.attempts, ...(leaseGen !== undefined ? { leaseGen } : {}) },
          'mock:' + input.runId,
        )
        if (ex && ex.runId === input.runId && examDoc && !examDoc.deleted) {
          // The server settles the exam document atomically with the mock op;
          // locally we just stop treating it as running (no extra write is sent).
          await engine.setDocLocal('exam.current', { ...ex, answers: input.submissions, status: 'submitted' })
        }
        return { status: 'committed', run: built.run }
      },
      saveMockRun: async (m: MockRun) => {
        await engine.commit('import', { src: 'mock-save', baselines: [], history: [], mocks: [m], aiReviews: [] })
      },
      deleteMockRun: async (id: string) => {
        await engine.commit('delete_mock', { runId: id })
      },
      updateSettings: async (s: Partial<AppSettings>) => {
        await engine.commit('settings', { patch: s })
      },
      clearHistory: async () => {
        await engine.commit('hide_history', { upto: engine.pullCursor })
      },
      resetAllProgress: async () => {
        await engine.commit('reset', {})
      },
      importRecords: async (recs, hist, mks, aiv) => {
        await engine.commitMany(
          buildImportOps('import', { records: recs, history: hist, mocks: mks, aiReviews: aiv }, newOpId('imp')),
        )
      },
      restoreBackup: async (input) => {
        const items: { kind: 'reset' | 'import' | 'settings'; body: unknown; id?: string }[] = []
        const mode = (input as { mode?: 'merge' | 'replace' }).mode ?? 'replace'
        if (mode === 'replace') items.push({ kind: 'reset', body: {} })
        items.push(...(buildImportOps('restore', input, newOpId('rst')) as typeof items))
        let nextSettings: AppSettings = settings
        if (input.settingsAction === 'set' && input.settings) {
          items.push({ kind: 'settings', body: { patch: { ...input.settings } } })
          nextSettings = { ...input.settings }
        } else if (input.settingsAction === 'reset') {
          const { mockConfig: _m, ...defaults } = DEFAULT_SYNCED_SETTINGS
          items.push({ kind: 'settings', body: { patch: defaults } })
          nextSettings = defaults
        }
        await engine.commitMany(items)
        return { settings: nextSettings }
      },
      clearWrong: async (qids: string[]) => {
        if (!qids.length) return
        for (let i = 0; i < qids.length; i += 1000) {
          await engine.commit('clear_qids', { qids: qids.slice(i, i + 1000), upto: engine.pullCursor })
        }
      },
    }),
    [st, scoped, engine, submitAnswer],
  )

  const aiChat = useMemo<AiChatApi>(
    () => ({
      putMsg: async (conv, msg, meta) => {
        const content = msg.content.length > MAX_AI_MSG_CHARS ? msg.content.slice(0, MAX_AI_MSG_CHARS) : msg.content
        // One op per (message, state): a retry of the same state is deduplicated by id.
        await engine.commit(
          'ai_msg',
          {
            conv,
            ...(meta?.title ? { title: meta.title.slice(0, 200) } : {}),
            ...(meta?.kind ? { kind: meta.kind } : {}),
            msg: { ...msg, content },
          },
          `aim-${msg.id}-${msg.status}`,
        )
      },
      deleteConv: async (conv) => {
        await engine.commit('ai_conv_del', { conv }, `aid-${conv}`)
      },
    }),
    [engine],
  )
  const aiChats = st.aiChats
  const proWelcomed = st.settings.proWelcomed === true
  const markProWelcomed = useCallback(async () => {
    if (engine.state.settings.proWelcomed === true) return
    await engine.commit('settings', { patch: { proWelcomed: true } })
  }, [engine])
  const sync = useMemo<SyncCtx>(
    () => ({
      engine,
      status,
      email,
      accountId: engine.accountId,
      serverNow: () => engine.serverNow(),
      exam,
      aiChats,
      aiChat,
      proWelcomed,
      markProWelcomed,
    }),
    [engine, status, email, exam, aiChats, aiChat, proWelcomed, markProWelcomed],
  )

  return (
    <SyncContext.Provider value={sync}>
      <StoreContext.Provider value={value}>{children}</StoreContext.Provider>
    </SyncContext.Provider>
  )
}

/** Same grading + attempt identities as lib/session.ts submitMockRun (desktop). */
export function buildMockOp(
  runId: string,
  paper: Question[],
  submissions: Record<string, string | null>,
  config: MockConfig,
  startedAt: number,
  endedAt: number,
  easeFloor: number,
) {
  const graded = gradeMockSubmission(paper, submissions, config)
  const run: MockRun = {
    id: runId,
    startedAt,
    endedAt,
    config,
    submissions,
    graded: true,
    score: graded.score,
    maxScore: graded.maxScore,
    objectiveMaxScore: graded.objectiveMaxScore,
    subjectiveMaxScore: graded.subjectiveMaxScore,
    perQuestion: graded.perQuestion,
  }
  const attempts: { h: HistoryEntry; ef: number | null }[] = []
  for (const { q, answer } of graded.persisted) {
    attempts.push({
      h: {
        id: attemptIdFor(runId, q.id),
        qid: q.id,
        mode: 'mock',
        sessionId: runId,
        answer,
        isCorrect: graded.perQuestion[q.id]?.isCorrect ?? null,
        submittedAt: endedAt,
        usedAI: false,
      },
      ef: easeFloor,
    })
  }
  for (const { q, answer } of graded.subjective) {
    attempts.push({
      h: {
        id: attemptIdFor(runId, q.id),
        qid: q.id,
        mode: 'mock',
        sessionId: runId,
        answer,
        isCorrect: null,
        submittedAt: endedAt,
        usedAI: false,
      },
      ef: null,
    })
  }
  return { run, attempts }
}

function makeExamApi(engine: SyncEngine): ExamApi {
  const KEY = 'exam.current'
  const cur = () => engine.getDoc(KEY)
  return {
    current: cur,
    async start({ runId, qids, config, durationMs }) {
      const now = engine.serverNow()
      const body: ExamDocBody = {
        runId,
        qids,
        config,
        startedAt: now,
        endsAt: now + durationMs,
        durationMs,
        answers: Object.fromEntries(qids.map((q) => [q, null])),
        idx: 0,
        status: 'active',
        leaseGen: 1,
        holder: engine.clientId,
      }
      await engine.putDoc(KEY, body, { pendingType: 'exam_start', leaseGen: 1, version: cur()?.version ?? 0 })
      void engine.syncNow()
    },
    async save(answers, idx) {
      const d = cur()
      const ex = d?.body as ExamDocBody | null
      if (!d || !ex || ex.status !== 'active') return
      const pendingType =
        d.dirty && d.pendingType === 'exam_start'
          ? 'exam_start'
          : d.dirty && d.pendingType === 'exam_takeover'
            ? 'exam_takeover'
            : 'exam_save'
      await engine.putDoc(KEY, { ...ex, answers, idx }, { pendingType, leaseGen: d.leaseGen ?? ex.leaseGen })
    },
    async takeover(runId?: string) {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'offline'
      // Refresh first: the copy on screen may be up to one poll interval old.
      await engine.syncNow()
      const d = cur()
      const ex = d && !d.deleted ? (d.body as ExamDocBody | null) : null
      if (!d || !ex || ex.status !== 'active') return 'failed'
      if (runId && ex.runId !== runId) return 'changed'
      if (ex.holder === engine.clientId && !d.serverNote) return 'ok'
      await engine.putDoc(KEY, { ...ex }, { pendingType: 'exam_takeover', leaseGen: ex.leaseGen })
      await engine.syncNow()
      const after = cur()
      const b = after?.body as ExamDocBody | null
      if (after && !after.dirty && b && b.holder === engine.clientId && b.status === 'active' && !after.serverNote)
        return 'ok'
      return engine.status.phase === 'offline' || engine.status.phase === 'retrying' ? 'offline' : 'failed'
    },
    async abandon() {
      const d = cur()
      const ex = d?.body as ExamDocBody | null
      if (!d || !ex) return
      await engine.putDoc(
        KEY,
        { ...ex, status: 'abandoned' },
        { pendingType: 'exam_abandon', leaseGen: d.leaseGen ?? ex.leaseGen },
      )
      void engine.syncNow()
    },
    async clearNote() {
      await engine.clearDocNote(KEY)
    },
  }
}
