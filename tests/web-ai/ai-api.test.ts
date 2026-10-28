/**
 * Web AI API (worker/ai.ts) — permission, credential and streaming behaviour.
 *
 * Runs the real handler against a real D1 (Miniflare) and a mock Sub2API
 * gateway injected as `fetch`. The streaming cases mirror tests/ai-stream.test.mjs
 * (the local proxy's regression suite) so the port keeps every earlier fix.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeHarness, HOST, type Harness } from '../sync/test-harness'
import { handleAi, _resetAiGuards, type AiEnv, type AiDeps } from '../../worker/ai'
import { DISCLAIMER, WEB_ACCURACY_GUARD } from '../../worker/ai-prompts'

const KEY = 'fixture-credential-not-a-real-key'
const enc = new TextEncoder()

interface Seen {
  url: string
  auth: string | null
  body: any
  aborted: boolean
  redirect: string
}

type Behaviour = (req: Request, seen: Seen) => Response | Promise<Response>

function gateway(behaviour: Behaviour) {
  const calls: Seen[] = []
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(String(input), init)
    const seen: Seen = {
      url: req.url,
      auth: req.headers.get('Authorization'),
      body: JSON.parse(await req.clone().text()),
      aborted: false,
      redirect: req.redirect,
    }
    calls.push(seen)
    req.signal.addEventListener('abort', () => (seen.aborted = true))
    if (req.signal.aborted) throw new DOMException('aborted', 'AbortError')
    return behaviour(req, seen)
  }) as typeof fetch
  return { fetch: f, calls }
}

/** An SSE body that emits frames with optional delays and honours abort. */
function sse(frames: (string | { wait: number } | { bytes: Uint8Array } | { fail: string })[], req: Request) {
  const stream = new ReadableStream<Uint8Array>({
    async start(c) {
      for (const fr of frames) {
        if (req.signal.aborted) return c.error(new DOMException('aborted', 'AbortError'))
        if (typeof fr === 'string') c.enqueue(enc.encode(fr))
        else if ('wait' in fr) {
          await new Promise<void>((res) => {
            const t = setTimeout(res, fr.wait)
            req.signal.addEventListener('abort', () => {
              clearTimeout(t)
              res()
            })
          })
          if (req.signal.aborted) return c.error(new DOMException('aborted', 'AbortError'))
        } else if ('bytes' in fr) c.enqueue(fr.bytes)
        else return c.error(new Error(fr.fail))
      }
      c.close()
    },
  })
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}
const delta = (t: string) => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`

let H: Harness
let env: AiEnv

beforeEach(async () => {
  H = await makeHarness()
  _resetAiGuards()
  env = {
    ...H.env,
    AI_BASE_URL: 'https://gw.example.com/v1',
    AI_API_KEY: KEY,
    AI_MODEL: 'grok-4.7',
    AI_TIMEOUT_MS: '5000',
  }
})
afterEach(async () => {
  await H.dispose()
})

async function accountOf(email: string): Promise<string> {
  const r = await H.call('GET', '/api/sync/me', { email })
  return r.json.accountId
}
async function setPro(email: string, on: boolean) {
  if (on)
    await H.raw
      .prepare(
        `INSERT INTO pro_grants (id, email, source, kind, duration_ms, starts_at, state, created_by, created_at) VALUES (?, ?, 'admin', 'permanent', 0, 0, 'active', 'test', 0)`,
      )
      .bind('pg_t' + Math.random().toString(36).slice(2), email)
      .run()
  else
    await H.raw
      .prepare(`UPDATE pro_grants SET state = 'revoked', revoked_at = ? WHERE email = ? AND state = 'active'`)
      .bind(Date.now() - 1, email)
      .run()
}
async function grant(email: string, on = true) {
  const id = await accountOf(email)
  await setPro(email, on)
  return id
}
async function makeAdmin(email: string) {
  const id = await accountOf(email)
  await H.raw.prepare(`UPDATE members SET role = 'super' WHERE email = ?`).bind(email).run()
  return id
}

async function ai(
  method: string,
  p: string,
  opts: {
    email?: string | null
    token?: string
    body?: unknown
    headers?: Record<string, string>
    deps?: AiDeps
    raw?: boolean
  } = {},
) {
  const headers: Record<string, string> = { 'X-ExamPilot-Client': '1', ...(opts.headers ?? {}) }
  if (opts.token !== undefined) headers['Cf-Access-Jwt-Assertion'] = opts.token
  else if (opts.email !== null) headers['Cf-Access-Jwt-Assertion'] = await H.issuer.token(opts.email ?? 'a@example.com')
  let body: string | undefined
  if (opts.body !== undefined) {
    body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)
    headers['Content-Type'] = headers['Content-Type'] ?? 'application/json'
    headers['Origin'] = headers['Origin'] ?? HOST
  }
  const res = await handleAi(new Request(HOST + p, { method, headers, body }), env, {
    auth: { fetchJwks: async () => H.issuer.jwks },
    ...opts.deps,
  })
  return res
}
async function readSse(res: Response) {
  const text = await res.text()
  const events = text
    .split('\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => JSON.parse(l.slice(6)))
  return {
    text,
    events,
    joined: events
      .filter((e) => e.type === 'chunk')
      .map((e) => e.delta)
      .join(''),
  }
}

const QA = { messages: [{ role: 'user', content: '什么是新发展理念？' }], stream: true }
const GRADE = {
  qid: 'Q1',
  stem: '论述新发展理念',
  userAnswer: '创新协调绿色开放共享',
  chapter: '第七章',
  kind: 'short',
}

/* ======================================================= permissions */
describe('permissions', () => {
  it('default: a new account has no AI (status says so, qa/grade refused before any upstream call)', async () => {
    const gw = gateway(() => new Response('{}'))
    const st = await (await ai('GET', '/api/ai/status', { email: 'n@x.com', deps: { fetch: gw.fetch } })).json()
    expect(st).toMatchObject({ ok: true, allowed: false, admin: false })
    expect(JSON.stringify(st)).not.toContain('gw.example.com')
    const qa = await ai('POST', '/api/ai/qa', { email: 'n@x.com', body: QA, deps: { fetch: gw.fetch } })
    expect(qa.status).toBe(403)
    expect((await qa.json()).error).toBe('ai_forbidden')
    const gr = await ai('POST', '/api/ai/grade', { email: 'n@x.com', body: GRADE, deps: { fetch: gw.fetch } })
    expect(gr.status).toBe(403)
    expect(gw.calls.length).toBe(0)
  })

  it('a granted account can call; the upstream gets the server key and model, never client values', async () => {
    await grant('g@x.com')
    const gw = gateway((req) => sse([delta('你好'), 'data: [DONE]\n\n'], req))
    const res = await ai('POST', '/api/ai/qa', {
      email: 'g@x.com',
      body: { ...QA, model: 'evil', baseUrl: 'https://evil.example', apiKey: 'x' },
      deps: { fetch: gw.fetch },
    })
    const { joined } = await readSse(res)
    expect(joined).toBe('你好')
    expect(gw.calls[0].url).toBe('https://gw.example.com/v1/chat/completions')
    expect(gw.calls[0].auth).toBe('Bearer ' + KEY)
    expect(gw.calls[0].body.model).toBe('grok-4.7')
    expect(gw.calls[0].redirect).toBe('manual')
  })

  it('identity comes only from the verified token: body/header claims are ignored', async () => {
    await grant('g@x.com')
    const gw = gateway(() => new Response('{}'))
    const res = await ai('POST', '/api/ai/qa', {
      email: 'n@x.com',
      body: { ...QA, email: 'g@x.com', ai_enabled: true },
      headers: { 'X-User-Email': 'g@x.com', 'Cf-Access-Authenticated-User-Email': 'g@x.com' },
      deps: { fetch: gw.fetch },
    })
    expect(res.status).toBe(403)
    expect(gw.calls.length).toBe(0)
  })

  it('no token / bad signature / expired / wrong audience are rejected', async () => {
    await grant('g@x.com')
    const gw = gateway(() => new Response('{}'))
    const d = { fetch: gw.fetch }
    expect((await ai('POST', '/api/ai/qa', { email: null, body: QA, deps: d })).status).toBe(401)
    const forged = await H.issuer.sign(
      {
        aud: ['aud-test-0123456789'],
        email: 'g@x.com',
        exp: Date.now() / 1000 + 600,
        iat: Date.now() / 1000,
        iss: 'https://test-team.cloudflareaccess.com',
        sub: 's',
      },
      { key: H.issuer.otherKey },
    )
    expect((await ai('POST', '/api/ai/qa', { token: forged, body: QA, deps: d })).status).toBe(401)
    const expired = await H.issuer.token('g@x.com', { exp: Math.floor(Date.now() / 1000) - 3600 })
    expect((await ai('POST', '/api/ai/qa', { token: expired, body: QA, deps: d })).status).toBe(401)
    const wrongAud = await H.issuer.token('g@x.com', { aud: ['other-app'] })
    expect((await ai('POST', '/api/ai/qa', { token: wrongAud, body: QA, deps: d })).status).toBe(401)
    expect(gw.calls.length).toBe(0)
  })

  it('a failed permission lookup denies (fail closed) without calling upstream', async () => {
    await grant('g@x.com')
    const gw = gateway(() => new Response('{}'))
    H.failQueries([/FROM pro_grants/])
    const res = await ai('POST', '/api/ai/qa', { email: 'g@x.com', body: QA, deps: { fetch: gw.fetch } })
    expect(res.status).toBe(503)
    expect((await res.json()).error).toBe('ai_forbidden')
    // N-01: status reports "unavailable" (503, ok:false) instead of a definitive
    // allowed:false, so an open page keeps its state instead of hiding AI mid-answer.
    const stRes = await ai('GET', '/api/ai/status', { email: 'g@x.com' })
    expect(stRes.status).toBe(503)
    const st = await stRes.json()
    expect(st.ok).toBe(false)
    expect(st.allowed).not.toBe(true)
    expect(gw.calls.length).toBe(0)
  })

  it('revoking stops new requests immediately', async () => {
    await grant('g@x.com')
    const gw = gateway((req) => sse([delta('ok'), 'data: [DONE]\n\n'], req))
    expect(
      (await readSse(await ai('POST', '/api/ai/qa', { email: 'g@x.com', body: QA, deps: { fetch: gw.fetch } }))).joined,
    ).toBe('ok')
    await grant('g@x.com', false)
    expect((await ai('POST', '/api/ai/qa', { email: 'g@x.com', body: QA, deps: { fetch: gw.fetch } })).status).toBe(403)
    expect(gw.calls.length).toBe(1)
  })

  it('revoking during a running stream stops it with an explicit error and cancels upstream', async () => {
    await grant('g@x.com')
    const frames: (string | { wait: number })[] = []
    for (let i = 0; i < 40; i++) frames.push(delta('字'), { wait: 25 })
    const gw = gateway((req) => sse(frames, req))
    const resP = ai('POST', '/api/ai/qa', { email: 'g@x.com', body: QA, deps: { fetch: gw.fetch, recheckMs: 100 } })
    setTimeout(() => void grant('g@x.com', false), 250)
    const { events, joined } = await readSse(await resP)
    const last = events[events.length - 1]
    expect(last.type).toBe('error')
    expect(last.code).toBe('AI_FORBIDDEN')
    expect(joined.length).toBeGreaterThan(0)
    expect(joined.length).toBeLessThan(40)
    expect(gw.calls[0].aborted).toBe(true)
  })

  it('N-01: a permission re-check that cannot run is not a revocation (no AI_FORBIDDEN); repeated failures stop with a retryable error', async () => {
    await grant('g@x.com')
    const frames: (string | { wait: number })[] = []
    for (let i = 0; i < 40; i++) frames.push(delta('字'), { wait: 25 })
    const gw = gateway((req) => sse(frames, req))
    const resP = ai('POST', '/api/ai/qa', { email: 'g@x.com', body: QA, deps: { fetch: gw.fetch, recheckMs: 100 } })
    setTimeout(() => H.failQueries([/FROM pro_grants/]), 150)
    const { events } = await readSse(await resP)
    const last = events[events.length - 1]
    expect(last.type).toBe('error')
    expect(last.code).toBe('AI_PERMISSION_UNAVAILABLE')
    expect(events.some((e) => e.code === 'AI_FORBIDDEN')).toBe(false)
  })

  it('CSRF guards: missing client header, cross-origin POST, non-JSON content type', async () => {
    await grant('g@x.com')
    expect(
      (await ai('GET', '/api/ai/status', { email: 'g@x.com', headers: { 'X-ExamPilot-Client': '' } })).status,
    ).toBe(400)
    expect(
      (await ai('POST', '/api/ai/qa', { email: 'g@x.com', body: QA, headers: { Origin: 'https://evil.example' } }))
        .status,
    ).toBe(403)
    expect(
      (await ai('POST', '/api/ai/qa', { email: 'g@x.com', body: QA, headers: { 'Content-Type': 'text/plain' } }))
        .status,
    ).toBe(415)
  })
})

/* ========================================================= credentials */
describe('credentials', () => {
  it('/api/ai/config does not exist (any method), nothing changes', async () => {
    await grant('g@x.com')
    await makeAdmin('g@x.com')
    for (const m of ['GET', 'POST', 'PUT', 'DELETE']) {
      const r = await ai(m, '/api/ai/config', {
        email: 'g@x.com',
        ...(m === 'GET' || m === 'DELETE'
          ? {}
          : { body: { baseUrl: 'https://evil.example/v1', apiKey: 'stolen', model: 'x' } }),
      })
      expect(r.status).toBe(404)
    }
    const gw = gateway((req) => sse([delta('ok'), 'data: [DONE]\n\n'], req))
    await readSse(await ai('POST', '/api/ai/qa', { email: 'g@x.com', body: QA, deps: { fetch: gw.fetch } }))
    expect(gw.calls[0].url.startsWith('https://gw.example.com/')).toBe(true)
  })

  it('status never returns key, base URL or a masked key', async () => {
    await grant('g@x.com')
    const t = await (await ai('GET', '/api/ai/status', { email: 'g@x.com' })).text()
    expect(t).not.toContain(KEY)
    expect(t).not.toContain(KEY.slice(0, 6))
    expect(t).not.toContain('gw.example.com')
    expect(t).not.toMatch(/maskedKey|baseUrl|hasKey/)
    expect(JSON.parse(t)).toMatchObject({ allowed: true, configured: true, model: 'grok-4.7' })
  })

  it('gateway errors that echo the key are redacted', async () => {
    await grant('g@x.com')
    const gw = gateway(() => new Response(`invalid key ${KEY} (Bearer ${KEY})`, { status: 401 }))
    const t = await (await ai('POST', '/api/ai/qa', { email: 'g@x.com', body: QA, deps: { fetch: gw.fetch } })).text()
    expect(t).not.toContain(KEY)
    expect(t).toContain('网关返回 401')
    const g2 = gateway(() => new Response(`bad ${KEY}`, { status: 500 }))
    const t2 = await (
      await ai('POST', '/api/ai/grade', { email: 'g@x.com', body: GRADE, deps: { fetch: g2.fetch } })
    ).text()
    expect(t2).not.toContain(KEY)
  })

  it('a redirect from the gateway is refused (the key is not re-sent elsewhere)', async () => {
    await grant('g@x.com')
    const gw = gateway(() => new Response(null, { status: 307, headers: { Location: 'https://evil.example/steal' } }))
    const r = await ai('POST', '/api/ai/qa', { email: 'g@x.com', body: QA, deps: { fetch: gw.fetch } })
    const j = await r.json()
    expect(j.ok).toBe(false)
    expect(j.reason).toContain('重定向')
    expect(gw.calls.length).toBe(1)
  })

  it('unconfigured gateway: explicit NOT_CONFIGURED, no call, no fake success', async () => {
    await grant('g@x.com')
    env.AI_API_KEY = ''
    const gw = gateway(() => new Response('{}'))
    const j = await (await ai('POST', '/api/ai/qa', { email: 'g@x.com', body: QA, deps: { fetch: gw.fetch } })).json()
    expect(j).toMatchObject({ ok: false, code: 'NOT_CONFIGURED' })
    expect(gw.calls.length).toBe(0)
    env.AI_API_KEY = KEY
    env.AI_BASE_URL = 'http://plain-http.example/v1'
    const j2 = await (await ai('POST', '/api/ai/qa', { email: 'g@x.com', body: QA, deps: { fetch: gw.fetch } })).json()
    expect(j2.code).toBe('NOT_CONFIGURED')
  })
})

/* =========================================================== streaming */
describe('streaming (mirrors tests/ai-stream.test.mjs)', () => {
  beforeEach(async () => {
    await grant('g@x.com')
  })
  const ask = (gw: { fetch: typeof fetch }, extra: Partial<AiDeps> = {}) =>
    ai('POST', '/api/ai/qa', { email: 'g@x.com', body: QA, deps: { fetch: gw.fetch, ...extra } })

  it('streams a standard SSE answer with start/chunk/done events and no-cache headers', async () => {
    const gw = gateway((req) => sse([delta('新发展'), delta('理念'), 'data: [DONE]\n\n'], req))
    const res = await ask(gw)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    expect(res.headers.get('cache-control')).toContain('no-store')
    const { events, joined } = await readSse(res)
    expect(events[0]).toMatchObject({ type: 'start', model: 'grok-4.7', provider: 'sub2api' })
    expect(joined).toBe('新发展理念')
    expect(events[events.length - 1]).toEqual({ type: 'done' })
  })

  it('accepts `data:` frames without the space and a final frame without trailing newline', async () => {
    const gw = gateway((req) =>
      sse(
        [
          `data:${JSON.stringify({ choices: [{ delta: { content: 'A' } }] })}\n\n`,
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'B' } }] })}`,
        ],
        req,
      ),
    )
    const { joined, events } = await readSse(await ask(gw))
    expect(joined).toBe('AB')
    expect(events[events.length - 1].type).toBe('done')
  })

  it('degrades to a single chunk when the gateway ignores stream:true (plain JSON)', async () => {
    const gw = gateway(
      () =>
        new Response(JSON.stringify({ choices: [{ message: { content: '整段回答' } }] }), {
          headers: { 'Content-Type': 'application/json' },
        }),
    )
    const { joined, events } = await readSse(await ask(gw))
    expect(joined).toBe('整段回答')
    expect(events.map((e) => e.type)).toEqual(['start', 'chunk', 'done'])
  })

  it('plain JSON without content is an error, never parsed as SSE nor a success', async () => {
    const gw = gateway(
      () => new Response(JSON.stringify({ choices: [] }), { headers: { 'Content-Type': 'application/json' } }),
    )
    const j = await (await ask(gw)).json()
    expect(j).toMatchObject({ ok: false, code: 'BAD_RESPONSE' })
  })

  it('a long but continuously streaming answer is NOT cut off by the idle timeout', async () => {
    env.AI_TIMEOUT_MS = '5000'
    const frames: (string | { wait: number })[] = []
    for (let i = 0; i < 30; i++) frames.push(delta('x'), { wait: 200 }) // 6s total > 5s idle
    frames.push('data: [DONE]\n\n')
    const gw = gateway((req) => sse(frames, req))
    const { joined, events } = await readSse(await ask(gw))
    expect(joined).toBe('x'.repeat(30))
    expect(events[events.length - 1].type).toBe('done')
  }, 20000)

  it('UTF-8 split across network chunks is decoded correctly', async () => {
    const full = enc.encode(delta('习近平新时代'))
    const gw = gateway((req) =>
      sse(
        [{ bytes: full.slice(0, 17) }, { bytes: full.slice(17, 20) }, { bytes: full.slice(20) }, 'data: [DONE]\n\n'],
        req,
      ),
    )
    expect((await readSse(await ask(gw))).joined).toBe('习近平新时代')
  })

  it('empty stream -> explicit error, never a silent success', async () => {
    const gw = gateway((req) => sse(['data: [DONE]\n\n'], req))
    const { events } = await readSse(await ask(gw))
    expect(events[events.length - 1]).toMatchObject({ type: 'error', code: 'EMPTY_STREAM' })
    expect(events.some((e) => e.type === 'done')).toBe(false)
  })

  it('204 No Content -> explicit error', async () => {
    const gw = gateway(() => new Response(null, { status: 204 }))
    const j = await (await ask(gw)).json()
    expect(j.ok).toBe(false)
  })

  it('a gateway that never sends headers times out with a clear reason', async () => {
    env.AI_TIMEOUT_MS = '5000'
    const gw = gateway(
      (req) =>
        new Promise<Response>((_, rej) => {
          req.signal.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')))
        }),
    )
    const j = await (await ask(gw)).json()
    expect(j).toMatchObject({ ok: false, code: 'TIMEOUT' })
    expect(j.reason).toContain('未返回响应头')
    expect(gw.calls[0].aborted).toBe(true)
  }, 15000)

  it('a stream that opens then goes silent times out with a clear reason (partial kept)', async () => {
    env.AI_TIMEOUT_MS = '5000'
    const gw = gateway((req) => sse([delta('半句'), { wait: 60_000 }], req))
    const { events, joined } = await readSse(await ask(gw))
    expect(joined).toBe('半句')
    expect(events[events.length - 1]).toMatchObject({ type: 'error', code: 'TIMEOUT' })
    expect(events[events.length - 1].reason).toContain('没有收到新内容')
  }, 15000)

  it('upstream HTTP 500 is reported, not masked', async () => {
    const gw = gateway(() => new Response('upstream exploded', { status: 500 }))
    const r = await ask(gw)
    expect(r.status).toBe(502)
    expect((await r.json()).reason).toContain('网关返回 500')
  })

  it('an upstream dying mid-stream keeps the partial text and reports the break', async () => {
    const gw = gateway((req) => sse([delta('部分'), { wait: 30 }, { fail: 'connection reset' }], req))
    const { events, joined } = await readSse(await ask(gw))
    expect(joined).toBe('部分')
    expect(events[events.length - 1]).toMatchObject({ type: 'error', code: 'STREAM_ERROR' })
  })

  it('a client abort (stop / page closed) cancels the UPSTREAM request (no 499 leak)', async () => {
    const frames: (string | { wait: number })[] = []
    for (let i = 0; i < 100; i++) frames.push(delta('字'), { wait: 20 })
    const gw = gateway((req) => sse(frames, req))
    const res = await ask(gw)
    const reader = res.body!.getReader()
    await reader.read()
    await reader.read()
    await reader.cancel()
    await new Promise((r) => setTimeout(r, 100))
    expect(gw.calls[0].aborted).toBe(true)
    // and later requests still work (no stuck concurrency slot)
    for (let i = 0; i < 5; i++) {
      const g2 = gateway((req) => sse([delta('ok'), 'data: [DONE]\n\n'], req))
      expect((await readSse(await ask(g2))).joined).toBe('ok')
    }
  })

  it('a malformed request body is a 400, not a 502 that blames the gateway', async () => {
    const gw = gateway(() => new Response('{}'))
    const r = await ai('POST', '/api/ai/qa', { email: 'g@x.com', body: '{not json', deps: { fetch: gw.fetch } })
    expect(r.status).toBe(400)
    expect(gw.calls.length).toBe(0)
  })

  it('oversized input is refused before any upstream call (size guard, not a quota)', async () => {
    const gw = gateway(() => new Response('{}'))
    const big = { messages: [{ role: 'user', content: 'x'.repeat(50_000) }], stream: true }
    const r = await ai('POST', '/api/ai/qa', { email: 'g@x.com', body: big, deps: { fetch: gw.fetch } })
    expect(r.status).toBe(400)
    const huge = await ai('POST', '/api/ai/qa', {
      email: 'g@x.com',
      body: { messages: [{ role: 'user', content: 'y'.repeat(400_000) }] },
      deps: { fetch: gw.fetch },
    })
    expect(huge.status).toBe(413)
    expect(gw.calls.length).toBe(0)
  })

  it('there is no daily/total usage cap: 200 sequential requests all succeed', async () => {
    for (let i = 0; i < 200; i++) {
      _resetAiGuards() // the per-minute burst guard is time based; this checks no cumulative cap exists
      const gw = gateway(
        () =>
          new Response(JSON.stringify({ choices: [{ message: { content: 'ok' + i } }] }), {
            headers: { 'Content-Type': 'application/json' },
          }),
      )
      const r = await ai('POST', '/api/ai/qa', {
        email: 'g@x.com',
        body: { messages: [{ role: 'user', content: 'q' }] },
        deps: { fetch: gw.fetch },
      })
      expect((await r.json()).answer).toBe('ok' + i)
    }
  }, 60000)
})

/* ============================================================= grading */
describe('grading', () => {
  beforeEach(async () => {
    await grant('g@x.com')
  })
  const gradeWith = async (content: string) => {
    const gw = gateway(
      () =>
        new Response(JSON.stringify({ choices: [{ message: { content } }], model: 'grok-4.7' }), {
          headers: { 'Content-Type': 'application/json' },
        }),
    )
    const r = await ai('POST', '/api/ai/grade', { email: 'g@x.com', body: GRADE, deps: { fetch: gw.fetch } })
    return { j: await r.json(), gw }
  }
  const valid = {
    score: 78,
    hitPoints: ['创新'],
    missedPoints: ['共享'],
    deductions: ['缺例子'],
    suggestions: ['补材料'],
    structureNote: '结构清晰',
  }

  it('valid result (even prose-wrapped) is returned with the reference disclaimer', async () => {
    const { j, gw } = await gradeWith('评阅如下：' + JSON.stringify(valid) + ' 以上。')
    expect(j.ok).toBe(true)
    expect(j.result).toMatchObject({ score: 78, maxScore: 100, hitPoints: ['创新'], structureNote: '结构清晰' })
    expect(j.result.disclaimer).toBe(DISCLAIMER)
    expect(gw.calls[0].body.stream).toBeUndefined()
    expect(gw.calls[0].body.temperature).toBe(0.3)
  })

  it.each([
    ['not JSON', '没有 JSON'],
    ['missing score', JSON.stringify({ ...valid, score: undefined })],
    ['score > 100', JSON.stringify({ ...valid, score: 130 })],
    ['score < 0', JSON.stringify({ ...valid, score: -1 })],
    ['missing array', JSON.stringify({ ...valid, hitPoints: undefined })],
    ['non-string element', JSON.stringify({ ...valid, suggestions: [1] })],
    ['missing structureNote', JSON.stringify({ ...valid, structureNote: undefined })],
  ])('invalid result (%s) is a failure, never a fabricated score', async (_n, content) => {
    const { j } = await gradeWith(content)
    expect(j.ok).toBe(false)
    expect(j.result).toBeUndefined()
    expect(j.code).toBe('BAD_GRADE_FORMAT')
  })

  it('an incomplete grade (missing field) is retried once; a complete second answer is used as is', async () => {
    const answers = [JSON.stringify({ ...valid, deductions: undefined }), JSON.stringify(valid)]
    const gw = gateway(
      () =>
        new Response(JSON.stringify({ choices: [{ message: { content: answers.shift() } }], model: 'grok-4.7' }), {
          headers: { 'Content-Type': 'application/json' },
        }),
    )
    const r = await ai('POST', '/api/ai/grade', { email: 'g@x.com', body: GRADE, deps: { fetch: gw.fetch } })
    const j = await r.json()
    expect(gw.calls.length).toBe(2)
    expect(j.ok).toBe(true)
    expect(j.result.deductions).toEqual(['缺例子'])
  })

  it('retry is at most once, and only for missing fields (out-of-range is refused without a retry)', async () => {
    const bad = gateway(
      () =>
        new Response(
          JSON.stringify({ choices: [{ message: { content: JSON.stringify({ ...valid, hitPoints: undefined }) } }] }),
          { headers: { 'Content-Type': 'application/json' } },
        ),
    )
    const r1 = await (
      await ai('POST', '/api/ai/grade', { email: 'g@x.com', body: GRADE, deps: { fetch: bad.fetch } })
    ).json()
    expect(bad.calls.length).toBe(2)
    expect(r1.ok).toBe(false)
    expect(r1.code).toBe('BAD_GRADE_FORMAT')
    const { j, gw } = await gradeWith(JSON.stringify({ ...valid, score: 130 }))
    expect(gw.calls.length).toBe(1)
    expect(j.ok).toBe(false)
  })

  it('the web-only accuracy guard is sent as the second system message on qa and grade', async () => {
    const { gw } = await gradeWith(JSON.stringify(valid))
    const msgs = gw.calls[0].body.messages
    expect(msgs[0].role).toBe('system')
    expect(msgs[1]).toEqual({ role: 'system', content: WEB_ACCURACY_GUARD })
    expect(msgs[1].content).toContain('人口规模巨大的现代化')
    expect(msgs[1].content).toContain('坚持中国共产党领导')
  })
})

/* =============================================================== admin */
describe('admin', () => {
  it('only an admin (from ai_admins, bound server-side) can list and change grants', async () => {
    const adminId = await makeAdmin('admin@x.com')
    const userId = await accountOf('u@x.com')
    await grant('ai-user@x.com')
    // ordinary user and AI-enabled user are both refused
    for (const email of ['u@x.com', 'ai-user@x.com']) {
      expect((await ai('GET', '/api/admin/ai-users', { email })).status).toBe(403)
      const r = await ai('POST', '/api/admin/ai-users', { email, body: { accountId: userId, enabled: true } })
      expect(r.status).toBe(403)
    }
    const self = await ai('POST', '/api/admin/ai-users', {
      email: 'ai-user@x.com',
      body: { accountId: await accountOf('ai-user@x.com'), enabled: true, admin: true },
    })
    expect(self.status).toBe(403)
    // still off
    expect((await (await ai('GET', '/api/ai/status', { email: 'u@x.com' })).json()).allowed).toBe(false)

    const list = await (await ai('GET', '/api/admin/ai-users', { email: 'admin@x.com' })).json()
    expect(list.ok).toBe(true)
    const row = list.users.find((u: { accountId: string }) => u.accountId === userId)
    expect(row).toMatchObject({ aiEnabled: false, emails: ['u@x.com'] })
    expect(JSON.stringify(list)).not.toContain(KEY)

    const on = await (
      await ai('POST', '/api/admin/ai-users', { email: 'admin@x.com', body: { accountId: userId, enabled: true } })
    ).json()
    expect(on).toMatchObject({ ok: true, aiEnabled: true })
    expect((await (await ai('GET', '/api/ai/status', { email: 'u@x.com' })).json()).allowed).toBe(true)
    const off = await (
      await ai('POST', '/api/admin/ai-users', { email: 'admin@x.com', body: { accountId: userId, enabled: false } })
    ).json()
    expect(off.aiEnabled).toBe(false)
    expect((await (await ai('GET', '/api/ai/status', { email: 'u@x.com' })).json()).allowed).toBe(false)
    const log = await H.raw
      .prepare('SELECT COUNT(*) AS n FROM ai_grant_log WHERE account_id = ? AND by_account = ?')
      .bind(userId, adminId)
      .first<{ n: number }>()
    expect(log!.n).toBe(2)
    // admin flag in status, and admin ≠ AI permission
    const st = await (await ai('GET', '/api/ai/status', { email: 'admin@x.com' })).json()
    expect(st).toMatchObject({ admin: true, allowed: false })
  })

  it('admin endpoint: bad input, unknown account, admin lookup failure', async () => {
    await makeAdmin('admin@x.com')
    expect(
      (await ai('POST', '/api/admin/ai-users', { email: 'admin@x.com', body: { accountId: 'x', enabled: true } }))
        .status,
    ).toBe(400)
    expect(
      (
        await ai('POST', '/api/admin/ai-users', {
          email: 'admin@x.com',
          body: { accountId: 'acc_000000000000000000000000', enabled: true },
        })
      ).status,
    ).toBe(404)
    H.failQueries([/role, status FROM members/])
    expect((await ai('GET', '/api/admin/ai-users', { email: 'admin@x.com' })).status).toBe(503)
  })
})

/* ======================================================= admin grant log */
describe('admin grant log (GET /api/admin/ai-log)', () => {
  it('admins read who changed which grant; everyone else is refused; nothing is invented', async () => {
    await makeAdmin('boss@x.com')
    const target = await accountOf('stud@x.com')
    // ordinary account: refused
    expect((await ai('GET', '/api/admin/ai-log', { email: 'stud@x.com' })).status).toBe(403)
    const empty = await (await ai('GET', '/api/admin/ai-log', { email: 'boss@x.com' })).json()
    expect(empty.ok).toBe(true)
    const before = empty.log.length
    await ai('POST', '/api/admin/ai-users', { email: 'boss@x.com', body: { accountId: target, enabled: true } })
    await ai('POST', '/api/admin/ai-users', { email: 'boss@x.com', body: { accountId: target, enabled: false } })
    const j = await (await ai('GET', '/api/admin/ai-log', { email: 'boss@x.com' })).json()
    expect(j.log.length).toBe(before + 2)
    expect(j.log[0]).toMatchObject({ accountId: target, enabled: false, target: 'stud@x.com', actor: 'boss@x.com' })
    expect(j.log[1]).toMatchObject({ accountId: target, enabled: true })
    // read-only: POST is not a route
    expect((await ai('POST', '/api/admin/ai-log', { email: 'boss@x.com', body: {} })).status).toBe(404)
  })
})

/* ======================================================= 联网 + 图片 (web only) */
describe('web search and images', () => {
  const PNG =
    'data:image/png;base64,' + btoa(String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a) + 'xxxxxxxx')
  const JPG = 'data:image/jpeg;base64,' + btoa(String.fromCharCode(0xff, 0xd8, 0xff, 0xe0) + 'xxxxxxxx')
  const rdelta = (t: string) => `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: t })}\n\n`
  beforeEach(async () => {
    await grant('g@x.com')
  })

  it('plain questions keep the original /chat/completions body (no tools, no images)', async () => {
    const gw = gateway((req) => sse([delta('好'), 'data: [DONE]\n\n'], req))
    await readSse(await ai('POST', '/api/ai/qa', { email: 'g@x.com', body: QA, deps: { fetch: gw.fetch } }))
    expect(gw.calls[0].url).toMatch(/\/chat\/completions$/)
    expect(gw.calls[0].body.tools).toBeUndefined()
    expect(typeof gw.calls[0].body.messages.at(-1).content).toBe('string')
  })

  it('search:true goes to /responses with the web_search tool and streams typed deltas', async () => {
    const gw = gateway((req) =>
      sse([rdelta('据新华网'), rdelta('报道'), `data: ${JSON.stringify({ type: 'response.completed' })}\n\n`], req),
    )
    const res = await ai('POST', '/api/ai/qa', {
      email: 'g@x.com',
      body: { ...QA, search: true },
      deps: { fetch: gw.fetch },
    })
    const { joined, events } = await readSse(res)
    expect(joined).toBe('据新华网报道')
    expect(events.at(-1)).toEqual({ type: 'done' })
    const c = gw.calls[0]
    expect(c.url).toBe('https://gw.example.com/v1/responses')
    expect(c.body.tools).toEqual([{ type: 'web_search' }])
    expect(c.body.model).toBe('grok-4.7')
    expect(c.auth).toBe('Bearer ' + KEY)
    expect(JSON.stringify(c.body.input)).toContain('联网搜索已开启')
  })

  it('images go to the last user turn as image_url parts; search+images as input_image', async () => {
    const gw = gateway((req) => sse([delta('看到了'), 'data: [DONE]\n\n'], req))
    const body = {
      messages: [
        { role: 'user', content: '第一问' },
        { role: 'assistant', content: '答' },
        { role: 'user', content: '图里写了什么' },
      ],
      images: [PNG, JPG],
      stream: true,
    }
    expect(
      (await readSse(await ai('POST', '/api/ai/qa', { email: 'g@x.com', body, deps: { fetch: gw.fetch } }))).joined,
    ).toBe('看到了')
    const last = gw.calls[0].body.messages.at(-1)
    expect(last.content[0]).toEqual({ type: 'text', text: '图里写了什么' })
    expect(last.content.slice(1).map((p: any) => p.image_url.url)).toEqual([PNG, JPG])
    expect(typeof gw.calls[0].body.messages[1].content).toBe('string')

    const gw2 = gateway((req) => sse([rdelta('好'), 'data: [DONE]\n\n'], req))
    await readSse(
      await ai('POST', '/api/ai/qa', { email: 'g@x.com', body: { ...body, search: true }, deps: { fetch: gw2.fetch } }),
    )
    const inp = gw2.calls[0].body.input
    expect(inp.at(-1).content.filter((p: any) => p.type === 'input_image').length).toBe(2)
    expect(inp.find((m: any) => m.role === 'assistant').content[0].type).toBe('output_text')
  })

  it('bad images are refused before any upstream call', async () => {
    const gw = gateway(() => new Response('{}'))
    const fake = 'data:image/png;base64,' + btoa('GIF89a-not-a-png')
    const cases = [
      [fake],
      ['data:image/gif;base64,R0lGODlh'],
      ['https://evil.example/a.png'],
      [PNG, PNG, PNG, PNG],
      ['data:image/png;base64,' + 'A'.repeat(1_500_000)],
    ]
    for (const images of cases) {
      const r = await ai('POST', '/api/ai/qa', { email: 'g@x.com', body: { ...QA, images }, deps: { fetch: gw.fetch } })
      expect(r.status, JSON.stringify(images).slice(0, 60)).toBe(400)
    }
    const noMsg = await ai('POST', '/api/ai/qa', {
      email: 'g@x.com',
      body: { images: [PNG] },
      deps: { fetch: gw.fetch },
    })
    expect(noMsg.status).toBe(400)
    const badFlag = await ai('POST', '/api/ai/qa', {
      email: 'g@x.com',
      body: { ...QA, search: 'yes' },
      deps: { fetch: gw.fetch },
    })
    expect(badFlag.status).toBe(400)
    expect(gw.calls.length).toBe(0)
  })

  it('a non-stream /responses answer is read from output[].content[].output_text', async () => {
    const gw = gateway(
      () =>
        new Response(
          JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: '有来源的回答' }] }] }),
          { headers: { 'Content-Type': 'application/json' } },
        ),
    )
    const r = await ai('POST', '/api/ai/qa', {
      email: 'g@x.com',
      body: { messages: QA.messages, search: true },
      deps: { fetch: gw.fetch },
    })
    expect(await r.json()).toMatchObject({ ok: true, answer: '有来源的回答' })
  })
})

describe('联网 source links', () => {
  it('grounding redirect links are resolved to the real page before reaching the client; unresolvable ones are dropped, never shown', async () => {
    await grant('g@x.com')
    const G1 = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/AAA111'
    const G2 = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/BBB222'
    const rd = (t: string) => `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: t })}\n\n`
    const gw0 = gateway((req) => {
      return sse(
        [rd('据报道。\n来源：[新华网]('), rd(G1.slice(0, 40)), rd(G1.slice(40) + ')\n[2] [x](' + G2 + ')')],
        req,
      )
    })
    const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = input instanceof Request ? input.url : String(input)
      if (u === G1) return new Response(null, { status: 302, headers: { Location: 'https://www.news.cn/a.html' } })
      if (u === G2) return new Response('nope', { status: 500 })
      if (u === 'https://www.news.cn/a.html') return new Response('<html>ok</html>', { status: 200 })
      return gw0.fetch(input, init)
    }) as typeof fetch
    const { joined } = await readSse(
      await ai('POST', '/api/ai/qa', { email: 'g@x.com', body: { ...QA, search: true }, deps: { fetch: f } }),
    )
    expect(joined).toBe('据报道。\n来源：[新华网](https://www.news.cn/a.html)\n[2] x（来源链接未能核实，已省略）')
    expect(joined).not.toContain('vertexaisearch')
  })

  it('a redirect whose target page is gone (404) is dropped; a bare redirect URL disappears', async () => {
    await grant('g@x.com')
    const G1 = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/CCC333'
    const G2 = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/DDD444'
    const rd = (t: string) => `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: t })}\n\n`
    const gw0 = gateway((req) => sse([rd(`见[人民网](${G1})。另见 ${G2}\n`)], req))
    const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = input instanceof Request ? input.url : String(input)
      if (u === G1)
        return new Response(null, { status: 302, headers: { Location: 'https://www.people.com.cn/gone.html' } })
      if (u === 'https://www.people.com.cn/gone.html') return new Response('not found', { status: 404 })
      if (u === G2)
        return new Response(null, { status: 302, headers: { Location: 'https://www.gov.cn/zhengce/a.htm' } })
      if (u === 'https://www.gov.cn/zhengce/a.htm') return new Response('', { status: 403 })
      return gw0.fetch(input, init)
    }) as typeof fetch
    const { joined } = await readSse(
      await ai('POST', '/api/ai/qa', { email: 'g@x.com', body: { ...QA, search: true }, deps: { fetch: f } }),
    )
    expect(joined).toBe('见人民网（来源链接未能核实，已省略）。另见 https://www.gov.cn/zhengce/a.htm\n')
  })
})

/* ======================================================= fix4 */
import { isSafePublicUrl, stripUnverifiableLinks, resolveGroundingLinks } from '../../worker/ai'

describe('fix4: SSE ends at [DONE] even if the gateway keeps its connection open', () => {
  it('done is sent, the response closes and the lease is free for the next question', async () => {
    await grant('d@x.com')
    const gw = gateway((req) => sse([delta('答案'), 'data: [DONE]\n\n', { wait: 60_000 }], req))
    const t0 = Date.now()
    const res = await ai('POST', '/api/ai/qa', { email: 'd@x.com', body: QA, deps: { fetch: gw.fetch } })
    const r = await readSse(res)
    expect(Date.now() - t0).toBeLessThan(3000)
    expect(r.joined).toBe('答案')
    expect(r.events.at(-1)).toEqual({ type: 'done' })
    const gw2 = gateway((req) => sse([delta('ok'), 'data: [DONE]\n\n'], req))
    const res2 = await ai('POST', '/api/ai/qa', { email: 'd@x.com', body: QA, deps: { fetch: gw2.fetch } })
    expect(res2.status).toBe(200)
    expect((await readSse(res2)).joined).toBe('ok')
  })
  it('/responses stream: response.completed ends the response the same way', async () => {
    await grant('e@x.com')
    const ev = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`
    const gw = gateway((req) =>
      sse(
        [
          ev({ type: 'response.output_text.delta', delta: '联网答案' }),
          ev({ type: 'response.completed' }),
          { wait: 60_000 },
        ],
        req,
      ),
    )
    const t0 = Date.now()
    const res = await ai('POST', '/api/ai/qa', {
      email: 'e@x.com',
      body: { ...QA, search: true },
      deps: { fetch: gw.fetch },
    })
    const r = await readSse(res)
    expect(Date.now() - t0).toBeLessThan(3000)
    expect(r.joined).toBe('联网答案')
    expect(r.events.at(-1)).toEqual({ type: 'done' })
  })
})

describe('fix4: source links', () => {
  it('isSafePublicUrl refuses private / loopback / odd targets', () => {
    for (const u of [
      'http://127.0.0.1/x',
      'http://10.0.0.5/',
      'http://192.168.1.1/',
      'http://172.20.0.1/',
      'http://169.254.169.254/latest',
      'http://100.64.1.1/',
      'http://[::1]/',
      'http://localhost/',
      'http://foo.internal/',
      'http://intranet/',
      'https://user:pw@example.com/',
      'https://example.com:8443/',
      'ftp://example.com/',
      'file:///etc/passwd',
      'http://2130706433/',
      'http://0x7f000001/',
    ])
      expect(isSafePublicUrl(u), u).toBe(false)
    for (const u of [
      'https://www.news.cn/tech/20261022/x/c.html',
      'http://www.stdaily.com/a.html',
      'https://example.com:443/a',
    ])
      expect(isSafePublicUrl(u), u).toBe(true)
  })
  it('stripUnverifiableLinks removes Google landing / wrapper links in any form', () => {
    const t =
      '[新华网](https://vertexaisearch.cloud.google.com/) 和 https://vertexaisearch.cloud.google.com/grounding-api-redirect/AB%2Fcd ' +
      '[谷歌](https://www.google.com/url?q=https://x.com) [好](https://www.news.cn/a.html)'
    const o = stripUnverifiableLinks(t)
    expect(o).not.toMatch(/vertexaisearch|google\.com\/url/)
    expect(o).toContain('新华网（来源链接未能核实，已省略）')
    expect(o).toContain('[好](https://www.news.cn/a.html)')
  })
  it('a grounding redirect that points at a private address or back to Google is dropped, never fetched further', async () => {
    const fetched: string[] = []
    const f = (async (input: RequestInfo | URL) => {
      const u = input instanceof Request ? input.url : String(input)
      fetched.push(u)
      if (u.endsWith('/AAA'))
        return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } })
      if (u.endsWith('/BBB'))
        return new Response(null, { status: 302, headers: { location: 'https://vertexaisearch.cloud.google.com/' } })
      if (u.endsWith('/CCC'))
        return new Response(null, { status: 302, headers: { location: 'https://www.news.cn/ok.html' } })
      if (u === 'https://www.news.cn/ok.html') return new Response('ok', { status: 200 })
      return new Response('landing', { status: 200 })
    }) as typeof fetch
    const R = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/'
    const out = await resolveGroundingLinks(`[甲](${R}AAA) [乙](${R}BBB) [丙](${R}CCC)`, f, new Map())
    expect(out).toContain('甲（来源链接未能核实，已省略）')
    expect(out).toContain('乙（来源链接未能核实，已省略）')
    expect(out).toContain('[丙](https://www.news.cn/ok.html)')
    expect(out).not.toContain('vertexaisearch')
    expect(fetched.some((u) => u.includes('169.254'))).toBe(false)
  })
})

import { stripHomepageLinks } from '../../worker/ai'
describe('fix4: home-page "sources"', () => {
  it('a link to a site home page is not shown as a source; article links stay', () => {
    const o = stripHomepageLinks(
      '[央广网（2026-10-25）](https://china.cnr.cn/)、[原文](https://china.cnr.cn/news/20261025/t1.shtml) 见 http://news.china.com.cn/ 和 https://www.moe.gov.cn/a.html',
    )
    expect(o).toContain('央广网（2026-10-25）（未给出具体文章链接，已省略）')
    expect(o).toContain('[原文](https://china.cnr.cn/news/20261025/t1.shtml)')
    expect(o).not.toContain('http://news.china.com.cn/ ')
    expect(o).toContain('https://www.moe.gov.cn/a.html')
  })
})
describe('fix4: static-asset "sources"', () => {
  it('a share image / icon is not shown as a source link', () => {
    const o = stripHomepageLinks(
      '[新华网](https://my-h5news.app.xinhuanet.com/h5/images/logoNew.png) 及 https://cdn2-app.people.cn/static/img/sound.gif 和 [文](https://www.eol.cn/news/yaowen/202610/t20261025_2786346.shtml)',
    )
    expect(o).toContain('新华网（未给出具体文章链接，已省略）')
    expect(o).not.toMatch(/\.png|\.gif/)
    expect(o).toContain('[文](https://www.eol.cn/news/yaowen/202610/t20261025_2786346.shtml)')
  })
})
