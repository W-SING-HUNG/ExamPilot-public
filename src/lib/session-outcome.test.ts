import { describe, it, expect } from 'vitest'
import { summarise, EMPTY_RESULT } from './session-outcome'

/**
 * The three-outcome model is the fix for the audit's P0-5: a subjective answer
 * with no auto grade used to be counted as "wrong" in the counter and painted
 * "correct" in the progress dots at the same time.
 */
describe('session outcome summarisation', () => {
  it('counts correct, wrong and unscored separately', () => {
    const r = summarise({
      total: 5,
      outcomes: { a: 'correct', b: 'correct', c: 'wrong', d: 'unscored' },
      durationMs: 1000,
    })
    expect(r.correct).toBe(2)
    expect(r.wrong).toBe(1)
    expect(r.unscored).toBe(1)
    expect(r.answered).toBe(4)
    expect(r.unanswered).toBe(1)
  })

  it('never counts an unscored subjective answer as wrong', () => {
    const r = summarise({ total: 1, outcomes: { s: 'unscored' }, durationMs: 0 })
    expect(r.wrong).toBe(0)
    expect(r.correct).toBe(0)
    expect(r.unscored).toBe(1)
    expect(r.wrongQids).toEqual([])
  })

  it('reports accuracy over auto-graded questions only', () => {
    const r = summarise({
      total: 4,
      outcomes: { a: 'correct', b: 'correct', c: 'wrong', d: 'unscored' },
      durationMs: 0,
    })
    // 2 correct of 3 graded, NOT of 4 answered.
    expect(r.accuracy).toBeCloseTo(2 / 3, 5)
  })

  it('reports null accuracy when nothing was auto-graded', () => {
    const r = summarise({ total: 2, outcomes: { a: 'unscored', b: 'unscored' }, durationMs: 0 })
    expect(r.accuracy).toBeNull()
  })

  it('tracks skipped questions without calling them answered', () => {
    const r = summarise({ total: 3, outcomes: { a: 'correct' }, skipped: ['b'], durationMs: 0 })
    expect(r.answered).toBe(1)
    expect(r.unanswered).toBe(2)
    expect(r.skippedQids).toEqual(['b'])
  })

  it('never yields a negative unanswered count', () => {
    const r = summarise({ total: 1, outcomes: { a: 'correct', b: 'wrong' }, durationMs: 0 })
    expect(r.unanswered).toBe(0)
  })

  it('exposes wrong qids for the summary action', () => {
    const r = summarise({ total: 3, outcomes: { x: 'wrong', y: 'correct', z: 'wrong' }, durationMs: 0 })
    expect(r.wrongQids.sort()).toEqual(['x', 'z'])
  })

  it('has a zeroed empty result', () => {
    expect(EMPTY_RESULT.answered).toBe(0)
    expect(EMPTY_RESULT.accuracy).toBeNull()
  })
})
