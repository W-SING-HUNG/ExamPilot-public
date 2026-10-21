import type { Question, QRecord } from './types'
import { selectQuestions, mulberry32, isDue as isRecordDue } from './scheduler'

/** Extra subjective questions appended to a plan, on top of the objective quota. */
export const SUBJECTIVE_SLOTS = 1

/** Share of the objective quota reserved for questions that are due now. */
const DUE_SHARE = 0.5
/** Share of the objective quota reserved for questions answered wrong before. */
const WRONG_SHARE = 0.25

export interface PlanInput {
  /** Questions the plan may draw objective picks from. */
  objective: Question[]
  /** Questions the plan may draw the subjective slot from. */
  subjective: Question[]
  records: Map<string, QRecord>
  now: number
  /** Objective questions requested by the user. */
  size: number
  /** Deterministic source; production passes a seeded PRNG or Math.random. */
  rng?: () => number
}

export interface PlanResult {
  questions: Question[]
  /** Counts of each pool, for the honest "how much is left" line. */
  pools: { due: number; wrong: number; fresh: number }
  /** Due questions that did not fit today and will be deferred in FIFO order. */
  deferredDue: number
  /** True when the bank could not supply `size` objective questions. */
  shortfall: number
}

/**
 * Split the objective bank into the three pools the plan draws from.
 *
 * The pools are mutually exclusive by construction:
 *  - `due`    — attempted and overdue now (highest priority)
 *  - `wrong`  — attempted, has a wrong answer, but is NOT due
 *  - `fresh`  — never attempted (no record, or a record with 0 attempts)
 *
 * "Due" is delegated to the scheduler's `isDue` so the plan and the selector
 * can never disagree about what counts as overdue.
 */
export function planPools(objective: Question[], records: Map<string, QRecord>, now: number) {
  const due: Question[] = []
  const wrong: Question[] = []
  const fresh: Question[] = []
  for (const q of objective) {
    const r = records.get(q.id)
    if (!r || r.attempts === 0) {
      fresh.push(q)
    } else if (isRecordDue(r, now)) {
      due.push(q)
    } else if (r.wrongCount > 0) {
      wrong.push(q)
    }
  }
  return { due, wrong, fresh }
}

/**
 * Order the due pool oldest-first, so an ever-growing backlog drains in order
 * instead of being re-sampled forever. `qid` is the tie-breaker for questions
 * last seen in the same millisecond, keeping the order deterministic.
 */
export function orderDueOldestFirst(due: Question[], records: Map<string, QRecord>): Question[] {
  return due.slice().sort((a, b) => {
    const ra = records.get(a.id)
    const rb = records.get(b.id)
    const sa = ra?.lastSeenAt ?? 0
    const sb = rb?.lastSeenAt ?? 0
    if (sa !== sb) return sa - sb
    // Overdue longer = due earlier; fall back to nextReviewAt, then qid.
    const na = ra?.nextReviewAt ?? 0
    const nb = rb?.nextReviewAt ?? 0
    if (na !== nb) return na - nb
    return a.id.localeCompare(b.id)
  })
}

/**
 * True when a question was already trained during the same calendar day.
 *
 * Used to avoid serving the identical set twice in one day. The window is the
 * local calendar day, not a rolling 24h, because that is how a user thinks about
 * "today's practice".
 */
function trainedToday(rec: QRecord | undefined, now: number): boolean {
  if (!rec || rec.lastSeenAt <= 0) return false
  const day = (t: number) => {
    const d = new Date(t)
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
  }
  return day(rec.lastSeenAt) === day(now)
}

/**
 * Seed for one calendar day.
 *
 * Used when the caller supplies no PRNG. The plan is then reproducible within a
 * day (regenerating shows the same tasks) but varies from day to day, instead of
 * a fixed constant that would serve the same combination indefinitely.
 */
function daySeed(now: number): number {
  const d = new Date(now)
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate()
}

/** Split a pool into (not trained today, trained today). */
function splitByToday(
  pool: Question[],
  records: Map<string, QRecord>,
  now: number,
): { notToday: Question[]; today: Question[] } {
  const notToday: Question[] = []
  const today: Question[] = []
  for (const q of pool) {
    if (trainedToday(records.get(q.id), now)) today.push(q)
    else notToday.push(q)
  }
  return { notToday, today }
}

/**
 * Build the daily plan.
 *
 * `size` counts OBJECTIVE questions only. The subjective slot is additional and
 * never takes an objective slot, so the user can always tell the two apart.
 *
 * Quotas: 50% due, 25% wrong, remainder fresh. Unused quota flows back
 * wrong -> due -> fresh, so a category that is exhausted never wastes capacity.
 *
 * Same-day protection is applied as a PARTITION, not a reordering: each pool is
 * split into "not trained today" and "trained today", and the quota is filled
 * from the first group before the second. Reordering alone would be defeated by
 * the weighted draw, which ranks candidates by record state rather than by list
 * position. When the first group cannot cover the quota the remainder comes from
 * the second, so a plan is never empty and never silently short.
 *
 * When the bank cannot supply `size` objective questions the plan is as long as
 * the bank allows — it never pads with duplicates and never borrows from the
 * subjective slot.
 */
export function buildPlan(input: PlanInput): PlanResult {
  const { objective, subjective, records, now, size } = input
  // No caller-supplied PRNG: derive a per-day seed so the plan is stable within
  // a day yet varies across days (a fixed constant would repeat forever).
  const rng = input.rng ?? mulberry32(daySeed(now))

  const { due: duePool, wrong: wrongPool, fresh: freshPool } = planPools(objective, records, now)
  const pools = { due: duePool.length, wrong: wrongPool.length, fresh: freshPool.length }

  const objTarget = Math.max(0, Math.min(size, objective.length))
  const shortfall = Math.max(0, size - objTarget)

  // 50% due, 25% wrong, remainder fresh, each capped by what the pool holds.
  let dueQuota = Math.min(duePool.length, Math.ceil(objTarget * DUE_SHARE))
  let wrongQuota = Math.min(wrongPool.length, Math.ceil(objTarget * WRONG_SHARE))
  let freshQuota = Math.min(freshPool.length, Math.max(0, objTarget - dueQuota - wrongQuota))

  // Refund unused capacity, in priority order: wrong first (a known failure is
  // more valuable than more new material), then due, then fresh.
  let spare = objTarget - dueQuota - wrongQuota - freshQuota
  if (spare > 0) {
    const extraWrong = Math.min(wrongPool.length - wrongQuota, spare)
    wrongQuota += extraWrong
    spare -= extraWrong
  }
  if (spare > 0) {
    const extraDue = Math.min(duePool.length - dueQuota, spare)
    dueQuota += extraDue
    spare -= extraDue
  }
  if (spare > 0) {
    const extraFresh = Math.min(freshPool.length - freshQuota, spare)
    freshQuota += extraFresh
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

  // --- due: oldest-first within each half of the same-day partition ---------
  {
    const { notToday, today } = splitByToday(duePool, records, now)
    const ordered = [...orderDueOldestFirst(notToday, records), ...orderDueOldestFirst(today, records)]
    push(ordered.slice(0, dueQuota))
  }

  // --- wrong / fresh: fill from "not today" first, then fall back -----------
  const fillPool = (pool: Question[], quota: number) => {
    if (quota <= 0 || pool.length === 0) return
    const { notToday, today } = splitByToday(pool, records, now)
    const fromNotToday = Math.min(quota, notToday.length)
    push(selectQuestions({ pool: notToday, records, now, count: fromNotToday, rng }))
    const remaining = quota - Math.min(fromNotToday, notToday.length)
    if (remaining > 0) push(selectQuestions({ pool: today, records, now, count: remaining, rng }))
  }
  fillPool(wrongPool, wrongQuota)
  fillPool(freshPool, freshQuota)

  const objectivePicks = picks.slice(0, objTarget)
  // Due questions that did not fit today, deferred to the next plan. Counted
  // from what actually made it into the plan, so the number can never drift.
  const dueIds = new Set(duePool.map((q) => q.id))
  const dueInPlan = objectivePicks.filter((q) => dueIds.has(q.id)).length
  const deferredDue = Math.max(0, duePool.length - dueInPlan)

  // One extra subjective question, independent of the objective quota so writing
  // practice is never crowded out.
  //
  // Priority: a question that is DUE for review comes first (its schedule says
  // it should reappear now); otherwise a never-trained one (coverage); otherwise
  // any. Picking uniformly across all subjective questions regardless of state
  // would ignore the spaced-repetition schedule for writing practice entirely.
  let subjectivePicks: Question[] = []
  if (subjective.length > 0) {
    // Rotate away from questions already trained today when alternatives exist.
    const { notToday, today } = splitByToday(subjective, records, now)
    const pool = notToday.length > 0 ? notToday : today
    const isOverdue = (q: Question) => {
      const r = records.get(q.id)
      return !!r && isRecordDue(r, now)
    }
    const isUntrained = (q: Question) => (records.get(q.id)?.attempts ?? 0) === 0
    const overdue = pool.filter(isOverdue)
    const untrained = pool.filter((q) => !isOverdue(q) && isUntrained(q))
    const rest = pool.filter((q) => !isOverdue(q) && !isUntrained(q))
    const ordered = [...overdue, ...untrained, ...rest]
    if (ordered.length > 0) {
      // Overdue work is scheduled, not sampled: take the oldest-due first so a
      // backlog of subjective reviews actually drains. Otherwise rotate within
      // the group using the day-seeded PRNG.
      if (overdue.length > 0) {
        const oldest = overdue.slice().sort((a, b) => {
          const ra = records.get(a.id)?.nextReviewAt ?? 0
          const rb = records.get(b.id)?.nextReviewAt ?? 0
          return ra - rb || a.id.localeCompare(b.id)
        })
        subjectivePicks = [oldest[0]]
      } else {
        const idx = Math.min(ordered.length - 1, Math.floor(rng() * ordered.length))
        subjectivePicks = [ordered[idx]]
      }
    }
  }

  return {
    questions: [...objectivePicks, ...subjectivePicks],
    pools,
    deferredDue,
    shortfall,
  }
}
