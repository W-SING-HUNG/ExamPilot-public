import { describe, it, expect } from 'vitest'
import { buildPlan, planPools, orderDueOldestFirst, SUBJECTIVE_SLOTS } from './plan'
import { freshRecord, applyAttempt, applySubjectiveAttempt, mulberry32 } from './scheduler'
import { objectiveQuestions, subjectiveQuestions, usingSampleBank } from './bank'
import type { Question, QRecord } from './types'

const DAY = 86400000

/** Deterministic, controllable inputs for the plan builder. */
function setup(o: { now?: number; size: number; objective?: Question[]; subjective?: Question[] }) {
  const now = o.now ?? 10 * DAY
  const objective = o.objective ?? objectiveQuestions
  const subjective = o.subjective ?? subjectiveQuestions
  const records = new Map<string, QRecord>()
  return { now, objective, subjective, records, size: o.size }
}

const objOf = (plan: Question[]) => plan.filter((q) => q.type !== 'short' && q.type !== 'material')
const subjOf = (plan: Question[]) => plan.filter((q) => q.type === 'short' || q.type === 'material')

/** Mark questions with a record, in bank order. */
function mark(
  records: Map<string, QRecord>,
  questions: Question[],
  fn: (q: Question, i: number) => Partial<QRecord>,
  now: number,
) {
  questions.forEach((q, i) => {
    records.set(q.id, { ...freshRecord(q.id, now), ...fn(q, i) })
  })
}

/**
 * Split a list into three roughly equal thirds.
 *
 * Tests must not assume a bank size: CI runs against the public 17-question
 * sample bank, local runs against the licensed full bank. Everything here is
 * derived from the installed bank so the same assertions hold on both.
 */
function thirds<T>(list: T[]): [T[], T[], T[]] {
  const n = list.length
  const a = Math.ceil(n / 3)
  const b = Math.ceil((n - a) / 2)
  return [list.slice(0, a), list.slice(a, a + b), list.slice(a + b)]
}

describe('plan / pools', () => {
  it('splits the bank into due / wrong / fresh, mutually exclusively', () => {
    const now = 10 * DAY
    const [duePart, wrongPart, freshPart] = thirds(objectiveQuestions)
    expect(duePart.length + wrongPart.length + freshPart.length).toBe(objectiveQuestions.length)
    const records = new Map<string, QRecord>()
    mark(records, duePart, () => ({ attempts: 5, correctCount: 5, nextReviewAt: now - DAY }), now) // due
    mark(records, wrongPart, () => ({ attempts: 5, correctCount: 3, wrongCount: 2, nextReviewAt: now + 5 * DAY }), now) // wrong, not due
    mark(records, freshPart, () => ({ attempts: 0, nextReviewAt: now }), now) // fresh
    const { due, wrong, fresh } = planPools(objectiveQuestions, records, now)
    expect(due).toHaveLength(duePart.length)
    expect(wrong).toHaveLength(wrongPart.length)
    expect(fresh).toHaveLength(freshPart.length)
    // No question appears twice.
    const ids = [...due, ...wrong, ...fresh].map((q) => q.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('a due question that was also answered wrong counts as due only', () => {
    const now = 10 * DAY
    const obj = objectiveQuestions.slice(0, Math.min(5, objectiveQuestions.length))
    const records = new Map<string, QRecord>()
    mark(records, obj, () => ({ attempts: 5, correctCount: 1, wrongCount: 4, nextReviewAt: now - DAY }), now)
    const { due, wrong } = planPools(obj, records, now)
    expect(due).toHaveLength(obj.length)
    expect(wrong).toHaveLength(0)
  })

  it('orders the due pool oldest-first with a stable tie-break', () => {
    const now = 10 * DAY
    const obj = objectiveQuestions.slice(0, 4)
    const records = new Map<string, QRecord>()
    // Intentionally inserted out of order.
    obj.forEach((q, i) => {
      records.set(q.id, {
        ...freshRecord(q.id, now),
        attempts: 5,
        lastSeenAt: now - (4 - i) * DAY,
        nextReviewAt: now - DAY,
      })
    })
    const ordered = orderDueOldestFirst(obj, records)
    const seen = ordered.map((q) => records.get(q.id)!.lastSeenAt)
    expect(seen).toEqual([...seen].sort((a, b) => a - b))
  })
})

describe('plan / quota', () => {
  it('T1: a brand-new user gets exactly the requested objective count', () => {
    const bank = objectiveQuestions.length
    for (const size of [10, 20, 30, 50]) {
      const expected = Math.min(size, bank)
      const s = setup({ size })
      const plan = buildPlan({ ...s, rng: mulberry32(7) })
      expect(objOf(plan.questions)).toHaveLength(expected)
      expect(plan.shortfall).toBe(size - expected)
      expect(plan.pools.due).toBe(0)
      expect(plan.pools.wrong).toBe(0)
    }
  })

  it('T1: the subjective slot is extra and does not consume the objective quota', () => {
    const size = 20
    const expected = Math.min(size, objectiveQuestions.length)
    const s = setup({ size })
    const plan = buildPlan({ ...s, rng: mulberry32(7) })
    expect(objOf(plan.questions)).toHaveLength(expected)
    expect(subjOf(plan.questions)).toHaveLength(SUBJECTIVE_SLOTS)
    expect(plan.questions).toHaveLength(expected + SUBJECTIVE_SLOTS)
  })

  it('T2: due questions take up to half the quota and fresh fills the rest', () => {
    const now = 10 * DAY
    const obj = objectiveQuestions
    const records = new Map<string, QRecord>()
    // Make at least a quarter of the bank overdue, or all of it if the bank is
    // smaller than that.
    const dueCount = Math.max(1, Math.min(obj.length, Math.ceil(obj.length / 4)))
    mark(
      records,
      obj.slice(0, dueCount),
      () => ({
        status: 'struggling',
        attempts: 6,
        wrongCount: 4,
        correctCount: 2,
        lastSeenAt: now - 10 * DAY,
        nextReviewAt: now - 5 * DAY,
      }),
      now,
    )
    const size = 20
    const plan = buildPlan({
      objective: obj,
      subjective: subjectiveQuestions,
      records,
      now,
      size,
      rng: mulberry32(7),
    })
    const objTarget = Math.min(size, obj.length)
    const dueInPlan = objOf(plan.questions).filter((q) => {
      const r = records.get(q.id)
      return !!r && r.attempts > 0 && r.nextReviewAt <= now
    }).length
    // The due quota is 50% of the objective target, capped by the due pool.
    const dueQuota = Math.min(dueCount, Math.ceil(objTarget * 0.5))
    expect(dueInPlan).toBe(dueQuota)
    expect(dueInPlan).toBeLessThanOrEqual(objTarget)
    // Whatever is left is filled from the untrained pool.
    expect(objOf(plan.questions)).toHaveLength(objTarget)
    if (dueQuota < objTarget) expect(plan.pools.fresh).toBeGreaterThan(0)
  })

  it('T12: when due questions overflow the quota they are deferred, not dropped silently', () => {
    const now = 10 * DAY
    const obj = objectiveQuestions
    const records = new Map<string, QRecord>()
    // Overdue the whole bank: the quota can never hold it all.
    mark(
      records,
      obj,
      (_, i) => ({
        status: 'learning',
        attempts: 4,
        correctCount: 3,
        wrongCount: 1,
        lastSeenAt: now - 20 * DAY,
        nextReviewAt: now - (i + 1) * DAY,
      }),
      now,
    )
    const size = 20
    const objTarget = Math.min(size, obj.length)
    const plan = buildPlan({
      objective: obj,
      subjective: subjectiveQuestions,
      records,
      now,
      size,
      rng: mulberry32(7),
    })
    const objPicks = objOf(plan.questions)
    expect(objPicks).toHaveLength(objTarget)
    const dueInPlan = objPicks.filter((q) => (records.get(q.id)?.nextReviewAt ?? Infinity) <= now).length
    // At least the 50% due quota is filled, and with no wrong pool to draw from
    // the leftover capacity flows back to due — so on a small bank it can be all
    // of them. Either way the plan is never short.
    expect(dueInPlan).toBeGreaterThanOrEqual(Math.ceil(objTarget * 0.5))
    expect(dueInPlan).toBeLessThanOrEqual(objTarget)
    // Everything else is reported as deferred, and the page can say so.
    expect(plan.deferredDue).toBe(obj.length - dueInPlan)
    expect(plan.pools.due).toBe(obj.length)
    expect(plan.pools.wrong).toBe(0)
  })

  it('T12: the backlog drains oldest-first', () => {
    const now = 10 * DAY
    const obj = objectiveQuestions.slice(0, 12)
    const records = new Map<string, QRecord>()
    obj.forEach((q, i) => {
      records.set(q.id, {
        ...freshRecord(q.id, now),
        attempts: 4,
        lastSeenAt: now - (12 - i) * DAY,
        nextReviewAt: now - DAY,
      })
    })
    const plan = buildPlan({ objective: obj, subjective: [], records, now, size: 5, rng: mulberry32(7) })
    const pickedAges = objOf(plan.questions).map((q) => records.get(q.id)!.lastSeenAt)
    expect(pickedAges).toEqual([...pickedAges].sort((a, b) => a - b))
  })

  it('T13: when nothing is due and nothing is fresh the plan is subjective only', () => {
    const now = 10 * DAY
    const obj = objectiveQuestions
    const records = new Map<string, QRecord>()
    mark(
      records,
      obj,
      () => ({
        status: 'mastered',
        attempts: 6,
        correctCount: 6,
        intervalDays: 90,
        lastSeenAt: now - 90 * DAY,
        nextReviewAt: now + 90 * DAY,
      }),
      now,
    )
    const plan = buildPlan({
      objective: obj,
      subjective: subjectiveQuestions,
      records,
      now,
      size: 20,
      rng: mulberry32(7),
    })
    expect(objOf(plan.questions)).toHaveLength(0)
    expect(subjOf(plan.questions)).toHaveLength(1)
    expect(plan.pools.due).toBe(0)
    expect(plan.pools.fresh).toBe(0)
  })

  it('T14: an empty subjective bank yields no subjective slot and no error', () => {
    const s = setup({ size: 10, subjective: [] })
    const plan = buildPlan({ ...s, rng: mulberry32(7) })
    expect(subjOf(plan.questions)).toHaveLength(0)
    expect(objOf(plan.questions)).toHaveLength(10)
  })

  it('refunds unused quota instead of wasting capacity', () => {
    const now = 10 * DAY
    const obj = objectiveQuestions
    const records = new Map<string, QRecord>()
    // A large due pool and NO wrong pool: the wrong quota must flow to due and
    // then fresh so the plan is still full.
    const dueCount = Math.max(4, Math.min(obj.length, Math.ceil(obj.length * 0.2)))
    mark(
      records,
      obj.slice(0, dueCount),
      () => ({
        status: 'learning',
        attempts: 4,
        correctCount: 3,
        wrongCount: 0,
        lastSeenAt: now - DAY,
        nextReviewAt: now - DAY,
      }),
      now,
    )
    const size = 30
    const objTarget = Math.min(size, obj.length)
    const plan = buildPlan({
      objective: obj,
      subjective: subjectiveQuestions,
      records,
      now,
      size,
      rng: mulberry32(7),
    })
    expect(objOf(plan.questions)).toHaveLength(objTarget)
    expect(plan.shortfall).toBe(size - objTarget)
    expect(plan.pools.wrong).toBe(0)
  })
})

describe('plan / small bank', () => {
  it('T7: never exceeds the bank and never duplicates', () => {
    const obj = objectiveQuestions.slice(0, 14)
    const plan = buildPlan({
      objective: obj,
      subjective: subjectiveQuestions,
      records: new Map(),
      now: 10 * DAY,
      size: 50,
      rng: mulberry32(7),
    })
    expect(objOf(plan.questions)).toHaveLength(14)
    expect(plan.questions).toHaveLength(15) // + 1 subjective
    expect(plan.shortfall).toBe(36)
    const ids = plan.questions.map((q) => q.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('T7: a tiny bank still produces a non-empty plan', () => {
    const obj = objectiveQuestions.slice(0, 3)
    const plan = buildPlan({
      objective: obj,
      subjective: [],
      records: new Map(),
      now: 10 * DAY,
      size: 10,
      rng: mulberry32(7),
    })
    expect(objOf(plan.questions)).toHaveLength(3)
    expect(plan.shortfall).toBe(7)
  })

  it('T7: a duplicated pool never yields duplicate questions', () => {
    if (objectiveQuestions.length === 0) return
    const dup = [objectiveQuestions[0], objectiveQuestions[0], objectiveQuestions[0]]
    const plan = buildPlan({
      objective: dup,
      subjective: [],
      records: new Map(),
      now: 10 * DAY,
      size: 3,
      rng: mulberry32(7),
    })
    const ids = objOf(plan.questions).map((q) => q.id)
    expect(ids).toEqual([objectiveQuestions[0].id])
  })
})

// ---------------------------------------------------------------------------
// Defensive boundaries
// ---------------------------------------------------------------------------

describe('plan / defensive boundaries', () => {
  it('a non-positive size produces no objective picks and no error', () => {
    for (const size of [-5, 0]) {
      const plan = buildPlan({
        objective: objectiveQuestions,
        subjective: subjectiveQuestions,
        records: new Map(),
        now: 10 * DAY,
        size,
        rng: mulberry32(7),
      })
      expect(objOf(plan.questions)).toHaveLength(0)
      // The subjective slot is independent of the objective quota.
      expect(subjOf(plan.questions)).toHaveLength(SUBJECTIVE_SLOTS)
    }
  })

  it('a huge size is capped by the bank and never duplicates', () => {
    const t0 = Date.now()
    const plan = buildPlan({
      objective: objectiveQuestions,
      subjective: subjectiveQuestions,
      records: new Map(),
      now: 10 * DAY,
      size: 100000,
      rng: mulberry32(7),
    })
    expect(objOf(plan.questions)).toHaveLength(objectiveQuestions.length)
    expect(Date.now() - t0).toBeLessThan(5000)
    const ids = plan.questions.map((q) => q.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('a fractional size never issues more questions than requested', () => {
    for (const size of [1.2, 7.5, 10.1, 19.9]) {
      const plan = buildPlan({
        objective: objectiveQuestions,
        subjective: subjectiveQuestions,
        records: new Map(),
        now: 10 * DAY,
        size,
        rng: mulberry32(7),
      })
      expect(objOf(plan.questions).length).toBeLessThanOrEqual(Math.ceil(size))
      expect(objOf(plan.questions).length).toBeLessThanOrEqual(objectiveQuestions.length)
      const ids = plan.questions.map((q) => q.id)
      expect(new Set(ids).size).toBe(ids.length)
    }
  })

  it('an empty objective bank yields only the subjective slot', () => {
    const plan = buildPlan({
      objective: [],
      subjective: subjectiveQuestions,
      records: new Map(),
      now: 10 * DAY,
      size: 20,
      rng: mulberry32(7),
    })
    expect(objOf(plan.questions)).toHaveLength(0)
    expect(plan.shortfall).toBe(20)
    expect(plan.deferredDue).toBe(0)
  })

  it('a legacy record with attempts=0 is never treated as due', () => {
    // Older builds could leave a row with attempts=0 and a past nextReviewAt.
    // Such a question has never been answered, so it belongs to the fresh pool.
    const now = 10 * DAY
    const records = new Map<string, QRecord>()
    const n = Math.min(5, objectiveQuestions.length)
    objectiveQuestions.slice(0, n).forEach((q) => {
      records.set(q.id, { ...freshRecord(q.id, now), attempts: 0, nextReviewAt: now - DAY })
    })
    const plan = buildPlan({
      objective: objectiveQuestions,
      subjective: subjectiveQuestions,
      records,
      now,
      size: 10,
      rng: mulberry32(7),
    })
    expect(plan.pools.due).toBe(0)
    expect(plan.pools.wrong).toBe(0)
    expect(plan.pools.fresh).toBe(objectiveQuestions.length)
  })

  it('same-day detection uses the local calendar day, not a rolling 24h', () => {
    // 23:59 yesterday vs 00:01 today must be treated as different days.
    const yesterday2359 = new Date()
    yesterday2359.setDate(yesterday2359.getDate() - 1)
    yesterday2359.setHours(23, 59, 0, 0)
    const today0001 = new Date()
    today0001.setHours(0, 1, 0, 0)
    const now = today0001.getTime() > Date.now() ? Date.now() : today0001.getTime()

    const records = new Map<string, QRecord>()
    const n = Math.min(2, objectiveQuestions.length)
    objectiveQuestions.slice(0, n).forEach((q) => {
      records.set(q.id, {
        ...freshRecord(q.id, now),
        attempts: 4,
        correctCount: 3,
        wrongCount: 1,
        lastSeenAt: yesterday2359.getTime(),
        nextReviewAt: now - DAY,
      })
    })
    const trained = new Set(objectiveQuestions.slice(0, n).map((q) => q.id))
    // size equals the pool so quota arithmetic cannot truncate the set.
    const plan = buildPlan({
      objective: objectiveQuestions,
      subjective: [],
      records,
      now,
      size: Math.max(n, 2),
      rng: mulberry32(7),
    })
    const servedTrained = objOf(plan.questions).filter((q) => trained.has(q.id)).length
    // Trained on a different local day: eligible for today, not deprioritised.
    expect(servedTrained).toBeGreaterThan(0)
  })

  it('mixing subjective and objective attempts keeps both sets of counters', () => {
    let r = freshRecord('mix', 0)
    r = applyAttempt(r, true, 0)
    r = applyAttempt(r, false, DAY)
    const before = { c: r.correctCount, w: r.wrongCount, a: r.attempts }
    r = applySubjectiveAttempt(r, 2 * DAY)
    expect(r.correctCount).toBe(before.c)
    expect(r.wrongCount).toBe(before.w)
    expect(r.attempts).toBe(before.a + 1)
    // And the objective path resumes on the objective curve, not the subjective cap.
    r = applyAttempt(r, true, 3 * DAY)
    expect(r.correctCount).toBe(before.c + 1)
  })
})

describe('plan / scale', () => {
  const withFullBank = () => {
    // Uses whatever bank is installed: the public sample bank in CI, the
    // licensed full bank locally. Assertions below are size-relative.
    const now = 10 * DAY
    return { objective: objectiveQuestions, subjective: subjectiveQuestions, records: new Map<string, QRecord>(), now }
  }

  it('T8: the plan is built from the installed bank without error', () => {
    const s = withFullBank()
    const plan = buildPlan({ ...s, size: 20, rng: mulberry32(7) })
    expect(objOf(plan.questions).length).toBe(Math.min(20, s.objective.length))
  })

  it('T8: builds quickly enough to run on every render', () => {
    const s = withFullBank()
    const t0 = Date.now()
    for (let i = 0; i < 5; i++) buildPlan({ ...s, size: 50, rng: mulberry32(i) })
    expect(Date.now() - t0).toBeLessThan(2000)
  })
})

describe('plan / determinism', () => {
  it('the same inputs and seed produce the same plan', () => {
    const mk = () => {
      const now = 10 * DAY
      const records = new Map<string, QRecord>()
      mark(
        records,
        objectiveQuestions.slice(0, 40),
        (_, i) => ({
          attempts: 4,
          correctCount: 3,
          wrongCount: 1,
          lastSeenAt: now - DAY,
          nextReviewAt: i < 10 ? now - DAY : now + 5 * DAY,
        }),
        now,
      )
      return { objective: objectiveQuestions, subjective: subjectiveQuestions, records, now, size: 20 }
    }
    const a = buildPlan({ ...mk(), rng: mulberry32(7) })
    const b = buildPlan({ ...mk(), rng: mulberry32(7) })
    expect(a.questions.map((q) => q.id)).toEqual(b.questions.map((q) => q.id))
  })

  it('T6: a second plan on the same day serves questions not yet trained today', () => {
    // Needs at least 20 overdue questions so half can be already-trained-today
    // and the other half is still available to rotate to.
    if (objectiveQuestions.length < 20) return
    const now = 10 * DAY
    const startOfToday = new Date(now)
    startOfToday.setHours(0, 0, 0, 0)
    const earlierToday = startOfToday.getTime() + 3600_000 // 01:00 today
    const records = new Map<string, QRecord>()
    objectiveQuestions.slice(0, 20).forEach((q, i) => {
      records.set(q.id, {
        ...freshRecord(q.id, now),
        status: 'struggling',
        attempts: 5,
        wrongCount: 4,
        correctCount: 1,
        lastSeenAt: i < 10 ? earlierToday : now - 5 * DAY,
        nextReviewAt: now - 60_000,
      })
    })
    const trainedTodayIds = new Set(objectiveQuestions.slice(0, 10).map((q) => q.id))
    const args = { objective: objectiveQuestions, subjective: [], records, now, size: 10 }
    const plan = buildPlan({ ...args, rng: mulberry32(7) })
    const picks = objOf(plan.questions)
    expect(picks).toHaveLength(10)
    // None of the questions already trained today are re-served.
    expect(picks.filter((q) => trainedTodayIds.has(q.id))).toHaveLength(0)
  })

  it('T6: when every due question was already trained today the plan still fills up', () => {
    // Honest fallback: nothing left to rotate to, so the plan repeats rather
    // than shrinking to nothing.
    const now = 10 * DAY
    const startOfToday = new Date(now)
    startOfToday.setHours(0, 0, 0, 0)
    const records = new Map<string, QRecord>()
    const dueCount = Math.min(10, objectiveQuestions.length)
    objectiveQuestions.slice(0, dueCount).forEach((q) => {
      records.set(q.id, {
        ...freshRecord(q.id, now),
        status: 'struggling',
        attempts: 5,
        wrongCount: 4,
        correctCount: 1,
        lastSeenAt: startOfToday.getTime() + 3600_000,
        nextReviewAt: now - 60_000,
      })
    })
    const size = 10
    const plan = buildPlan({
      objective: objectiveQuestions,
      subjective: [],
      records,
      now,
      size,
      rng: mulberry32(7),
    })
    // The plan is as long as the bank allows; it never shrinks to nothing.
    expect(objOf(plan.questions)).toHaveLength(Math.min(size, objectiveQuestions.length))
  })

  it('reports whether the demo or the full bank is in use', () => {
    expect(typeof usingSampleBank).toBe('boolean')
  })
})
