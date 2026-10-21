import { describe, it, expect } from 'vitest'
import { buildPaper, mulberry32 } from './scheduler'
import type { Question, QuestionType } from './types'

const mkq = (id: string, type: QuestionType, chapter = '导论'): Question => ({
  id,
  chapter,
  chapterIndex: 0,
  type,
  bankNo: 1,
  pageStart: 1,
  pageEnd: 1,
  stem: id,
  options: type === 'single' || type === 'multi' ? ['a', 'b', 'c', 'd'] : [],
  answer: type === 'judge' ? '正确' : 'A',
  answerNorm: type === 'judge' ? true : 'A',
  hasOfficialAnswer: type !== 'short' && type !== 'material',
  isFlagged: false,
  flagReason: '',
})

const bank = (n: Partial<Record<QuestionType, number>>, chapter = '导论'): Question[] => {
  const out: Question[] = []
  for (const [type, count] of Object.entries(n) as [QuestionType, number][]) {
    for (let i = 0; i < count; i++) out.push(mkq(`${type}-${i}`, type, chapter))
  }
  return out
}

const cfg = (over: Partial<Parameters<typeof buildPaper>[1]> = {}) => ({
  singleCount: 2,
  multiCount: 1,
  judgeCount: 1,
  shortCount: 1,
  chapters: 'all' as const,
  ...over,
})

describe('buildPaper / random selection', () => {
  it('draws subjective questions randomly instead of always taking the first ones', () => {
    // 6 subjective questions, request 1 — the choice must vary across seeds.
    const questions = [
      ...bank({ single: 4, multi: 2, judge: 2 }),
      ...Array.from({ length: 6 }, (_, i) => mkq(`sub-${i}`, 'short')),
    ]
    const picked = new Set<string>()
    for (let seed = 1; seed <= 30; seed++) {
      const r = buildPaper(questions, cfg({ shortCount: 1 }), mulberry32(seed))
      expect(r.ok).toBe(true)
      if (r.ok) picked.add(r.questions.find((q) => q.type === 'short')!.id)
    }
    // Old implementation always returned sub-0; a random draw touches several.
    expect(picked.size).toBeGreaterThan(1)
  })

  it('can draw from both short and material questions', () => {
    const questions = [
      ...bank({ single: 4, multi: 2, judge: 2 }),
      ...Array.from({ length: 4 }, (_, i) => mkq(`short-${i}`, 'short')),
      ...Array.from({ length: 4 }, (_, i) => mkq(`material-${i}`, 'material')),
    ]
    const types = new Set<string>()
    for (let seed = 1; seed <= 40; seed++) {
      const r = buildPaper(questions, cfg({ shortCount: 1 }), mulberry32(seed))
      if (r.ok) types.add(r.questions.find((q) => q.type === 'short' || q.type === 'material')!.type)
    }
    expect(types.size).toBe(2)
  })

  it('never repeats a question within one paper', () => {
    const questions = bank({ single: 10, multi: 5, judge: 5, short: 5 })
    const r = buildPaper(questions, cfg({ singleCount: 5, multiCount: 3, judgeCount: 3, shortCount: 3 }), mulberry32(7))
    expect(r.ok).toBe(true)
    if (r.ok) {
      const ids = r.questions.map((q) => q.id)
      expect(new Set(ids).size).toBe(ids.length)
      expect(ids).toHaveLength(14)
    }
  })
})

describe('buildPaper / insufficient bank', () => {
  it('fails with an explanatory error instead of shrinking the paper', () => {
    const questions = bank({ single: 2, multi: 1, judge: 1, short: 1 })
    const r = buildPaper(questions, cfg({ singleCount: 99 }), mulberry32(1))
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toMatch(/题库数量不足/)
      expect(r.error).toMatch(/single 需要 99 题，题库仅有 2 题/)
      expect(r.missing).toHaveLength(1)
      expect(r.missing[0]).toEqual({ type: 'single', requested: 99, available: 2 })
    }
  })

  it('reports every unsatisfiable type at once', () => {
    const questions = bank({ single: 1, multi: 0, judge: 0, short: 0 })
    const r = buildPaper(questions, cfg({ singleCount: 5, multiCount: 3, judgeCount: 2, shortCount: 4 }), mulberry32(1))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.missing).toHaveLength(4)
  })

  it('does not loop forever when a type is completely absent', () => {
    // Old code had `while (need > 0)` which spun forever with no subjective questions.
    const questions = bank({ single: 4, multi: 2, judge: 2 })
    const started = Date.now()
    const r = buildPaper(questions, cfg({ shortCount: 3 }), mulberry32(1))
    expect(Date.now() - started).toBeLessThan(2000)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.missing[0].type).toBe('short')
  })

  it('respects the chapter filter when validating availability', () => {
    const questions = [...bank({ single: 5 }, '导论'), ...bank({ single: 1 }, '第一章')]
    const ok = buildPaper(
      questions,
      cfg({ singleCount: 5, multiCount: 0, judgeCount: 0, shortCount: 0, chapters: ['导论'] }),
      mulberry32(1),
    )
    expect(ok.ok).toBe(true)
    const bad = buildPaper(
      questions,
      cfg({ singleCount: 2, multiCount: 0, judgeCount: 0, shortCount: 0, chapters: ['第一章'] }),
      mulberry32(1),
    )
    expect(bad.ok).toBe(false)
  })

  it('succeeds with an exact-fit bank', () => {
    const questions = bank({ single: 2, multi: 1, judge: 1, short: 1 })
    const r = buildPaper(questions, cfg(), mulberry32(3))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.questions).toHaveLength(5)
  })

  it('treats zero-count types as satisfied', () => {
    const questions = bank({ single: 2 })
    const r = buildPaper(questions, cfg({ singleCount: 2, multiCount: 0, judgeCount: 0, shortCount: 0 }), mulberry32(1))
    expect(r.ok).toBe(true)
  })
})
