import { describe, expect, it, vi, afterEach } from 'vitest'
import sampleBank from '../../data/sample-bank.json'
import type { BankData } from './types'
import { bankFingerprint } from './bank-fingerprint'
import { AI_ENABLED, EDITION } from './edition'

describe('edition switch', () => {
  it('defaults to the desktop edition with AI enabled (desktop behaviour unchanged)', () => {
    expect(EDITION).toBe('desktop')
    expect(AI_ENABLED).toBe(true)
  })
})

describe('bank fingerprint', () => {
  it('matches tools/web/bank-fingerprint.mjs for the sample bank (browser/Node parity)', async () => {
    const fp = await bankFingerprint(sampleBank as unknown as BankData)
    expect(fp.total).toBe(17)
    // Computed by tools/web/bank-fingerprint.mjs (`npm run build:web:demo` prints it).
    expect(fp.hashes.full).toBe('1053c9d39c037d401c3c7f87d5e413fe114ea7e84353c015db176023f6ed4294')
    expect(fp.hashes.answers).toBe('67223e226170713113893d5c0f397773805b54aa5267a12a6484cb1ed9ba0764')
  })

  it('changes when a single answer changes', async () => {
    const b = structuredClone(sampleBank) as unknown as BankData
    const a = await bankFingerprint(b)
    b.questions[0].answerNorm = 'A'
    const c = await bankFingerprint(b)
    expect(c.hashes.full).not.toBe(a.hashes.full)
    expect(c.hashes.answers).not.toBe(a.hashes.answers)
    expect(c.hashes.stemsOptions).toBe(a.hashes.stemsOptions)
  })
})

describe('web edition AI short-circuit', () => {
  afterEach(() => {
    vi.resetModules()
    vi.doUnmock('./edition')
    vi.unstubAllGlobals()
  })

  it('never issues a network request and reports AI as disabled', async () => {
    vi.doMock('./edition', () => ({
      IS_WEB_EDITION: false,
      WEB_EDITION_MARKER: '',
      AI_ENABLED: false,
      AI_DISABLED_REASON: '网页版暂不提供 AI 功能',
    }))
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const ai = await import('./ai')
    const g = await ai.aiGrade({ qid: 'x', stem: 's', userAnswer: 'u', chapter: 'c', kind: 'short' })
    const q = await ai.aiAskQuestion({ messages: [] })
    const s = await ai.aiAskQuestionStream({ messages: [] }, () => {})
    const st = await ai.aiStatus()
    expect([g.ok, q.ok, s.ok, st.ok]).toEqual([false, false, false, false])
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
