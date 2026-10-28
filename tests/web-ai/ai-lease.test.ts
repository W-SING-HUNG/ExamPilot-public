/**
 * D-01: AI concurrency leases. The account cap still exists, but a slot can no
 * longer be held forever: a lost cleanup expires, a cancelled stream frees its slot
 * at once, and one request can never release another request's slot.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeHarness, HOST, type Harness } from '../sync/test-harness'
import {
  handleAi,
  _resetAiGuards,
  _activeLeaseCount,
  acquireLease,
  releaseLease,
  renewLease,
  AI_LIMITS,
  type AiEnv,
  type AiDeps,
} from '../../worker/ai'

const enc = new TextEncoder()
let H: Harness
let env: AiEnv
beforeEach(async () => {
  H = await makeHarness()
  _resetAiGuards()
  env = {
    ...H.env,
    AI_BASE_URL: 'https://gw.example.com/v1',
    AI_API_KEY: 'sk-test-k',
    AI_MODEL: 'grok-4.7',
    AI_TIMEOUT_MS: '5000',
  }
})
afterEach(async () => {
  await H.dispose()
})

async function grant(email: string) {
  const id = (await H.call('GET', '/api/sync/me', { email })).json.accountId as string
  await H.raw
    .prepare(
      `INSERT INTO pro_grants (id, email, source, kind, duration_ms, starts_at, state, created_by, created_at) VALUES (?, ?, 'admin', 'permanent', 0, 0, 'active', 'test', 0)`,
    )
    .bind('pg_' + id, email)
    .run()
  return id
}
async function qa(
  email: string,
  deps: AiDeps,
  body: unknown = { messages: [{ role: 'user', content: 'hi' }], stream: true },
) {
  return handleAi(
    new Request(HOST + '/api/ai/qa', {
      method: 'POST',
      headers: {
        'X-ExamPilot-Client': '1',
        'Content-Type': 'application/json',
        Origin: HOST,
        'Cf-Access-Jwt-Assertion': await H.issuer.token(email),
      },
      body: JSON.stringify(body),
    }),
    env,
    { auth: { fetchJwks: async () => H.issuer.jwks }, ...deps },
  )
}
/** an upstream SSE that sends one chunk, then stays open until aborted */
function hangingGateway() {
  const seen: { aborted: boolean }[] = []
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(String(input), init)
    const s = { aborted: false }
    seen.push(s)
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: '第一段' } }] })}\n\n`))
        req.signal.addEventListener('abort', () => {
          s.aborted = true
          try {
            c.error(new DOMException('aborted', 'AbortError'))
          } catch {
            /* closed */
          }
        })
      },
    })
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
  }) as typeof fetch
  return { fetch: f, seen }
}

describe('lease primitives', () => {
  it('a lease whose cleanup never runs stops counting after its TTL', () => {
    const t0 = 1_000_000
    for (let i = 0; i < AI_LIMITS.maxConcurrent; i++) expect(acquireLease('acc', t0, 30_000, 'qa')).toBeTruthy()
    expect(acquireLease('acc', t0 + 1, 30_000, 'qa')).toBeNull() // cap still enforced
    expect(_activeLeaseCount('acc', t0 + 29_999)).toBe(AI_LIMITS.maxConcurrent)
    expect(_activeLeaseCount('acc', t0 + 30_000)).toBe(0) // all expired, nobody released
    expect(acquireLease('acc', t0 + 30_000, 30_000, 'qa')).toBeTruthy()
  })
  it('release removes only its own lease; double release is harmless', () => {
    const a = acquireLease('acc', 0, 60_000, 'qa')!
    const b = acquireLease('acc', 0, 60_000, 'qa')!
    releaseLease('acc', a, 1)
    releaseLease('acc', a, 2)
    releaseLease('other', b, 3) // wrong account: no effect
    expect(_activeLeaseCount('acc', 4)).toBe(1)
    releaseLease('acc', b, 5)
    expect(_activeLeaseCount('acc', 6)).toBe(0)
  })
  it('renewal keeps a live stream counted past its first TTL', () => {
    const a = acquireLease('acc', 0, 10_000, 'qa')!
    renewLease('acc', a, 9_000, 10_000)
    expect(_activeLeaseCount('acc', 15_000)).toBe(1)
    expect(_activeLeaseCount('acc', 19_000)).toBe(0)
  })
  it('accounts never share slots', () => {
    for (let i = 0; i < AI_LIMITS.maxConcurrent; i++) acquireLease('a', 0, 60_000, 'qa')
    expect(acquireLease('b', 1, 60_000, 'qa')).toBeTruthy()
  })
})

describe('handler', () => {
  it('a client that cancels a running stream frees its slot immediately and aborts upstream', async () => {
    const id = await grant('a@x.com')
    const gw = hangingGateway()
    const res = await qa('a@x.com', { fetch: gw.fetch })
    expect(res.status).toBe(200)
    const rd = res.body!.getReader()
    await rd.read() // start
    await rd.read() // first chunk
    expect(_activeLeaseCount(id)).toBe(1)
    await rd.cancel()
    expect(_activeLeaseCount(id)).toBe(0)
    await new Promise((r) => setTimeout(r, 10))
    expect(gw.seen[0].aborted).toBe(true)
  })
  it('the cap answers 429 BUSY with Retry-After; cancelling one stream lets the next request in', async () => {
    const id = await grant('a@x.com')
    const gw = hangingGateway()
    const readers: ReadableStreamDefaultReader<Uint8Array>[] = []
    for (let i = 0; i < AI_LIMITS.maxConcurrent; i++) {
      const r = await qa('a@x.com', { fetch: gw.fetch })
      const rd = r.body!.getReader()
      await rd.read()
      readers.push(rd)
    }
    const busy = await qa('a@x.com', { fetch: gw.fetch })
    expect(busy.status).toBe(429)
    const j = await busy.json()
    expect(j.code).toBe('BUSY')
    expect(Number(busy.headers.get('Retry-After'))).toBeGreaterThan(0)
    expect(j.retryAfter).toBeGreaterThan(0)
    await readers[0].cancel()
    const ok = await qa('a@x.com', { fetch: gw.fetch })
    expect(ok.status).toBe(200)
    await ok.body!.cancel()
    for (const r of readers.slice(1)) await r.cancel()
    expect(_activeLeaseCount(id)).toBe(0)
  })
  it('completed requests release their slot (30 sequential streams never hit BUSY)', async () => {
    const id = await grant('a@x.com')
    const f = (async () =>
      new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\ndata: [DONE]\n\n`, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })) as typeof fetch
    for (let i = 0; i < 30; i++) {
      const r = await qa('a@x.com', { fetch: f })
      expect(r.status).toBe(200)
      expect(await r.text()).toContain('"done"')
    }
    expect(_activeLeaseCount(id)).toBe(0)
  })
  it('a request abandoned without any cleanup (runtime dropped it) stops blocking after the lease TTL', async () => {
    const id = await grant('a@x.com')
    const gw = hangingGateway()
    const t0 = Date.now()
    for (let i = 0; i < AI_LIMITS.maxConcurrent; i++) {
      const r = await qa('a@x.com', { fetch: gw.fetch })
      await r.body!.getReader().read() // never read again, never cancelled
    }
    expect((await qa('a@x.com', { fetch: gw.fetch })).status).toBe(429)
    // stream TTL = AI_TIMEOUT_MS (5s) + 15s; nothing renews an abandoned stream
    expect(_activeLeaseCount(id, t0 + 20_500)).toBe(0)
  })
})
