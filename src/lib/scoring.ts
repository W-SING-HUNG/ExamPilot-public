import type { Question } from './types'

export type ParsedUserAnswer = { letters: string[] } | { boolean: boolean } | { text: string }

/** Normalize a user-provided answer string into structured form. */
export function parseUserAnswer(q: Question, raw: string | null | undefined): ParsedUserAnswer | null {
  if (raw == null) return null
  const s = String(raw).trim().toUpperCase()
  if (!s) return null
  if (q.type === 'judge') {
    const map: Record<string, boolean> = {
      正确: true,
      对: true,
      TRUE: true,
      T: true,
      '√': true,
      错误: false,
      错: false,
      FALSE: false,
      F: false,
      '×': false,
    }
    const key = Object.keys(map).find((k) => k.toUpperCase() === s)
    if (key) return { boolean: map[key] }
    // judge answer might be given as letter A/B meaning 正确/错误? Bank uses 正确/错误 only.
    const letters = s.match(/[AB]/g)
    if (letters && letters.length === 1) return { boolean: letters[0] === 'A' }
    return null
  }
  if (q.type === 'single' || q.type === 'multi') {
    const letters = (s.match(/[A-Z]/g) || []).filter(Boolean)
    if (letters.length === 0) return null
    return { letters: Array.from(new Set(letters)) }
  }
  // subjective
  return { text: String(raw) }
}

export function isAnswerBlank(q: Question, raw: string | null | undefined): boolean {
  const p = parseUserAnswer(q, raw)
  if (!p) return true
  if ('letters' in p) return p.letters.length === 0
  if ('boolean' in p) return false
  return p.text.trim().length === 0
}

/** Strictly score an objective question. Multi-choice requires exact set equality. */
export function scoreAnswer(q: Question, raw: string | null | undefined): boolean | null {
  if (!q.hasOfficialAnswer) return null // subjective: not auto-scored
  const parsed = parseUserAnswer(q, raw)
  if (!parsed) return null
  if (q.type === 'single') {
    if (!('letters' in parsed) || parsed.letters.length !== 1) return false
    return parsed.letters[0] === (q.answerNorm as string)
  }
  if (q.type === 'multi') {
    if (!('letters' in parsed)) return false
    const expected = Array.from(new Set((q.answerNorm as string).split('')))
    const got = parsed.letters.slice().sort()
    const exp = expected.slice().sort()
    if (expected.length !== got.length) return false
    return exp.join('') === got.join('')
  }
  if (q.type === 'judge') {
    if (!('boolean' in parsed)) return false
    return parsed.boolean === (q.answerNorm as boolean)
  }
  return null
}

/** Display the official answer text for objective questions. */
export function answerText(q: Question): string {
  if (q.type === 'single' || q.type === 'multi') return (q.answerNorm as string) ?? ''
  if (q.type === 'judge') return (q.answerNorm as boolean) ? '正确' : '错误'
  return '（无标准答案，可提交 AI 参考评阅）'
}

// The bank stores answerNorm for judge as boolean, for single/multi as string.
// answer is always a string; provide answerNormText convenience.
export function formatAnswerNorm(ans: string | boolean | null): string {
  if (ans === null || ans === undefined) return ''
  if (typeof ans === 'boolean') return ans ? '正确' : '错误'
  return ans
}
