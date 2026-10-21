import type { QRecord, Question } from './types'

const DEFAULT_EASE = 2.0

/** Longest interval (days) an objective question can reach. */
const MAX_INTERVAL_DAYS = 365

/**
 * Longest interval (days) a subjective question can reach.
 *
 * Subjective questions have no official answer, so there is no auto-grading
 * signal that a question has been learned. Their interval therefore grows much
 * more slowly and caps far below the objective cap: a trained subjective
 * question must reappear often enough to keep being practiced, but never be
 * treated as "mastered and done".
 */
const MAX_SUBJECTIVE_INTERVAL_DAYS = 30

/** Multiplier applied to the interval after each correct subjective attempt. */
const SUBJECTIVE_EASE = 1.5

/**
 * Interval update for objective questions.
 *
 * Fixed multiplier (`ease`), no dynamic difficulty adjustment: on a correct
 * answer the interval grows by `ease`, on a wrong answer it resets to the
 * shortest interval so the question is immediately due again.
 *
 * `ease` is carried on the record and is never lowered by a wrong answer — that
 * is a deliberate, documented limitation (see docs/study-strategy.md).
 */
export function nextInterval(
  prevIntervalDays: number,
  isCorrect: boolean,
  ease = DEFAULT_EASE,
): { intervalDays: number; ease: number } {
  if (!isCorrect) {
    return { intervalDays: 0, ease: ease }
  }
  if (prevIntervalDays <= 0) {
    return { intervalDays: 1, ease: ease }
  }
  const next = Math.round(prevIntervalDays * ease)
  return { intervalDays: Math.min(Math.max(next, 1), MAX_INTERVAL_DAYS), ease }
}

/**
 * Derive the mastery status from the outcome of the attempt that just happened.
 *
 * The status is a function of the LATEST outcome plus the accumulated counters:
 *
 *   - last answer wrong AND 3+ lifetime wrong answers  -> struggling
 *   - last answer correct AND net correct >= 3          -> mastered
 *   - last answer correct                              -> learning
 *   - anything else (including a fresh wrong answer)    -> learning
 *
 * Two properties this guarantees, both of which the previous rules violated:
 *
 *  1. `struggling` is NOT permanent. It means "the most recent answer was wrong
 *     and this question has a history of errors". Answer correctly again and the
 *     question leaves `struggling`, because there is now real evidence it is
 *     being recovered.
 *  2. `mastered` is NOT sticky. A question that was mastered and then answered
 *     wrongly drops to `learning`, so it is scheduled again at full priority
 *     instead of disappearing behind the mastered weight penalty.
 *
 * `wrongCount` still only ever increases, so history is never rewritten.
 */
export function statusAfterAttempt(rec: {
  correctCount: number
  wrongCount: number
  lastCorrect: boolean | null
}): QRecord['status'] {
  if (rec.lastCorrect === false && rec.wrongCount >= 3) return 'struggling'
  if (rec.lastCorrect === true) {
    return rec.correctCount - rec.wrongCount >= 3 ? 'mastered' : 'learning'
  }
  return 'learning'
}

/**
 * Advance a record after a graded (objective) attempt.
 *
 * `easeFloor` is the user-configured minimum interval multiplier
 * (`settings.reviewIntervalBase`). It is applied as a floor on every write path
 * so the same question grows its interval identically regardless of whether it
 * was answered in practice, a mock exam, or a review session.
 */
/**
 * Advance a record after a graded (objective) attempt.
 *
 * `easeFloor` is the user-configured minimum interval multiplier
 * (`settings.reviewIntervalBase`). It is applied on every write path so the
 * same question grows its interval identically regardless of whether it was
 * answered in practice, a mock exam, or a review session.
 *
 * The effective ease is `max(easeFloor, DEFAULT_EASE)` — derived from the
 * CURRENT setting, not from the record. A record's stored `ease` is only used
 * when no floor is supplied, so lowering the setting always takes effect on the
 * next answer instead of being locked in by a previously persisted value.
 */
export function applyAttempt(rec: QRecord, isCorrect: boolean, now = Date.now(), easeFloor?: number): QRecord {
  const ease = easeFloor === undefined ? Math.max(rec.ease, DEFAULT_EASE) : Math.max(easeFloor, DEFAULT_EASE)
  const prev = rec.intervalDays
  const { intervalDays } = nextInterval(prev, isCorrect, ease)
  const attempts = rec.attempts + 1
  const correctCount = rec.correctCount + (isCorrect ? 1 : 0)
  const wrongCount = rec.wrongCount + (isCorrect ? 0 : 1)
  const status = statusAfterAttempt({ correctCount, wrongCount, lastCorrect: isCorrect })
  const nextReviewAt = intervalDays === 0 ? now : now + intervalDays * 24 * 3600 * 1000
  return {
    ...rec,
    status,
    attempts,
    correctCount,
    wrongCount,
    lastSeenAt: now,
    lastCorrect: isCorrect,
    intervalDays,
    ease,
    nextReviewAt,
  }
}

/**
 * Advance a record after a subjective attempt (writing practice / AI review).
 *
 * Deliberately separate from `applyAttempt`:
 *
 *   - `correctCount` / `wrongCount` are NEVER touched. They stay 0, because the
 *     bank provides no official answer and nothing here is scored. No rate is
 *     ever derived from them.
 *   - `lastCorrect` stays `null`. Training more never counts as "answered
 *     correctly".
 *   - `status` becomes `learning` and can never become `mastered` or
 *     `struggling`, no matter how many attempts accumulate. There is no evidence
 *     of mastery to justify it, and the app must not invent one.
 *   - The interval grows slowly (1.5x) and caps at 30 days, far below the
 *     objective cap, because spaced re-practice matters more than long-term
 *     retention for questions that are never auto-graded.
 */
export function applySubjectiveAttempt(rec: QRecord, now = Date.now()): QRecord {
  const prev = rec.intervalDays
  const intervalDays = prev <= 0 ? 1 : Math.min(Math.round(prev * SUBJECTIVE_EASE), MAX_SUBJECTIVE_INTERVAL_DAYS)
  return {
    ...rec,
    status: 'learning',
    attempts: rec.attempts + 1,
    lastSeenAt: now,
    lastCorrect: null,
    intervalDays,
    nextReviewAt: now + intervalDays * 24 * 3600 * 1000,
  }
}

export function freshRecord(qid: string, now = Date.now()): QRecord {
  return {
    qid,
    status: 'new',
    attempts: 0,
    correctCount: 0,
    wrongCount: 0,
    lastSeenAt: 0,
    lastCorrect: null,
    lastAnswer: null,
    intervalDays: 0,
    ease: DEFAULT_EASE,
    nextReviewAt: now,
  }
}

export interface SelectParams {
  pool: Question[]
  records: Map<string, QRecord>
  now: number
  count: number
  /** Minimum interval multiplier, applied as a floor on `ease` (settings). */
  easeFloor?: number
  /** Deterministic source; defaults to `Math.random` in production. */
  rng?: () => number
}

/** Deterministic PRNG for tests and paper composition. */
export function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Selection weights, in strict priority order.
 *
 * The rule the previous table broke is stated here explicitly: a question that
 * is DUE for review outranks a question that has never been attempted. Coverage
 * still matters — untouched questions are weighted well above ordinary
 * not-yet-due material — but they must not outrank work that is already overdue.
 *
 * `mastered` questions are no longer suppressed to ~0.15 when they become due:
 * "mastered but due" is a normal spaced-repetition event and gets the same
 * priority as any other due question. Only mastered questions that are NOT due
 * are held back.
 */
export const WEIGHT = {
  dueWrong: 12,
  due: 8,
  notDueWrong: 6,
  dueMastered: 6,
  untouched: 4,
  learningNotDue: 2,
  masteredNotDue: 0.3,
} as const

/** Weight applied to a question answered within this window (anti-repeat). */
const RECENT_WINDOW_MS = 60_000
const RECENT_PENALTY = 0.3

/**
 * True when a question is due for review.
 *
 * Being overdue only means something for a question that has actually been
 * answered. A never-attempted question is not "due" — it is untouched, and it
 * carries its own weight. Without the `attempts > 0` guard a never-attempted
 * question would read as due, because `freshRecord` seeds `nextReviewAt = now`
 * and a genuinely missing record is materialised that way; the untouched weight
 * of 4 would then never apply and such questions would silently be treated as
 * overdue work.
 */
export function isDue(rec: QRecord, now: number): boolean {
  return rec.attempts > 0 && rec.nextReviewAt <= now
}

/**
 * Weight of a single question. Exported so the plan builder and the tests can
 * reason about the same numbers the selector uses.
 *
 * Priority order, exactly as approved:
 *   overdue wrong (12) > overdue (8) > not-due wrong (6) = overdue mastered (6)
 *   > untouched (4) > learning not due (2) > mastered not due (0.3)
 *
 * Overdue work therefore outranks never-attempted work, while coverage still
 * outranks material that is neither due nor previously failed.
 */
export function questionWeight(rec: QRecord, now: number): number {
  const due = isDue(rec, now)
  const untouched = rec.attempts === 0
  let w: number
  if (due && rec.wrongCount > 0) w = WEIGHT.dueWrong
  else if (due && rec.status === 'mastered') w = WEIGHT.dueMastered
  else if (due) w = WEIGHT.due
  else if (rec.wrongCount > 0) w = WEIGHT.notDueWrong
  else if (untouched) w = WEIGHT.untouched
  else if (rec.status === 'mastered') w = WEIGHT.masteredNotDue
  else w = WEIGHT.learningNotDue

  if (rec.lastSeenAt > 0 && now - rec.lastSeenAt < RECENT_WINDOW_MS) w *= RECENT_PENALTY
  return w
}

/**
 * Pick `count` distinct questions from `pool` by weighted sampling.
 *
 * Guarantees:
 *  - Never returns a duplicate.
 *  - Never loops forever: the loop is bounded by the pool size.
 *  - Never returns an empty result when the pool is non-empty. If every
 *    candidate's weight falls below the selection floor (the previous behaviour,
 *    which silently produced empty sessions for "all attempted, all freshly
 *    mastered" pools), the draw degrades to uniform random over the pool.
 */
export function selectQuestions(params: SelectParams): Question[] {
  const { pool, records, now, count } = params
  const rng = params.rng ?? (Math.random as () => number)
  if (count <= 0 || pool.length === 0) return []

  const weightOf = (q: Question): number => {
    const rec = records.get(q.id) ?? freshRecord(q.id, now)
    return questionWeight(rec, now)
  }

  const result: Question[] = []
  const chosen = new Set<string>()
  while (result.length < count) {
    const candidates = pool.filter((q) => !chosen.has(q.id))
    if (candidates.length === 0) break
    const weights = candidates.map(weightOf)
    const total = weights.reduce((s, w) => s + w, 0)
    // Degenerate pool (every candidate below the old hard cut-off): fall back to
    // uniform selection so a non-empty pool always yields questions.
    const useUniform = total < WEIGHT.masteredNotDue * candidates.length
    let r = rng() * (useUniform ? candidates.length : total)
    let picked = candidates[candidates.length - 1]
    for (let i = 0; i < candidates.length; i++) {
      r -= useUniform ? 1 : weights[i]
      if (r <= 0) {
        picked = candidates[i]
        break
      }
    }
    result.push(picked)
    chosen.add(picked.id)
  }
  return result
}

export interface PaperError {
  ok: false
  error: string
  /** which requirement was not satisfiable */
  missing: { type: Question['type']; requested: number; available: number }[]
}
export interface PaperOk {
  ok: true
  questions: Question[]
}
export type PaperResult = PaperOk | PaperError

/**
 * Build a mock exam paper from config: exact per-type counts.
 *
 * Behaviour contract:
 *  - Selection is uniformly random per type (no slicing, no repeats).
 *  - If the bank cannot supply the requested count for a type, the call FAILS
 *    with an explanatory error. It never silently shrinks the paper, never
 *    duplicates a question, and never loops forever.
 */
export function buildPaper(
  allQuestions: Question[],
  config: {
    singleCount: number
    multiCount: number
    judgeCount: number
    shortCount: number
    chapters: string[] | 'all'
  },
  rng: () => number = Math.random,
): PaperResult {
  const pool =
    config.chapters === 'all'
      ? allQuestions
      : allQuestions.filter((q) => (config.chapters as string[]).includes(q.chapter))

  const byType = (t: Question['type']) => pool.filter((q) => q.type === t)
  const subjective = pool.filter((q) => q.type === 'short' || q.type === 'material')

  const requests: { type: Question['type']; n: number }[] = [
    { type: 'single', n: config.singleCount },
    { type: 'multi', n: config.multiCount },
    { type: 'judge', n: config.judgeCount },
    { type: 'short', n: config.shortCount },
  ]

  // Validate availability BEFORE building anything.
  const missing: PaperError['missing'] = []
  for (const r of requests) {
    if (r.n <= 0) continue
    const available = r.type === 'short' ? subjective.length : byType(r.type).length
    if (available < r.n) missing.push({ type: r.type, requested: r.n, available })
  }
  if (missing.length > 0) {
    const detail = missing.map((m) => `${m.type} 需要 ${m.requested} 题，题库仅有 ${m.available} 题`).join('；')
    return {
      ok: false,
      error: `题库数量不足，无法按当前配置组卷：${detail}。请减少对应题型数量或扩大章节范围。`,
      missing,
    }
  }

  const pick = (arr: Question[], n: number): Question[] => {
    const copy = arr.slice()
    const res: Question[] = []
    for (let i = 0; i < n; i++) {
      const idx = Math.floor(rng() * copy.length)
      res.push(copy[idx])
      copy.splice(idx, 1)
    }
    return res
  }

  // Subjective slot: draw from short + material together so the choice is random.
  const subs = pick(subjective, config.shortCount)

  const questions = [
    ...pick(byType('single'), config.singleCount),
    ...pick(byType('multi'), config.multiCount),
    ...pick(byType('judge'), config.judgeCount),
    ...subs,
  ]

  // Defensive invariant: no duplicates, exact requested total.
  const seen = new Set<string>()
  for (const q of questions) {
    if (seen.has(q.id)) {
      return { ok: false, error: `组卷内部错误：题目 ${q.id} 重复`, missing: [] }
    }
    seen.add(q.id)
  }
  return { ok: true, questions }
}
