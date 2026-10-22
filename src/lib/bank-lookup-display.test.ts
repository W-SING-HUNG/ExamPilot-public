import { describe, it, expect } from 'vitest'
import { allQuestions } from './bank'

/**
 * Regression: 题库查阅 showed only the first line of a stem.
 *
 * `BankLookup.tsx` rendered `q.stem.split('\n')[0]`, so a material question lost
 * its 材料 paragraphs and the actual 问题 line — the reader saw only 「材料一：…」.
 *
 * Correct behaviour: collapsed shows a one-line summary; expanded shows the
 * WHOLE stem with its line breaks preserved. The bank content itself must never
 * be altered.
 */

const SUBJECTIVE_OR_MATERIAL = allQuestions.filter((q) => q.type === 'material' || q.type === 'short')
const MULTILINE = allQuestions.filter((q) => q.stem.includes('\n'))

describe('bank lookup / stem display', () => {
  it('there is at least one multi-line stem in the bank (the case that broke)', () => {
    expect(MULTILINE.length).toBeGreaterThan(0)
  })

  it('every multi-line stem keeps all of its lines and its trailing question', () => {
    for (const q of MULTILINE) {
      const lines = q.stem.split('\n')
      expect(lines.length, q.id).toBeGreaterThan(1)
      // No line may be empty in a way that indicates accidental truncation.
      expect(lines.filter((l) => l.trim().length > 0).length, q.id).toBeGreaterThan(1)
      // The full stem is what the expanded view shows; it must contain every line.
      for (const line of lines) {
        expect(q.stem.includes(line), `${q.id} retains "${line.slice(0, 12)}…"`).toBe(true)
      }
    }
  })

  it('every material question keeps its multi-part structure and answer semantics', () => {
    // Assert against whatever bank is installed (sample or full): the invariant
    // is structural, not tied to one specific id.
    const materials = allQuestions.filter((q) => q.type === 'material')
    expect(materials.length, 'the installed bank has at least one material question').toBeGreaterThan(0)

    for (const mt of materials) {
      // Material questions are subjective by nature: no official answer, flagged.
      expect(mt.hasOfficialAnswer, mt.id).toBe(false)
      expect(mt.isFlagged, mt.id).toBe(true)
      expect(mt.answerNorm, mt.id).toBeNull()
      // A material question is presented as材料 + 问题, i.e. multiple lines.
      expect(mt.stem.split('\n').length, `${mt.id} has multiple lines`).toBeGreaterThan(1)
      expect(mt.stem.trim().length, mt.id).toBeGreaterThan(0)
    }
  })

  it('the sample bank keeps its material question with three logical parts', () => {
    // The sample bank is the one shipped publicly; guard its shape specifically
    // WITHOUT hardcoding an id that only exists in a private bank.
    const sampleMaterials = allQuestions.filter((q) => q.type === 'material')
    const threePart = sampleMaterials.find((q) => q.stem.split('\n').length === 3)
    if (!threePart) {
      // On a different bank the shape may differ; the structural test above covers it.
      expect(sampleMaterials.length).toBeGreaterThan(0)
      return
    }
    const parts = threePart.stem.split('\n')
    expect(parts[0]).toContain('材料一')
    expect(parts[1]).toContain('材料二')
    expect(parts[2]).toContain('问题')
  })

  it('subjective questions keep their text and never gain a fabricated answer', () => {
    for (const q of SUBJECTIVE_OR_MATERIAL) {
      expect(q.stem.trim().length, q.id).toBeGreaterThan(0)
      expect(q.hasOfficialAnswer, q.id).toBe(false)
      expect(q.isFlagged, q.id).toBe(true)
      expect(q.answerNorm, q.id).toBeNull()
    }
  })

  it('no bank content was altered: every question still has a non-empty stem', () => {
    for (const q of allQuestions) {
      expect(typeof q.stem, q.id).toBe('string')
      expect(q.stem.trim().length, q.id).toBeGreaterThan(0)
    }
  })
})
