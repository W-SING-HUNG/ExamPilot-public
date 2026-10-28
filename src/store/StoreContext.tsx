import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { db, restoreBackupInto, DEFAULT_SETTINGS } from '../db/database'
import type { QRecord, HistoryEntry, MockRun, AiReview, AppSettings, AiGradeResult, MockConfig } from '../lib/types'
import { freshRecord, applyAttempt } from '../lib/scheduler'
import { scoreAnswer, isAnswerBlank } from '../lib/scoring'
import { submitMockRun as submitMockRunTx, saveAiReviewWithAttempt, recordAttempt } from '../lib/session'
import type { Question } from '../lib/types'
import { questionById } from '../lib/bank'
import { IS_WEB_EDITION } from '../lib/edition'

/**
 * Rows in this browser's IndexedDB whose question ids are not in the installed
 * bank (e.g. left over from the 17-question demo that was served at the same
 * address before the full bank). They are never deleted; the web edition just
 * keeps them out of every statistic and list, and counts them here so the UI
 * can say so honestly.
 */
export interface LegacyCounts {
  records: number
  history: number
  mocks: number
}

const inBank = (qid: string) => questionById.has(qid)
const mockInBank = (m: MockRun) => Object.keys(m.submissions ?? {}).every(inBank)

export interface SubmitOutcome {
  isCorrect: boolean | null
  blank: boolean
}

export interface SubmitOptions {
  /** when true the attempt is NOT persisted (used by mock-exam blanks) */
  skipPersistence?: boolean
}

export interface StoreValue {
  ready: boolean
  records: Map<string, QRecord>
  history: HistoryEntry[]
  mocks: MockRun[]
  aiReviews: AiReview[]
  settings: AppSettings
  /** Unfiltered rows exactly as stored — for backup export only. */
  raw: { records: Map<string, QRecord>; history: HistoryEntry[]; mocks: MockRun[] }
  /** Rows kept out of statistics because their questions are not in the current bank. */
  legacy: LegacyCounts
  submitAnswer: (
    q: Question,
    answer: string | null,
    mode: string,
    sessionId: string,
    usedAI?: boolean,
    options?: SubmitOptions,
  ) => Promise<SubmitOutcome>
  saveSubjectiveAttempt: (
    q: Question,
    answer: string,
    mode: string,
    sessionId: string,
    usedAI?: boolean,
  ) => Promise<void>
  getRecord: (qid: string) => QRecord | undefined
  saveAiReview: (r: AiReview) => Promise<void>
  /** Save an AI review and at most one training attempt for this session. */
  saveAiReviewForQuestion: (
    q: Question,
    userAnswer: string,
    sessionId: string,
    provider: string,
    model: string,
    result: AiGradeResult,
  ) => Promise<{ created: boolean }>
  /**
   * Persist a whole mock-exam submission transactionally and idempotently.
   * Re-submitting the same runId never double-counts learning data.
   */
  submitMockRun: (input: {
    runId: string
    paper: Question[]
    submissions: Record<string, string | null>
    config: MockConfig
    startedAt: number
    endedAt: number
  }) => Promise<{ status: 'committed' | 'already-submitted'; run: MockRun }>
  saveMockRun: (m: MockRun) => Promise<void>
  deleteMockRun: (id: string) => Promise<void>
  updateSettings: (s: Partial<AppSettings>) => Promise<void>
  clearHistory: () => Promise<void>
  resetAllProgress: () => Promise<void>
  importRecords: (records: QRecord[], history: HistoryEntry[], mocks: MockRun[], aiReviews: AiReview[]) => Promise<void>
  /** Full restore: records + history + mocks + aiReviews + settings, all-or-nothing. */
  restoreBackup: (input: {
    records: QRecord[]
    history: HistoryEntry[]
    mocks: MockRun[]
    aiReviews: AiReview[]
    settingsAction: 'keep' | 'set' | 'reset'
    settings: AppSettings | null
    /** web edition: merge = add the backup's rows; replace = start over from the backup */
    mode?: 'merge' | 'replace'
  }) => Promise<{ settings: AppSettings }>
  clearWrong: (qids: string[]) => Promise<void>
}

export const StoreContext = createContext<StoreValue | null>(null)

export function StoreProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false)
  const [records, setRecords] = useState<Map<string, QRecord>>(new Map())
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [mocks, setMocks] = useState<MockRun[]>([])
  const [aiReviews, setAiReviews] = useState<AiReview[]>([])
  const [settings, setSettings] = useState<AppSettings>({
    theme: 'auto',
    reviewIntervalBase: 1,
    studyTarget: 30,
    dailyGoalQuestions: 30,
  })

  const refresh = useCallback(async () => {
    const [recs, hist, mks, aiv] = await Promise.all([
      db.records.toArray(),
      db.history.toArray(),
      db.mocks.toArray(),
      db.aiReviews.toArray(),
    ])
    setRecords(new Map(recs.map((r) => [r.qid, r])))
    setHistory(hist.sort((a, b) => b.submittedAt - a.submittedAt))
    setMocks(mks.sort((a, b) => b.startedAt - a.startedAt))
    setAiReviews(aiv.sort((a, b) => b.createdAt - a.createdAt))
  }, [])

  useEffect(() => {
    let alive = true
    ;(async () => {
      await refresh()
      const s = await db.settings.get('main')
      if (alive && s) setSettings(s)
      if (alive) setReady(true)
    })()
    return () => {
      alive = false
    }
  }, [refresh])

  const getRecord = useCallback((qid: string) => records.get(qid), [records])

  /**
   * Persist a graded objective attempt.
   *
   * `blank` answers are reported distinctly from `wrong`: a blank is never
   * counted as an error, and never lands in the wrong-question bank.
   * With `options.skipPersistence` nothing is written at all (mock-exam blanks).
   */
  const submitAnswer = useCallback<StoreValue['submitAnswer']>(
    async (q, answer, mode, sessionId, usedAI = false, options) => {
      const now = Date.now()
      const blank = isAnswerBlank(q, answer)
      const isCorrect = scoreAnswer(q, answer)
      if (options?.skipPersistence) {
        return { isCorrect, blank }
      }
      const entry: HistoryEntry = {
        id: `h-${now}-${q.id}-${Math.random().toString(36).slice(2, 7)}`,
        qid: q.id,
        mode,
        sessionId,
        answer: answer ?? null,
        isCorrect,
        submittedAt: now,
        usedAI,
      }
      await db.transaction('rw', db.records, db.history, async () => {
        // Read the authoritative row INSIDE the transaction: the React snapshot
        // may be stale (concurrent tab, or a write not yet refreshed).
        const current = (await db.records.get(q.id)) ?? freshRecord(q.id, now)
        const merged: QRecord = applyAttempt(current, isCorrect === true, now, settings.reviewIntervalBase)
        merged.lastAnswer = answer ?? null
        merged.lastCorrect = isCorrect
        await db.records.put(merged)
        await db.history.add(entry)
      })
      await refresh()
      return { isCorrect, blank }
    },
    [refresh, settings.reviewIntervalBase],
  )

  const saveSubjectiveAttempt = useCallback<StoreValue['saveSubjectiveAttempt']>(
    async (q, answer, mode, sessionId, usedAI = false) => {
      // Same attempt identity as every other path: one attempt per
      // (sessionId, qid), so a later AI review cannot add a second one, and a
      // legacy random-id row for the same pair is still recognised.
      await recordAttempt(db, {
        sessionId,
        qid: q.id,
        answer,
        mode,
        isCorrect: null,
        usedAI,
      })
      await refresh()
    },
    [refresh],
  )

  // Web edition: statistics and lists only ever see rows of the installed bank.
  const scoped = useMemo(() => {
    if (!IS_WEB_EDITION) {
      return { records, history, mocks, legacy: { records: 0, history: 0, mocks: 0 } }
    }
    const recs = new Map<string, QRecord>()
    for (const [k, r] of records) if (inBank(k)) recs.set(k, r)
    const hist = history.filter((h) => inBank(h.qid))
    const mks = mocks.filter(mockInBank)
    return {
      records: recs.size === records.size ? records : recs,
      history: hist.length === history.length ? history : hist,
      mocks: mks.length === mocks.length ? mocks : mks,
      legacy: {
        records: records.size - recs.size,
        history: history.length - hist.length,
        mocks: mocks.length - mks.length,
      },
    }
  }, [records, history, mocks])

  const value = useMemo<StoreValue>(
    () => ({
      ready,
      records: scoped.records,
      history: scoped.history,
      mocks: scoped.mocks,
      raw: { records, history, mocks },
      legacy: scoped.legacy,
      aiReviews,
      settings,
      submitAnswer,
      saveSubjectiveAttempt,
      getRecord,
      saveAiReview: async (r: AiReview) => {
        await db.aiReviews.put(r)
        await refresh()
      },
      saveAiReviewForQuestion: async (q, userAnswer, sessionId, provider, model, result) => {
        const out = await saveAiReviewWithAttempt(db, {
          sessionId,
          qid: q.id,
          question: q,
          userAnswer,
          provider,
          model,
          result,
        })
        await refresh()
        return out
      },
      submitMockRun: async (input) => {
        const out = await submitMockRunTx(db, { ...input, easeFloor: settings.reviewIntervalBase })
        await refresh()
        return { status: out.status, run: out.run }
      },
      saveMockRun: async (m: MockRun) => {
        await db.mocks.put(m)
        await refresh()
      },
      deleteMockRun: async (id: string) => {
        await db.mocks.delete(id)
        await refresh()
      },
      updateSettings: async (s: Partial<AppSettings>) => {
        const merged = { ...settings, ...s }
        await db.settings.put({ ...merged, id: 'main' })
        setSettings(merged)
      },
      clearHistory: async () => {
        await db.history.clear()
        await refresh()
      },
      resetAllProgress: async () => {
        await db.transaction('rw', db.records, db.history, db.mocks, db.aiReviews, async () => {
          await db.records.clear()
          await db.history.clear()
          await db.mocks.clear()
          await db.aiReviews.clear()
        })
        await refresh()
      },
      importRecords: async (recs, hist, mks, aiv) => {
        await db.transaction('rw', db.records, db.history, db.mocks, db.aiReviews, async () => {
          await db.records.bulkPut(recs)
          await db.history.bulkPut(hist)
          await db.mocks.bulkPut(mks)
          await db.aiReviews.bulkPut(aiv)
        })
        await refresh()
      },
      /**
       * Full backup restore. All-or-nothing: if any write fails the transaction
       * aborts and the previous data stays intact, so a failed import can never
       * leave a half-restored database.
       *
       * React state is reconciled from the DATABASE after the write, so the UI
       * can never show settings that differ from what was actually persisted.
       */
      restoreBackup: async ({
        records: recs,
        history: hist,
        mocks: mks,
        aiReviews: aiv,
        settingsAction,
        settings: s,
      }) => {
        await restoreBackupInto(db, {
          records: recs,
          history: hist,
          mocks: mks,
          aiReviews: aiv,
          settingsAction,
          settings: s,
        })
        // Read the authoritative settings back out of the DB.
        const persisted = await db.settings.get('main')
        const next: AppSettings = persisted
          ? {
              theme: persisted.theme,
              reviewIntervalBase: persisted.reviewIntervalBase,
              studyTarget: persisted.studyTarget,
              dailyGoalQuestions: persisted.dailyGoalQuestions,
            }
          : { ...DEFAULT_SETTINGS }
        setSettings(next)
        await refresh()
        return { settings: next }
      },
      clearWrong: async (qids: string[]) => {
        await db.transaction('rw', db.records, db.history, async () => {
          for (const qid of qids) await db.records.delete(qid)
          await db.history.where('qid').anyOf(qids).delete()
        })
        await refresh()
      },
    }),
    [
      ready,
      records,
      history,
      mocks,
      scoped,
      aiReviews,
      settings,
      submitAnswer,
      saveSubjectiveAttempt,
      getRecord,
      refresh,
    ],
  )

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>
}

export function useStore(): StoreValue {
  const ctx = useContext(StoreContext)
  if (!ctx) throw new Error('useStore must be used within StoreProvider')
  return ctx
}
