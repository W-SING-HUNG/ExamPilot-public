import { describe, it, expect } from 'vitest'
import { gradeMockSubmission } from './mock-grading'
import type { MockConfig, Question, QuestionType } from './types'

const mkq = (id: string, type: QuestionType): Question => ({
  id,
  chapter: '导论',
  chapterIndex: 0,
  type,
  bankNo: 1,
  pageStart: 1,
  pageEnd: 1,
  stem: id,
  options: type === 'single' || type === 'multi' ? ['a', 'b', 'c', 'd'] : [],
  answer: type === 'judge' ? '正确' : type === 'multi' ? 'AC' : 'A',
  answerNorm: type === 'judge' ? true : type === 'multi' ? 'AC' : 'A',
  hasOfficialAnswer: type !== 'short' && type !== 'material',
  isFlagged: false,
  flagReason: '',
})

const config: MockConfig = {
  singleCount: 2,
  multiCount: 1,
  judgeCount: 1,
  shortCount: 1,
  singleScore: 1,
  multiScore: 2,
  judgeScore: 1,
  shortScore: 15,
  durationMin: 30,
  chapters: 'all',
}

const paper: Question[] = [
  mkq('s1', 'single'),
  mkq('s2', 'single'),
  mkq('m1', 'multi'),
  mkq('j1', 'judge'),
  mkq('q1', 'short'),
]

describe('gradeMockSubmission / blank objective answers', () => {
  it('marks a blank objective answer as unanswered, not wrong', () => {
    const r = gradeMockSubmission(paper, { s1: null }, config)
    expect(r.perQuestion.s1).toEqual({ isCorrect: null, points: 0, unanswered: true })
    // NOT counted as wrong
    expect(r.perQuestion.s1.isCorrect).not.toBe(false)
  })

  it('never persists blank objective answers (no wrong-bank pollution)', () => {
    const r = gradeMockSubmission(paper, { s1: null, s2: '', m1: null, j1: null }, config)
    expect(r.skipped.sort()).toEqual(['j1', 'm1', 's1', 's2'])
    expect(r.persisted).toHaveLength(0)
  })

  it('treats blank and wrong distinctly in the same paper', () => {
    const r = gradeMockSubmission(paper, { s1: 'B', s2: null }, config) // s1 wrong, s2 blank
    expect(r.perQuestion.s1).toEqual({ isCorrect: false, points: 0, unanswered: false })
    expect(r.perQuestion.s2).toEqual({ isCorrect: null, points: 0, unanswered: true })
    expect(r.persisted.map((p) => p.q.id)).toEqual(['s1'])
    // s2 is blank, and the questions not supplied at all are blank too.
    expect(r.skipped).toEqual(['s2', 'm1', 'j1'])
    expect(r.skipped).not.toContain('s1')
  })

  it('excludes blank answers from the wrong-question count entirely', () => {
    const allBlank = gradeMockSubmission(paper, {}, config)
    const wrong = Object.values(allBlank.perQuestion).filter((p) => p.isCorrect === false)
    expect(wrong).toHaveLength(0)
    expect(allBlank.skipped).toHaveLength(4) // 4 objective questions
  })

  it('counts answered vs unanswered separately', () => {
    const r = gradeMockSubmission(paper, { s1: 'A', s2: null, m1: 'AC', j1: null, q1: '答' }, config)
    expect(r.answeredCount).toBe(3)
    expect(r.unansweredCount).toBe(2)
  })
})

describe('gradeMockSubmission / score breakdown', () => {
  it('separates auto-graded objective points from ungraded subjective points', () => {
    const r = gradeMockSubmission(paper, { s1: 'A', s2: 'A', m1: 'AC', j1: '正确', q1: '答' }, config)
    expect(r.objectiveMaxScore).toBe(1 + 1 + 2 + 1) // 5
    expect(r.subjectiveMaxScore).toBe(15)
    expect(r.maxScore).toBe(20)
    expect(r.score).toBe(5) // only objective points
  })

  it('never awards points for subjective questions', () => {
    const r = gradeMockSubmission(paper, { q1: '我的作答' }, config)
    expect(r.perQuestion.q1).toEqual({ isCorrect: null, points: 0, unanswered: false })
    expect(r.score).toBe(0)
  })

  it('distinguishes a subjective blank from a subjective answer', () => {
    const answered = gradeMockSubmission(paper, { q1: '答案' }, config)
    const blank = gradeMockSubmission(paper, { q1: null }, config)
    expect(answered.perQuestion.q1.unanswered).toBe(false)
    expect(blank.perQuestion.q1.unanswered).toBe(true)
    // A blank subjective question is not queued as a training attempt.
    expect(answered.subjective).toHaveLength(1)
    expect(blank.subjective).toHaveLength(0)
  })

  it('multi-choice requires an exact set match', () => {
    const correct = gradeMockSubmission(paper, { m1: 'AC' }, config)
    const partial = gradeMockSubmission(paper, { m1: 'A' }, config)
    const over = gradeMockSubmission(paper, { m1: 'ACD' }, config)
    expect(correct.perQuestion.m1.points).toBe(2)
    expect(partial.perQuestion.m1.isCorrect).toBe(false)
    expect(over.perQuestion.m1.isCorrect).toBe(false)
  })

  it('reports a partial score that is lower than the full-paper total', () => {
    const r = gradeMockSubmission(paper, { s1: 'A', s2: null, m1: null, j1: null, q1: null }, config)
    expect(r.score).toBe(1)
    expect(r.objectiveMaxScore).toBe(5)
    expect(r.maxScore).toBe(20)
    // The graded rate uses the objective max, not the paper total.
    const gradedRate = r.score / r.objectiveMaxScore
    const naiveRate = r.score / r.maxScore
    expect(gradedRate).toBeGreaterThan(naiveRate)
  })
})
