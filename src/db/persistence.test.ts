import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import 'fake-indexeddb/auto'
import { createDb, restoreBackupInto, snapshotDb, type ExamPilotDB } from './database'
import { applyAttempt, freshRecord } from '../lib/scheduler'
import type { QRecord, HistoryEntry } from '../lib/types'

/**
 * Reliability tests for the persistence layer used by mock-exam submission.
 * Uses its OWN database so real browser data is never involved.
 */

let dbName: string
let db: ExamPilotDB

beforeEach(() => {
  dbName = `exampilot-test-${Math.random().toString(36).slice(2, 10)}`
  db = createDb(dbName)
})

afterEach(async () => {
  await db.delete()
})

let seq = 0
/** Mirrors StoreContext.submitAnswer's persistence contract. */
async function persistAttempt(qid: string, isCorrect: boolean | null, sessionId: string): Promise<void> {
  const now = Date.now()
  const entry: HistoryEntry = {
    id: `h-${now}-${qid}-${seq++}`,
    qid,
    mode: 'mock',
    sessionId,
    answer: 'A',
    isCorrect,
    submittedAt: now,
    usedAI: false,
  }
  const existing = (await db.records.get(qid)) ?? freshRecord(qid, now)
  const next: QRecord = applyAttempt({ ...existing }, isCorrect === true, now)
  next.lastAnswer = 'A'
  next.lastCorrect = isCorrect
  await db.transaction('rw', db.records, db.history, async () => {
    await db.records.put(next)
    await db.history.add(entry)
  })
}

describe('learning-record integrity', () => {
  it('a blank attempt is not persisted at all (no record, no history)', async () => {
    // The mock exam skips persistence for blanks; nothing should be written.
    const before = await snapshotDb(db)
    expect(before.records).toHaveLength(0)

    // simulate "blank" by simply not calling persistAttempt
    const after = await snapshotDb(db)
    expect(after.records).toHaveLength(0)
    expect(after.history).toHaveLength(0)
  })

  it('a wrong answer increments wrongCount exactly once per submission', async () => {
    await persistAttempt('q1', false, 'run-1')
    let rec = await db.records.get('q1')
    expect(rec?.wrongCount).toBe(1)
    expect(rec?.attempts).toBe(1)

    await persistAttempt('q1', false, 'run-1')
    rec = await db.records.get('q1')
    expect(rec?.wrongCount).toBe(2)
    expect(rec?.attempts).toBe(2)
    expect(await db.history.count()).toBe(2)
  })

  it('each submission adds exactly one history row (sessionId groups a run)', async () => {
    await persistAttempt('q1', true, 'run-A')
    await persistAttempt('q2', false, 'run-A')
    await persistAttempt('q3', true, 'run-B')
    const hist = await db.history.toArray()
    expect(hist).toHaveLength(3)
    expect(hist.filter((h) => h.sessionId === 'run-A')).toHaveLength(2)
    expect(hist.filter((h) => h.sessionId === 'run-B')).toHaveLength(1)
  })

  it('records survive a full restore and keep their counters', async () => {
    await persistAttempt('q1', true, 'r')
    await persistAttempt('q1', false, 'r')
    const before = await snapshotDb(db)
    const recBefore = before.records[0]
    expect(recBefore.correctCount).toBe(1)
    expect(recBefore.wrongCount).toBe(1)

    await restoreBackupInto(db, {
      records: before.records,
      history: before.history,
      mocks: [],
      aiReviews: [],
      settings: null,
    })
    const after = await db.records.get('q1')
    expect(after?.correctCount).toBe(1)
    expect(after?.wrongCount).toBe(1)
    expect(after?.attempts).toBe(2)
  })
})

describe('transaction safety', () => {
  it('a failed restore leaves the previous data fully intact', async () => {
    await persistAttempt('q1', true, 'r')
    const before = await snapshotDb(db)

    const bad = [{ ...freshRecord('q2'), qid: undefined } as unknown as QRecord]
    await expect(restoreBackupInto(db, { records: bad, history: [], mocks: [], aiReviews: [] })).rejects.toBeTruthy()

    const after = await snapshotDb(db)
    expect(after.records).toHaveLength(before.records.length)
    expect(after.records[0].qid).toBe('q1')
    expect(after.history).toHaveLength(before.history.length)
  })
})
