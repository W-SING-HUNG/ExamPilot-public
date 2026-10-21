/**
 * Session outcome model and per-question outcome bookkeeping.
 *
 * Three outcomes are kept strictly apart, because conflating them is what made
 * an un-scored subjective answer both "wrong" in the counter and "correct" in
 * the progress dots:
 *
 *   correct   — auto-graded, right
 *   wrong     — auto-graded, wrong
 *   unscored  — no auto-grading exists for this question (subjective), or the
 *               answer was left blank in a deferred (mock) run
 *
 * `unanswered` is reported separately from `wrong`: a blank is never an error.
 */
export type Outcome = 'correct' | 'wrong' | 'unscored'

export interface SessionResult {
  /** Questions in the session. */
  total: number
  /** Questions with a recorded outcome (correct + wrong + unscored). */
  answered: number
  correct: number
  wrong: number
  /** Subjective / deferred-blank questions with no auto grade. */
  unscored: number
  /** Questions the user never submitted. */
  unanswered: number
  /** Wall-clock duration of the session, ms. */
  durationMs: number
  /** qids answered wrongly — used by the summary's "review these" action. */
  wrongQids: string[]
  /** qids that were skipped on purpose. */
  skippedQids: string[]
  /** Best-effort accuracy over auto-graded questions only; null when none. */
  accuracy: number | null
}

export const EMPTY_RESULT: SessionResult = {
  total: 0,
  answered: 0,
  correct: 0,
  wrong: 0,
  unscored: 0,
  unanswered: 0,
  durationMs: 0,
  wrongQids: [],
  skippedQids: [],
  accuracy: null,
}

/** Tally outcomes into a session result. */
export function summarise(args: {
  total: number
  outcomes: Record<string, Outcome>
  skipped?: string[]
  durationMs: number
}): SessionResult {
  const values = Object.values(args.outcomes)
  const correct = values.filter((v) => v === 'correct').length
  const wrong = values.filter((v) => v === 'wrong').length
  const unscored = values.filter((v) => v === 'unscored').length
  const answered = correct + wrong + unscored
  const graded = correct + wrong
  return {
    total: args.total,
    answered,
    correct,
    wrong,
    unscored,
    unanswered: Math.max(0, args.total - answered),
    durationMs: args.durationMs,
    wrongQids: Object.entries(args.outcomes)
      .filter(([, v]) => v === 'wrong')
      .map(([k]) => k),
    skippedQids: args.skipped ?? [],
    accuracy: graded > 0 ? correct / graded : null,
  }
}

/** Human label used consistently in dots, counters and the summary. */
export const OUTCOME_LABEL: Record<Outcome, string> = {
  correct: '正确',
  wrong: '错误',
  unscored: '未自动评分',
}
