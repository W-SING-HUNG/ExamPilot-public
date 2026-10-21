import type { MockConfig, MockQuestionResult, Question } from './types'
import { scoreAnswer, isAnswerBlank } from './scoring'

export interface GradedMock {
  score: number
  /** total points obtainable from auto-graded objective questions */
  objectiveMaxScore: number
  /** points reserved for subjective questions (never auto-scored) */
  subjectiveMaxScore: number
  maxScore: number
  perQuestion: Record<string, MockQuestionResult>
  /** questions that must NOT be written to learning records (blanks) */
  skipped: string[]
  /** questions that SHOULD be written to learning records */
  persisted: { q: Question; answer: string }[]
  /** subjective questions with a real answer, to persist as attempts */
  subjective: { q: Question; answer: string }[]
  answeredCount: number
  unansweredCount: number
}

function pointsFor(q: Question, config: MockConfig): number {
  if (q.type === 'multi') return config.multiScore
  if (q.type === 'judge') return config.judgeScore
  if (q.type === 'short' || q.type === 'material') return config.shortScore
  return config.singleScore
}

/**
 * Grade a mock-exam submission.
 *
 * Contract (regression-tested in `mock-grading.test.ts`):
 *  - A BLANK objective answer is `unanswered`: `isCorrect = null`, 0 points, and
 *    it is listed in `skipped` so the caller must not persist it. Blanks are
 *    never counted as wrong and never enter the wrong-question bank.
 *  - A WRONG objective answer is `isCorrect = false` and IS persisted.
 *  - Subjective questions are never auto-scored (`isCorrect = null`) and their
 *    points are reported separately in `subjectiveMaxScore`, so a partial score
 *    is never presented as a full-paper result.
 */
export function gradeMockSubmission(
  paper: Question[],
  submissions: Record<string, string | null>,
  config: MockConfig,
): GradedMock {
  const perQuestion: Record<string, MockQuestionResult> = {}
  const skipped: string[] = []
  const persisted: { q: Question; answer: string }[] = []
  const subjective: { q: Question; answer: string }[] = []

  let score = 0
  let objectiveMaxScore = 0
  let subjectiveMaxScore = 0
  let answeredCount = 0
  let unansweredCount = 0

  for (const q of paper) {
    const raw = submissions[q.id] ?? null
    const blank = isAnswerBlank(q, raw)
    if (blank) unansweredCount++
    else answeredCount++

    if (q.type === 'short' || q.type === 'material') {
      subjectiveMaxScore += pointsFor(q, config)
      perQuestion[q.id] = { isCorrect: null, points: 0, unanswered: blank }
      if (!blank) subjective.push({ q, answer: raw as string })
      continue
    }

    objectiveMaxScore += pointsFor(q, config)

    if (blank) {
      // Never wrong, never persisted.
      perQuestion[q.id] = { isCorrect: null, points: 0, unanswered: true }
      skipped.push(q.id)
      continue
    }

    const ok = scoreAnswer(q, raw) === true
    const pts = ok ? pointsFor(q, config) : 0
    score += pts
    perQuestion[q.id] = { isCorrect: ok, points: pts, unanswered: false }
    persisted.push({ q, answer: raw as string })
  }

  return {
    score,
    objectiveMaxScore,
    subjectiveMaxScore,
    maxScore: objectiveMaxScore + subjectiveMaxScore,
    perQuestion,
    skipped,
    persisted,
    subjective,
    answeredCount,
    unansweredCount,
  }
}
