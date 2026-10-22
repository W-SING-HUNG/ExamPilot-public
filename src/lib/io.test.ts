import { describe, it, expect } from 'vitest'
import {
  parseExport,
  planImport,
  diffImport,
  describePlan,
  checkBank,
  filterPayloadToBank,
  makeExportPayload,
  serialize,
  bankFingerprint,
  sha256,
  validateSettings,
  type ExistingData,
} from './io'
import type { QRecord, HistoryEntry, MockRun, AiReview, BankData, Question } from './types'

const mkre = (qid: string, i: number): QRecord => ({
  qid,
  status: 'learning',
  attempts: i,
  correctCount: i,
  wrongCount: 0,
  lastSeenAt: 1,
  lastCorrect: true,
  lastAnswer: 'B',
  intervalDays: 1,
  ease: 2,
  nextReviewAt: 1,
})

const mkhist = (id: string, qid: string): HistoryEntry => ({
  id,
  qid,
  mode: 'practice',
  sessionId: 's',
  answer: 'B',
  isCorrect: true,
  submittedAt: 1,
  usedAI: false,
})

const mkmock = (id: string): MockRun => ({
  id,
  startedAt: 1,
  endedAt: 2,
  config: {
    singleCount: 1,
    multiCount: 0,
    judgeCount: 0,
    shortCount: 0,
    singleScore: 1,
    multiScore: 2,
    judgeScore: 1,
    shortScore: 15,
    durationMin: 10,
    chapters: 'all',
  },
  submissions: {},
  graded: true,
  score: 1,
  maxScore: 1,
  objectiveMaxScore: 1,
  subjectiveMaxScore: 0,
  perQuestion: {},
})

const mkai = (id: string, qid: string): AiReview => ({
  id,
  qid,
  userAnswer: 'x',
  createdAt: 1,
  provider: 'stub',
  model: 'm',
  result: {
    score: 80,
    maxScore: 100,
    hitPoints: [],
    missedPoints: [],
    deductions: [],
    suggestions: [],
    structureNote: '',
    disclaimer: '',
  },
})

const SETTINGS = { theme: 'dark' as const, reviewIntervalBase: 1, studyTarget: 30, dailyGoalQuestions: 30 }

const payload = (over: Partial<ReturnType<typeof makeExportPayload>> = {}) => ({
  ...makeExportPayload({
    settings: SETTINGS,
    records: [mkre('q1', 1)],
    history: [mkhist('h1', 'q1')],
    mocks: [mkmock('m1')],
    aiReviews: [mkai('a1', 'q1')],
    bankFingerprint: 'fp',
    bankCount: 1,
  }),
  ...over,
})

const emptyExisting: ExistingData = { records: [], history: [], mocks: [], aiReviews: [], settings: null }

describe('io / sha256', () => {
  it('matches known vectors', () => {
    expect(sha256('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(sha256('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    )
  })
  it('handles multi-byte UTF-8 deterministically', () => {
    expect(sha256('中国特色社会主义')).toBe(sha256('中国特色社会主义'))
    expect(sha256('中国特色社会主义')).not.toBe(sha256('中国特色社会主'))
  })
})

describe('io / bankFingerprint (SHA-256 over full bank identity)', () => {
  const mkBank = (ids: string[], answers: Record<string, string> = {}, type: Question['type'] = 'single'): BankData =>
    ({
      schema: 'examPilot.bank.v1',
      source: 'x',
      generatedAt: '',
      chapterOrder: ['导论'],
      countsByType: {},
      questions: ids.map((id): Question => ({
        id,
        chapter: '导论',
        chapterIndex: 0,
        type,
        bankNo: 1,
        pageStart: 1,
        pageEnd: 1,
        stem: `stem-${id}`,
        options: ['a', 'b', 'c', 'd'],
        answer: answers[id] ?? 'A',
        answerNorm: answers[id] ?? 'A',
        hasOfficialAnswer: true,
        isFlagged: false,
        flagReason: '',
      })),
    }) as unknown as BankData

  it('is a 64-char hex SHA-256', () => {
    expect(bankFingerprint(mkBank(['a', 'b']))).toMatch(/^[0-9a-f]{64}$/)
  })

  it('REGRESSION: changes when an answer changes but the id stays the same', () => {
    const before = bankFingerprint(mkBank(['q1', 'q2', 'q3']))
    const after = bankFingerprint(mkBank(['q1', 'q2', 'q3'], { q2: 'D' }))
    expect(after).not.toBe(before)
  })

  it('REGRESSION: changes when only the LAST question changes (no truncation)', () => {
    const ids = Array.from({ length: 40 }, (_, i) => `q${i}`)
    const before = bankFingerprint(mkBank(ids))
    expect(bankFingerprint(mkBank(ids, { q39: 'C' }))).not.toBe(before)
  })

  it('changes when only the last question is appended', () => {
    const ids = Array.from({ length: 40 }, (_, i) => `q${i}`)
    const before = bankFingerprint(mkBank(ids))
    expect(bankFingerprint(mkBank([...ids, 'q40']))).not.toBe(before)
  })

  it('changes when options change for the same id and answer', () => {
    const a = mkBank(['q1'])
    const b = mkBank(['q1'])
    b.questions[0].options = ['a', 'b', 'c', 'e']
    expect(bankFingerprint(b)).not.toBe(bankFingerprint(a))
  })

  it('changes when the question type changes', () => {
    expect(bankFingerprint(mkBank(['a'], {}, 'single'))).not.toBe(bankFingerprint(mkBank(['a'], {}, 'multi')))
  })

  it('is stable for identical banks', () => {
    const ids = ['a', 'b', 'c']
    expect(bankFingerprint(mkBank(ids))).toBe(bankFingerprint(mkBank(ids)))
  })
})

describe('io / parseExport strictness', () => {
  it('rejects malformed JSON', () => {
    const r = parseExport('not json')
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => e.includes('JSON'))).toBe(true)
  })
  it('rejects an unknown schema', () => {
    const r = parseExport(JSON.stringify({ schema: 'other', records: [], history: [], mocks: [], aiReviews: [] }))
    expect(r.ok).toBe(false)
    expect(r.errors[0]).toMatch(/不支持的备份格式/)
  })
  it('rejects missing arrays', () => {
    const r = parseExport(JSON.stringify({ schema: 'exampilot.export.v1', records: 'nope' }))
    expect(r.ok).toBe(false)
    expect(r.errors.join(';')).toMatch(/records/)
    expect(r.errors.join(';')).toMatch(/history/)
  })
  it('rejects duplicate ids in every collection', () => {
    expect(parseExport(serialize(payload({ records: [mkre('q1', 1), mkre('q1', 2)] }))).ok).toBe(false)
    expect(parseExport(serialize(payload({ history: [mkhist('h1', 'q1'), mkhist('h1', 'q2')] }))).ok).toBe(false)
    expect(parseExport(serialize(payload({ mocks: [mkmock('m1'), mkmock('m1')] }))).ok).toBe(false)
    expect(parseExport(serialize(payload({ aiReviews: [mkai('a1', 'q1'), mkai('a1', 'q2')] }))).ok).toBe(false)
  })
  it('warns (not fails) when the bank fingerprint is absent', () => {
    const p = payload() as Record<string, unknown>
    delete p.bankFingerprint
    const r = parseExport(JSON.stringify(p))
    expect(r.ok).toBe(true)
    expect(r.warnings.join(';')).toMatch(/bankFingerprint|指纹/)
  })
  it('round-trips a valid payload with all five collections', () => {
    const r = parseExport(serialize(payload()))
    expect(r.ok).toBe(true)
    expect(r.payload?.records).toHaveLength(1)
    expect(r.payload?.settings).toEqual(SETTINGS)
  })
})

describe('io / validation of nested and malformed rows', () => {
  const parse1 = (over: Record<string, unknown>) => parseExport(JSON.stringify({ ...payload(), ...over }))

  it('rejects records with an invalid status', () => {
    const r = parse1({ records: [{ ...mkre('q1', 1), status: 'bogus' }] })
    expect(r.ok).toBe(false)
    expect(r.errors.join(';')).toMatch(/status/)
  })
  it('rejects records with negative counters', () => {
    const r = parse1({ records: [{ ...mkre('q1', 1), attempts: -1 }] })
    expect(r.ok).toBe(false)
    expect(r.errors.join(';')).toMatch(/attempts/)
  })
  it('rejects records where correct+wrong exceeds attempts', () => {
    const r = parse1({ records: [{ ...mkre('q1', 1), attempts: 1, correctCount: 5, wrongCount: 5 }] })
    expect(r.ok).toBe(false)
    expect(r.errors.join(';')).toMatch(/不得超过 attempts/)
  })
  it('rejects records with a null qid', () => {
    const r = parse1({ records: [{ ...mkre('q1', 1), qid: null }] })
    expect(r.ok).toBe(false)
    expect(r.errors.join(';')).toMatch(/qid/)
  })
  it('rejects history with a non-boolean isCorrect', () => {
    const r = parse1({ history: [{ ...mkhist('h1', 'q1'), isCorrect: 'yes' }] })
    expect(r.ok).toBe(false)
    expect(r.errors.join(';')).toMatch(/isCorrect/)
  })
  it('rejects mocks whose config is incomplete', () => {
    const r = parse1({ mocks: [{ ...mkmock('m1'), config: { singleCount: 1 } }] })
    expect(r.ok).toBe(false)
    expect(r.errors.join(';')).toMatch(/config\./)
  })
  it('rejects mocks whose score exceeds maxScore', () => {
    const r = parse1({ mocks: [{ ...mkmock('m1'), score: 99, maxScore: 1 }] })
    expect(r.ok).toBe(false)
    expect(r.errors.join(';')).toMatch(/score 不得超过 maxScore/)
  })
  it('rejects mocks whose perQuestion entry lacks unanswered', () => {
    const r = parse1({ mocks: [{ ...mkmock('m1'), perQuestion: { q1: { isCorrect: true, points: 1 } } }] })
    expect(r.ok).toBe(false)
    expect(r.errors.join(';')).toMatch(/unanswered/)
  })
  it('rejects AI reviews with an out-of-range score', () => {
    const bad = { ...mkai('a1', 'q1'), result: { ...mkai('a1', 'q1').result, score: 150 } }
    const r = parse1({ aiReviews: [bad] })
    expect(r.ok).toBe(false)
    expect(r.errors.join(';')).toMatch(/result\.score/)
  })
  it('rejects AI reviews whose result arrays contain non-strings', () => {
    const bad = { ...mkai('a1', 'q1'), result: { ...mkai('a1', 'q1').result, hitPoints: [1, 2] } }
    const r = parse1({ aiReviews: [bad] })
    expect(r.ok).toBe(false)
    expect(r.errors.join(';')).toMatch(/result\.hitPoints/)
  })
  it('rejects settings with an invalid theme', () => {
    const r = parse1({ settings: { ...SETTINGS, theme: 'neon' } })
    expect(r.ok).toBe(false)
    expect(r.errors.join(';')).toMatch(/theme/)
  })
  it('rejects settings with out-of-range numbers', () => {
    const r = parse1({ settings: { ...SETTINGS, reviewIntervalBase: 0 } })
    expect(r.ok).toBe(false)
    expect(r.errors.join(';')).toMatch(/reviewIntervalBase/)
  })
  it('reports a problem count and imports nothing', () => {
    const r = parse1({ records: [{ qid: '' }, { qid: '' }] })
    expect(r.ok).toBe(false)
    expect(r.invalidCount).toBeGreaterThan(0)
    expect(r.payload).toBeUndefined()
  })
})

describe('io / validateSettings', () => {
  it('returns null for absent settings (allowed)', () => {
    expect(validateSettings(undefined)).toBe(null)
    expect(validateSettings(null)).toBe(null)
  })
  it('returns the normalized object for valid settings', () => {
    expect(validateSettings(SETTINGS)).toEqual(SETTINGS)
  })
  it('returns null and records issues for invalid settings', () => {
    const issues: { path: string; message: string }[] = []
    expect(validateSettings({ theme: 'x' }, 'settings', issues)).toBe(null)
    expect(issues.length).toBeGreaterThan(0)
  })
})

describe('io / checkBank', () => {
  it('reports match for an identical fingerprint', () => {
    expect(checkBank(payload({ bankFingerprint: 'abc' }), 'abc', 1, new Set(['q1'])).status).toBe('match')
  })
  it('reports mismatch for a different fingerprint', () => {
    const c = checkBank(payload({ bankFingerprint: 'abc' }), 'xyz', 99, new Set(['q1']))
    expect(c.status).toBe('mismatch')
    expect(c.message).toMatch(/不一致/)
  })
  it('reports unknown for a legacy backup without a fingerprint', () => {
    const p = payload() as Record<string, unknown>
    delete p.bankFingerprint
    const c = checkBank(p as never, 'xyz', 99, new Set(['q1']))
    expect(c.status).toBe('unknown')
    expect(c.message).toMatch(/旧版/)
  })
  it('counts rows that cannot be matched to any current question', () => {
    const p = payload({
      records: [mkre('q1', 1), mkre('ghost', 1)],
      history: [mkhist('h1', 'q1'), mkhist('h2', 'ghost')],
    })
    const c = checkBank(p, 'fp', 1, new Set(['q1']))
    expect(c.unmatchedRecords).toBe(1)
    expect(c.unmatchedHistory).toBe(1)
  })
  it('counts mocks referencing unknown questions', () => {
    const mock = { ...mkmock('m1'), submissions: { ghost: 'A' } }
    expect(checkBank(payload({ mocks: [mock] }), 'fp', 1, new Set(['q1'])).mocksWithUnmatchedQuestions).toBe(1)
  })
})

describe('io / planImport strategies and settings semantics', () => {
  it('replace returns exactly the backup contents', () => {
    const plan = planImport(payload(), 'replace', {
      records: [mkre('old', 9)],
      history: [mkhist('old', 'old')],
      mocks: [mkmock('old')],
      aiReviews: [mkai('old', 'old')],
      settings: SETTINGS,
    })
    expect(plan.records.map((r) => r.qid)).toEqual(['q1'])
    expect(plan.history.map((h) => h.id)).toEqual(['h1'])
    expect(plan.mocks.map((m) => m.id)).toEqual(['m1'])
    expect(plan.aiReviews.map((a) => a.id)).toEqual(['a1'])
  })

  it('merge unions collections and lets the backup win on conflict', () => {
    const plan = planImport(payload({ records: [mkre('q1', 5)] }), 'merge', {
      records: [mkre('q1', 1), mkre('q2', 2)],
      history: [mkhist('h1', 'q1'), mkhist('h2', 'q2')],
      mocks: [mkmock('m1')],
      aiReviews: [mkai('a1', 'q1')],
      settings: SETTINGS,
    })
    expect(plan.records).toHaveLength(2)
    expect(plan.records.find((r) => r.qid === 'q1')?.attempts).toBe(5)
    expect(plan.history).toHaveLength(2)
  })

  it('REGRESSION (settings): replace with a settings-less backup resets to defaults', () => {
    const p = payload() as Record<string, unknown>
    delete p.settings
    const plan = planImport(p as never, 'replace', { ...emptyExisting, settings: SETTINGS })
    expect(plan.settingsAction).toBe('reset')
    expect(plan.settings).toBe(null)
    expect(describePlan(plan, 'replace').join(';')).toMatch(/重置为默认值/)
  })

  it('replace with valid settings writes them', () => {
    const plan = planImport(payload(), 'replace', { ...emptyExisting, settings: { ...SETTINGS, theme: 'light' } })
    expect(plan.settingsAction).toBe('set')
    expect(plan.settings?.theme).toBe('dark')
    expect(describePlan(plan, 'replace').join(';')).toMatch(/使用备份中的设置/)
  })

  it('REGRESSION (settings): merge without backup settings KEEPS the existing settings', () => {
    const p = payload() as Record<string, unknown>
    delete p.settings
    const plan = planImport(p as never, 'merge', { ...emptyExisting, settings: SETTINGS })
    // 'keep' is the action the DB honours; it must not clear the settings table.
    expect(plan.settingsAction).toBe('keep')
    expect(plan.settings).toBe(null)
    expect(describePlan(plan, 'merge').join(';')).toMatch(/保持当前设置不变/)
  })

  it('describePlan states the mode explicitly', () => {
    expect(describePlan(planImport(payload(), 'replace', emptyExisting), 'replace').join(';')).toMatch(/替换/)
    expect(describePlan(planImport(payload(), 'merge', emptyExisting), 'merge').join(';')).toMatch(/合并/)
  })
})

describe('io / diffImport', () => {
  it('counts added vs updated rows and rows destroyed by replace', () => {
    const existing = {
      records: [mkre('q1', 1), mkre('q2', 1)],
      history: [mkhist('h1', 'q1')],
      mocks: [],
      aiReviews: [],
      settings: SETTINGS,
    }
    const p = payload({ records: [mkre('q1', 1), mkre('q3', 1)], history: [mkhist('h1', 'q1'), mkhist('h9', 'q9')] })
    const d = diffImport(planImport(p, 'replace', existing), 'replace', existing)
    expect(d.records.incoming).toBe(2)
    expect(d.records.added).toBe(1)
    expect(d.records.updated).toBe(1)
    expect(d.history.added).toBe(1)
    expect(d.clearedInReplace).toBe(3)
  })

  it('reports clearedInReplace as 0 in merge mode', () => {
    expect(diffImport(planImport(payload(), 'merge', emptyExisting), 'merge', emptyExisting).clearedInReplace).toBe(0)
  })

  it('flags a settings change only when the values actually differ', () => {
    const same = { ...emptyExisting, settings: SETTINGS }
    expect(diffImport(planImport(payload(), 'merge', same), 'merge', same).settingsChanged).toBe(false)
    const diff = { ...emptyExisting, settings: { ...SETTINGS, theme: 'light' as const } }
    expect(diffImport(planImport(payload(), 'merge', diff), 'merge', diff).settingsChanged).toBe(true)
  })

  it('diff reflects the FILTERED rows, not the raw backup size', () => {
    const existing = { ...emptyExisting, settings: SETTINGS }
    const p = payload({ records: [mkre('q1', 1), mkre('ghost', 1)] })
    const plan = planImport(p, 'merge', existing, new Set(['q1']), true)
    const d = diffImport(plan, 'merge', existing)
    expect(d.records.incoming).toBe(1) // ghost excluded
    expect(plan.filter.excludedRecords).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Regression: the merge-mode preview reported the MERGED total as "backup"
//
// Reported by an independent tester: 11 existing records + a backup containing
// exactly 1 new record was previewed as "备份 12 / 覆盖 11". Root cause: in merge
// mode `plan.records` is the UNION (existing ∪ incoming), and `diffImport`
// diffed that union against the existing set — so every pre-existing row looked
// like it was being overwritten, and the backup looked like it contained them.
//
// The preview must describe what the BACKUP contributes: 1 new, 0 overwritten,
// 12 after restore. These tests fail against the old implementation.
// ---------------------------------------------------------------------------

describe('io / diffImport — merge preview counts the BACKUP, not the merged set', () => {
  /** 11 existing learning records, one per question q1..q11. */
  const existing11 = {
    records: Array.from({ length: 11 }, (_, i) => mkre(`q${i + 1}`, 1)),
    history: [] as ReturnType<typeof mkhist>[],
    mocks: [],
    aiReviews: [],
    settings: SETTINGS,
  }

  it('11 existing + backup with 1 new row => backup 1, existing 11, added 1, updated 0, total 12', () => {
    const p = payload({ records: [mkre('q99', 1)] })
    const plan = planImport(p, 'merge', existing11)
    const d = diffImport(plan, 'merge', existing11)

    expect(d.records.incoming, '备份中').toBe(1)
    expect(d.records.existing, '现有').toBe(11)
    expect(d.records.added, '新增').toBe(1)
    expect(d.records.updated, '覆盖').toBe(0)
    expect(d.records.total, '恢复后').toBe(12)
  })

  it('the merged plan really does contain 12 rows (so the preview and the write agree)', () => {
    const p = payload({ records: [mkre('q99', 1)] })
    const plan = planImport(p, 'merge', existing11)
    // The DB row set after restore — this is what `total` must equal.
    expect(plan.records).toHaveLength(12)
    expect(diffImport(plan, 'merge', existing11).records.total).toBe(plan.records.length)
  })

  it('a backup row whose id already exists counts as overwritten, not added', () => {
    const p = payload({ records: [mkre('q1', 5)] }) // q1 already present
    const d = diffImport(planImport(p, 'merge', existing11), 'merge', existing11)
    expect(d.records.incoming).toBe(1)
    expect(d.records.added).toBe(0)
    expect(d.records.updated).toBe(1)
    expect(d.records.total).toBe(11) // union: 11 unique rows
    expect(d.clearedInReplace).toBe(0) // merge never destroys
  })

  it('mixed backup: same-id rows are updated, new-id rows are added', () => {
    const p = payload({ records: [mkre('q1', 5), mkre('q2', 5), mkre('q98', 1), mkre('q99', 1)] })
    const d = diffImport(planImport(p, 'merge', existing11), 'merge', existing11)
    expect(d.records.incoming).toBe(4)
    expect(d.records.updated).toBe(2)
    expect(d.records.added).toBe(2)
    expect(d.records.total).toBe(13)
  })

  it('an empty backup adds nothing and overwrites nothing', () => {
    const p = payload({ records: [], history: [], mocks: [], aiReviews: [] })
    const d = diffImport(planImport(p, 'merge', existing11), 'merge', existing11)
    expect(d.records.incoming).toBe(0)
    expect(d.records.added).toBe(0)
    expect(d.records.updated).toBe(0)
    expect(d.records.existing).toBe(11)
    expect(d.records.total).toBe(11)
  })

  it('replace mode reports the backup count as the post-restore total, not a union', () => {
    const p = payload({ records: [mkre('q99', 1)] })
    const d = diffImport(planImport(p, 'replace', existing11), 'replace', existing11)
    expect(d.records.incoming).toBe(1)
    expect(d.records.existing).toBe(11)
    expect(d.records.added).toBe(1)
    expect(d.records.updated).toBe(0)
    // Replace discards the 11 existing rows.
    expect(d.records.total).toBe(1)
    expect(d.clearedInReplace).toBe(11)
  })

  it('applies the same backup-vs-current rule to history, mocks and aiReviews', () => {
    const existing = {
      records: [mkre('q1', 1)],
      history: [mkhist('h1', 'q1'), mkhist('h2', 'q1')],
      mocks: [] as never[],
      aiReviews: [] as never[],
      settings: SETTINGS,
    }
    const p = payload({
      records: [mkre('q9', 1)],
      history: [mkhist('h1', 'q1'), mkhist('h3', 'q1')],
    })
    const d = diffImport(planImport(p, 'merge', existing), 'merge', existing)

    // history: h1 exists (updated), h3 is new (added)
    expect(d.history.incoming).toBe(2)
    expect(d.history.existing).toBe(2)
    expect(d.history.updated).toBe(1)
    expect(d.history.added).toBe(1)
    expect(d.history.total).toBe(3)

    // records: 1 new out of 1
    expect(d.records.incoming).toBe(1)
    expect(d.records.added).toBe(1)
    expect(d.records.updated).toBe(0)
    expect(d.records.total).toBe(2)
  })

  it('cross-bank exclusion is reflected in the preview numbers', () => {
    const existing1 = {
      records: [mkre('q1', 1)],
      history: [] as ReturnType<typeof mkhist>[],
      mocks: [],
      aiReviews: [],
      settings: SETTINGS,
    }
    // Backup carries 3 rows; only q1 overlaps the current bank.
    const p = payload({ records: [mkre('q1', 2), mkre('otherA', 1), mkre('otherB', 1)] })

    // Case A — fingerprint MATCHES: rows whose qid is in the bank are verifiable,
    // the rest are excluded.
    const planMatch = planImport(p, 'merge', existing1, new Set(['q1']), true)
    const dMatch = diffImport(planMatch, 'merge', existing1)
    expect(dMatch.records.incoming, 'only the verifiable row is counted').toBe(1)
    expect(planMatch.filter.excludedRecords).toBe(2)
    // 备份中 = kept + excluded = everything the file carried.
    expect(dMatch.records.incoming + planMatch.filter.excludedRecords).toBe(3)
    expect(dMatch.records.updated).toBe(1)
    expect(dMatch.records.added).toBe(0)
    expect(dMatch.records.total).toBe(1)

    // Case B — fingerprint MISMATCH: no cross-bank progress may migrate, so the
    // preview must show 0 incoming even though the file holds 3 rows.
    const planMismatch = planImport(p, 'merge', existing1, new Set(['q1']), false)
    const dMismatch = diffImport(planMismatch, 'merge', existing1)
    expect(dMismatch.records.incoming, 'nothing verifiable across banks').toBe(0)
    expect(planMismatch.filter.excludedRecords).toBe(3)
    expect(dMismatch.records.existing).toBe(1)
    expect(dMismatch.records.added).toBe(0)
    expect(dMismatch.records.updated).toBe(0)
    // Existing data is untouched by an all-excluded backup.
    expect(dMismatch.records.total).toBe(1)
    expect(planMismatch.filter.nothingVerifiable).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Cross-bank safety: unverifiable progress must never reach the statistics
// ---------------------------------------------------------------------------

describe('io / filterPayloadToBank', () => {
  it('keeps verifiable rows and excludes rows whose question is absent when fingerprint matches', () => {
    const p = payload({
      records: [mkre('q1', 1), mkre('ghost', 1)],
      history: [mkhist('h1', 'q1'), mkhist('h2', 'ghost')],
      aiReviews: [mkai('a1', 'q1'), mkai('a2', 'ghost')],
    })
    const { payload: kept, report } = filterPayloadToBank(p, new Set(['q1']), true)
    expect(kept.records.map((r) => r.qid)).toEqual(['q1'])
    expect(kept.history.map((h) => h.qid)).toEqual(['q1'])
    expect(kept.aiReviews.map((a) => a.qid)).toEqual(['q1'])
    expect(report.excludedRecords).toBe(1)
    expect(report.excludedHistory).toBe(1)
    expect(report.excludedAiReviews).toBe(1)
    expect(report.nothingVerifiable).toBe(false)
  })

  it('drops a mock unless EVERY referenced question exists', () => {
    const full = { ...mkmock('m1'), submissions: { q1: 'A' } }
    const partial = { ...mkmock('m2'), submissions: { q1: 'A', ghost: 'B' } }
    const { payload: kept, report } = filterPayloadToBank(payload({ mocks: [full, partial] }), new Set(['q1']), true)
    expect(kept.mocks.map((m) => m.id)).toEqual(['m1'])
    expect(report.excludedMocks).toBe(1)
  })

  it('reports nothingVerifiable when no row matches the current bank', () => {
    const p = payload({
      records: [mkre('ghost', 1)],
      history: [mkhist('h', 'ghost')],
      mocks: [],
      aiReviews: [],
    })
    const { payload: kept, report } = filterPayloadToBank(p, new Set(['q1']), true)
    expect(kept.records).toHaveLength(0)
    expect(kept.history).toHaveLength(0)
    expect(report.nothingVerifiable).toBe(true)
  })

  it('REGRESSION: planImport through a different bank excludes unverifiable progress', () => {
    const p = payload({
      records: [mkre('ghost', 1)],
      history: [],
      mocks: [],
      aiReviews: [],
      bankFingerprint: 'other-bank',
    })
    const plan = planImport(p, 'replace', emptyExisting, new Set(['q1']), false)
    // nothing unverifiable reaches the write plan
    expect(plan.records).toHaveLength(0)
    expect(plan.filter.excludedRecords).toBe(1)
    expect(plan.filter.nothingVerifiable).toBe(true)
  })

  it('a matching bank keeps everything (no false positives)', () => {
    const p = payload({ records: [mkre('q1', 1), mkre('q2', 1)] })
    const plan = planImport(p, 'merge', emptyExisting, new Set(['q1', 'q2']), true)
    expect(plan.records).toHaveLength(2)
    expect(plan.filter.excludedRecords).toBe(0)
  })

  it('REGRESSION: same question ID but different answer in mismatched bank is NOT migrated', () => {
    // Question q1 has answer 'A' in the current bank, but backup comes from a bank where q1 had answer 'B'
    // Because bank fingerprint does not match, progress is blocked to prevent wrong-question misattribution
    const p = payload({
      records: [mkre('q1', 5)],
      history: [mkhist('h1', 'q1')],
      bankFingerprint: 'different-fingerprint-due-to-different-answer',
    })
    const plan = planImport(p, 'merge', emptyExisting, new Set(['q1']), false)
    expect(plan.records).toHaveLength(0)
    expect(plan.history).toHaveLength(0)
    expect(plan.filter.excludedRecords).toBe(1)
    expect(plan.filter.excludedHistory).toBe(1)
  })

  it('REGRESSION: same question ID but different option order in mismatched bank is NOT migrated', () => {
    const p = payload({
      records: [mkre('q1', 3)],
      history: [mkhist('h1', 'q1')],
      mocks: [],
      aiReviews: [],
      bankFingerprint: 'different-fingerprint-due-to-option-reorder',
    })
    const plan = planImport(p, 'replace', emptyExisting, new Set(['q1']), false)
    expect(plan.records).toHaveLength(0)
    expect(plan.history).toHaveLength(0)
    expect(plan.filter.nothingVerifiable).toBe(true)
  })

  it('REGRESSION: legacy backup without fingerprint cannot import learning progress', () => {
    const p = payload({
      records: [mkre('q1', 2)],
      history: [mkhist('h1', 'q1')],
    }) as Record<string, unknown>
    delete p.bankFingerprint
    const check = checkBank(p as never, 'current-sha256-fingerprint', 10, new Set(['q1']))
    expect(check.status).toBe('unknown')

    const plan = planImport(p as never, 'merge', emptyExisting, new Set(['q1']), false)
    expect(plan.records).toHaveLength(0)
    expect(plan.history).toHaveLength(0)
    expect(plan.filter.excludedRecords).toBe(1)
  })

  it('REGRESSION: AI reviews are excluded when bank fingerprint does not match (preventing wrong association & overwrite)', () => {
    const p = payload({
      aiReviews: [mkai('a1', 'q1')],
      bankFingerprint: 'different-fingerprint-cross-bank',
    })
    const existingAi = mkai('a1-local', 'q1')
    existingAi.result.score = 99
    const existing: ExistingData = {
      ...emptyExisting,
      aiReviews: [existingAi],
    }

    const plan = planImport(p, 'merge', existing, new Set(['q1']), false)
    // The incoming AI review must NOT be kept because its question binding cannot be proven
    expect(plan.aiReviews).toHaveLength(1)
    expect(plan.aiReviews[0].id).toBe('a1-local')
    expect(plan.aiReviews[0].result.score).toBe(99)
    expect(plan.filter.excludedAiReviews).toBe(1)
  })

  it('REGRESSION: valid settings are preserved and can be restored independently in merge mode even if study data is excluded', () => {
    const customSettings = {
      theme: 'dark' as const,
      reviewIntervalBase: 5,
      studyTarget: 50,
      dailyGoalQuestions: 50,
    }
    const p = payload({
      records: [mkre('q1', 3)],
      history: [mkhist('h1', 'q1')],
      settings: customSettings,
      bankFingerprint: 'mismatched-bank-fingerprint',
    })

    const existingSettings = {
      theme: 'light' as const,
      reviewIntervalBase: 1,
      studyTarget: 20,
      dailyGoalQuestions: 20,
    }
    const existing: ExistingData = {
      ...emptyExisting,
      settings: existingSettings,
    }

    // Merge mode: study data excluded due to fingerprint mismatch, but settings are valid and can be applied!
    const plan = planImport(p, 'merge', existing, new Set(['q1']), false)
    expect(plan.records).toHaveLength(0)
    expect(plan.history).toHaveLength(0)
    expect(plan.settings).toEqual(customSettings)
    expect(plan.settingsAction).toBe('set')
    expect(plan.filter.excludedRecords).toBe(1)
  })
})
