import { describe, it, expect } from 'vitest'
import { buildPaper } from './scheduler'
import { allQuestions } from './bank'
import { formatAnswerNorm } from './scoring'
import { displayUserAnswer, displayCorrectAnswer, UNANSWERED_LABEL } from './answer-display'

/**
 * Regression tests for two user-visible defects found by independent testing.
 *
 *  1. 判断题复盘 rendered "你的作答：true" — the raw stored wire value leaked into
 *     the UI instead of 正确 / 错误 / 未作答.
 *  2. On the 17-question public sample bank the first mock exam could not start:
 *     the shipped defaults demand 20 single + 10 multi + 10 judge + 1 subjective.
 */

// ---------------------------------------------------------------------------
// 1. Judge answer display
// ---------------------------------------------------------------------------

describe('answer display / judge answers never leak the wire format', () => {
  it('maps judge wire values to 正确 / 错误', () => {
    expect(displayUserAnswer('judge', 'true')).toBe('正确')
    expect(displayUserAnswer('judge', 'false')).toBe('错误')
  })

  it('never returns the raw "true" / "false" strings for a judge question', () => {
    for (const raw of ['true', 'false']) {
      const shown = displayUserAnswer('judge', raw)
      expect(shown).not.toBe('true')
      expect(shown).not.toBe('false')
      expect(['正确', '错误']).toContain(shown)
    }
  })

  it('treats null, undefined, empty and unknown values as 未作答', () => {
    expect(displayUserAnswer('judge', null)).toBe(UNANSWERED_LABEL)
    expect(displayUserAnswer('judge', undefined)).toBe(UNANSWERED_LABEL)
    expect(displayUserAnswer('judge', '')).toBe(UNANSWERED_LABEL)
    expect(displayUserAnswer('judge', 'maybe')).toBe(UNANSWERED_LABEL)
    expect(UNANSWERED_LABEL).toBe('未作答')
  })

  it('a "false" answer is NOT reported as unanswered (the old || bug)', () => {
    // The old code did `mine || '（未作答）'`; a judge answer of false is falsy in
    // that position and would be shown as unanswered. It must be 错误.
    expect(displayUserAnswer('judge', 'false')).toBe('错误')
    expect(displayUserAnswer('judge', 'false')).not.toBe(UNANSWERED_LABEL)
  })

  it('passes choice answers through unchanged', () => {
    expect(displayUserAnswer('single', 'B')).toBe('B')
    expect(displayUserAnswer('multi', 'ABD')).toBe('ABD')
    expect(displayUserAnswer('single', null)).toBe(UNANSWERED_LABEL)
    expect(displayUserAnswer('multi', '')).toBe(UNANSWERED_LABEL)
  })

  it('renders subjective answers as their text', () => {
    expect(displayUserAnswer('short', '我的作答')).toBe('我的作答')
    expect(displayUserAnswer('material', '材料分析作答')).toBe('材料分析作答')
  })

  it('renders correct answers: booleans to 正确/错误, letters as-is, null as 无标准答案', () => {
    expect(displayCorrectAnswer(true)).toBe('正确')
    expect(displayCorrectAnswer(false)).toBe('错误')
    expect(displayCorrectAnswer('BC')).toBe('BC')
    expect(displayCorrectAnswer(null)).toBe('无标准答案')
    expect(displayCorrectAnswer(undefined)).toBe('无标准答案')
  })

  it('displayCorrectAnswer agrees with formatAnswerNorm for non-null values', () => {
    for (const v of [true, false, 'A', 'ABCD']) {
      expect(displayCorrectAnswer(v)).toBe(formatAnswerNorm(v))
    }
  })
})

// ---------------------------------------------------------------------------
// 2. Mock exam defaults must be startable on whatever bank is installed
// ---------------------------------------------------------------------------

describe('mock exam / first-run defaults vs installed bank', () => {
  const byType = (t: string) => allQuestions.filter((q) => q.type === t).length
  const subjective = allQuestions.filter((q) => q.type === 'short' || q.type === 'material').length

  it('the shipped full-exam defaults are refused on a small bank (documents the defect)', () => {
    const fullExamDefaults = {
      singleCount: 20,
      multiCount: 10,
      judgeCount: 10,
      shortCount: 1,
      chapters: 'all' as const,
    }
    const res = buildPaper(allQuestions, fullExamDefaults)
    if (allQuestions.length < 20) {
      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.missing.length).toBeGreaterThan(0)
        expect(res.error).toContain('题库数量不足')
      }
    } else {
      // A large bank can satisfy them; the defect was bank-size dependent.
      expect(res.ok).toBe(true)
    }
  })

  it('a paper fitted to the bank always starts, with no invented or repeated questions', () => {
    const fitted = {
      singleCount: Math.min(20, byType('single')),
      multiCount: Math.min(10, byType('multi')),
      judgeCount: Math.min(10, byType('judge')),
      shortCount: Math.min(1, subjective),
      chapters: 'all' as const,
    }
    const res = buildPaper(allQuestions, fitted)
    expect(res.ok).toBe(true)
    if (res.ok) {
      const ids = res.questions.map((q) => q.id)
      expect(new Set(ids).size).toBe(ids.length) // no repeats
      for (const q of res.questions) {
        expect(allQuestions.some((a) => a.id === q.id)).toBe(true) // no inventions
      }
      expect(res.questions.length).toBeGreaterThan(0)
      if (fitted.singleCount > 0)
        expect(res.questions.filter((q) => q.type === 'single')).toHaveLength(fitted.singleCount)
      if (fitted.multiCount > 0) expect(res.questions.filter((q) => q.type === 'multi')).toHaveLength(fitted.multiCount)
      if (fitted.judgeCount > 0) expect(res.questions.filter((q) => q.type === 'judge')).toHaveLength(fitted.judgeCount)
    }
  })

  it('a fully-fitted paper draws the whole bank exactly once', () => {
    const res = buildPaper(allQuestions, {
      singleCount: byType('single'),
      multiCount: byType('multi'),
      judgeCount: byType('judge'),
      shortCount: subjective,
      chapters: 'all' as const,
    })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.questions).toHaveLength(allQuestions.length)
      expect(new Set(res.questions.map((q) => q.id)).size).toBe(allQuestions.length)
    }
  })

  it('an oversized SAVED configuration is reported, not silently shrunk', () => {
    const oversized = { singleCount: 999, multiCount: 0, judgeCount: 0, shortCount: 0, chapters: 'all' as const }
    const res = buildPaper(allQuestions, oversized)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.missing[0]).toMatchObject({ type: 'single', requested: 999 })
  })

  it('the sample bank has every type needed for a meaningful first exam', () => {
    // Guards the fit rule's assumptions: if a type disappeared, the fitter would
    // silently drop it and the first exam would be less representative.
    expect(byType('single')).toBeGreaterThan(0)
    expect(byType('multi')).toBeGreaterThan(0)
    expect(byType('judge')).toBeGreaterThan(0)
    expect(subjective).toBeGreaterThan(0)
  })
})
