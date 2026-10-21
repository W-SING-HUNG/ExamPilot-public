import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { saveDraft, loadDraft, clearDraft, DRAFT_PREFIX } from './session-draft'

/**
 * Draft persistence protects the in-flight session from a reload. It stores only
 * UI position — never a learning record — so restoring can never double-count an
 * attempt; these tests pin that down along with the defensive reads.
 */
function memoryStorage() {
  const map = new Map<string, string>()
  return {
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    get length() {
      return map.size
    },
  } as unknown as Storage
}

const base = {
  mode: 'practice',
  sessionId: 's-1',
  qids: ['q1', 'q2', 'q3'],
  idx: 1,
  answers: { q1: 'A' },
  outcomes: { q1: 'correct' as const },
  skipped: [],
  startedAt: 1000,
}

describe('session draft', () => {
  beforeEach(() => {
    vi.stubGlobal('sessionStorage', memoryStorage())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('round-trips a draft', () => {
    saveDraft(base)
    const d = loadDraft('practice')
    expect(d).not.toBeNull()
    expect(d!.idx).toBe(1)
    expect(d!.qids).toEqual(['q1', 'q2', 'q3'])
    expect(d!.outcomes.q1).toBe('correct')
  })

  it('does not leak a draft into another mode', () => {
    saveDraft(base)
    expect(loadDraft('special')).toBeNull()
  })

  it('clears on demand', () => {
    saveDraft(base)
    clearDraft('practice')
    expect(loadDraft('practice')).toBeNull()
  })

  it('discards malformed JSON instead of throwing', () => {
    sessionStorage.setItem(DRAFT_PREFIX + 'practice', '{not json')
    expect(loadDraft('practice')).toBeNull()
  })

  it('discards a draft whose index is out of range', () => {
    saveDraft({ ...base, idx: 99 })
    expect(loadDraft('practice')).toBeNull()
  })

  it('discards a draft with no questions', () => {
    saveDraft({ ...base, qids: [] })
    expect(loadDraft('practice')).toBeNull()
  })

  it('discards a draft older than a day', () => {
    saveDraft(base)
    const raw = JSON.parse(sessionStorage.getItem(DRAFT_PREFIX + 'practice') as string)
    raw.savedAt = Date.now() - 25 * 3600 * 1000
    sessionStorage.setItem(DRAFT_PREFIX + 'practice', JSON.stringify(raw))
    expect(loadDraft('practice')).toBeNull()
  })

  it('survives a storage that throws (private mode)', () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
      removeItem: () => {
        throw new Error('denied')
      },
    })
    expect(() => saveDraft(base)).not.toThrow()
    expect(loadDraft('practice')).toBeNull()
  })
})
