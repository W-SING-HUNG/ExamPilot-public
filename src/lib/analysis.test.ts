import { describe, it, expect } from 'vitest'
import { bank, allQuestions, objectiveQuestions, usingSampleBank } from './bank'
import type { Question, QRecord } from './types'
import { freshRecord, applyAttempt, applySubjectiveAttempt } from './scheduler'
import { computeDiagnosis, rankWeakPoints, WEAK_POINT_LIMIT, type ChapterStat } from './analysis'

/**
 * Tests for the PUBLIC sample bank.
 *
 * These assertions must hold for any valid bank (sample or full), so they are
 * structural rather than size-specific. Validation that only applies once a full
 * bank is installed lives in `src/lib/bank.local.test.ts`; its cases skip while
 * the bundled sample bank is in use.
 */
describe('sample bank integrity', () => {
  it('ships a non-empty demo bank', () => {
    expect(allQuestions.length).toBeGreaterThan(0)
    expect(bank.chapterOrder.length).toBeGreaterThan(0)
  })

  it('has unique question ids', () => {
    expect(new Set(allQuestions.map((q) => q.id)).size).toBe(allQuestions.length)
  })

  it('countsByType matches the actual questions', () => {
    for (const [type, n] of Object.entries(bank.countsByType)) {
      const actual = allQuestions.filter((q) => q.type === type).length
      expect(actual, `type ${type}`).toBe(n)
    }
  })

  it('covers all five question types', () => {
    for (const t of ['single', 'multi', 'judge', 'short', 'material']) {
      expect(
        allQuestions.some((q) => q.type === t),
        t,
      ).toBe(true)
    }
  })

  it('objective questions all have answers and options', () => {
    for (const q of objectiveQuestions) {
      expect(q.hasOfficialAnswer, q.id).toBe(true)
      if (q.type === 'single' || q.type === 'multi') {
        expect(q.options.length, q.id).toBeGreaterThanOrEqual(2)
        const letters = String(q.answerNorm).split('')
        expect(
          letters.every((l) => l.charCodeAt(0) - 65 < q.options.length),
          q.id,
        ).toBe(true)
      }
    }
  })

  it('multi answers have at least two letters', () => {
    for (const q of allQuestions.filter((x) => x.type === 'multi')) {
      expect(String(q.answerNorm).length, q.id).toBeGreaterThanOrEqual(2)
    }
  })

  it('subjective questions have no fabricated official answers', () => {
    for (const q of allQuestions.filter((x) => x.type === 'short' || x.type === 'material')) {
      expect(q.hasOfficialAnswer, q.id).toBe(false)
      expect(q.answerNorm, q.id).toBe(null)
    }
  })

  it('every question has PDF page traceability', () => {
    for (const q of allQuestions) {
      expect(q.pageStart, q.id).toBeGreaterThan(0)
      expect(q.pageEnd ?? q.pageStart!, q.id).toBeGreaterThanOrEqual(q.pageStart!)
    }
  })

  it('judge answers are boolean-normalized', () => {
    for (const q of allQuestions.filter((x) => x.type === 'judge')) {
      expect(typeof q.answerNorm, q.id).toBe('boolean')
    }
  })

  it('reports whether the demo bank is in use', () => {
    expect(typeof usingSampleBank).toBe('boolean')
  })
})

describe('analysis (sample bank)', () => {
  const recs = (ids: string[], fn: (r: QRecord) => QRecord) => new Map(ids.map((id) => [id, fn(freshRecord(id))]))

  it('reports zero coverage when nothing attempted', async () => {
    const { computeDiagnosis } = await import('./analysis')
    const d = computeDiagnosis(allQuestions, new Map())
    expect(d.overall.attempted).toBe(0)
    expect(d.overall.coverage).toBe(0)
    expect(d.overall.correctRate).toBe(0)
  })

  it('computes correct rate from real attempts only', async () => {
    const { computeDiagnosis } = await import('./analysis')
    const some = objectiveQuestions.slice(0, 4)
    const d = computeDiagnosis(
      allQuestions,
      recs(
        some.map((q) => q.id),
        (r) => applyAttempt(r, true),
      ),
    )
    expect(d.overall.attempted).toBe(4)
    expect(d.overall.correctRate).toBe(1)
    expect(d.overall.wrong).toBe(0)
  })

  it('does not count blank/unattempted as mastered', async () => {
    const { computeDiagnosis } = await import('./analysis')
    const some = objectiveQuestions.slice(0, 4)
    const d = computeDiagnosis(
      allQuestions,
      recs(
        some.map((q) => q.id),
        (r) => r,
      ),
    )
    expect(d.overall.attempted).toBe(0)
    expect(d.overall.ourMastered).toBe(0)
    expect(d.overall.coverage).toBe(0)
  })

  it('type stats cover all five types', async () => {
    const { computeDiagnosis } = await import('./analysis')
    const d = computeDiagnosis(allQuestions, new Map())
    expect(d.types.map((t) => t.type)).toEqual(['single', 'multi', 'judge', 'short', 'material'])
    expect(d.types.reduce((s, t) => s + t.total, 0)).toBe(allQuestions.length)
  })
})

// ---------------------------------------------------------------------------
// Chapter totals must include subjective questions
// ---------------------------------------------------------------------------

describe('analysis / chapter totals', () => {
  it('chapter totals account for every question, subjective included', () => {
    const d = computeDiagnosis(allQuestions, new Map())
    expect(d.chapters.reduce((s, c) => s + c.total, 0)).toBe(allQuestions.length)
  })

  it('reports subjective questions inside their chapter instead of dropping them', () => {
    const d = computeDiagnosis(allQuestions, new Map())
    const subjectiveTotal = allQuestions.filter((q) => q.type === 'short' || q.type === 'material').length
    expect(d.chapters.reduce((s, c) => s + c.subjectiveTotal, 0)).toBe(subjectiveTotal)
    expect(d.chapters.reduce((s, c) => s + c.objectiveTotal, 0)).toBe(objectiveQuestions.length)
  })

  it('keeps coverage measured against objective questions only', () => {
    // A chapter made only of subjective questions has no objective denominator,
    // so its coverage is 0 rather than a fabricated ratio.
    const d = computeDiagnosis(allQuestions, new Map())
    for (const c of d.chapters) {
      if (c.objectiveTotal === 0) expect(c.coverage).toBe(0)
      else expect(c.coverage).toBeLessThanOrEqual(1)
    }
  })
})

// ---------------------------------------------------------------------------
// Weak-point classification (R1-R9)
// ---------------------------------------------------------------------------

/** Build a ChapterStat directly, so the ranking rules can be tested in isolation. */
function ch(
  chapter: string,
  o: Partial<{
    attempted: number
    objectiveTotal: number
    subjectiveTotal: number
    coverage: number
    correctRate: number
    struggling: number
  }>,
): ChapterStat {
  const objectiveTotal = o.objectiveTotal ?? 10
  const attempted = o.attempted ?? 0
  return {
    chapter,
    total: objectiveTotal + (o.subjectiveTotal ?? 0),
    objectiveTotal,
    subjectiveTotal: o.subjectiveTotal ?? 0,
    attempted,
    coverage: o.coverage ?? attempted / objectiveTotal,
    correct: 0,
    wrong: 0,
    correctRate: o.correctRate ?? 0,
    mastered: 0,
    struggling: o.struggling ?? 0,
    single: objectiveTotal,
    multi: 0,
    judge: 0,
    subj: o.subjectiveTotal ?? 0,
  }
}

describe('weak points / classification', () => {
  it('R1: an all-wrong chapter is never pushed off the list by untouched chapters', () => {
    // 1 attempted-but-all-wrong chapter + 8 never-attempted chapters.
    const allWrong = ch('全错章', { attempted: 10, objectiveTotal: 10, coverage: 1, correctRate: 0 })
    const untouched = Array.from({ length: 8 }, (_, i) => ch(`未练章${i}`, { attempted: 0, objectiveTotal: 10 }))
    const ranked = rankWeakPoints([allWrong, ...untouched])

    expect(ranked.length).toBe(WEAK_POINT_LIMIT)
    expect(ranked[0].chapter).toBe('全错章')
    expect(ranked[0].kind).toBe('weak')
    // Untouched chapters may only fill the remaining slots.
    expect(ranked.filter((w) => w.kind === 'uncovered')).toHaveLength(WEAK_POINT_LIMIT - 1)
  })

  it('R2: a lone uncovered chapter is listed as uncovered with no rate', () => {
    const ranked = rankWeakPoints([ch('未练章', { attempted: 0, objectiveTotal: 12, subjectiveTotal: 3 })])
    expect(ranked).toHaveLength(1)
    expect(ranked[0].kind).toBe('uncovered')
    expect(ranked[0].score).toBe(0)
    expect(ranked[0].detail).toContain('尚未开始练习')
    expect(ranked[0].detail).toContain('3')
  })

  it('R3: weak chapters fill the list before uncovered ones', () => {
    const weak = Array.from({ length: 6 }, (_, i) =>
      ch(`薄弱章${i}`, { attempted: 5, objectiveTotal: 10, coverage: 0.5, correctRate: 0.2 }),
    )
    const uncovered = Array.from({ length: 8 }, (_, i) => ch(`未练章${i}`, { attempted: 0, objectiveTotal: 10 }))
    const ranked = rankWeakPoints([...weak, ...uncovered])
    expect(ranked).toHaveLength(WEAK_POINT_LIMIT)
    expect(ranked.every((w) => w.kind === 'weak')).toBe(true)
  })

  it('R4: a fully consolidated chapter is not surfaced', () => {
    const consolidated = ch('巩固章', { attempted: 10, objectiveTotal: 10, coverage: 1, correctRate: 1 })
    expect(rankWeakPoints([consolidated])).toHaveLength(0)
  })

  it('R5: an all-wrong chapter scores from its real 0% rate, not a stand-in', () => {
    const allWrong = ch('全错章', { attempted: 10, objectiveTotal: 10, coverage: 1, correctRate: 0 })
    expect(rankWeakPoints([allWrong])[0].score).toBe(40)
    // And the score does not change when untouched chapters are added.
    const withUntouched = rankWeakPoints([
      allWrong,
      ...Array.from({ length: 8 }, (_, i) => ch(`未练章${i}`, { attempted: 0 })),
    ])
    expect(withUntouched[0].score).toBe(40)
  })

  it('R6: an all-wrong chapter reports its real rate', () => {
    const allWrong = ch('全错章', { attempted: 10, objectiveTotal: 10, coverage: 1, correctRate: 0 })
    const wp = rankWeakPoints([allWrong])[0]
    expect(wp.detail).toContain('正确率仅 0%')
    expect(wp.detail).not.toContain('待进一步巩固')
  })

  it('R7: uncovered chapters rank by how many questions are still untouched', () => {
    const small = ch('小未练章', { attempted: 0, objectiveTotal: 10 })
    const big = ch('大未练章', { attempted: 0, objectiveTotal: 50 })
    const ranked = rankWeakPoints([small, big])
    expect(ranked[0].chapter).toBe('大未练章')
    expect(ranked[1].chapter).toBe('小未练章')
  })

  it('R8: the two groups are never blended into one score ordering', () => {
    // A weak chapter scoring 70 must still outrank an uncovered chapter whose
    // score is 0 — this is the regression that used to hide failures.
    const weakHigh = ch('高Weak', { attempted: 9, objectiveTotal: 10, coverage: 0.9, correctRate: 0.85 })
    const uncovered = ch('未练章', { attempted: 0, objectiveTotal: 10 })
    const ranked = rankWeakPoints([weakHigh, uncovered])
    expect(ranked[0].chapter).toBe('高Weak')
    expect(ranked[1].kind).toBe('uncovered')
  })

  it('R9: every entry carries a kind', () => {
    const ranked = rankWeakPoints([
      ch('薄弱章', { attempted: 5, objectiveTotal: 10, coverage: 0.5, correctRate: 0.2 }),
      ch('未练章', { attempted: 0, objectiveTotal: 10 }),
    ])
    expect(ranked.every((w) => w.kind === 'weak' || w.kind === 'uncovered')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// End-to-end through computeDiagnosis with real records
// ---------------------------------------------------------------------------

describe('analysis / diagnosis with real attempts', () => {
  it('an all-wrong chapter outranks untouched chapters in the real diagnosis', () => {
    const now = Date.now()
    const recs = new Map<string, QRecord>()
    const chapterOf = (q: Question) => q.chapter
    const target = allQuestions.find((q) => q.type !== 'short' && q.type !== 'material')!
    const targetChapter = chapterOf(target)
    // Answer every objective question of one chapter wrongly.
    for (const q of allQuestions) {
      if (q.chapter === targetChapter && q.type !== 'short' && q.type !== 'material') {
        recs.set(q.id, applyAttempt(freshRecord(q.id, now), false, now))
      }
    }
    const d = computeDiagnosis(allQuestions, recs)
    const idx = d.weakPoints.findIndex((w) => w.chapter === targetChapter)
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(d.weakPoints[idx].kind).toBe('weak')
    // The chapter's measured rate really is 0.
    const stat = d.chapters.find((c) => c.chapter === targetChapter)!
    expect(stat.correctRate).toBe(0)
    expect(stat.wrong).toBeGreaterThan(0)
  })

  it('subjective training never produces a correct rate or a mastered count', () => {
    const now = Date.now()
    const recs = new Map<string, QRecord>()
    for (const q of allQuestions.filter((x) => x.type === 'short' || x.type === 'material')) {
      let r = freshRecord(q.id, now)
      for (let i = 0; i < 5; i++) r = applySubjectiveAttempt(r, now + i * 86400000)
      recs.set(q.id, r)
    }
    const d = computeDiagnosis(allQuestions, recs)
    for (const t of d.types.filter((x) => x.type === 'short' || x.type === 'material')) {
      expect(t.correctRate).toBe(0)
      expect(t.correct).toBe(0)
      expect(t.wrong).toBe(0)
      expect(t.mastered).toBe(0)
      expect(t.attempted).toBe(t.total) // trained, but never scored
    }
    expect(d.overall.subjectiveAttempted).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Defensive boundaries for the diagnosis engine
// ---------------------------------------------------------------------------

describe('analysis / defensive boundaries', () => {
  const isSubj = (q: Question) => q.type === 'short' || q.type === 'material'

  it('an empty bank yields well-formed, NaN-free output', () => {
    const d = computeDiagnosis([], new Map())
    expect(d.chapters).toHaveLength(0)
    expect(d.types).toHaveLength(5)
    expect(d.weakPoints).toHaveLength(0)
    for (const v of [d.overall.coverage, d.overall.correctRate]) {
      expect(Number.isNaN(v)).toBe(false)
    }
    for (const t of d.types) {
      expect(Number.isNaN(t.coverage)).toBe(false)
      expect(Number.isNaN(t.correctRate)).toBe(false)
    }
  })

  it('a chapter with no objective questions never divides by zero', () => {
    const subj = allQuestions.filter(isSubj).slice(0, Math.min(5, allQuestions.filter(isSubj).length))
    if (subj.length === 0) return
    const d = computeDiagnosis(subj, new Map())
    for (const c of d.chapters) {
      expect(Number.isNaN(c.coverage)).toBe(false)
      expect(c.coverage).toBe(0)
      expect(c.total).toBe(c.subjectiveTotal)
      expect(c.objectiveTotal).toBe(0)
    }
  })

  it('chapter totals and type totals both account for the whole bank', () => {
    const d = computeDiagnosis(allQuestions, new Map())
    expect(d.types.reduce((s, t) => s + t.total, 0)).toBe(allQuestions.length)
    expect(d.chapters.reduce((s, c) => s + c.total, 0)).toBe(allQuestions.length)
    expect(d.overall.total).toBe(objectiveQuestions.length)
  })

  it('a consolidated chapter is not surfaced even when it still has struggling questions', () => {
    const ch0 = allQuestions.find((q) => !isSubj(q))!.chapter
    const qs = allQuestions.filter((q) => q.chapter === ch0 && !isSubj(q))
    if (qs.length < 10) return
    const now = Date.now()
    const recs = new Map<string, QRecord>()
    qs.forEach((q, i) => {
      // ~10% of questions genuinely struggle (3 errors, ending on a wrong
      // answer), while the chapter rate stays comfortably above 80%.
      const struggling = i % 10 === 0
      let r = freshRecord(q.id, now)
      if (struggling) {
        r = applyAttempt(r, false, now)
        r = applyAttempt(r, false, now + 1000)
        r = applyAttempt(r, false, now + 2000)
      }
      for (let k = 0; k < 12; k++) r = applyAttempt(r, true, now + 3000 + k * 1000)
      if (struggling) r = applyAttempt(r, false, now + 20000)
      recs.set(q.id, r)
    })
    const d = computeDiagnosis(allQuestions, recs)
    const stat = d.chapters.find((c) => c.chapter === ch0)!
    expect(stat.struggling).toBeGreaterThan(0)
    expect(stat.coverage).toBe(1)
    expect(stat.correctRate).toBeGreaterThanOrEqual(0.8)
    expect(d.weakPoints.find((w) => w.chapter === ch0)).toBeUndefined()
  })

  it('the same chapter IS surfaced once its correct rate drops below 80%', () => {
    const ch0 = allQuestions.find((q) => !isSubj(q))!.chapter
    const qs = allQuestions.filter((q) => q.chapter === ch0 && !isSubj(q))
    if (qs.length < 4) return
    const now = Date.now()
    const recs = new Map<string, QRecord>()
    qs.forEach((q, i) => {
      let r = freshRecord(q.id, now)
      const wrong = i % 2 === 0
      for (let k = 0; k < 4; k++) r = applyAttempt(r, !wrong, now + k * 1000)
      recs.set(q.id, r)
    })
    const d = computeDiagnosis(allQuestions, recs)
    const stat = d.chapters.find((c) => c.chapter === ch0)!
    expect(stat.correctRate).toBeLessThan(0.8)
    const wp = d.weakPoints.find((w) => w.chapter === ch0)
    expect(wp).toBeDefined()
    expect(wp?.kind).toBe('weak')
  })

  it('a record for a question that is not in the bank is ignored', () => {
    const now = Date.now()
    const recs = new Map<string, QRecord>([
      ['not-in-bank-xyz', { ...freshRecord('not-in-bank-xyz', now), attempts: 9, correctCount: 9, status: 'mastered' }],
    ])
    const d = computeDiagnosis(allQuestions, recs)
    expect(d.overall.attempted).toBe(0)
    expect(d.overall.ourMastered).toBe(0)
  })

  it('the diagnosis is deterministic for identical inputs', () => {
    const now = Date.now()
    const recs = new Map<string, QRecord>()
    objectiveQuestions.slice(0, Math.min(8, objectiveQuestions.length)).forEach((q, i) => {
      recs.set(q.id, applyAttempt(freshRecord(q.id, now), i % 2 === 0, now))
    })
    expect(JSON.stringify(computeDiagnosis(allQuestions, recs))).toBe(
      JSON.stringify(computeDiagnosis(allQuestions, recs)),
    )
  })

  it('the weak list never exceeds the limit', () => {
    const d = computeDiagnosis(allQuestions, new Map())
    expect(d.weakPoints.length).toBeLessThanOrEqual(WEAK_POINT_LIMIT)
  })
})
