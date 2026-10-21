import { describe, it, expect } from 'vitest'
import { selectQuestions, questionWeight, isDue, freshRecord, mulberry32, WEIGHT } from './scheduler'
import { objectiveQuestions } from './bank'
import type { Question, QRecord } from './types'

/**
 * Weight regressions driven through the REAL `selectQuestions` entry point.
 *
 * The bug this guards against: a genuinely missing record is materialised with
 * `freshRecord`, whose `nextReviewAt` is `now`. A due test of just
 * `nextReviewAt <= now` therefore reports a never-attempted question as overdue,
 * which silently overrode the declared untouched weight.
 */

const DAY = 86400000
const NOW = Date.UTC(2024, 0, 10, 12, 0, 0)

/** Take the real bank's first questions and label them for readability. */
const realQuestions = (n: number): Question[] => objectiveQuestions.slice(0, n)

describe('scheduler / weight of never-attempted questions', () => {
  it('a materialised fresh record is not due', () => {
    const rec = freshRecord('q', NOW)
    // The record itself claims nextReviewAt === now...
    expect(rec.nextReviewAt).toBe(NOW)
    // ...but it has never been answered, so it is not overdue work.
    expect(isDue(rec, NOW)).toBe(false)
    expect(questionWeight(rec, NOW)).toBe(WEIGHT.untouched)
  })

  it('a record with attempts=0 and a past nextReviewAt is not due either', () => {
    const rec: QRecord = { ...freshRecord('q', NOW), attempts: 0, nextReviewAt: NOW - 10 * DAY }
    expect(isDue(rec, NOW)).toBe(false)
    expect(questionWeight(rec, NOW)).toBe(WEIGHT.untouched)
  })

  it('the untouched weight is exactly the declared 4, via weight and via selection', () => {
    const pool = realQuestions(6)
    // No records at all: every question is materialised as fresh inside the selector.
    const records = new Map<string, QRecord>()
    for (const q of pool) {
      const w = questionWeight(freshRecord(q.id, NOW), NOW)
      expect(w, q.id).toBe(WEIGHT.untouched)
      expect(w, q.id).toBe(4)
    }
    // The real entry point still returns questions (no empty-session surprise).
    const picked = selectQuestions({ pool, records, now: NOW, count: 4, rng: mulberry32(11) })
    expect(picked).toHaveLength(4)
  })

  it('overdue wrong / overdue mastered / untouched keep the approved order', () => {
    const [qDue, qMastered, qUntouched, qNotDueWrong] = realQuestions(4)
    const records = new Map<string, QRecord>([
      [
        qDue.id,
        {
          ...freshRecord(qDue.id, NOW),
          attempts: 5,
          correctCount: 1,
          wrongCount: 4,
          lastSeenAt: NOW - 5 * DAY,
          nextReviewAt: NOW - DAY,
        },
      ],
      [
        qMastered.id,
        {
          ...freshRecord(qMastered.id, NOW),
          status: 'mastered',
          attempts: 5,
          correctCount: 5,
          lastSeenAt: NOW - 9 * DAY,
          nextReviewAt: NOW - DAY,
        },
      ],
      [
        qNotDueWrong.id,
        {
          ...freshRecord(qNotDueWrong.id, NOW),
          attempts: 5,
          correctCount: 3,
          wrongCount: 2,
          lastSeenAt: NOW - DAY,
          nextReviewAt: NOW + 5 * DAY,
        },
      ],
    ])
    const wDue = questionWeight(records.get(qDue.id)!, NOW)
    const wMastered = questionWeight(records.get(qMastered.id)!, NOW)
    const wUntouched = questionWeight(freshRecord(qUntouched.id, NOW), NOW)
    const wNotDueWrong = questionWeight(records.get(qNotDueWrong.id)!, NOW)

    expect(wDue).toBe(WEIGHT.dueWrong) // 12
    expect(wMastered).toBe(WEIGHT.dueMastered) // 6
    expect(wUntouched).toBe(WEIGHT.untouched) // 4
    expect(wNotDueWrong).toBe(WEIGHT.notDueWrong) // 6

    // Due work outranks untouched work; untouched outranks ordinary not-due work.
    expect(wDue).toBeGreaterThan(wUntouched)
    expect(wUntouched).toBeGreaterThan(WEIGHT.learningNotDue)
  })

  it('the selector actually prefers an overdue question over never-attempted ones', () => {
    // One overdue-wrong question against five never-attempted ones. Over many
    // seeds the overdue one must be picked far more often (12 vs 4).
    const pool = realQuestions(6)
    const overdue = pool[0]
    const records = new Map<string, QRecord>([
      [
        overdue.id,
        {
          ...freshRecord(overdue.id, NOW),
          attempts: 6,
          correctCount: 2,
          wrongCount: 4,
          lastSeenAt: NOW - 30 * DAY,
          nextReviewAt: NOW - DAY,
        },
      ],
    ])
    let overduePicked = 0
    const RUNS = 400
    for (let s = 0; s < RUNS; s++) {
      const picked = selectQuestions({ pool, records, now: NOW, count: 1, rng: mulberry32(s + 1) })
      if (picked[0]?.id === overdue.id) overduePicked++
    }
    const share = overduePicked / RUNS
    // Expected 12 / (12 + 5*4) = 0.375. Assert clearly above an even split.
    expect(share).toBeGreaterThan(0.25)
  })

  it('an untouched question is not counted as due by the selector', () => {
    // If a never-attempted question were treated as due it would weigh 8 and
    // beat a genuinely not-due wrong question (6). Verify it does not.
    const [qFresh, qWrong] = realQuestions(2)
    const records = new Map<string, QRecord>([
      [
        qWrong.id,
        {
          ...freshRecord(qWrong.id, NOW),
          attempts: 4,
          correctCount: 2,
          wrongCount: 2,
          lastSeenAt: NOW - DAY,
          nextReviewAt: NOW + 5 * DAY,
        },
      ],
    ])
    const wFresh = questionWeight(freshRecord(qFresh.id, NOW), NOW)
    const wWrong = questionWeight(records.get(qWrong.id)!, NOW)
    expect(wFresh).toBe(4)
    expect(wWrong).toBe(6)
    expect(wWrong).toBeGreaterThan(wFresh)
  })

  it('the selector result is unaffected by a legacy attempts=0 row with a past due date', () => {
    const pool = realQuestions(5)
    const q0 = pool[0]
    // A row left by an older build: 0 attempts but a stale past nextReviewAt.
    const records = new Map<string, QRecord>([
      [q0.id, { ...freshRecord(q0.id, NOW), attempts: 0, nextReviewAt: NOW - 30 * DAY }],
    ])
    expect(questionWeight(records.get(q0.id)!, NOW)).toBe(WEIGHT.untouched)
    const picked = selectQuestions({ pool, records, now: NOW, count: 3, rng: mulberry32(3) })
    expect(picked).toHaveLength(3)
    expect(new Set(picked.map((q) => q.id)).size).toBe(3)
  })
})
