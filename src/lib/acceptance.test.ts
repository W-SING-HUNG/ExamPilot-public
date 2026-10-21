import { describe, it, expect } from 'vitest'
import { buildPlan } from './plan'
import { applyAttempt, applySubjectiveAttempt, freshRecord, mulberry32, selectQuestions } from './scheduler'
import { computeDiagnosis } from './analysis'
import { allQuestions, objectiveQuestions, subjectiveQuestions } from './bank'
import type { Question, QRecord } from './types'

/**
 * Phase-2 acceptance metrics, measured and asserted rather than reported.
 *
 * The task requires a before/after comparison on selection coverage, due-task
 * hit rate, repeat rate, statistical consistency and boundary behaviour.
 *
 * The "before" column is `planBefore` below: the main `2e65a6b` plan builder
 * reproduced with its OWN weight table and weighted-sampling selector (see the
 * block comment on `baselineWeight`), driven by the same seeded PRNG as the
 * "after" column. It is the baseline algorithm, not a stand-in for it.
 *
 * The "after" column is this branch. Both run against the same installed bank,
 * so the comparison is apples to apples. Every assertion is expressed relative
 * to the bank size and therefore holds on both the public sample bank and a
 * larger locally installed bank.
 */

const DAY = 86400000
/** A fixed reference instant so "today" is stable across runs. */
const NOW = Date.UTC(2024, 0, 10, 12, 0, 0)
const SEED = 20240110

const objOf = (plan: Question[]) => plan.filter((q) => q.type !== 'short' && q.type !== 'material')
const dueCountOf = (records: Map<string, QRecord>, plan: Question[], now: number) =>
  objOf(plan).filter((q) => {
    const r = records.get(q.id)
    return !!r && r.attempts > 0 && r.nextReviewAt <= now
  }).length

/** The plan builder as it behaves on this branch. */
function planAfter(records: Map<string, QRecord>, size: number) {
  return buildPlan({
    objective: objectiveQuestions,
    subjective: subjectiveQuestions,
    records,
    now: NOW,
    size,
    rng: mulberry32(SEED),
  })
}

/**
 * The BASELINE plan builder, reproduced faithfully from main `2e65a6b`.
 *
 * Source of truth: `git show 2e65a6b:src/lib/plan.ts` (Plan.tsx `buildPlan`) and
 * `git show 2e65a6b:src/lib/scheduler.ts` (`selectQuestions`). Both the quota
 * arithmetic AND the weighted-sampling selector are reproduced, including the
 * old weight table and the old hard cut-off — a `slice(0, n)` stand-in would not
 * be the same algorithm and would make the comparison meaningless.
 *
 * Differences from this branch, deliberately preserved here:
 *  - due quota 30% / wrong 40% / fresh `max(4, round(size*0.5))`
 *  - the old weight table (untouched reaches 16.4 and outranks overdue work)
 *  - `weight > 0.05` hard cut-off (could yield an empty session)
 *  - no same-day de-duplication at all
 *  - `Math.random` for the subjective slot (omitted: irrelevant to these metrics)
 */
const BASELINE_WEIGHT = {
  dueBonus: 6,
  wrongBoost: 4,
  learningBonus: 2,
  newBoost: 1.2,
  masteredMultiplier: 0.15,
  recentMultiplier: 0.3,
  untouchedMultiplier: 2,
}

/** Baseline `questionWeight`: the internal `weight()` closure of `selectQuestions`. */
function baselineWeight(rec: QRecord, now: number): number {
  let w = 1
  if (rec.nextReviewAt <= now) w += BASELINE_WEIGHT.dueBonus
  if (rec.status === 'struggling' || rec.wrongCount >= 2) w += BASELINE_WEIGHT.wrongBoost
  else if (rec.status === 'learning') w += BASELINE_WEIGHT.learningBonus
  if (rec.status === 'new') w += BASELINE_WEIGHT.newBoost
  if (rec.status === 'mastered') w *= BASELINE_WEIGHT.masteredMultiplier
  if (rec.lastSeenAt > 0 && now - rec.lastSeenAt < 60_000) w *= BASELINE_WEIGHT.recentMultiplier
  if (rec.attempts === 0) w *= BASELINE_WEIGHT.untouchedMultiplier
  return w
}

/** Baseline `selectQuestions`, verbatim in behaviour including the 0.05 cut-off. */
function baselineSelect(
  pool: Question[],
  records: Map<string, QRecord>,
  now: number,
  count: number,
  rng: () => number,
) {
  if (count <= 0 || pool.length === 0) return []
  const weight = (q: Question) => baselineWeight(records.get(q.id) ?? freshRecord(q.id, now), now)
  const result: Question[] = []
  const chosen = new Set<string>()
  let guard = 0
  while (result.length < count && guard < 10000) {
    guard++
    const candidates = pool.filter((q) => !chosen.has(q.id) && weight(q) > 0.05)
    if (candidates.length === 0) break
    const total = candidates.reduce((s, q) => s + weight(q), 1e-9)
    let r = rng() * total
    let picked: Question | null = null
    for (const q of candidates) {
      r -= weight(q)
      if (r <= 0) {
        picked = q
        break
      }
    }
    if (!picked) picked = candidates[candidates.length - 1]
    result.push(picked)
    chosen.add(picked.id)
  }
  return result
}

/**
 * Baseline `buildPlan`. Uses the SAME seeded PRNG as `planAfter` so the two are
 * compared on identical random draws.
 */
function planBefore(records: Map<string, QRecord>, size: number) {
  const now = NOW
  const rng = mulberry32(SEED)
  const due: Question[] = []
  const wrong: Question[] = []
  const fresh: Question[] = []
  for (const q of objectiveQuestions) {
    const r = records.get(q.id)
    if (!r || r.attempts === 0) fresh.push(q)
    else if (r.nextReviewAt <= now) due.push(q)
    else if (r.wrongCount > 0) wrong.push(q)
  }
  const picks: Question[] = []
  const seen = new Set<string>()
  const push = (list: Question[]) => {
    for (const q of list) {
      if (!seen.has(q.id)) {
        seen.add(q.id)
        picks.push(q)
      }
    }
  }
  push(baselineSelect(due, records, now, Math.max(3, Math.round(size * 0.3)), rng))
  push(baselineSelect(wrong, records, now, Math.max(3, Math.round(size * 0.4)), rng))
  push(baselineSelect(fresh, records, now, Math.max(4, Math.round(size * 0.5)), rng))
  return picks.slice(0, size)
}

describe('phase-2 acceptance metrics', () => {
  const bank = objectiveQuestions.length

  // -- M1: a brand-new user no longer loses half the requested quota --------

  it('M1: a new user gets the full requested objective quota (was ~50%)', () => {
    for (const size of [10, 20, 30, 50]) {
      const target = Math.min(size, bank)
      const after = planAfter(new Map(), size)
      expect(objOf(after.questions)).toHaveLength(target)
      // The old cap lost roughly half the request on any bank that can supply it.
      if (target === size) {
        const before = planBefore(new Map(), size)
        expect(objOf(before).length).toBeLessThan(target)
      }
    }
  })

  // -- M2: due work takes its share and the backlog is drained in order -----

  it('M2: due hit rate is at least 50% of the quota (was 30%)', () => {
    const records = new Map<string, QRecord>()
    const dueCount = Math.max(1, Math.min(60, Math.ceil(bank / 4)))
    objectiveQuestions.slice(0, dueCount).forEach((q, i) => {
      let r = freshRecord(q.id, NOW - 30 * DAY)
      r = applyAttempt(r, true, NOW - 30 * DAY)
      records.set(q.id, { ...r, nextReviewAt: NOW - (i + 1) * DAY })
    })
    const size = 20
    const objTarget = Math.min(size, bank)
    const after = planAfter(records, size)
    const dueHit = dueCountOf(records, after.questions, NOW)
    expect(dueHit).toBeGreaterThanOrEqual(Math.min(dueCount, Math.ceil(objTarget * 0.5)))

    const before = planBefore(records, size)
    const beforeHit = dueCountOf(records, before, NOW)
    // The old 30% due quota hit strictly less work when the pool was large.
    if (dueCount >= Math.ceil(objTarget * 0.3)) {
      expect(beforeHit).toBeLessThanOrEqual(dueHit)
    }
  })

  it('M2b: the due backlog drains oldest-first', () => {
    const records = new Map<string, QRecord>()
    const n = Math.min(12, bank)
    objectiveQuestions.slice(0, n).forEach((q, i) => {
      records.set(q.id, {
        ...freshRecord(q.id, NOW),
        attempts: 4,
        lastSeenAt: NOW - (n - i) * DAY,
        nextReviewAt: NOW - DAY,
      })
    })
    const plan = planAfter(records, Math.max(2, Math.floor(n / 2)))
    const ages = objOf(plan.questions)
      .map((q) => records.get(q.id)?.lastSeenAt)
      .filter((v): v is number => typeof v === 'number')
    expect(ages.length).toBeGreaterThan(0)
    expect(ages).toEqual([...ages].sort((a, b) => a - b))
  })

  it('M2c: an overflowing backlog is reported, not silently dropped', () => {
    const records = new Map<string, QRecord>()
    objectiveQuestions.forEach((q, i) => {
      let r = freshRecord(q.id, NOW - 40 * DAY)
      r = applyAttempt(r, true, NOW - 40 * DAY)
      records.set(q.id, { ...r, nextReviewAt: NOW - (i + 1) * DAY })
    })
    const size = 10
    const objTarget = Math.min(size, bank)
    const plan = planAfter(records, size)
    const dueHit = dueCountOf(records, plan.questions, NOW)
    expect(dueHit).toBeGreaterThanOrEqual(Math.ceil(objTarget * 0.5))
    expect(plan.deferredDue).toBe(bank - dueHit)
    expect(plan.deferredDue).toBeGreaterThan(0)
  })

  // -- M3: same-day repeat rate ---------------------------------------------

  it.skipIf(bank < 20)('M3: a second plan on the same day does not re-serve questions trained today', () => {
    const startOfToday = new Date(NOW)
    startOfToday.setUTCHours(0, 0, 0, 0)
    const earlierToday = startOfToday.getTime() + 3600_000

    const records = new Map<string, QRecord>()
    objectiveQuestions.slice(0, 20).forEach((q, i) => {
      let r = freshRecord(q.id, NOW - 10 * DAY)
      for (let k = 0; k < 3; k++) r = applyAttempt(r, k === 2, NOW - 10 * DAY + k * DAY)
      records.set(q.id, { ...r, lastSeenAt: i < 10 ? earlierToday : NOW - 5 * DAY, nextReviewAt: NOW - DAY })
    })
    const trainedToday = new Set(objectiveQuestions.slice(0, 10).map((q) => q.id))
    const plan = planAfter(records, 10)
    const reServed = objOf(plan.questions).filter((q) => trainedToday.has(q.id)).length
    expect(reServed).toBe(0)
  })

  // -- M4: statistical consistency ------------------------------------------

  it('M4: chapter totals and type totals both account for the whole bank', () => {
    const d = computeDiagnosis(allQuestions, new Map())
    expect(d.chapters.reduce((s, c) => s + c.total, 0)).toBe(allQuestions.length)
    expect(d.types.reduce((s, t) => s + t.total, 0)).toBe(allQuestions.length)
    expect(d.overall.total).toBe(bank)
  })

  it('M4b: an all-wrong chapter outranks untouched chapters', () => {
    const records = new Map<string, QRecord>()
    const ch = objectiveQuestions[0].chapter
    for (const q of objectiveQuestions) {
      if (q.chapter !== ch) continue
      records.set(q.id, applyAttempt(freshRecord(q.id, NOW), false, NOW))
    }
    const d = computeDiagnosis(allQuestions, records)
    const idx = d.weakPoints.findIndex((w) => w.chapter === ch)
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(d.weakPoints[idx].kind).toBe('weak')
    // Its measured rate is really 0, and the score reflects that.
    const stat = d.chapters.find((c) => c.chapter === ch)!
    expect(stat.correctRate).toBe(0)
    expect(d.weakPoints[idx].score).toBe(40)
  })

  it('M4c: subjective training never produces a score or a mastered count', () => {
    const records = new Map<string, QRecord>()
    const n = Math.min(5, subjectiveQuestions.length)
    for (const q of subjectiveQuestions.slice(0, n)) {
      let r = freshRecord(q.id, NOW)
      for (let i = 0; i < 4; i++) r = applySubjectiveAttempt(r, NOW + i * DAY)
      records.set(q.id, r)
    }
    const d = computeDiagnosis(allQuestions, records)
    for (const t of d.types.filter((x) => x.type === 'short' || x.type === 'material')) {
      expect(t.correct).toBe(0)
      expect(t.wrong).toBe(0)
      expect(t.correctRate).toBe(0)
      expect(t.mastered).toBe(0)
    }
    expect(d.overall.subjectiveAttempted).toBe(n)
  })

  // -- M5: status-machine boundaries ----------------------------------------

  it('M5: struggling recovers and mastered demotes', () => {
    const run = (seq: boolean[]) => {
      let r = freshRecord('q', 0)
      seq.forEach((ok, i) => {
        r = applyAttempt(r, ok, i * DAY)
      })
      return r
    }
    // Was: permanently struggling.
    expect(run([false, false, false, true]).status).toBe('learning')
    expect(run([false, false, false, ...Array.from({ length: 30 }, () => true)]).status).toBe('mastered')
    // Was: stayed mastered after a wrong answer.
    expect(run([true, true, true, false]).status).toBe('learning')
  })

  // -- M6: boundary behaviour -----------------------------------------------

  it('M6: a pool of low-weight questions still yields a non-empty session', () => {
    // This is the selector's guarantee (an empty session was the old bug), so
    // it must be asserted against selectQuestions, not buildPlan: a question
    // that is mastered, not due and never wrong legitimately belongs to no plan
    // pool, which is a different (and correct) statement.
    const now0 = Date.now()
    const pool = objectiveQuestions.slice(0, Math.min(20, bank))
    const records = new Map<string, QRecord>()
    for (const q of pool) {
      let r = freshRecord(q.id, now0)
      for (let i = 0; i < 4; i++) r = applyAttempt(r, true, now0 - 1000)
      records.set(q.id, r)
    }
    const picked = selectQuestions({ pool, records, now: now0, count: Math.min(10, pool.length), rng: mulberry32(5) })
    expect(picked.length).toBeGreaterThan(0)
  })

  it('M6z: a plan is empty only when there is genuinely nothing to practice', () => {
    // Mastered, not due, never wrong, and nothing untrained: no pool applies, so
    // the plan is just the subjective slot. That is honest, not an empty-session
    // bug. (With untrained questions left in the bank the fresh pool applies and
    // the plan is legitimately full.)
    const now0 = Date.now()
    const records = new Map<string, QRecord>()
    for (const q of objectiveQuestions) {
      let r = freshRecord(q.id, now0 - 1000)
      for (let i = 0; i < 4; i++) r = applyAttempt(r, true, now0 - 1000)
      records.set(q.id, r)
    }
    const plan = planAfter(records, 10)
    expect(objOf(plan.questions)).toHaveLength(0)
    expect(plan.pools.due).toBe(0)
    expect(plan.pools.wrong).toBe(0)
    expect(plan.pools.fresh).toBe(0)
    expect(plan.deferredDue).toBe(0)
  })

  it('M6b: a non-positive size yields no objective picks and no error', () => {
    for (const size of [0, -5]) {
      const plan = planAfter(new Map(), size)
      expect(objOf(plan.questions)).toHaveLength(0)
    }
  })

  it('M6c: a huge size is capped by the bank and never duplicates', () => {
    const plan = planAfter(new Map(), 100000)
    expect(objOf(plan.questions)).toHaveLength(bank)
    const ids = plan.questions.map((q) => q.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
