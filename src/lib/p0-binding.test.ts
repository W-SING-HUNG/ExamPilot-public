import { describe, it, expect } from 'vitest'
import { allQuestions, usingSampleBank } from './bank'
import { scoreAnswer, answerText } from './scoring'
// The sample bank JSON is imported through Vite's JSON support, so this test
// needs no Node filesystem types (the project deliberately ships without
// @types/node, and tsconfig only includes `src` + vite/client).
import rawBank from '../../data/sample-bank.json'

/** Shape of the sample-bank JSON we rely on here. */
interface RawBank {
  isSample?: boolean
  questions: Array<{
    id: string
    type: string
    chapter: string
    bankNo: number
    stem: string
    options?: string[]
    answerNorm: string | boolean | null
    hasOfficialAnswer: boolean
    isFlagged: boolean
  }>
}

/**
 * P0 — full-chain binding verification for every question in the installed bank.
 *
 * An independent tester found 16 of 17 sample questions consistent and could not
 * reach a conclusion on the remaining one. This closes that out by proving, for
 * EVERY question, that ID / stem / options / answer stay bound across:
 *
 *   source JSON  →  loader normalisation  →  scoring  →  result
 *
 * It also distinguishes the four things that can look like "answer misalignment":
 *   - display truncation        (shown elsewhere: BankLookup tests)
 *   - subjective with no answer (asserted here: never auto-scored)
 *   - different test conventions (asserted here: wire format is explicit)
 *   - a REAL answer/ID mismatch (would fail the identity assertions below)
 *
 * Read-only: it asserts, it never rewrites the bank.
 */

const raw = rawBank as unknown as RawBank
const rawById = new Map(raw.questions.map((q) => [q.id, q]))

describe('P0 / per-question full-chain binding', () => {
  it('reports which bank is under test', () => {
    // Surfaced as an assertion rather than a console log so lint stays at zero
    // warnings, and so the run records the bank it actually verified.
    expect(typeof usingSampleBank, 'the loader states which bank it uses').toBe('boolean')
    expect(allQuestions.length, 'the installed bank has questions').toBeGreaterThan(0)
    if (usingSampleBank) {
      expect(allQuestions.length, 'the sample bank holds 17 questions').toBe(17)
    }
  })

  it('the loader exposes exactly the questions that are in the source JSON', () => {
    if (!usingSampleBank) {
      // On a private bank the loader reads data/local-bank.json, not the sample.
      expect(allQuestions.length).toBeGreaterThan(0)
      return
    }
    expect(allQuestions).toHaveLength(raw.questions.length)
    const loadedIds = new Set(allQuestions.map((q) => q.id))
    for (const q of raw.questions) {
      expect(loadedIds.has(q.id), `loaded bank contains ${q.id}`).toBe(true)
    }
  })

  it('every question keeps its ID, stem, options, chapter and answer through the loader', () => {
    if (!usingSampleBank) return
    for (const q of allQuestions) {
      const r = rawById.get(q.id)
      expect(r, `source JSON has ${q.id}`).toBeTruthy()
      if (!r) continue
      expect(q.stem, `${q.id} stem`).toBe(r.stem)
      expect(q.type, `${q.id} type`).toBe(r.type)
      expect(q.chapter, `${q.id} chapter`).toBe(r.chapter)
      expect(q.bankNo, `${q.id} bankNo`).toBe(r.bankNo)
      expect(q.options ?? [], `${q.id} options`).toEqual(r.options ?? [])
      expect(q.answerNorm, `${q.id} answerNorm`).toBe(r.answerNorm)
      expect(q.hasOfficialAnswer, `${q.id} hasOfficialAnswer`).toBe(r.hasOfficialAnswer)
      expect(q.isFlagged, `${q.id} isFlagged`).toBe(r.isFlagged)
    }
  })

  it('every objective question grades its own answer as correct and a wrong one as false', () => {
    for (const q of allQuestions) {
      if (q.type === 'short' || q.type === 'material') continue
      expect(q.answerNorm, `${q.id} has an answer`).not.toBeNull()

      // The UI wire format: letters for choice, 'true'/'false' for judge.
      const wire = q.type === 'judge' ? (q.answerNorm === true ? 'true' : 'false') : String(q.answerNorm)

      // Correct answer → true.
      expect(scoreAnswer(q, wire), `${q.id} correct answer grades true`).toBe(true)

      // Unanswered → null (never false, never counted as wrong).
      expect(scoreAnswer(q, null), `${q.id} unanswered grades null`).toBeNull()

      // A deliberately wrong answer → false.
      let wrongWire
      if (q.type === 'judge') {
        wrongWire = wire === 'true' ? 'false' : 'true'
      } else {
        const answerLetters = String(q.answerNorm).split('')
        const allLetters = q.options.map((_, i) => String.fromCharCode(65 + i))
        wrongWire = allLetters.find((L) => !answerLetters.includes(L))
      }
      if (wrongWire !== undefined) {
        expect(scoreAnswer(q, wrongWire), `${q.id} wrong answer grades false`).toBe(false)
      }
    }
  })

  it('every subjective question never auto-scores and never claims an official answer', () => {
    const subs = allQuestions.filter((q) => q.type === 'short' || q.type === 'material')
    for (const q of subs) {
      expect(scoreAnswer(q, '任意作答文本'), `${q.id} is never auto-graded`).toBeNull()
      expect(q.hasOfficialAnswer, `${q.id} has no official answer`).toBe(false)
      expect(q.isFlagged, `${q.id} is flagged as unverified`).toBe(true)
      expect(q.answerNorm, `${q.id} answerNorm is null`).toBeNull()
      expect(answerText(q), `${q.id} answer text states no official answer`).toContain('无标准答案')
    }
  })

  it('every question has a unique ID (identity never collides)', () => {
    const ids = allQuestions.map((q) => q.id)
    expect(new Set(ids).size, 'unique ids').toBe(ids.length)
  })

  it('sample bank stems are unique, so a stem identifies exactly one question', () => {
    // The SAMPLE bank is hand-written for the public build, so its stems must be
    // unique. A full course bank legitimately repeats a stem across chapters or
    // variants (the real bank has a few such groups), which is why this stricter
    // check is scoped to the sample rather than asserted for every bank.
    if (!usingSampleBank) return
    const stems = allQuestions.map((q) => q.stem.trim())
    expect(new Set(stems).size, 'unique stems in the sample bank').toBe(stems.length)
  })

  it('choice answers reference only options that exist', () => {
    for (const q of allQuestions) {
      if (q.type !== 'single' && q.type !== 'multi') continue
      const letters = String(q.answerNorm).split('')
      expect(letters.length, `${q.id} has at least one letter`).toBeGreaterThan(0)
      for (const L of letters) {
        const idx = L.charCodeAt(0) - 65
        expect(idx, `${q.id} letter ${L} is within its ${q.options.length} options`).toBeLessThan(q.options.length)
        expect(idx, `${q.id} letter ${L} is non-negative`).toBeGreaterThanOrEqual(0)
      }
      // No duplicate letters in a multi answer.
      expect(new Set(letters).size, `${q.id} has no duplicate letters`).toBe(letters.length)
    }
  })

  it('judge answers are actual booleans (the one type with a boolean wire format)', () => {
    for (const q of allQuestions.filter((x) => x.type === 'judge')) {
      expect(typeof q.answerNorm, `${q.id} judge answerNorm is boolean`).toBe('boolean')
    }
  })

  it('the material question keeps its multi-part structure and is graded as subjective', () => {
    const materials = allQuestions.filter((q) => q.type === 'material')
    expect(materials.length, 'a material question exists').toBeGreaterThan(0)
    for (const m of materials) {
      // Its stem spans several lines (材料 paragraphs + 问题).
      expect(m.stem.split('\n').length, `${m.id} has multiple lines`).toBeGreaterThan(1)
      // It must NOT be auto-graded, and must not masquerade as an objective item.
      expect(scoreAnswer(m, '任意作答'), `${m.id} not auto-graded`).toBeNull()
      expect(m.hasOfficialAnswer, `${m.id} no official answer`).toBe(false)
    }
  })

  it('17/17 summary: every question passes all binding checks', () => {
    if (!usingSampleBank) {
      // Still assert the invariant set above ran for the installed bank.
      expect(allQuestions.length).toBeGreaterThan(0)
      return
    }
    const results = allQuestions.map((q) => {
      const r = rawById.get(q.id)
      const isObjective = q.type !== 'short' && q.type !== 'material'
      const checks = []
      checks.push(!!r)
      checks.push(!!r && r.stem === q.stem)
      checks.push(!!r && JSON.stringify(r.options ?? []) === JSON.stringify(q.options ?? []))
      checks.push(!!r && r.answerNorm === q.answerNorm)
      if (isObjective) {
        const wire = q.type === 'judge' ? (q.answerNorm === true ? 'true' : 'false') : String(q.answerNorm)
        checks.push(scoreAnswer(q, wire) === true)
        checks.push(scoreAnswer(q, null) === null)
      } else {
        checks.push(scoreAnswer(q, 'x') === null)
        checks.push(q.hasOfficialAnswer === false)
      }
      return { id: q.id, ok: checks.every(Boolean) }
    })
    const failing = results.filter((r) => !r.ok)
    expect(failing.map((f) => f.id)).toEqual([])
    expect(results).toHaveLength(17)
    expect(results.filter((r) => r.ok)).toHaveLength(17)
  })

  it('the loader reports the sample bank exactly when the sample is in use', () => {
    // `usingSampleBank` is derived from identity with the bundled sample; it must
    // agree with the raw file's own isSample flag.
    if (usingSampleBank) {
      expect(raw.isSample, 'the sample JSON self-identifies as a sample').toBe(true)
    }
  })
})
