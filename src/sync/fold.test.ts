import { describe, expect, it } from 'vitest'
import { foldLog, baselineKey, type LogOp } from './fold'
import { applyAttempt, applySubjectiveAttempt, freshRecord, mulberry32 } from '../lib/scheduler'
import type { HistoryEntry, QRecord } from '../lib/types'

const h = (id: string, qid: string, isCorrect: boolean | null, t: number, sessionId = 's'): HistoryEntry => ({
  id,
  qid,
  mode: 'practice',
  sessionId,
  answer: isCorrect === null ? '主观作答' : 'A',
  isCorrect,
  submittedAt: t,
  usedAI: false,
})
let seq = 0
const op = (
  kind: LogOp['kind'],
  body: unknown,
  clientId = 'c1',
  s: number | null = ++seq,
  id = kind + '-' + seq + '-' + Math.random(),
): LogOp => ({
  id,
  kind,
  seq: s,
  clientId,
  body,
})

/** The original single-device write path (StoreContext.submitAnswer / recordAttempt). */
function sequential(entries: HistoryEntry[], ef: number | undefined): Map<string, QRecord> {
  const m = new Map<string, QRecord>()
  for (const e of [...entries].sort((a, b) => a.submittedAt - b.submittedAt)) {
    const cur = m.get(e.qid) ?? freshRecord(e.qid, e.submittedAt)
    const next =
      e.isCorrect === null
        ? applySubjectiveAttempt(cur, e.submittedAt)
        : applyAttempt(cur, e.isCorrect === true, e.submittedAt, ef)
    next.lastAnswer = e.answer
    if (e.isCorrect !== null) next.lastCorrect = e.isCorrect
    m.set(e.qid, next)
  }
  return m
}

describe('foldLog', () => {
  it('matches the original single-device computation for any arrival order', () => {
    const rng = mulberry32(7)
    const entries: HistoryEntry[] = []
    for (let i = 0; i < 300; i++) {
      const r = rng()
      entries.push(h('h' + i, 'q' + Math.floor(rng() * 25), r < 0.1 ? null : r < 0.6, 1_000_000 + i * 60_000))
    }
    const expected = sequential(entries, 1)
    for (let trial = 0; trial < 5; trial++) {
      const shuffled = [...entries].sort(() => rng() - 0.5)
      const log = shuffled.map((e, i) => op('attempt', { h: e, ef: 1 }, i % 2 ? 'phone' : 'pc', i + 1))
      const got = foldLog(log)
      expect(JSON.stringify([...got.records].sort())).toBe(JSON.stringify([...expected].sort()))
      expect(got.history).toHaveLength(300)
    }
  })

  it('counts a duplicated attempt once', () => {
    const e = h('dup', 'q1', false, 5)
    const got = foldLog([op('attempt', { h: e }), op('attempt', { h: e }), op('attempt', { h: e }, 'other')])
    expect(got.records.get('q1')?.attempts).toBe(1)
    expect(got.history).toHaveLength(1)
  })

  it('subjective attempts never count as wrong', () => {
    const got = foldLog([op('attempt', { h: h('s1', 'q1', null, 1) })])
    const r = got.records.get('q1')!
    expect(r.wrongCount).toBe(0)
    expect(r.correctCount).toBe(0)
    expect(r.attempts).toBe(1)
    expect(r.lastCorrect).toBeNull()
  })

  it('clear_qids removes only what the issuing device could see', () => {
    const log = [
      op('attempt', { h: h('a', 'q1', false, 1) }, 'pc', 1),
      op('attempt', { h: h('b', 'q1', false, 2) }, 'phone', 2), // pc had not pulled this yet
      op('clear_qids', { qids: ['q1'], upto: 1 }, 'pc', 3),
    ]
    const got = foldLog(log)
    expect(got.history.map((x) => x.id)).toEqual(['b'])
    expect(got.records.get('q1')?.attempts).toBe(1)
  })

  it('hide_history hides rows but keeps learning progress', () => {
    const got = foldLog([
      op('attempt', { h: h('a', 'q1', true, 1) }, 'pc', 1),
      op('hide_history', { upto: 1 }, 'pc', 2),
    ])
    expect(got.history).toHaveLength(0)
    expect(got.records.get('q1')?.attempts).toBe(1)
    expect(got.attemptKeys.has('a')).toBe(true)
  })

  it('reset drops learning rows but keeps settings', () => {
    const got = foldLog([
      op('settings', { patch: { theme: 'dark' } }, 'pc', 1),
      op('attempt', { h: h('a', 'q1', true, 1) }, 'pc', 2),
      op('reset', {}, 'pc', 3),
      op('attempt', { h: h('b', 'q2', true, 4) }, 'pc', 4),
    ])
    expect([...got.records.keys()]).toEqual(['q2'])
    expect(got.settings.theme).toBe('dark')
  })

  it('a second submission of the same exam is ignored', () => {
    const run = {
      id: 'm1',
      startedAt: 1,
      endedAt: 2,
      config: {},
      submissions: {},
      graded: true,
      score: 1,
      maxScore: 1,
      objectiveMaxScore: 1,
      subjectiveMaxScore: 0,
      perQuestion: {},
    }
    const got = foldLog([
      op('mock', { run, attempts: [{ h: h('h-att-m1-q1', 'q1', true, 2), ef: 1 }] }, 'pc', 1, 'mock:m1'),
      op(
        'mock',
        { run: { ...run, score: 0 }, attempts: [{ h: h('h-att-m1-q1x', 'q1', false, 3), ef: 1 }] },
        'phone',
        2,
        'mock:m1b',
      ),
    ])
    expect(got.mocks).toHaveLength(1)
    expect(got.mocks[0].score).toBe(1)
    expect(got.records.get('q1')?.attempts).toBe(1)
  })

  it('merging a backup of the same account does not double count', () => {
    const a1 = h('a1', 'q1', true, 1)
    const a2 = h('a2', 'q1', false, 2)
    const live = foldLog([op('attempt', { h: a1, ef: 1 }, 'pc', 1), op('attempt', { h: a2, ef: 1 }, 'pc', 2)])
    const rec = live.records.get('q1')!
    const ids = ['a1', 'a2']
    const got = foldLog([
      op('attempt', { h: a1, ef: 1 }, 'pc', 1),
      op('attempt', { h: a2, ef: 1 }, 'pc', 2),
      op(
        'import',
        {
          src: 'bk',
          baselines: [{ qid: 'q1', rec, hids: ids, ck: baselineKey(rec, ids) }],
          history: [a1, a2],
          mocks: [],
          aiReviews: [],
        },
        'pc',
        3,
      ),
      op('attempt', { h: h('a3', 'q1', true, 9), ef: 1 }, 'pc', 4),
    ])
    expect(got.records.get('q1')?.attempts).toBe(3)
    expect(got.history).toHaveLength(3)
  })

  describe('imported baselines (legacy migration / backup restore)', () => {
    const rec = (attempts: number, c: number, w: number, lastSeenAt = 10): QRecord => ({
      ...freshRecord('q1', 0),
      status: c > w ? 'learning' : 'struggling',
      attempts,
      correctCount: c,
      wrongCount: w,
      lastSeenAt,
      intervalDays: 3,
      nextReviewAt: lastSeenAt + 3 * 864e5,
    })
    const imp = (src: string, r: QRecord, hist: HistoryEntry[], clientId = 'pc') =>
      op(
        'import',
        {
          src,
          baselines: [
            {
              qid: r.qid,
              rec: r,
              hids: hist.map((x) => x.id),
              ck: baselineKey(
                r,
                hist.map((x) => x.id),
              ),
            },
          ],
          history: hist,
          mocks: [],
          aiReviews: [],
        },
        clientId,
      )

    it('a single baseline reproduces the record exactly, and new answers continue from it', () => {
      const r = rec(5, 3, 2)
      const hist = [h('x1', 'q1', true, 5), h('x2', 'q1', false, 6)]
      const got = foldLog([imp('b1', r, hist), op('attempt', { h: h('n1', 'q1', true, 20), ef: 1 })])
      const expect1 = applyAttempt(r, true, 20, 1)
      expect(got.records.get('q1')?.attempts).toBe(6)
      expect(got.records.get('q1')?.intervalDays).toBe(expect1.intervalDays)
      expect(got.history).toHaveLength(3)
    })

    it('the same backup imported twice (two browsers) counts once', () => {
      const r = rec(5, 3, 2)
      const hist = [h('x1', 'q1', true, 5)]
      const got = foldLog([imp('browserA', r, hist), imp('browserB', r, hist, 'phone')])
      expect(got.records.get('q1')?.attempts).toBe(5)
      expect(got.history).toHaveLength(1)
    })

    it('two browsers with different real practice are merged (sum), shared rows once', () => {
      const shared = h('x1', 'q1', true, 5)
      const ra = rec(3, 2, 1, 10) // x1 + 2 unexplained
      const rb = rec(2, 1, 1, 20) // x1 + y1
      const y1 = h('y1', 'q1', false, 15)
      const got = foldLog([imp('A', ra, [shared]), imp('B', rb, [shared, y1], 'phone')])
      // A residual: 3-1=2 (c 2-1=1, w 1-0=1); B residual: 2-2=0; union rows x1(c), y1(w)
      expect(got.records.get('q1')?.attempts).toBe(4)
      expect(got.records.get('q1')?.correctCount).toBe(2)
      expect(got.records.get('q1')?.wrongCount).toBe(2)
      expect(got.records.get('q1')?.lastSeenAt).toBe(20)
    })
  })
})
