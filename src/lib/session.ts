import type { ExamPilotDB } from '../db/database'
import type { AiGradeResult, HistoryEntry, MockConfig, MockRun, QRecord, Question } from './types'
import { gradeMockSubmission } from './mock-grading'
import { applyAttempt, applySubjectiveAttempt, freshRecord } from './scheduler'

export interface SubmitMockInput {
  /** Stable id for this exam attempt; re-submitting the same id is a no-op. */
  runId: string
  paper: Question[]
  submissions: Record<string, string | null>
  config: MockConfig
  startedAt: number
  endedAt: number
  /** Interval floor from settings, so a mock exam paces like every other mode. */
  easeFloor?: number
}

export interface SubmitMockResult {
  /** 'committed' = this call wrote the exam; 'already-submitted' = idempotent replay */
  status: 'committed' | 'already-submitted'
  run: MockRun
  /** rows actually written by THIS call (zero on replay) */
  written: { records: number; history: number }
}

/**
 * Deterministic history id for one attempt at one question inside one session.
 *
 * The identity of an attempt is (sessionId, qid): answering or reviewing the same
 * question inside the same session is ONE training attempt. The id is a pure
 * function of those inputs, so a re-entry updates the existing row instead of
 * inserting a second one.
 *
 * NOTE ON LEGACY DATA: history rows written by older versions used random ids.
 * They are never deleted or recomputed; `hasAttempt()` below detects them by
 * scanning (qid, sessionId) so no new attempt is added on top of them.
 */
export function attemptIdFor(sessionId: string, qid: string): string {
  return `h-att-${sessionId}-${qid}`
}

/** Deterministic id of the mock archive row for one exam run. */
export function mockRunIdFor(runId: string): string {
  return runId
}

/**
 * Deterministic AI-review id for one question inside one session, so pressing
 * "AI 璇勯槄" repeatedly updates a single record instead of adding attempts.
 */
export function aiReviewIdFor(sessionId: string, qid: string): string {
  return `ai-${sessionId}-${qid}`
}

/**
 * True when this session already recorded an attempt at this question.
 *
 * Scans by qid and matches the sessionId, so it also finds legacy rows that used
 * a random id. This is what prevents an AI review from double-counting an attempt
 * that a practice submission or a mock exam already recorded.
 */
export async function hasAttempt(db: ExamPilotDB, sessionId: string, qid: string): Promise<boolean> {
  const rows = await db.history.where('qid').equals(qid).toArray()
  return rows.some((h) => h.sessionId === sessionId)
}

/**
 * Record ONE training attempt for a question inside a session.
 *
 * Idempotent per (sessionId, qid): if any attempt for that pair already exists
 * (including legacy random-id rows), nothing is added and `created: false` is
 * returned. The learning record is only advanced when a new attempt is created.
 *
 * `isCorrect === null` (subjective / AI review) advances ONLY the attempt count
 * and the review interval through `applySubjectiveAttempt`: no correctness is
 * inferred, no mastery status is granted, and the interval grows on its own
 * slower curve.
 *
 * `easeFloor` is the user's `settings.reviewIntervalBase`. It is applied on
 * every graded write so the same question behaves identically here and in
 * `StoreContext.submitAnswer`.
 */
export async function recordAttempt(
  db: ExamPilotDB,
  input: {
    sessionId: string
    qid: string
    answer: string
    mode: string
    isCorrect: boolean | null
    usedAI: boolean
    now?: number
    easeFloor?: number
  },
): Promise<{ created: boolean }> {
  const now = input.now ?? Date.now()
  // Pass the setting through verbatim: `undefined` means "no setting supplied",
  // which lets the scheduler keep the record's own ease. Substituting a default
  // here would silently override a user's persisted value.
  const easeFloor = input.easeFloor
  let created = false

  await db.transaction('rw', db.records, db.history, async () => {
    if (await hasAttempt(db, input.sessionId, input.qid)) return
    created = true

    const current = (await db.records.get(input.qid)) ?? freshRecord(input.qid, now)
    const next: QRecord =
      input.isCorrect === null
        ? applySubjectiveAttempt(current, now)
        : applyAttempt(current, input.isCorrect === true, now, easeFloor)
    next.lastAnswer = input.answer
    if (input.isCorrect !== null) next.lastCorrect = input.isCorrect
    await db.records.put(next)

    await db.history.put({
      id: attemptIdFor(input.sessionId, input.qid),
      qid: input.qid,
      mode: input.mode,
      sessionId: input.sessionId,
      answer: input.answer,
      isCorrect: input.isCorrect,
      submittedAt: now,
      usedAI: input.usedAI,
    })
  })

  return { created }
}

/**
 * Persist one mock-exam submission.
 *
 * Guarantees (all covered by fault-injection tests):
 *  1. Everything happens inside ONE Dexie transaction over records/history/mocks,
 *     so a failure anywhere rolls the whole submission back 鈥?there is never a
 *     partially-persisted exam.
 *  2. Progress is computed from records READ INSIDE the transaction, not from a
 *     possibly stale React snapshot.
 *  3. Re-submitting the same `runId` after a successful commit is a no-op: the
 *     mock row already exists, so the exam is returned as 'already-submitted'
 *     and no counters move.
 *  4. Blank objective answers are never persisted and never counted as wrong.
 */
export async function submitMockRun(db: ExamPilotDB, input: SubmitMockInput): Promise<SubmitMockResult> {
  const { runId, paper, submissions, config, startedAt, endedAt } = input
  // `undefined` lets the scheduler keep the record's own ease; see recordAttempt.
  const easeFloor = input.easeFloor
  const graded = gradeMockSubmission(paper, submissions, config)

  const run: MockRun = {
    id: mockRunIdFor(runId),
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

  let status: SubmitMockResult['status'] = 'committed'
  const written = { records: 0, history: 0 }

  await db.transaction('rw', db.records, db.history, db.mocks, async () => {
    // Idempotency gate: a committed run is never applied twice.
    const existing = await db.mocks.get(runId)
    if (existing) {
      status = 'already-submitted'
      return
    }

    // Answered objective questions: update the shared learning record.
    for (const { q, answer } of graded.persisted) {
      const current = (await db.records.get(q.id)) ?? freshRecord(q.id, endedAt)
      const isCorrect = graded.perQuestion[q.id]?.isCorrect ?? null
      const next: QRecord = applyAttempt(current, isCorrect === true, endedAt, easeFloor)
      next.lastAnswer = answer
      next.lastCorrect = isCorrect
      await db.records.put(next)
      written.records++

      const entry: HistoryEntry = {
        id: attemptIdFor(runId, q.id),
        qid: q.id,
        mode: 'mock',
        sessionId: runId,
        answer,
        isCorrect,
        submittedAt: endedAt,
        usedAI: false,
      }
      await db.history.put(entry)
      written.history++
    }

    // Answered subjective questions count as a training attempt (no score).
    // Only the attempt count and the review interval move; nothing is scored
    // and no mastery status is granted.
    for (const { q, answer } of graded.subjective) {
      const current = (await db.records.get(q.id)) ?? freshRecord(q.id, endedAt)
      const next: QRecord = applySubjectiveAttempt(current, endedAt)
      next.lastAnswer = answer
      await db.records.put(next)
      written.records++

      const entry: HistoryEntry = {
        id: attemptIdFor(runId, q.id),
        qid: q.id,
        mode: 'mock',
        sessionId: runId,
        answer,
        isCorrect: null,
        submittedAt: endedAt,
        usedAI: false,
      }
      await db.history.put(entry)
      written.history++
    }

    await db.mocks.put(run)
  })

  return { status, run, written }
}

/**
 * Persist an AI review together with (at most) one training attempt.
 *
 * - The AI review row id is deterministic per (sessionId, qid): repeated reviews
 *   update one row instead of accumulating.
 * - The training attempt is written through the same attempt identity used by
 *   every other path: `hasAttempt()` scans (qid, sessionId), so it also sees
 *   attempts written by practice, subjective or mock submission — including
 *   legacy random-id rows. A question already answered in this session therefore
 *   keeps its single attempt and the AI review only ADDS an attempt for a
 *   genuinely new question.
 * - Both writes share one transaction: a failure leaves neither behind.
 */
export async function saveAiReviewWithAttempt(
  db: ExamPilotDB,
  input: {
    sessionId: string
    qid: string
    question: Question
    userAnswer: string
    provider: string
    model: string
    result: AiGradeResult
    now?: number
  },
): Promise<{ created: boolean; attemptCreated: boolean }> {
  const { sessionId, qid, userAnswer, provider, model, result } = input
  const now = input.now ?? Date.now()
  const reviewId = aiReviewIdFor(sessionId, qid)
  let created = false
  let attemptCreated = false

  await db.transaction('rw', db.records, db.history, db.aiReviews, async () => {
    const existing = await db.aiReviews.get(reviewId)
    created = !existing

    await db.aiReviews.put({ id: reviewId, qid, userAnswer, createdAt: now, provider, model, result })

    // Only a genuinely new attempt for this (sessionId, qid) moves the counters.
    // Re-reviewing an already-answered question updates the review row ONLY —
    // it never advances the attempt count or the review interval.
    if (!(await hasAttempt(db, sessionId, qid))) {
      attemptCreated = true
      const current = (await db.records.get(qid)) ?? freshRecord(qid, now)
      const next: QRecord = applySubjectiveAttempt(current, now)
      next.lastAnswer = userAnswer
      await db.records.put(next)
      await db.history.put({
        id: attemptIdFor(sessionId, qid),
        qid,
        mode: 'ai-review',
        sessionId,
        answer: userAnswer,
        isCorrect: null,
        submittedAt: now,
        usedAI: true,
      })
    }
  })

  return { created, attemptCreated }
}
