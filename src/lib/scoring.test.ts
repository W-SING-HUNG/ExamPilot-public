import { describe, it, expect } from 'vitest'
import { scoreAnswer, isAnswerBlank } from './scoring'
import type { Question } from './types'

const qSingle: Question = {
  id: 'S001-x-导论',
  chapter: '导论',
  chapterIndex: 0,
  type: 'single',
  bankNo: 1,
  pageStart: 2,
  pageEnd: 2,
  stem: '目标',
  options: ['a', 'b', 'c', 'd'],
  answer: 'B',
  answerNorm: 'B',
  hasOfficialAnswer: true,
  isFlagged: false,
  flagReason: '',
}
const qMulti: Question = {
  id: 'M024-x-第一章',
  chapter: '第一章',
  chapterIndex: 1,
  type: 'multi',
  bankNo: 24,
  pageStart: 23,
  pageEnd: 24,
  stem: '多选题',
  options: ['一', '二', '三', '四', '五', '六'],
  answer: 'ABCDEF',
  answerNorm: 'ABCDEF',
  hasOfficialAnswer: true,
  isFlagged: false,
  flagReason: '',
}
const qJudge: Question = {
  id: 'J040-x-第二章',
  chapter: '第二章',
  chapterIndex: 2,
  type: 'judge',
  bankNo: 40,
  pageStart: 30,
  pageEnd: 30,
  stem: '判断',
  options: [],
  answer: '正确',
  answerNorm: true,
  hasOfficialAnswer: true,
  isFlagged: false,
  flagReason: '',
}
const qShort: Question = {
  id: 'Q001-x-全册',
  chapter: '全册',
  chapterIndex: -1,
  type: 'short',
  bankNo: 1,
  pageStart: 245,
  pageEnd: 245,
  stem: '请回答',
  options: [],
  answer: null,
  answerNorm: null,
  hasOfficialAnswer: false,
  isFlagged: true,
  flagReason: '无官方标准答案',
}

describe('scoring', () => {
  it('scores single answers strictly', () => {
    expect(scoreAnswer(qSingle, 'B')).toBe(true)
    expect(scoreAnswer(qSingle, 'b')).toBe(true)
    expect(scoreAnswer(qSingle, 'A')).toBe(false)
    expect(scoreAnswer(qSingle, 'AB')).toBe(false) // two letters on single
    expect(scoreAnswer(qSingle, '')).toBe(null)
    expect(scoreAnswer(qSingle, null)).toBe(null)
  })

  it('scores multi-choice with EXACT set equality — no wrong/lost selection passes', () => {
    expect(scoreAnswer(qMulti, 'ABCDEF')).toBe(true)
    expect(scoreAnswer(qMulti, 'ABCDE')).toBe(false) // missing F
    expect(scoreAnswer(qMulti, 'ABCDEFG')).toBe(false) // extra
    expect(scoreAnswer(qMulti, 'FEDCBA')).toBe(true) // same set
    expect(scoreAnswer(qMulti, 'ABC')).toBe(false)
    expect(scoreAnswer(qMulti, '')).toBe(null)
  })

  it('scores judge questions', () => {
    expect(scoreAnswer(qJudge, '正确')).toBe(true)
    expect(scoreAnswer(qJudge, '√')).toBe(true)
    expect(scoreAnswer(qJudge, '错误')).toBe(false)
    expect(scoreAnswer(qJudge, 'B')).toBe(false)
  })

  it('does not auto-score subjective questions', () => {
    expect(scoreAnswer(qShort, '长期坚持')).toBe(null)
  })

  it('detects blank answers', () => {
    expect(isAnswerBlank(qSingle, '')).toBe(true)
    expect(isAnswerBlank(qSingle, null)).toBe(true)
    expect(isAnswerBlank(qMulti, '')).toBe(true)
    expect(isAnswerBlank(qShort, '')).toBe(true)
    expect(isAnswerBlank(qShort, '内容')).toBe(false)
    expect(isAnswerBlank(qSingle, 'A')).toBe(false)
  })

  it('trims single choice letter', () => {
    expect(scoreAnswer(qSingle, ' B ')).toBe(true)
  })
})
