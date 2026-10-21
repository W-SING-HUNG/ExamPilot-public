import { describe, it, expect } from 'vitest'
import { buildPlan, planPools } from './plan'
import { freshRecord, mulberry32, applyAttempt } from './scheduler'
import { objectiveQuestions, subjectiveQuestions } from './bank'
import type { Question, QRecord } from './types'

/**
 * Same-day de-duplication, driven through the REAL `buildPlan`.
 *
 * The bug this guards against: the previous implementation only REORDERED each
 * pool ("not trained today" first) and then handed it to the weighted selector.
 * The selector ranks candidates by their record state, not by list position, so
 * the reordering had no effect on the draw — a second plan in the same day
 * served exactly the same questions. These tests pin the partition behaviour:
 * the quota is filled from the not-trained-today group first, and only falls
 * back to the trained-today group when that group cannot cover it.
 *
 * Everything runs on a FIXED clock and an explicit seeded PRNG.
 */

const DAY = 86400000
const NOW = Date.UTC(2024, 0, 10, 12, 0, 0)
const SEED = 424242

/** Local start-of-day for NOW, so "today" is unambiguous in any timezone. */
function startOfLocalDay(t: number): number {
  const d = new Date(t)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

const objOf = (plan: Question[]) => plan.filter((q) => q.type !== 'short' && q.type !== 'material')

const run = (records: Map<string, QRecord>, size: number, rng = mulberry32(SEED)) =>
  buildPlan({ objective: objectiveQuestions, subjective: [], records, now: NOW, size, rng })

describe('plan / same-day de-duplication', () => {
  /**
   * The bank differs by environment (the public sample bank in CI, a larger
   * bank installed locally), so sizes below are derived from it.
   *
   * A case that needs more questions than the installed bank holds is marked
   * SKIPPED explicitly rather than returning early: a silent `return` would be
   * reported as a passing test, which overstates what actually ran.
   */
  const bank = objectiveQuestions.length
  /** True when the installed bank can support a scenario needing `n` questions. */
  const canRun = (n: number) => bank >= n

  it.skipIf(!canRun(20))('the primary scenario: 20 wrong questions, 10 of them trained today', () => {
    // 20 questions are in the wrong pool (attempted, wrong, not due).
    // The first 10 were trained EARLIER TODAY; the other 10 have not been today.
    const pool = objectiveQuestions.slice(0, 20)
    const trainedTodayIds = new Set(pool.slice(0, 10).map((q) => q.id))
    const records = new Map<string, QRecord>()
    const earlierToday = startOfLocalDay(NOW) + 3600_000
    pool.forEach((q, i) => {
      records.set(q.id, {
        ...freshRecord(q.id, NOW),
        status: 'struggling',
        attempts: 5,
        correctCount: 1,
        wrongCount: 4,
        lastSeenAt: i < 10 ? earlierToday : NOW - 5 * DAY,
        // Not due: keeps them in the wrong pool rather than the due pool.
        nextReviewAt: NOW + 5 * DAY,
      })
    })

    const { wrong } = planPools(objectiveQuestions, records, NOW)
    expect(wrong).toHaveLength(20)

    // Ask for 10. All 10 must come from the not-trained-today half.
    const plan = run(records, 10)
    const picks = objOf(plan.questions)
    expect(picks).toHaveLength(10)
    expect(new Set(picks.map((q) => q.id)).size).toBe(10)
    const fromToday = picks.filter((q) => trainedTodayIds.has(q.id))
    expect(fromToday, 'a plentiful not-today group must be used exclusively').toHaveLength(0)
  })

  it('falls back to trained-today questions rather than shortening the plan', () => {
    // A CONTROLLED pool of 10 wrong questions, so the wrong quota (25% of 10 =
    // 3) is what is actually being exercised. Only 2 of them are today-free, so
    // the third slot must fall back to a trained-today question.
    const pool = objectiveQuestions.slice(0, 10)
    const records = new Map<string, QRecord>()
    const earlierToday = startOfLocalDay(NOW) + 3600_000
    pool.forEach((q, i) => {
      records.set(q.id, {
        ...freshRecord(q.id, NOW),
        status: 'struggling',
        attempts: 5,
        correctCount: 1,
        wrongCount: 4,
        // Only the last 2 are today-free.
        lastSeenAt: i < 8 ? earlierToday : NOW - 5 * DAY,
        nextReviewAt: NOW + 5 * DAY,
      })
    })
    const todayIds = new Set(pool.slice(0, 8).map((q) => q.id))
    const notTodayIds = new Set(pool.slice(8).map((q) => q.id))

    // Pool = only these 10, size = 3 so the wrong quota is exactly 3.
    const plan = buildPlan({ objective: pool, subjective: [], records, now: NOW, size: 3, rng: mulberry32(SEED) })
    const picks = objOf(plan.questions)
    expect(picks).toHaveLength(3)
    expect(new Set(picks.map((q) => q.id)).size).toBe(3)
    // Both today-free questions are used...
    const usedNotToday = picks.filter((q) => notTodayIds.has(q.id))
    expect(usedNotToday, 'both today-free questions must be preferred').toHaveLength(2)
    // ...and exactly one falls back to a trained-today question.
    const usedToday = picks.filter((q) => todayIds.has(q.id))
    expect(usedToday, 'the quota must be filled by fallback, not left short').toHaveLength(1)
  })

  it('every question trained today still yields a full plan', () => {
    const pool = objectiveQuestions.slice(0, 10)
    const records = new Map<string, QRecord>()
    const earlierToday = startOfLocalDay(NOW) + 3600_000
    for (const q of pool) {
      records.set(q.id, {
        ...freshRecord(q.id, NOW),
        status: 'struggling',
        attempts: 5,
        correctCount: 1,
        wrongCount: 4,
        lastSeenAt: earlierToday,
        nextReviewAt: NOW + 5 * DAY,
      })
    }
    const plan = run(records, 10)
    expect(objOf(plan.questions)).toHaveLength(10)
    expect(plan.pools.wrong).toBe(10)
  })

  it('the due pool is partitioned too and still drains oldest-first within each half', () => {
    const pool = objectiveQuestions.slice(0, 8)
    const records = new Map<string, QRecord>()
    const earlierToday = startOfLocalDay(NOW) + 3600_000
    // 4 due-and-today, 4 due-and-not-today, with distinct ages.
    pool.forEach((q, i) => {
      const isToday = i < 4
      records.set(q.id, {
        ...freshRecord(q.id, NOW),
        attempts: 4,
        correctCount: 3,
        wrongCount: 1,
        lastSeenAt: isToday ? earlierToday : NOW - (i + 1) * DAY,
        nextReviewAt: NOW - DAY,
      })
    })
    const plan = run(records, 8)
    const picks = objOf(plan.questions)
    expect(picks).toHaveLength(8)
    // The four not-trained-today questions come first, in oldest-first order.
    const firstFour = picks.slice(0, 4)
    const firstFourIds = new Set(firstFour.map((q) => q.id))
    const todayIds = new Set(pool.slice(0, 4).map((q) => q.id))
    expect(firstFour.filter((q) => todayIds.has(q.id))).toHaveLength(0)
    // Among the not-today group, oldest lastSeenAt is served first.
    const ages = firstFour.map((q) => records.get(q.id)!.lastSeenAt)
    expect(ages).toEqual([...ages].sort((a, b) => a - b))
    expect(firstFourIds.size).toBe(4)
  })

  it('the fresh pool is partitioned on the same rule (nothing trained today there)', () => {
    // Fresh questions have no record, so none can be trained today; the pool is
    // returned whole and the plan is full.
    const plan = run(new Map(), 12)
    expect(objOf(plan.questions)).toHaveLength(12)
    expect(plan.pools.fresh).toBeGreaterThanOrEqual(12)
  })

  it.skipIf(!canRun(20))('no hard-coded seed: two different days produce different plans', () => {
    // Needs a pool large enough that two draws can plausibly differ.
    // Build the same records state on two different dates. With a per-day seed
    // the selections must differ across days rather than repeating forever.
    const build = (dayOffset: number) => {
      const now = NOW + dayOffset * DAY
      const records = new Map<string, QRecord>()
      // A large wrong pool so the draw has room to differ.
      objectiveQuestions.slice(0, Math.min(60, bank)).forEach((q, i) => {
        records.set(q.id, {
          ...freshRecord(q.id, now),
          attempts: 5,
          correctCount: 2,
          wrongCount: 3,
          lastSeenAt: now - 10 * DAY,
          nextReviewAt: now + 10 * DAY,
          // Alternate status so the schedule itself is not the only variable.
          status: i % 2 === 0 ? 'struggling' : 'learning',
        })
      })
      const size = Math.min(20, bank)
      return objOf(buildPlan({ objective: objectiveQuestions, subjective: [], records, now, size }).questions).map(
        (q) => q.id,
      )
    }
    const dayA = build(0)
    const dayB = build(3)
    const expected = Math.min(20, bank)
    expect(dayA).toHaveLength(expected)
    expect(dayB).toHaveLength(expected)
    expect(dayA.join(',')).not.toBe(dayB.join(','))
  })

  it('the same day produces the same plan (stable within a day)', () => {
    const records = new Map<string, QRecord>()
    objectiveQuestions.slice(0, Math.min(40, bank)).forEach((q) => {
      records.set(q.id, {
        ...freshRecord(q.id, NOW),
        attempts: 5,
        correctCount: 2,
        wrongCount: 3,
        lastSeenAt: NOW - 10 * DAY,
        nextReviewAt: NOW + 10 * DAY,
      })
    })
    const size = Math.min(20, bank)
    const a = run(records, size).questions.map((q) => q.id)
    const b = run(records, size).questions.map((q) => q.id)
    expect(a).toEqual(b)
  })

  it.skipIf(!canRun(8))('an explicit rng still overrides the day seed', () => {
    const records = new Map<string, QRecord>()
    objectiveQuestions.slice(0, Math.min(40, bank)).forEach((q) => {
      records.set(q.id, {
        ...freshRecord(q.id, NOW),
        attempts: 5,
        correctCount: 2,
        wrongCount: 3,
        lastSeenAt: NOW - 10 * DAY,
        nextReviewAt: NOW + 10 * DAY,
      })
    })
    const size = Math.min(20, bank)
    const a = run(records, size, mulberry32(1)).questions.map((q) => q.id)
    const b = run(records, size, mulberry32(2)).questions.map((q) => q.id)
    expect(a.join(',')).not.toBe(b.join(','))
  })

  it.skipIf(!canRun(20))('same-day protection does not disturb the due/wrong/fresh quotas', () => {
    // 6 due (3 today-free), plenty wrong and fresh; size 20.
    const records = new Map<string, QRecord>()
    const earlierToday = startOfLocalDay(NOW) + 3600_000
    objectiveQuestions.slice(0, 6).forEach((q, i) => {
      records.set(q.id, {
        ...freshRecord(q.id, NOW),
        attempts: 4,
        correctCount: 3,
        wrongCount: 1,
        lastSeenAt: i < 3 ? earlierToday : NOW - (i + 1) * DAY,
        nextReviewAt: NOW - DAY,
      })
    })
    objectiveQuestions.slice(6, 26).forEach((q) => {
      records.set(q.id, {
        ...freshRecord(q.id, NOW),
        attempts: 4,
        correctCount: 2,
        wrongCount: 2,
        lastSeenAt: NOW - 20 * DAY,
        nextReviewAt: NOW + 20 * DAY,
      })
    })
    const plan = run(records, 20)
    expect(objOf(plan.questions)).toHaveLength(20)
    // All 6 due questions fit inside the 50% due quota (10), so none is deferred.
    const dueIds = new Set(objectiveQuestions.slice(0, 6).map((q) => q.id))
    const dueInPlan = objOf(plan.questions).filter((q) => dueIds.has(q.id)).length
    expect(dueInPlan).toBe(6)
    expect(plan.deferredDue).toBe(0)
  })

  it('an untouched question is never selected as due work', () => {
    // A stale row with 0 attempts and a past due date must not read as overdue.
    const q0 = objectiveQuestions[0]
    const records = new Map<string, QRecord>([
      [q0.id, { ...freshRecord(q0.id, NOW), attempts: 0, nextReviewAt: NOW - 30 * DAY }],
    ])
    const { due, fresh } = planPools(objectiveQuestions, records, NOW)
    expect(due).toHaveLength(0)
    expect(fresh.some((q) => q.id === q0.id)).toBe(true)
    const plan = run(records, 5)
    expect(plan.deferredDue).toBe(0)
  })

  it('trained-today detection uses a real record written by applyAttempt', () => {
    // Not a hand-built QRecord: drive the scheduler and check the plan reacts.
    const pool = objectiveQuestions.slice(0, 10)
    const records = new Map<string, QRecord>()
    const earlierToday = startOfLocalDay(NOW) + 3600_000
    pool.forEach((q, i) => {
      let r = freshRecord(q.id, earlierToday)
      r = applyAttempt(r, false, earlierToday)
      r = applyAttempt(r, false, earlierToday + 1000)
      r = applyAttempt(r, false, earlierToday + 2000)
      // Keep them out of the due pool by scheduling well ahead.
      records.set(q.id, { ...r, nextReviewAt: NOW + 30 * DAY })
      void i
    })
    expect([...records.values()].every((r) => r.wrongCount === 3)).toBe(true)
    const plan = run(records, 10)
    // Every one was trained today, so the plan falls back to them and stays full.
    expect(objOf(plan.questions)).toHaveLength(10)
  })

  it.skipIf(subjectiveQuestions.length < 2)('the subjective slot prefers a question that is due for review', () => {
    // A subjective question that has come due must have a better chance of
    // reappearing than one that is not due. Previously the slot was drawn
    // uniformly, which ignored the schedule entirely.
    const subj = subjectiveQuestions
    const overdueQ = subj[0]
    const notDueQ = subj[1]
    const records = new Map<string, QRecord>([
      [
        overdueQ.id,
        // Attempted, not trained today, well overdue.
        { ...freshRecord(overdueQ.id, NOW), attempts: 3, lastSeenAt: NOW - 10 * DAY, nextReviewAt: NOW - 5 * DAY },
      ],
      [
        notDueQ.id,
        // Attempted, not trained today, scheduled far ahead.
        { ...freshRecord(notDueQ.id, NOW), attempts: 3, lastSeenAt: NOW - 2 * DAY, nextReviewAt: NOW + 30 * DAY },
      ],
    ])
    // Force a wide objective bank so the plan is never empty.
    const plan = buildPlan({
      objective: objectiveQuestions,
      subjective: subj,
      records,
      now: NOW,
      size: 5,
      rng: mulberry32(SEED),
    })
    const pickedSubj = plan.questions.filter((q) => q.type === 'short' || q.type === 'material')
    expect(pickedSubj).toHaveLength(1)
    expect(pickedSubj[0].id, 'the overdue subjective question must be preferred over the not-due one').toBe(overdueQ.id)
  })

  it.skipIf(subjectiveQuestions.length < 2)(
    'the subjective slot does not repeat a question trained today when others exist',
    () => {
      const subj = subjectiveQuestions
      const trainedTodayQ = subj[0]
      const otherQ = subj[1]
      const earlierToday = startOfLocalDay(NOW) + 3600_000
      const records = new Map<string, QRecord>([
        [
          trainedTodayQ.id,
          {
            ...freshRecord(trainedTodayQ.id, NOW),
            attempts: 2,
            lastSeenAt: earlierToday,
            nextReviewAt: NOW - DAY,
          },
        ],
        [
          otherQ.id,
          { ...freshRecord(otherQ.id, NOW), attempts: 2, lastSeenAt: NOW - 3 * DAY, nextReviewAt: NOW - DAY },
        ],
      ])
      const plan = buildPlan({
        objective: objectiveQuestions,
        subjective: subj,
        records,
        now: NOW,
        size: 5,
        rng: mulberry32(SEED),
      })
      const pickedSubj = plan.questions.filter((q) => q.type === 'short' || q.type === 'material')
      expect(pickedSubj).toHaveLength(1)
      expect(pickedSubj[0].id).not.toBe(trainedTodayQ.id)
    },
  )
})
