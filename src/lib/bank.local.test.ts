import { describe, it, expect } from 'vitest'
import { allQuestions, objectiveQuestions, bank, usingSampleBank } from './bank'

/**
 * Full-bank validation.
 *
 * Runs only when a full course bank has been installed with `npm run bank:local`;
 * with the bundled sample bank every case is skipped, so a clean checkout stays
 * green without any private file.
 *
 * The assertions describe the PROPERTIES a valid bank must have — unique ids,
 * contiguous in-chapter numbering, intact stem-option-answer binding, and
 * subjective items that never claim an official answer — rather than the
 * composition of any particular bank. Encoding one specific bank's question
 * counts here would disclose details of a document this project has no licence
 * to redistribute, and would make the suite fail for any other valid bank.
 */
const maybeDescribe = usingSampleBank ? describe.skip : describe

maybeDescribe('full bank integrity', () => {
  it('is the installed full bank, not the demo bank', () => {
    expect(usingSampleBank).toBe(false)
  })

  it('has questions with unique ids', () => {
    expect(allQuestions.length).toBeGreaterThan(0)
    expect(new Set(allQuestions.map((q) => q.id)).size).toBe(allQuestions.length)
  })

  it('reports countsByType consistent with the questions it contains', () => {
    const counts = { single: 0, multi: 0, judge: 0, short: 0, material: 0 }
    for (const q of allQuestions) counts[q.type] += 1
    expect(bank.countsByType).toEqual(counts)
    const { single, multi, judge, short, material } = counts
    expect(single + multi + judge + short + material).toBe(allQuestions.length)
  })

  it('chapter numbers are contiguous from 1 within each chapter', () => {
    const byCh = new Map<string, number[]>()
    for (const q of objectiveQuestions) {
      const arr = byCh.get(q.chapter) ?? []
      arr.push(q.bankNo)
      byCh.set(q.chapter, arr)
    }
    for (const [ch, nums] of byCh) {
      const sorted = nums.slice().sort((a, b) => a - b)
      expect(sorted[0], ch).toBe(1)
      for (let i = 1; i < sorted.length; i++) expect(sorted[i] - sorted[i - 1], ch).toBe(1)
    }
  })

  it('objective questions pass stem-option-answer binding', () => {
    for (const q of objectiveQuestions) {
      expect(q.isFlagged, q.id).toBe(false)
      expect(q.answerNorm, q.id).not.toBe(null)
      if (q.type === 'single' || q.type === 'multi') {
        const letters = String(q.answerNorm).split('')
        expect(letters.length, q.id).toBeGreaterThan(0)
        for (const l of letters) {
          expect(l.charCodeAt(0) - 65, `${q.id} letter ${l}`).toBeLessThan(q.options.length)
        }
      }
    }
  })

  it('subjective questions are all flagged as having no official answer', () => {
    const subj = allQuestions.filter((q) => q.type === 'short' || q.type === 'material')
    expect(subj.length).toBeGreaterThan(0)
    for (const q of subj) {
      expect(q.hasOfficialAnswer, q.id).toBe(false)
      expect(q.isFlagged, q.id).toBe(true)
    }
  })
})
