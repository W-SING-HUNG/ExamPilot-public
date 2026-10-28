import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeHarness, type Harness, HOST, BANK_FP } from './test-harness'
import { handleApi } from '../../worker/api'
import { SyncEngine, CloudDB, type Fetcher } from '../../src/sync/engine'

let H: Harness
let engines: SyncEngine[] = []
beforeEach(async () => {
  H = await makeHarness()
})
afterEach(async () => {
  for (const e of engines) e.dispose()
  engines = []
  await H.dispose()
})

interface Net {
  offline: boolean
  /** perform the request on the server but lose the response */
  dropResponses: number
  fail500: number
  email: string
}

async function device(email: string, name: string, net?: Partial<Net>) {
  const n: Net = { offline: false, dropResponses: 0, fail500: 0, email, ...net }
  const fetcher: Fetcher = async (path, init) => {
    if (n.offline) throw new TypeError('Failed to fetch')
    if (n.fail500 > 0) {
      n.fail500--
      return new Response(JSON.stringify({ ok: false, error: 'server_error' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    const headers = new Headers(init.headers)
    headers.set('Cf-Access-Jwt-Assertion', await H.issuer.token(n.email))
    if (init.method === 'POST') headers.set('Origin', HOST)
    const res = await handleApi(
      new Request(HOST + path, { method: init.method, headers, body: init.body as string }),
      H.env,
      {
        auth: { fetchJwks: async () => H.issuer.jwks },
      },
    )
    if (n.dropResponses > 0) {
      n.dropResponses--
      throw new TypeError('connection reset')
    }
    return res
  }
  const me = await (await fetcher('/api/sync/me', { method: 'GET', headers: { 'X-ExamPilot-Sync': '1' } })).json()
  const e = new SyncEngine({
    accountId: me.accountId,
    email,
    clientId: 'dev-' + name + '-' + Math.random().toString(36).slice(2, 8),
    bankFp: BANK_FP,
    fetcher,
    manual: true,
    db: new CloudDB('t-' + name + '-' + Math.random().toString(36).slice(2)),
  })
  await e.init()
  engines.push(e)
  return { e, n }
}

const attempt = (id: string, qid: string, isCorrect: boolean | null, t: number, sessionId = 's') => ({
  h: { id, qid, mode: 'practice', sessionId, answer: 'A', isCorrect, submittedAt: t, usedAI: false },
  ef: 1,
})

describe('two devices, one account', () => {
  it('an answer on the phone appears on the computer exactly once', async () => {
    const phone = await device('a@x.com', 'phone')
    const pc = await device('a@x.com', 'pc')
    await phone.e.commit('attempt', attempt('h-1', 'q1', true, 1000))
    await phone.e.syncNow()
    await pc.e.syncNow()
    expect(pc.e.state.history.map((h) => h.id)).toEqual(['h-1'])
    expect(pc.e.state.records.get('q1')?.attempts).toBe(1)
    expect(phone.e.status.synced).toBe(true)
    expect(pc.e.status.synced).toBe(true)
  })

  it('concurrent answers (different and same question) all survive and states are identical', async () => {
    const a = await device('a@x.com', 'a')
    const b = await device('a@x.com', 'b')
    await a.e.commit('attempt', attempt('h-a1', 'q1', true, 1000))
    await b.e.commit('attempt', attempt('h-b1', 'q2', false, 1001))
    await a.e.commit('attempt', attempt('h-a2', 'q3', true, 1002))
    await b.e.commit('attempt', attempt('h-b2', 'q3', false, 1003)) // same question, different session
    await Promise.all([a.e.syncNow(), b.e.syncNow()])
    await a.e.syncNow()
    await b.e.syncNow()
    for (const d of [a, b]) {
      expect(d.e.state.history).toHaveLength(4)
      expect(d.e.state.records.get('q3')?.attempts).toBe(2)
      expect(d.e.state.records.get('q3')?.correctCount).toBe(1)
      expect(d.e.state.records.get('q3')?.wrongCount).toBe(1)
    }
    expect(JSON.stringify([...a.e.state.records])).toBe(JSON.stringify([...b.e.state.records]))
  })

  it('offline answers are kept, not reported as synced, and upload when back online', async () => {
    const a = await device('a@x.com', 'a', { offline: false })
    a.n.offline = true
    await a.e.commit('attempt', attempt('h-off', 'q1', true, 1000))
    await a.e.syncNow()
    expect(a.e.status.synced).toBe(false)
    expect(a.e.status.pending).toBe(1)
    expect(['retrying', 'offline']).toContain(a.e.status.phase)
    a.n.offline = false
    await a.e.syncNow()
    expect(a.e.status.synced).toBe(true)
    const b = await device('a@x.com', 'b')
    await b.e.syncNow()
    expect(b.e.state.history).toHaveLength(1)
  })

  it('response lost after the server committed: the retry does not double count', async () => {
    const a = await device('a@x.com', 'a')
    a.n.dropResponses = 1
    await a.e.commit('attempt', attempt('h-lost', 'q1', false, 1000))
    await a.e.syncNow() // server stored it, client never heard
    expect(a.e.status.synced).toBe(false)
    await a.e.syncNow()
    const b = await device('a@x.com', 'b')
    await b.e.syncNow()
    expect(b.e.state.records.get('q1')?.attempts).toBe(1)
    const p = await H.call('GET', '/api/sync/pull?since=0', { email: 'a@x.com' })
    expect(p.json.ops).toHaveLength(1)
  })

  it('a 5xx is retried and never shown as synced in between', async () => {
    const a = await device('a@x.com', 'a')
    a.n.fail500 = 1
    await a.e.commit('attempt', attempt('h-5', 'q1', true, 1000))
    await a.e.syncNow()
    expect(a.e.status.phase).toBe('retrying')
    expect(a.e.status.synced).toBe(false)
    await a.e.syncNow()
    expect(a.e.status.synced).toBe(true)
  })

  it('a browser restart keeps unsent ops (they live in IndexedDB)', async () => {
    const a = await device('a@x.com', 'a')
    a.n.offline = true
    await a.e.commit('attempt', attempt('h-r', 'q1', true, 1000))
    const dbName = a.e.db.name
    a.e.dispose()
    const again = new SyncEngine({
      accountId: a.e.accountId,
      email: 'a@x.com',
      clientId: a.e.clientId,
      bankFp: BANK_FP,
      fetcher: async () => {
        throw new Error('offline')
      },
      manual: true,
      db: new CloudDB(dbName),
    })
    await again.init()
    engines.push(again)
    expect(again.status.pending).toBe(1)
    expect(again.state.history).toHaveLength(1)
  })

  it('clear history on one device hides it on the other, but keeps progress and unseen answers', async () => {
    const a = await device('a@x.com', 'a')
    const b = await device('a@x.com', 'b')
    await a.e.commit('attempt', attempt('h-1', 'q1', true, 1000))
    await a.e.syncNow()
    await b.e.syncNow()
    // b answers something a has not seen yet
    await b.e.commit('attempt', attempt('h-2', 'q2', false, 1100))
    await b.e.syncNow()
    await a.e.commit('hide_history', { upto: a.e.pullCursor })
    await a.e.syncNow()
    await b.e.syncNow()
    for (const d of [a, b]) {
      expect(d.e.state.history.map((h) => h.id)).toEqual(['h-2'])
      expect(d.e.state.records.get('q1')?.attempts).toBe(1)
    }
  })

  it('reset cannot be undone by an offline device; its stale ops are quarantined, not lost', async () => {
    const a = await device('a@x.com', 'a')
    const old = await device('a@x.com', 'old')
    await a.e.commit('attempt', attempt('h-1', 'q1', true, 1000))
    await a.e.syncNow()
    await old.e.syncNow()
    old.n.offline = true
    await old.e.commit('attempt', attempt('h-old', 'q9', false, 1200))
    await a.e.commit('reset', {})
    await a.e.syncNow()
    expect(a.e.state.records.size).toBe(0)
    old.n.offline = false
    await old.e.syncNow()
    await old.e.syncNow()
    expect(old.e.state.records.size).toBe(0)
    expect(old.e.quarantine.map((q) => (q.op.body as { h: { id: string } }).h.id)).toEqual(['h-old'])
    expect(old.e.quarantine[0].reason).toBe('reset')
    await a.e.syncNow()
    expect(a.e.state.records.size).toBe(0)
    // user chooses to keep it: re-issued in the new epoch
    await old.e.restoreQuarantined(old.e.quarantine.map((q) => q.id))
    await old.e.syncNow()
    await a.e.syncNow()
    expect(a.e.state.records.get('q9')?.attempts).toBe(1)
  })

  it('different accounts never see each other', async () => {
    const a = await device('a@x.com', 'a')
    const b = await device('b@x.com', 'b')
    await a.e.commit('attempt', attempt('h-a', 'q1', true, 1000))
    await a.e.syncNow()
    await b.e.syncNow()
    expect(b.e.state.history).toHaveLength(0)
    expect(a.e.accountId).not.toBe(b.e.accountId)
  })

  it('a tab that still believes it is account A cannot push after the login changed to B', async () => {
    const a = await device('a@x.com', 'a')
    await a.e.commit('attempt', attempt('h-a', 'q1', true, 1000))
    a.n.email = 'b@x.com' // cookie now belongs to B
    await a.e.syncNow()
    expect(a.e.status.phase).toBe('account_switched')
    expect(a.e.status.pending).toBe(1) // kept, not lost, not uploaded to B
    const b = await device('b@x.com', 'b')
    await b.e.syncNow()
    expect(b.e.state.history).toHaveLength(0)
  })

  it('draft: newer progress on another device is not silently overwritten', async () => {
    const a = await device('a@x.com', 'a')
    const b = await device('a@x.com', 'b')
    await a.e.putDoc('draft.practice', { sessionId: 's1', idx: 1 })
    await a.e.syncNow()
    await b.e.syncNow()
    expect((b.e.getDoc('draft.practice')?.body as { idx: number }).idx).toBe(1)
    await b.e.putDoc('draft.practice', { sessionId: 's1', idx: 5 })
    await b.e.syncNow()
    // a, without pulling, writes from its older state
    await a.e.putDoc('draft.practice', { sessionId: 's1', idx: 2 })
    await a.e.syncNow()
    const doc = a.e.getDoc('draft.practice')!
    expect(doc.conflict).toBeTruthy()
    expect((doc.conflict!.body as { idx: number }).idx).toBe(5)
    expect(a.e.status.conflicts).toBe(1)
    await a.e.resolveDocUseServer('draft.practice')
    expect((a.e.getDoc('draft.practice')?.body as { idx: number }).idx).toBe(5)
  })

  it('settings: last write in server order wins, regardless of client clocks', async () => {
    const a = await device('a@x.com', 'a')
    const b = await device('a@x.com', 'b')
    await b.e.commit('settings', { patch: { theme: 'dark', studyTarget: 45 } })
    await b.e.syncNow()
    await a.e.commit('settings', { patch: { theme: 'light' } })
    await a.e.syncNow()
    await b.e.syncNow()
    for (const d of [a, b]) {
      expect(d.e.state.settings.theme).toBe('light')
      expect(d.e.state.settings.studyTarget).toBe(45)
    }
  })

  it('a draft deleted on one device does not block a new draft from a fresh device (tombstone)', async () => {
    const a = await device('a@x.com', 'a')
    await a.e.putDoc('draft.practice', { sessionId: 's1', idx: 1 })
    await a.e.syncNow()
    await a.e.deleteDoc('draft.practice', 's1')
    await a.e.syncNow()
    // a brand-new device (pulled everything, including the deleted placeholder)
    const b = await device('a@x.com', 'b')
    await b.e.syncNow()
    expect(b.e.getDoc('draft.practice')?.deleted).toBe(true)
    await b.e.putDoc('draft.practice', { sessionId: 's2', idx: 0 })
    await b.e.syncNow()
    expect(b.e.status.conflicts).toBe(0)
    expect(b.e.status.synced).toBe(true)
    await a.e.syncNow()
    expect((a.e.getDoc('draft.practice')?.body as { sessionId: string }).sessionId).toBe('s2')
  })

  it('an old local copy without the tombstone re-sends its draft instead of raising a conflict', async () => {
    const a = await device('a@x.com', 'a')
    const b = await device('a@x.com', 'b') // b never pulls the draft or its deletion
    await a.e.putDoc('draft.practice', { sessionId: 's1', idx: 1 })
    await a.e.syncNow()
    await a.e.deleteDoc('draft.practice', 's1')
    await a.e.syncNow()
    await b.e.putDoc('draft.practice', { sessionId: 's9', idx: 3 }, { version: 0 })
    await b.e.syncNow()
    await b.e.syncNow()
    expect(b.e.status.conflicts).toBe(0)
    expect(b.e.getDoc('draft.practice')?.dirty).toBe(false)
    await a.e.syncNow()
    expect((a.e.getDoc('draft.practice')?.body as { sessionId: string }).sessionId).toBe('s9')
  })

  it('a takeover based on a stale exam copy adopts the server exam instead of getting stuck', async () => {
    const a = await device('a@x.com', 'a')
    const b = await device('a@x.com', 'b')
    const exam = (runId: string, holder: string) => ({
      runId,
      qids: ['S001-第一章'],
      config: null,
      startedAt: Date.now(),
      endsAt: Date.now() + 600_000,
      durationMs: 600_000,
      answers: {},
      idx: 0,
      status: 'active',
      leaseGen: 1,
      holder,
    })
    await a.e.putDoc('exam.current', exam('run-old1', a.e.clientId), { pendingType: 'exam_start', leaseGen: 1 })
    await a.e.syncNow()
    await b.e.syncNow() // b sees run-old1
    const old = a.e.getDoc('exam.current')!
    await a.e.putDoc(
      'exam.current',
      { ...(old.body as object), status: 'abandoned' },
      { pendingType: 'exam_abandon', leaseGen: 1 },
    )
    await a.e.syncNow()
    await a.e.putDoc('exam.current', exam('run-new2', a.e.clientId), { pendingType: 'exam_start', leaseGen: 1 })
    await a.e.syncNow()
    // b still shows run-old1 and tries to take it over
    const bOld = b.e.getDoc('exam.current')!
    await b.e.putDoc('exam.current', { ...(bOld.body as object) }, { pendingType: 'exam_takeover', leaseGen: 1 })
    await b.e.syncNow()
    const now = b.e.getDoc('exam.current')!
    expect(now.conflict ?? null).toBeNull()
    expect(now.dirty).toBe(false)
    expect((now.body as { runId: string }).runId).toBe('run-new2')
    expect(b.e.status.conflicts).toBe(0)
  })
})
