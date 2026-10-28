/**
 * AI conversations and AI reviews through the EXISTING sync system
 * (engine → real Worker sync API → real D1), across devices and accounts.
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeHarness, type Harness, HOST, BANK_FP } from '../sync/test-harness'
import { handleApi } from '../../worker/api'
import { SyncEngine, CloudDB, type Fetcher } from '../../src/sync/engine'
import type { AiChatMsg } from '../../src/sync/protocol'

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

async function device(email: string, name: string) {
  const net = { offline: false }
  const fetcher: Fetcher = async (path, init) => {
    if (net.offline) throw new TypeError('Failed to fetch')
    const headers = new Headers(init.headers)
    headers.set('Cf-Access-Jwt-Assertion', await H.issuer.token(email))
    if (init.method === 'POST') headers.set('Origin', HOST)
    return handleApi(new Request(HOST + path, { method: init.method, headers, body: init.body as string }), H.env, {
      auth: { fetchJwks: async () => H.issuer.jwks },
    })
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
  return { e, net }
}

/** Same op ids as CloudStore's aiChat.putMsg / deleteConv. */
const put = (e: SyncEngine, conv: string, msg: AiChatMsg, meta?: { title?: string; kind?: 'question' | 'free' }) =>
  e.commit('ai_msg', { conv, ...(meta ?? {}), msg }, `aim-${msg.id}-${msg.status}`)
const del = (e: SyncEngine, conv: string) => e.commit('ai_conv_del', { conv }, `aid-${conv}`)
const u = (id: string, content: string, at: number): AiChatMsg => ({ id, role: 'user', content, status: 'done', at })
const a = (id: string, content: string, status: AiChatMsg['status'], at: number, error?: string): AiChatMsg => ({
  id,
  role: 'assistant',
  content,
  status,
  at,
  ...(error ? { error } : {}),
})

describe('AI chat sync', () => {
  it('phone chat appears on the computer with the full history and states', async () => {
    const phone = await device('s@x.com', 'phone')
    const pc = await device('s@x.com', 'pc')
    await put(phone.e, 'conv-1', u('id-m1', '什么是新发展理念？', 1000), { title: '什么是新发展理念？', kind: 'free' })
    await put(phone.e, 'conv-1', a('id-m2', '', 'generating', 1001))
    await put(phone.e, 'conv-1', a('id-m2', '创新、协调、绿色、开放、共享', 'done', 1001))
    await put(phone.e, 'conv-1', u('id-m3', '哪个最重要？', 2000))
    await put(phone.e, 'conv-1', a('id-m4', '五者是一个整体', 'done', 2001))
    await phone.e.syncNow()
    await pc.e.syncNow()
    const c = pc.e.state.aiChats
    expect(c.length).toBe(1)
    expect(c[0].title).toBe('什么是新发展理念？')
    expect(c[0].messages.map((m) => [m.role, m.content, m.status])).toEqual([
      ['user', '什么是新发展理念？', 'done'],
      ['assistant', '创新、协调、绿色、开放、共享', 'done'],
      ['user', '哪个最重要？', 'done'],
      ['assistant', '五者是一个整体', 'done'],
    ])
    // and back: a computer chat appears on the phone
    await put(pc.e, 'conv-2', u('id-p1', '电脑上的问题', 3000), { title: '电脑上的问题' })
    await put(pc.e, 'conv-2', a('id-p2', '电脑上的回答', 'done', 3001))
    await pc.e.syncNow()
    await phone.e.syncNow()
    expect(phone.e.state.aiChats.map((x) => x.id)).toEqual(['conv-2', 'conv-1'])
    expect(JSON.stringify(phone.e.state.aiChats)).toBe(JSON.stringify(pc.e.state.aiChats))
  })

  it('stop / failure / interruption keep honest states; a late "generating" never downgrades a final reply', async () => {
    const d1 = await device('s@x.com', 'd1')
    const d2 = await device('s@x.com', 'd2')
    await put(d1.e, 'conv-c', u('id-q1', '问', 1))
    await put(d1.e, 'conv-c', a('id-r1', '一半', 'cancelled', 2))
    await put(d1.e, 'conv-c', u('id-q2', '再问', 3))
    await put(d1.e, 'conv-c', a('id-r2', '半句', 'error', 4, 'AI 响应超时'))
    await put(d1.e, 'conv-c', u('id-q3', '第三问', 5))
    await put(d1.e, 'conv-c', a('id-r3', '', 'generating', 6)) // device closed mid-answer
    await d1.e.syncNow()
    await d2.e.syncNow()
    const st = d2.e.state.aiChats[0].messages
      .filter((m) => m.role === 'assistant')
      .map((m) => [m.id, m.status, m.content])
    expect(st).toEqual([
      ['id-r1', 'cancelled', '一半'],
      ['id-r2', 'error', '半句'],
      ['id-r3', 'generating', ''],
    ])
    expect(d2.e.state.aiChats[0].messages.find((m) => m.id === 'id-r2')!.error).toBe('AI 响应超时')
    // the final state arrives, then a replayed placeholder: final wins
    await put(d1.e, 'conv-c', a('id-r3', '完整回答', 'done', 6))
    await d1.e.syncNow()
    await d2.e.commit('ai_msg', { conv: 'conv-c', msg: a('id-r3', '', 'generating', 6) }, 'aim-r3-generating-replay')
    await d2.e.syncNow()
    for (const d of [d1, d2]) {
      await d.e.syncNow()
      expect(d.e.state.aiChats[0].messages.find((m) => m.id === 'id-r3')).toMatchObject({
        status: 'done',
        content: '完整回答',
      })
    }
  })

  it('retrying the same op (lost response / two tabs) never duplicates a message', async () => {
    const d = await device('s@x.com', 'd')
    const other = await device('s@x.com', 'o')
    for (let i = 0; i < 3; i++) await put(d.e, 'conv-c', u('same-id', '只发一次', 10))
    await d.e.syncNow()
    // second tab replays the same op id
    await put(other.e, 'conv-c', u('same-id', '只发一次', 10))
    await other.e.syncNow()
    await d.e.syncNow()
    expect(d.e.state.aiChats[0].messages.length).toBe(1)
    expect(other.e.state.aiChats[0].messages.length).toBe(1)
  })

  it('deleting a conversation propagates; an offline device cannot bring it back', async () => {
    const a1 = await device('s@x.com', 'a1')
    const b1 = await device('s@x.com', 'b1')
    await put(a1.e, 'conv-c', u('id-m1', 'hi', 1))
    await a1.e.syncNow()
    await b1.e.syncNow()
    expect(b1.e.state.aiChats.length).toBe(1)
    b1.net.offline = true
    await put(b1.e, 'conv-c', u('id-m2', '离线时追问', 2)) // written offline, before seeing the delete
    await del(a1.e, 'conv-c')
    await a1.e.syncNow()
    expect(a1.e.state.aiChats.length).toBe(0)
    b1.net.offline = false
    await b1.e.syncNow()
    await a1.e.syncNow()
    expect(b1.e.state.aiChats.length).toBe(0)
    expect(a1.e.state.aiChats.length).toBe(0)
  })

  it('a learning-data reset keeps AI conversations; settings-like epoch rules do not reject them', async () => {
    const d = await device('s@x.com', 'd')
    await put(d.e, 'conv-c', u('id-m1', 'hi', 1))
    await d.e.syncNow()
    await d.e.commit('reset', {})
    await d.e.syncNow()
    await put(d.e, 'conv-c', u('id-m2', 'after reset', 2))
    await d.e.syncNow()
    expect(d.e.state.aiChats[0].messages.length).toBe(2)
    expect(d.e.status.conflicts).toBe(0)
  })

  it('accounts are isolated: another account never receives the conversation', async () => {
    const s = await device('s@x.com', 's')
    const t = await device('t@x.com', 't')
    await put(s.e, 'conv-c', u('id-m1', '我的私人问题', 1))
    await s.e.syncNow()
    await t.e.syncNow()
    expect(t.e.state.aiChats).toEqual([])
    const r = await H.call('GET', '/api/sync/pull?since=0', { email: 't@x.com' })
    expect(JSON.stringify(r.json)).not.toContain('我的私人问题')
  })

  it('AI reviews sync across devices and a repeated review does not add attempts', async () => {
    const phone = await device('s@x.com', 'p')
    const pc = await device('s@x.com', 'conv-c')
    const review = (score: number) => ({
      id: 'ai-sess1-Q1',
      qid: 'Q1',
      userAnswer: '我的完整作答',
      createdAt: 100 + score,
      provider: 'sub2api',
      model: 'grok-4.7',
      result: {
        score,
        maxScore: 100,
        hitPoints: ['a'],
        missedPoints: [],
        deductions: [],
        suggestions: [],
        structureNote: 'ok',
        disclaimer: 'd',
      },
    })
    const attempt = {
      id: 'h-sess1-Q1',
      qid: 'Q1',
      mode: 'subjective',
      sessionId: 'sess1',
      answer: '我的完整作答',
      isCorrect: null,
      submittedAt: 100,
      usedAI: true,
    }
    await phone.e.commit('ai_review', { review: review(60), attempt })
    await phone.e.commit('ai_review', { review: review(70), attempt })
    await phone.e.syncNow()
    await pc.e.syncNow()
    expect(pc.e.state.aiReviews.length).toBe(1)
    expect(pc.e.state.aiReviews[0]).toMatchObject({
      userAnswer: '我的完整作答',
      model: 'grok-4.7',
      result: { score: 70 },
    })
    expect(pc.e.state.records.get('Q1')!.attempts).toBe(1)
    expect(pc.e.state.history.filter((h) => h.qid === 'Q1').length).toBe(1)
  })

  it('the server validates chat ops (bad status, oversize content, user message not "done")', async () => {
    const d = await device('s@x.com', 'd')
    await d.e.commit(
      'ai_msg',
      { conv: 'conv-c', msg: { id: 'x1', role: 'assistant', content: 'x', status: 'weird', at: 1 } },
      'bad-1',
    )
    await d.e.commit(
      'ai_msg',
      { conv: 'conv-c', msg: { id: 'x2', role: 'user', content: 'y'.repeat(70_000), status: 'done', at: 1 } },
      'bad-2',
    )
    await d.e.commit(
      'ai_msg',
      { conv: 'conv-c', msg: { id: 'x3', role: 'user', content: 'z', status: 'generating', at: 1 } },
      'bad-3',
    )
    await d.e.syncNow()
    expect(d.e.quarantine.map((q) => q.op.id).sort()).toEqual(['bad-1', 'bad-2', 'bad-3'])
  })

  it('a device that joins after a reset still receives AI conversations and settings written before it', async () => {
    const d = await device('s@x.com', 'd')
    await put(d.e, 'conv-c', u('id-m1', '重置前的对话', 1))
    await d.e.commit('settings', { patch: { theme: 'dark' } })
    await d.e.commit('attempt', {
      h: {
        id: 'h-old-1',
        qid: 'Q-old',
        mode: 'practice',
        sessionId: 's1',
        answer: 'A',
        isCorrect: true,
        submittedAt: 1,
        usedAI: false,
      },
      ef: 1,
    })
    await d.e.syncNow()
    await d.e.commit('reset', {})
    await d.e.syncNow()
    const fresh = await device('s@x.com', 'fresh')
    await fresh.e.syncNow()
    expect(fresh.e.state.aiChats[0]?.messages[0]?.content).toBe('重置前的对话')
    expect(fresh.e.state.settings.theme).toBe('dark')
    expect(fresh.e.state.history.length).toBe(0) // learning data stays reset
    expect(fresh.e.state.records.size).toBe(0)
  })
})
