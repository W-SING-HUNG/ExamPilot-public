import { describe, it, expect } from 'vitest'
import { computeDiagnosis, chapterGaps } from './analysis'
import { allQuestions, chapterOrder } from './bank'
import type { QRecord } from './types'

const rec = (qid: string, correct: number, wrong: number): QRecord =>
  ({
    qid,
    status: wrong > correct ? 'struggling' : 'learning',
    attempts: correct + wrong,
    correctCount: correct,
    wrongCount: wrong,
    lastSeenAt: 1,
    lastCorrect: correct > 0,
    lastAnswer: 'A',
    intervalDays: 1,
    ease: 2,
    nextReviewAt: 2,
  }) as QRecord

describe('chapterGaps: weak vs not-yet-started', () => {
  it('no practice at all → zero weak chapters, every formal chapter unstarted', () => {
    const d = computeDiagnosis(allQuestions, new Map())
    const g = chapterGaps(d.chapters, chapterOrder)
    expect(g.weak).toHaveLength(0)
    expect(g.unstarted.map((c) => c.chapter)).toEqual(
      chapterOrder.filter((ch) => d.chapters.find((c) => c.chapter === ch)!.objectiveTotal > 0),
    )
    // the legacy list still mixes in untouched chapters — that is what produced "6 薄弱章节"
    expect(d.weakPoints.every((w) => w.kind === 'uncovered')).toBe(true)
  })

  it('records of questions outside the bank never create a weak chapter', () => {
    const d = computeDiagnosis(allQuestions, new Map([['X999-00000000-第一章', rec('X999-00000000-第一章', 0, 3)]]))
    expect(chapterGaps(d.chapters, chapterOrder).weak).toHaveLength(0)
  })

  it('an attempted, mostly-wrong chapter is weak and no longer unstarted', () => {
    const ch = chapterOrder[1]
    const qs = allQuestions.filter((q) => q.chapter === ch && q.type === 'single').slice(0, 3)
    const m = new Map(qs.map((q) => [q.id, rec(q.id, 0, 2)]))
    const g = chapterGaps(computeDiagnosis(allQuestions, m).chapters, chapterOrder)
    expect(g.weak.map((w) => w.chapter)).toEqual([ch])
    expect(g.unstarted.find((c) => c.chapter === ch)).toBeUndefined()
  })
})
