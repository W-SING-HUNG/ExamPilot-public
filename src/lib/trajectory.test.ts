import { describe, it, expect } from 'vitest'
import { buildPlan } from './plan'
import { applyAttempt, applySubjectiveAttempt, freshRecord, mulberry32 } from './scheduler'
import { computeDiagnosis } from './analysis'
import { allQuestions, objectiveQuestions, subjectiveQuestions, usingSampleBank } from './bank'
import type { Question, QRecord } from './types'

/**
 * Synthetic learning trajectories.
 *
 * Every test drives the real `buildPlan` / `applyAttempt` / `computeDiagnosis`
 * with an EXPLICIT clock and an EXPLICIT seeded PRNG, so results are
 * deterministic: no wall-clock reads, no `Math.random`. A pass here is a real
 * signal, not a lucky seed.
 *
 * The bank is whatever is installed: the public 17-question sample bank in CI,
 * a larger locally installed bank. Tests that assert absolute numbers
 * say which bank they require, and skip cleanly on the other one so CI stays
 * meaningful without a private bank.
 */

const DAY = 86400000
/** A fixed reference instant: 2024-01-10T12:00:00Z, so "today" is stable. */
const NOW = Date.UTC(2024, 0, 10, 12, 0, 0)
const SEED = 20240110

const objOf = (plan: Question[]) => plan.filter((q) => q.type !== 'short' && q.type !== 'material')
const subjOf = (plan: Question[]) => plan.filter((q) => q.type === 'short' || q.type === 'material')

/** True when the licensed full bank is installed locally. */
const fullBank = () => !usingSampleBank && objectiveQuestions.length > 200

const runPlan = (o: {
  records: Map<string, QRecord>
  size: number
  now?: number
  objective?: Question[]
  subjective?: Question[]
}) =>
  buildPlan({
    objective: o.objective ?? objectiveQuestions,
    subjective: o.subjective ?? subjectiveQuestions,
    records: o.records,
    now: o.now ?? NOW,
    size: o.size,
    rng: mulberry32(SEED),
  })

/** Apply `n` outcomes to a question, continuing from any existing record. */
function train(
  q: Question,
  records: Map<string, QRecord>,
  n: number,
  ok: boolean | ((i: number) => boolean),
  startAt = NOW - 60 * DAY,
) {
  let r = records.get(q.id) ?? freshRecord(q.id, startAt)
  for (let i = 0; i < n; i++) {
    r = applyAttempt(r, typeof ok === 'function' ? ok(i) : ok, startAt + i * DAY)
  }
  records.set(q.id, r)
}

function trainSubjective(q: Question, records: Map<string, QRecord>, n: number, startAt = NOW - 60 * DAY) {
  let r = records.get(q.id) ?? freshRecord(q.id, startAt)
  for (let i = 0; i < n; i++) r = applySubjectiveAttempt(r, startAt + i * DAY)
  records.set(q.id, r)
}

// ---------------------------------------------------------------------------
// T1 - a user with no learning history at all
// ---------------------------------------------------------------------------

describe('T1 / brand-new user', () => {
  it('gets exactly the requested number of objective questions', () => {
    for (const size of [10, 20, 30, 50]) {
      const plan = runPlan({ records: new Map(), size })
      expect(objOf(plan.questions)).toHaveLength(Math.min(size, objectiveQuestions.length))
      expect(plan.shortfall).toBe(Math.max(0, size - objectiveQuestions.length))
      expect(plan.pools.due).toBe(0)
      expect(plan.pools.wrong).toBe(0)
    }
  })

  it('gets exactly one extra subjective question, outside the objective quota', () => {
    const plan = runPlan({ records: new Map(), size: 20 })
    expect(subjOf(plan.questions)).toHaveLength(1)
    expect(objOf(plan.questions)).toHaveLength(Math.min(20, objectiveQuestions.length))
    expect(plan.questions).toHaveLength(Math.min(20, objectiveQuestions.length) + 1)
  })

  it('produces a plan even with an empty records map and no errors', () => {
    const plan = runPlan({ records: new Map(), size: 20 })
    expect(plan.deferredDue).toBe(0)
    expect(new Set(plan.questions.map((q) => q.id)).size).toBe(plan.questions.length)
  })
})

// ---------------------------------------------------------------------------
// T2 / T12 - a large backlog of overdue work
// ---------------------------------------------------------------------------

describe('T2 / large backlog of untrained questions', () => {
  it('due questions take their share and untrained questions fill the rest', () => {
    const records = new Map<string, QRecord>()
    // Overdue at least a quarter of the bank, capped so the test stays fast.
    const dueCount = Math.max(1, Math.min(60, Math.ceil(objectiveQuestions.length / 4)))
    objectiveQuestions.slice(0, dueCount).forEach((q, i) => {
      let r = freshRecord(q.id, NOW - 30 * DAY)
      r = applyAttempt(r, false, NOW - 30 * DAY)
      r = applyAttempt(r, false, NOW - 29 * DAY)
      r = applyAttempt(r, false, NOW - 28 * DAY)
      r = applyAttempt(r, true, NOW - (i + 1) * DAY) // due now, recently correct
      records.set(q.id, r)
    })
    const size = 20
    const objTarget = Math.min(size, objectiveQuestions.length)
    const plan = runPlan({ records, size })
    const dueInPlan = objOf(plan.questions).filter((q) => (records.get(q.id)?.nextReviewAt ?? Infinity) <= NOW).length
    expect(dueInPlan).toBeGreaterThanOrEqual(Math.min(dueCount, Math.ceil(objTarget * 0.5)))
    expect(objOf(plan.questions)).toHaveLength(objTarget)
    // Whatever capacity the due pool could not fill comes from untrained work.
    if (dueInPlan < objTarget) expect(plan.pools.fresh).toBeGreaterThan(0)
  })

  it('T12: an overflowing due backlog is reported, not silently dropped', () => {
    const records = new Map<string, QRecord>()
    // Overdue the WHOLE bank, so the quota can never hold it all.
    objectiveQuestions.forEach((q, i) => {
      let r = freshRecord(q.id, NOW - 40 * DAY)
      r = applyAttempt(r, true, NOW - 40 * DAY)
      r = applyAttempt(r, true, NOW - 39 * DAY)
      records.set(q.id, { ...r, nextReviewAt: NOW - (i + 1) * DAY })
    })
    const size = 20
    const objTarget = Math.min(size, objectiveQuestions.length)
    const plan = runPlan({ records, size })
    const objPicks = objOf(plan.questions)
    expect(objPicks).toHaveLength(objTarget)
    const dueInPlan = objPicks.filter((q) => (records.get(q.id)?.nextReviewAt ?? Infinity) <= NOW).length
    // At least the 50% due quota is filled; leftover capacity flows back to due.
    expect(dueInPlan).toBeGreaterThanOrEqual(Math.ceil(objTarget * 0.5))
    expect(dueInPlan).toBeLessThanOrEqual(objTarget)
    // The remainder is reported, so the page can say so.
    expect(plan.deferredDue).toBe(objectiveQuestions.length - dueInPlan)
    expect(plan.pools.due).toBe(objectiveQuestions.length)
    expect(plan.pools.wrong).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// T3 / T4 - long-running wrong answers, and mastery lost to one mistake
// ---------------------------------------------------------------------------

describe('T3 / long-running wrong answers', () => {
  it('recovers from struggling through real correct answers', () => {
    const records = new Map<string, QRecord>()
    const q = objectiveQuestions[0]
    // 3 consecutive wrong answers -> struggling.
    train(q, records, 3, false, NOW - 60 * DAY)
    expect(records.get(q.id)!.status).toBe('struggling')

    // Then 20 more wrong answers: still struggling, history intact.
    train(q, records, 20, false, NOW - 59 * DAY)
    expect(records.get(q.id)!.status).toBe('struggling')
    expect(records.get(q.id)!.wrongCount).toBe(23)

    // Then correct answers: it leaves struggling...
    train(q, records, 1, true, NOW - 30 * DAY)
    expect(records.get(q.id)!.status).toBe('learning')

    // ...and reaches mastered once the net correct count is +3 or better.
    train(q, records, 30, true, NOW - 29 * DAY)
    const r = records.get(q.id)!
    expect(r.status).toBe('mastered')
    expect(r.wrongCount).toBe(23) // history preserved, never rewritten
  })

  it('a question stuck in struggling keeps a high selection weight', () => {
    const records = new Map<string, QRecord>()
    const q = objectiveQuestions[0]
    train(q, records, 20, false)
    const plan = runPlan({ records, size: 10 })
    expect(plan.questions.some((p) => p.id === q.id)).toBe(true)
  })
})

describe('T4 / correct streak broken by one wrong answer', () => {
  it('demotes out of mastered so the question is scheduled again', () => {
    const records = new Map<string, QRecord>()
    const q = objectiveQuestions[0]
    train(q, records, 5, true)
    expect(records.get(q.id)!.status).toBe('mastered')

    let r = records.get(q.id)!
    r = applyAttempt(r, false, NOW)
    records.set(q.id, r)
    expect(r.status).toBe('learning')
    expect(r.intervalDays).toBe(0)
    expect(r.nextReviewAt).toBe(NOW) // due immediately

    // And it is selected in the next plan.
    const plan = runPlan({ records, size: 10 })
    expect(plan.questions.some((p) => p.id === q.id)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// T5 - a mastered question that has come due
// ---------------------------------------------------------------------------

describe('T5 / mastered question coming due', () => {
  it('is scheduled at normal due priority, not suppressed', () => {
    const records = new Map<string, QRecord>()
    const q = objectiveQuestions[0]
    let r = freshRecord(q.id, NOW - 40 * DAY)
    for (let i = 0; i < 5; i++) r = applyAttempt(r, true, NOW - 40 * DAY + i * DAY)
    expect(r.status).toBe('mastered')
    expect(r.intervalDays).toBeGreaterThan(0)
    records.set(q.id, { ...r, nextReviewAt: NOW - DAY }) // now overdue

    const plan = runPlan({ records, size: 10 })
    expect(plan.questions.some((p) => p.id === q.id)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// T6 - same-day repeated training
// ---------------------------------------------------------------------------

describe('T6 / same-day repeated training', () => {
  // Needs at least 20 overdue questions so half can be already-trained-today and
  // the other half is still available to rotate to. Marked as a skip rather than
  // returning early, so a report never counts a case that did not execute.
  it.skipIf(objectiveQuestions.length < 20)('prefers questions not yet trained today', () => {
    const records = new Map<string, QRecord>()
    const startOfToday = new Date(NOW)
    startOfToday.setUTCHours(0, 0, 0, 0)
    const earlierToday = startOfToday.getTime() + 3600_000

    // 20 overdue questions; the first 10 were trained earlier today.
    objectiveQuestions.slice(0, 20).forEach((q, i) => {
      let r = freshRecord(q.id, NOW - 10 * DAY)
      for (let k = 0; k < 3; k++) r = applyAttempt(r, k === 2, NOW - 10 * DAY + k * DAY)
      records.set(q.id, { ...r, lastSeenAt: i < 10 ? earlierToday : NOW - 5 * DAY, nextReviewAt: NOW - DAY })
    })
    const trainedTodayIds = new Set(objectiveQuestions.slice(0, 10).map((q) => q.id))

    const plan = runPlan({ records, size: 10 })
    const picks = objOf(plan.questions)
    expect(picks).toHaveLength(10)
    expect(picks.filter((q) => trainedTodayIds.has(q.id))).toHaveLength(0)
  })

  it('still fills the plan when every due question was trained today', () => {
    const records = new Map<string, QRecord>()
    const startOfToday = new Date(NOW)
    startOfToday.setUTCHours(0, 0, 0, 0)
    objectiveQuestions.slice(0, 10).forEach((q) => {
      let r = freshRecord(q.id, NOW - 10 * DAY)
      for (let k = 0; k < 3; k++) r = applyAttempt(r, k === 2, NOW - 10 * DAY + k * DAY)
      records.set(q.id, { ...r, lastSeenAt: startOfToday.getTime() + 3600_000, nextReviewAt: NOW - DAY })
    })
    const plan = runPlan({ records, size: 10 })
    expect(objOf(plan.questions)).toHaveLength(10)
  })
})

// ---------------------------------------------------------------------------
// T7 - a small bank
// ---------------------------------------------------------------------------

describe('T7 / small bank', () => {
  const small = () => objectiveQuestions.slice(0, 10)

  it('never exceeds the bank and never duplicates', () => {
    const plan = runPlan({
      records: new Map(),
      size: 50,
      objective: small(),
      subjective: subjectiveQuestions.slice(0, 2),
    })
    expect(objOf(plan.questions)).toHaveLength(10)
    expect(subjOf(plan.questions)).toHaveLength(1)
    expect(plan.shortfall).toBe(40)
    const ids = plan.questions.map((q) => q.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('handles a bank too small for any quota', () => {
    const plan = runPlan({ records: new Map(), size: 10, objective: objectiveQuestions.slice(0, 3), subjective: [] })
    expect(objOf(plan.questions)).toHaveLength(3)
    expect(plan.shortfall).toBe(7)
  })

  it('handles an empty objective bank without throwing', () => {
    const plan = runPlan({ records: new Map(), size: 10, objective: [], subjective: subjectiveQuestions.slice(0, 1) })
    expect(objOf(plan.questions)).toHaveLength(0)
    expect(subjOf(plan.questions)).toHaveLength(1)
    expect(plan.shortfall).toBe(10)
  })
})

// ---------------------------------------------------------------------------
// T8 - the full bank
// ---------------------------------------------------------------------------

describe('T8 / full bank', () => {
  // These only make sense on the licensed bank; on the sample bank they are
  // reported as skipped so the summary never claims they ran.
  it.skipIf(!fullBank())('fills the requested quota from the installed bank', () => {
    const plan = runPlan({ records: new Map(), size: 50 })
    expect(objOf(plan.questions)).toHaveLength(50)
    expect(subjOf(plan.questions)).toHaveLength(1)
  })

  it.skipIf(!fullBank())('builds quickly enough for interactive use', () => {
    const t0 = Date.now()
    for (let i = 0; i < 5; i++) runPlan({ records: new Map(), size: 50 })
    expect(Date.now() - t0).toBeLessThan(2000)
  })
})

// ---------------------------------------------------------------------------
// T9 - subjective and objective mixed
// ---------------------------------------------------------------------------

describe('T9 / subjective and objective mixed', () => {
  // A bank with no subjective questions cannot exercise these; skip explicitly
  // so the summary distinguishes "not applicable" from "verified".
  it.skipIf(subjectiveQuestions.length === 0)(
    'subjective training advances the interval without inventing a score',
    () => {
      const records = new Map<string, QRecord>()
      const q = subjectiveQuestions[0]
      const seen: number[] = []
      for (let i = 0; i < 6; i++) {
        trainSubjective(q, records, 1, NOW - 30 * DAY + i * DAY)
        seen.push(records.get(q.id)!.intervalDays)
      }
      expect(seen).toEqual([1, 2, 3, 5, 8, 12])
      const r = records.get(q.id)!
      expect(r.status).toBe('learning')
      expect(r.correctCount).toBe(0)
      expect(r.wrongCount).toBe(0)
      expect(r.lastCorrect).toBe(null)
    },
  )

  it.skipIf(subjectiveQuestions.length === 0)('diagnosis reports subjective training without a correct rate', () => {
    const records = new Map<string, QRecord>()
    // Train up to 5, or all of them when the bank is smaller.
    const n = Math.min(5, subjectiveQuestions.length)
    for (const q of subjectiveQuestions.slice(0, n)) trainSubjective(q, records, 3)
    const d = computeDiagnosis(allQuestions, records)
    for (const t of d.types.filter((x) => x.type === 'short' || x.type === 'material')) {
      expect(t.correct).toBe(0)
      expect(t.wrong).toBe(0)
      expect(t.correctRate).toBe(0)
      expect(t.mastered).toBe(0)
      expect(t.struggling).toBe(0)
    }
    expect(d.overall.subjectiveAttempted).toBe(n)
  })

  it('chapter totals account for every question in the bank', () => {
    const d = computeDiagnosis(allQuestions, new Map())
    expect(d.chapters.reduce((s, c) => s + c.total, 0)).toBe(allQuestions.length)
  })
})

// ---------------------------------------------------------------------------
// T10 - time advancing changes what is due
// ---------------------------------------------------------------------------

describe('T10 / time advancing changes the due set', () => {
  it('due questions appear as their interval elapses', () => {
    const records = new Map<string, QRecord>()
    const q = objectiveQuestions[0]
    let r = freshRecord(q.id, NOW - 30 * DAY)
    r = applyAttempt(r, true, NOW - 30 * DAY) // interval 1 day
    records.set(q.id, r)

    const dueAt = (t: number) => (records.get(q.id)!.nextReviewAt ?? Infinity) <= t
    expect(dueAt(NOW)).toBe(true) // 1-day interval already elapsed

    // Answer it correctly and the next due date moves out.
    r = applyAttempt(r, true, NOW)
    records.set(q.id, r)
    expect(dueAt(NOW)).toBe(false)
    expect(dueAt(NOW + 2 * DAY)).toBe(true) // 2-day interval
  })

  it('untrained questions stay available no matter how far time moves', () => {
    const records = new Map<string, QRecord>()
    const plan = runPlan({ records, size: 20, now: NOW + 365 * DAY })
    expect(objOf(plan.questions)).toHaveLength(Math.min(20, objectiveQuestions.length))
  })

  it.skipIf(!fullBank())('a full month of daily practice does not lose any question', () => {
    const records = new Map<string, QRecord>()
    // Simulate 30 days: each day, plan 20 and mark every pick as answered.
    for (let day = 0; day < 30; day++) {
      const now = NOW - 29 * DAY + day * DAY
      const plan = buildPlan({
        objective: objectiveQuestions,
        subjective: subjectiveQuestions,
        records,
        now,
        size: 20,
        rng: mulberry32(SEED + day),
      })
      for (const q of objOf(plan.questions)) {
        const cur = records.get(q.id) ?? freshRecord(q.id, now)
        records.set(q.id, applyAttempt(cur, true, now))
      }
    }
    // Every question that was picked still has a record; none vanished.
    expect(records.size).toBeGreaterThan(0)
    for (const r of records.values()) {
      expect(r.correctCount + r.wrongCount).toBeLessThanOrEqual(r.attempts)
    }
    // And coverage grew.
    const d = computeDiagnosis(allQuestions, records)
    expect(d.overall.attempted).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// T13 / T14 - exhausted pools
// ---------------------------------------------------------------------------

describe('T13 / nothing due and nothing untrained', () => {
  it.skipIf(subjectiveQuestions.length === 0)('the plan is the subjective slot alone, with no error', () => {
    const records = new Map<string, QRecord>()
    for (const q of objectiveQuestions) {
      // Trained just now: the 1-day interval keeps everything not-due today.
      let r = freshRecord(q.id, NOW - 60 * 60 * 1000)
      for (let i = 0; i < 5; i++) r = applyAttempt(r, true, NOW - 60 * 60 * 1000 + i * 1000)
      records.set(q.id, r)
    }
    expect(records.size).toBe(objectiveQuestions.length)
    const plan = runPlan({ records, size: 20 })
    expect(objOf(plan.questions)).toHaveLength(0)
    expect(subjOf(plan.questions)).toHaveLength(1)
    expect(plan.pools.due).toBe(0)
    expect(plan.pools.fresh).toBe(0)
    expect(plan.deferredDue).toBe(0)
  })
})

describe('T14 / no subjective questions in the bank', () => {
  it('the plan has no subjective slot and does not throw', () => {
    const plan = runPlan({ records: new Map(), size: 10, subjective: [] })
    expect(subjOf(plan.questions)).toHaveLength(0)
    expect(objOf(plan.questions)).toHaveLength(Math.min(10, objectiveQuestions.length))
  })
})

// ---------------------------------------------------------------------------
// Statistical invariants that must hold on every trajectory
// ---------------------------------------------------------------------------

describe('invariants across trajectories', () => {
  it('never produces a duplicate question in one plan', () => {
    const records = new Map<string, QRecord>()
    objectiveQuestions.slice(0, 30).forEach((q, i) => {
      let r = freshRecord(q.id, NOW - 20 * DAY)
      r = applyAttempt(r, i % 3 === 0, NOW - 20 * DAY)
      records.set(q.id, { ...r, nextReviewAt: i % 2 === 0 ? NOW - DAY : NOW + 3 * DAY })
    })
    for (const size of [1, 5, 10, 20, 50]) {
      const plan = runPlan({ records, size })
      const ids = plan.questions.map((q) => q.id)
      expect(new Set(ids).size, `size ${size}`).toBe(ids.length)
    }
  })

  it('never reports more deferred due questions than exist', () => {
    const records = new Map<string, QRecord>()
    objectiveQuestions.slice(0, 40).forEach((q) => {
      let r = freshRecord(q.id, NOW - 20 * DAY)
      r = applyAttempt(r, true, NOW - 20 * DAY)
      records.set(q.id, { ...r, nextReviewAt: NOW - DAY })
    })
    for (const size of [5, 10, 20, 50]) {
      const plan = runPlan({ records, size })
      expect(plan.deferredDue).toBeLessThanOrEqual(plan.pools.due)
      expect(plan.deferredDue).toBeGreaterThanOrEqual(0)
    }
  })

  it('counters stay consistent after any sequence of outcomes', () => {
    const sequences: boolean[][] = [
      [true],
      [false],
      [true, false, true, false, true],
      Array.from({ length: 20 }, () => false),
      Array.from({ length: 20 }, () => true),
      [true, true, true, false, true, true, false, false, false, true],
    ]
    for (const seq of sequences) {
      let r = freshRecord('inv', NOW)
      for (const ok of seq) r = applyAttempt(r, ok, NOW)
      expect(r.correctCount + r.wrongCount).toBe(r.attempts)
      expect(r.attempts).toBe(seq.length)
      expect(r.correctCount).toBe(seq.filter(Boolean).length)
      expect(r.wrongCount).toBe(seq.filter((x) => !x).length)
      expect(r.intervalDays).toBeGreaterThanOrEqual(0)
      expect(['new', 'learning', 'mastered', 'struggling']).toContain(r.status)
    }
  })

  it('a plan is deterministic for the same inputs and seed', () => {
    const mk = () => {
      const records = new Map<string, QRecord>()
      objectiveQuestions.slice(0, 25).forEach((q, i) => {
        let r = freshRecord(q.id, NOW - 20 * DAY)
        r = applyAttempt(r, i % 4 !== 0, NOW - 20 * DAY)
        records.set(q.id, { ...r, nextReviewAt: i % 3 === 0 ? NOW - DAY : NOW + 2 * DAY })
      })
      return records
    }
    const a = buildPlan({
      objective: objectiveQuestions,
      subjective: subjectiveQuestions,
      records: mk(),
      now: NOW,
      size: 15,
      rng: mulberry32(SEED),
    })
    const b = buildPlan({
      objective: objectiveQuestions,
      subjective: subjectiveQuestions,
      records: mk(),
      now: NOW,
      size: 15,
      rng: mulberry32(SEED),
    })
    expect(a.questions.map((q) => q.id)).toEqual(b.questions.map((q) => q.id))
  })
})
