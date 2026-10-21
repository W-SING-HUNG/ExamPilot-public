import { describe, it, expect } from 'vitest'
import {
  nextInterval,
  applyAttempt,
  applySubjectiveAttempt,
  freshRecord,
  selectQuestions,
  questionWeight,
  mulberry32,
} from './scheduler'
import type { Question, QRecord } from './types'

const DAY = 86400000

const mkq = (id: string, type: Question['type'] = 'single'): Question => ({
  id,
  chapter: '导论',
  chapterIndex: 0,
  type,
  bankNo: 1,
  pageStart: 2,
  pageEnd: 2,
  stem: id,
  options: ['a', 'b', 'c', 'd'],
  answer: 'B',
  answerNorm: type === 'judge' ? true : 'B',
  hasOfficialAnswer: type !== 'short' && type !== 'material',
  isFlagged: type === 'short' || type === 'material',
  flagReason: '',
})

/** Apply a sequence of outcomes with a fixed clock. */
function run(seq: boolean[], startAt = 0, gap = DAY): QRecord {
  let r = freshRecord('q', startAt)
  seq.forEach((ok, i) => {
    r = applyAttempt(r, ok, startAt + i * gap)
  })
  return r
}

describe('scheduler / interval', () => {
  it('computes intervals', () => {
    expect(nextInterval(0, true).intervalDays).toBe(1)
    expect(nextInterval(1, true).intervalDays).toBe(2)
    expect(nextInterval(2, false).intervalDays).toBe(0)
  })

  it('caps the objective interval at 365 days', () => {
    expect(nextInterval(300, true).intervalDays).toBe(365)
    expect(nextInterval(1000, true).intervalDays).toBe(365)
  })

  it('applies the ease floor on every write, regardless of the stored ease', () => {
    // A record whose ease was persisted at the default 2.0 must still honour a
    // raised floor — the old value must not lock the calculation.
    const base = { ...freshRecord('q', 0), intervalDays: 1, ease: 2 }
    expect(applyAttempt(base, true, 0, 2).intervalDays).toBe(2)
    expect(applyAttempt(base, true, 0, 4).intervalDays).toBe(4)

    // Lowering the setting below the built-in default must not drag the
    // multiplier down with it: ease is clamped to DEFAULT_EASE as a floor too.
    const plain = { ...freshRecord('q', 0), intervalDays: 4, ease: 2 }
    expect(applyAttempt(plain, true, 0, 1).intervalDays).toBe(8)
    expect(applyAttempt(plain, true, 0, 1).ease).toBe(2)
  })

  it('never lets the floor drop below the built-in default', () => {
    const rec = { ...freshRecord('q', 0), intervalDays: 1, ease: 2 }
    expect(applyAttempt(rec, true, 0, 0.5).intervalDays).toBe(2)
  })

  it('lowering the setting is not locked by a previously persisted ease', () => {
    // Acceptance criterion: the setting must take effect in BOTH directions.
    // Raise it, train (the record now stores a raised ease), then lower it and
    // train again — the next interval must follow the lowered setting.
    let r = freshRecord('q', 0)
    r = applyAttempt(r, true, 0, 4) // setting = 4
    expect(r.ease).toBe(4)
    expect(r.intervalDays).toBe(1)

    r = applyAttempt(r, true, DAY, 2) // setting lowered back to 2
    expect(r.ease).toBe(2)
    expect(r.intervalDays).toBe(2) // 1 * 2, NOT 1 * 4

    // And it stays consistent for as long as the setting stays lowered.
    r = applyAttempt(r, true, 2 * DAY, 2)
    expect(r.intervalDays).toBe(4)
  })

  it('raising the setting takes effect on a record trained at a lower ease', () => {
    let r = freshRecord('q', 0)
    r = applyAttempt(r, true, 0, 2) // setting = 2
    expect(r.ease).toBe(2)
    r = applyAttempt(r, true, DAY, 3) // setting raised to 3
    expect(r.ease).toBe(3)
    expect(r.intervalDays).toBe(3) // 1 * 3
  })

  it('a stored ease is still honoured when no floor is supplied', () => {
    // Backwards compatibility for callers that do not pass a setting.
    const rec = { ...freshRecord('q', 0), intervalDays: 2, ease: 4 }
    const out = applyAttempt(rec, true, 0)
    expect(out.ease).toBe(4)
    expect(out.intervalDays).toBe(8)
  })
})

describe('scheduler / mastery status', () => {
  it('promotes to mastered after three net correct answers', () => {
    const r = run([true, true, true])
    expect(r.status).toBe('mastered')
    expect(r.correctCount).toBe(3)
  })

  it('demotes on repeated errors', () => {
    const r = run([true, false, false, false])
    expect(r.status).toBe('struggling')
    expect(r.wrongCount).toBe(3)
  })

  it('struggling is NOT permanent: a correct answer leaves it', () => {
    // 3 wrong then 1 correct: the latest outcome is correct, so it recovers.
    const r = run([false, false, false, true])
    expect(r.status).toBe('learning')
    expect(r.wrongCount).toBe(3) // history is preserved
  })

  it('struggling recovers to mastered after enough correct answers', () => {
    // 3 wrong then 30 correct: net correct 27 >= 3.
    const seq = [false, false, false, ...Array.from({ length: 30 }, () => true)]
    const r = run(seq)
    expect(r.status).toBe('mastered')
    expect(r.lastCorrect).toBe(true)
    expect(r.wrongCount).toBe(3)
  })

  it('stays struggling while the most recent answer is still wrong', () => {
    const r = run([false, false, false, false, false])
    expect(r.status).toBe('struggling')
  })

  it('a single wrong answer after mastery demotes to learning, not struggling', () => {
    // Regression: this used to stay "mastered", which hid a fresh failure.
    const r = run([true, true, true, true, false])
    expect(r.status).toBe('learning')
    expect(r.intervalDays).toBe(0)
    expect(r.lastCorrect).toBe(false)
  })

  it('a wrong answer on a never-correct question stays learning until 3 errors', () => {
    expect(run([false]).status).toBe('learning')
    expect(run([false, false]).status).toBe('learning')
    expect(run([false, false, false]).status).toBe('struggling')
  })

  it('mastered requires net correct >= 3, not a lifetime ratio', () => {
    // 4 correct + 1 wrong: net = 3 -> mastered (old rule needed attempts>=4 && net>=3 too)
    expect(run([true, true, true, true, false, true]).status).toBe('mastered')
    // 3 correct + 3 wrong: net = 0 -> never mastered while errors balance it out
    expect(run([true, true, true, false, false, false]).status).toBe('struggling')
  })
})

describe('scheduler / subjective attempts', () => {
  it('advances only the attempt count and interval', () => {
    let r = freshRecord('s', 0)
    const seq: number[] = []
    for (let i = 0; i < 5; i++) {
      r = applySubjectiveAttempt(r, i * DAY)
      seq.push(r.intervalDays)
    }
    expect(seq).toEqual([1, 2, 3, 5, 8]) // round(prev * 1.5)
  })

  it('caps the subjective interval at 30 days', () => {
    let r = freshRecord('s', 0)
    for (let i = 0; i < 30; i++) r = applySubjectiveAttempt(r, i * DAY)
    expect(r.intervalDays).toBe(30)
  })

  it('never grants mastery or struggling, no matter how many attempts', () => {
    let r = freshRecord('s', 0)
    for (let i = 0; i < 50; i++) r = applySubjectiveAttempt(r, i * DAY)
    expect(r.attempts).toBe(50)
    expect(r.status).toBe('learning')
    expect(r.status).not.toBe('mastered')
    expect(r.status).not.toBe('struggling')
  })

  it('never fabricates correctness', () => {
    let r = freshRecord('s', 0)
    for (let i = 0; i < 10; i++) r = applySubjectiveAttempt(r, i * DAY)
    expect(r.correctCount).toBe(0)
    expect(r.wrongCount).toBe(0)
    expect(r.lastCorrect).toBe(null)
  })

  it('does not wipe counters that already exist on the record', () => {
    // Defensive: an objective record must keep its counters if this runs on it.
    const obj = applyAttempt(freshRecord('q', 0), true, 0)
    const after = applySubjectiveAttempt(obj, DAY)
    expect(after.correctCount).toBe(obj.correctCount)
    expect(after.wrongCount).toBe(obj.wrongCount)
    expect(after.lastCorrect).toBe(null) // subjective attempt records no verdict
  })
})

describe('scheduler / selection weights', () => {
  const now = 10 * DAY
  const mk = (o: Partial<QRecord>): QRecord => ({ ...freshRecord('x', now), ...o })

  it('ranks due work above untouched work', () => {
    const dueWrong = mk({ attempts: 6, wrongCount: 4, lastSeenAt: now - DAY, nextReviewAt: now - DAY })
    const due = mk({ attempts: 3, correctCount: 3, lastSeenAt: now - DAY, nextReviewAt: now - DAY })
    // An untouched question is not "due" until it is scheduled; model one that
    // has simply never been attempted.
    const untouched = mk({ attempts: 0, status: 'new', lastSeenAt: 0, nextReviewAt: now + DAY })
    const learning = mk({ attempts: 3, correctCount: 3, lastSeenAt: now - DAY, nextReviewAt: now + DAY })
    const wDueWrong = questionWeight(dueWrong, now)
    const wDue = questionWeight(due, now)
    const wUntouched = questionWeight(untouched, now)
    const wLearning = questionWeight(learning, now)
    expect(wDueWrong).toBeGreaterThan(wDue)
    expect(wDue).toBeGreaterThan(wUntouched)
    expect(wUntouched).toBeGreaterThan(wLearning)
  })

  it('gives a due mastered question normal priority instead of suppressing it', () => {
    const dueMastered = mk({
      status: 'mastered',
      attempts: 5,
      correctCount: 5,
      intervalDays: 30,
      lastSeenAt: now - 30 * DAY,
      nextReviewAt: now - DAY,
    })
    const notDueMastered = mk({
      status: 'mastered',
      attempts: 5,
      correctCount: 5,
      intervalDays: 30,
      lastSeenAt: now - DAY,
      nextReviewAt: now + 29 * DAY,
    })
    expect(questionWeight(dueMastered, now)).toBeGreaterThan(questionWeight(notDueMastered, now))
    // Same priority band as any other due question.
    expect(questionWeight(dueMastered, now)).toBe(6)
  })

  it('penalises a question answered seconds ago', () => {
    const recent = mk({ attempts: 0, lastSeenAt: now, nextReviewAt: now })
    const old = mk({ attempts: 0, lastSeenAt: now - 2 * 60_000, nextReviewAt: now })
    expect(questionWeight(recent, now)).toBeLessThan(questionWeight(old, now))
  })

  it('selection never repeats a question within one session', () => {
    const pool = Array.from({ length: 30 }, (_, i) => mkq(`q${i}`))
    const records = new Map<string, QRecord>()
    for (let i = 0; i < 5; i++) {
      records.set(`q${i}`, {
        ...freshRecord(`q${i}`, now),
        status: 'struggling',
        attempts: 6,
        wrongCount: 4,
        lastSeenAt: now - 999999,
        nextReviewAt: now - 10000,
      })
    }
    const picked = selectQuestions({ pool, records, now, count: 12, rng: mulberry32(3) })
    const ids = picked.map((q) => q.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.length).toBe(12)
  })

  it('selection favors wrong questions over mastered ones', () => {
    const pool = Array.from({ length: 20 }, (_, i) => mkq(`q${i}`))
    const records = new Map<string, QRecord>()
    // last 10 mastered, long interval, NOT due
    for (let i = 10; i < 20; i++) {
      records.set(`q${i}`, {
        ...freshRecord(`q${i}`, now),
        status: 'mastered',
        attempts: 5,
        correctCount: 5,
        intervalDays: 100,
        nextReviewAt: now + 99999999,
        lastSeenAt: now - 1000,
      })
    }
    // first 5 wrong, struggling and due for review
    for (let i = 0; i < 5; i++) {
      records.set(`q${i}`, {
        ...freshRecord(`q${i}`, now),
        status: 'struggling',
        attempts: 6,
        wrongCount: 4,
        lastCorrect: false,
        lastSeenAt: now - 999999,
        nextReviewAt: now - 10000,
      })
    }
    const masteredIds = new Set(Array.from({ length: 10 }, (_, k) => `q${k + 10}`))
    const wrongIds = new Set(['q0', 'q1', 'q2', 'q3', 'q4'])

    let masteredPicked = 0
    let wrongPicked = 0
    let untouchedPicked = 0
    // run several seeds to remove flakiness; the invariant must hold on aggregate
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const picked = selectQuestions({ pool, records, now, count: 8, rng: mulberry32(seed) })
      const ids = picked.map((q) => q.id)
      expect(ids.length).toBe(8)
      for (const id of ids) {
        if (masteredIds.has(id)) masteredPicked++
        else if (wrongIds.has(id)) wrongPicked++
        else untouchedPicked++
      }
    }
    expect(masteredPicked).toBeLessThanOrEqual(4)
    expect(wrongPicked).toBeGreaterThan(masteredPicked * 2)
    expect(untouchedPicked).toBeGreaterThan(0)
  })

  it('a mastered question that was just answered wrong is still selectable', () => {
    // Regression: this used to be suppressed to ~2% and effectively vanished.
    const pool = [mkq('a'), mkq('b'), mkq('c')]
    const records = new Map<string, QRecord>([
      [
        'a',
        applyAttempt(
          {
            ...freshRecord('a', now),
            status: 'mastered',
            attempts: 5,
            correctCount: 5,
            intervalDays: 8,
            lastSeenAt: now - DAY,
          },
          false,
          now,
        ),
      ],
      [
        'b',
        {
          ...freshRecord('b', now),
          attempts: 5,
          correctCount: 4,
          wrongCount: 1,
          lastSeenAt: now - DAY,
          nextReviewAt: now + 3 * DAY,
        },
      ],
      // 'c' is untouched and NOT due, so it must not outrank the fresh failure.
      ['c', { ...freshRecord('c', now), attempts: 0, status: 'new', lastSeenAt: 0, nextReviewAt: now + DAY }],
    ])
    // a: due + wrong -> 12 ; b: learning not due -> 2 ; c: untouched -> 4
    let picked = 0
    for (let s = 0; s < 500; s++) {
      if (selectQuestions({ pool, records, now, count: 1, rng: mulberry32(s + 1) })[0].id === 'a') picked++
    }
    // Expected share 12/18 = 0.667; assert well above the old ~2% suppression.
    expect(picked / 500).toBeGreaterThan(0.2)
  })

  it('never returns an empty session for a non-empty pool of low-weight questions', () => {
    // Regression: the old hard weight cut-off returned 0 questions here.
    const now0 = Date.now()
    const pool = Array.from({ length: 20 }, (_, i) => mkq(`m${i}`))
    const records = new Map<string, QRecord>()
    for (const q of pool) {
      let r = freshRecord(q.id, now0)
      for (let i = 0; i < 4; i++) r = applyAttempt(r, true, now0 - 1000)
      records.set(q.id, r) // all mastered, answered seconds ago
    }
    const picked = selectQuestions({ pool, records, now: now0, count: 10, rng: mulberry32(5) })
    expect(picked.length).toBe(10)
  })

  it('returns nothing for an empty pool and does not hang', () => {
    expect(selectQuestions({ pool: [], records: new Map(), now, count: 5 })).toEqual([])
    expect(selectQuestions({ pool: [mkq('only')], records: new Map(), now, count: 0 })).toEqual([])
  })

  it('returns fewer than requested when the pool is smaller', () => {
    const picked = selectQuestions({ pool: [mkq('only-one')], records: new Map(), now, count: 5 })
    expect(picked.length).toBe(1)
  })

  it('a pool of only not-due mastered questions is still served', () => {
    // The old hard weight cut-off made these pools yield nothing.
    const now0 = Date.now()
    const pool = Array.from({ length: 10 }, (_, i) => mkq(`nd${i}`))
    const records = new Map<string, QRecord>()
    for (const q of pool) {
      records.set(q.id, {
        ...freshRecord(q.id, now0),
        status: 'mastered',
        attempts: 5,
        correctCount: 5,
        intervalDays: 100,
        lastSeenAt: now0 - 5 * DAY,
        nextReviewAt: now0 + 95 * DAY,
      })
    }
    expect(questionWeight(records.get(pool[0].id)!, now0)).toBe(0.3)
    const picked = selectQuestions({ pool, records, now: now0, count: 5, rng: mulberry32(3) })
    expect(picked).toHaveLength(5)
    expect(new Set(picked.map((q) => q.id)).size).toBe(5)
  })

  it('the recent-answer penalty applies at the 60s boundary but never zeroes a weight', () => {
    const now0 = Date.now()
    const justNow = { ...freshRecord('a', now0), attempts: 0, lastSeenAt: now0, nextReviewAt: now0 + DAY }
    const justInside = { ...freshRecord('b', now0), attempts: 0, lastSeenAt: now0 - 59_999, nextReviewAt: now0 + DAY }
    const justOutside = { ...freshRecord('c', now0), attempts: 0, lastSeenAt: now0 - 60_001, nextReviewAt: now0 + DAY }
    expect(questionWeight(justNow, now0)).toBeGreaterThan(0)
    expect(questionWeight(justInside, now0)).toBeLessThan(questionWeight(justOutside, now0))
  })

  it('a question due exactly now counts as due', () => {
    const now0 = Date.now()
    const rec = {
      ...freshRecord('d', now0),
      attempts: 3,
      correctCount: 3,
      lastSeenAt: now0 - DAY,
      nextReviewAt: now0,
    }
    expect(questionWeight(rec, now0)).toBe(8)
  })

  it('a count larger than the pool returns the whole pool without duplicates', () => {
    const pool = Array.from({ length: 6 }, (_, i) => mkq(`big${i}`))
    const picked = selectQuestions({ pool, records: new Map(), now, count: 100, rng: mulberry32(4) })
    expect(picked).toHaveLength(6)
    expect(new Set(picked.map((q) => q.id)).size).toBe(6)
  })

  it('a degenerate rng that always returns 0 or 1 still picks valid questions', () => {
    const pool = Array.from({ length: 5 }, (_, i) => mkq(`dz${i}`))
    for (const fixed of [0, 1]) {
      const picked = selectQuestions({ pool, records: new Map(), now, count: 2, rng: () => fixed })
      expect(picked).toHaveLength(2)
      expect(new Set(picked.map((q) => q.id)).size).toBe(2)
    }
  })

  it('sampling an equal-weight pool spreads across it', () => {
    // Probabilistic: assert reachability and spread, never exact coverage.
    const now0 = Date.now()
    const pool = Array.from({ length: 40 }, (_, i) => mkq(`sp${i}`))
    const seen = new Set<string>()
    for (let s = 0; s < 20; s++) {
      for (const q of selectQuestions({ pool, records: new Map(), now: now0, count: 5, rng: mulberry32(s + 1) })) {
        seen.add(q.id)
      }
    }
    expect(seen.size).toBeGreaterThan(pool.length * 0.7)
  })

  it('different seeds produce different orders', () => {
    const now0 = Date.now()
    const pool = Array.from({ length: 30 }, (_, i) => mkq(`sd${i}`))
    const records = new Map<string, QRecord>()
    for (const q of pool) records.set(q.id, { ...freshRecord(q.id, now0), attempts: 0, nextReviewAt: now0 + DAY })
    const a = selectQuestions({ pool, records, now: now0, count: 6, rng: mulberry32(1) }).map((q) => q.id)
    const b = selectQuestions({ pool, records, now: now0, count: 6, rng: mulberry32(2) }).map((q) => q.id)
    expect(a.join(',')).not.toBe(b.join(','))
  })
})
