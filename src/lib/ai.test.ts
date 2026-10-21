/**
 * AI client (src/lib/ai.ts) regression tests.
 *
 * These lock the behaviour that produced "AI 助手请求后一个字都没输出，最终超时":
 *   - the timeout is an IDLE budget, not a hard cap on the whole answer
 *   - a long answer that keeps streaming is never killed
 *   - an empty stream is a failure, never a silent empty success
 *   - a non-JSON body (dev-proxy 503 / HTML error page) is reported, not swallowed
 *
 * `fetch` is stubbed per test; no network is used.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { aiAskQuestion, aiAskQuestionStream, aiStatus, getAiConfig, setAiConfig } from './ai'

/** Build an SSE Response whose body emits `chunks` with `gapMs` between them. */
function sseResponse(chunks: string[], gapMs = 0) {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const c of chunks) {
        if (gapMs) await new Promise((r) => setTimeout(r, gapMs))
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'chunk', delta: c })}\n\n`))
      }
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'done' })}\n\n`))
      controller.close()
    },
  })
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } })
}

/** A Response that never resolves until the caller's signal aborts. */
function hangingResponse(init?: RequestInit) {
  return new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      const e = new Error('aborted')
      e.name = 'AbortError'
      reject(e)
    })
  })
}

const originalFetch = globalThis.fetch

/**
 * vitest runs this file under `environment: 'node'`, so the browser `localStorage`
 * the AI client reads its config from does not exist. Provide the minimal surface
 * it uses rather than switching the whole suite to a DOM environment.
 */
beforeEach(() => {
  const store = new Map<string, string>()
  globalThis.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size
    },
  } as Storage

  // Short idle budget so timeout tests stay fast.
  setAiConfig({ baseUrl: '/api', model: 'default', timeoutMs: 250 })
})

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

describe('ai client / config', () => {
  it('merges partial config over the defaults', () => {
    setAiConfig({ timeoutMs: 1234 })
    expect(getAiConfig().timeoutMs).toBe(1234)
    expect(getAiConfig().baseUrl).toBe('/api')
  })
})

describe('aiAskQuestionStream: streaming', () => {
  it('accumulates chunks and reports them incrementally', async () => {
    globalThis.fetch = vi.fn(async () => sseResponse(['甲', '乙', '丙']))
    const seen: string[] = []
    const res = await aiAskQuestionStream({ messages: [{ role: 'user', content: 'hi' }] }, (_c, full) => {
      seen.push(full)
    })
    expect(res).toEqual({ ok: true, answer: '甲乙丙' })
    // The UI renders `fullText`; it must grow monotonically.
    expect(seen).toEqual(['甲', '甲乙', '甲乙丙'])
  })

  it('does not time out a long answer that keeps streaming', async () => {
    // 8 chunks, 60ms apart (480ms total) with a 250ms idle budget: the total
    // exceeds the budget, but it is never idle for that long.
    globalThis.fetch = vi.fn(async () => sseResponse(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], 60))
    const res = await aiAskQuestionStream({ messages: [{ role: 'user', content: 'hi' }] }, () => {})
    expect(res.ok).toBe(true)
    expect(res.answer).toBe('abcdefgh')
  })

  it('reports an explicit failure when the stream ends with no text', async () => {
    globalThis.fetch = vi.fn(async () => sseResponse([]))
    const res = await aiAskQuestionStream({ messages: [{ role: 'user', content: 'hi' }] }, () => {})
    expect(res.ok).toBe(false)
    expect(res.answer).toBeUndefined()
    expect(res.reason).toMatch(/未返回任何内容/)
  })

  it('surfaces a server-side error event verbatim', async () => {
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ type: 'error', reason: 'AI 响应超时（超过 60000ms 没有收到新内容）' })}\n\n`,
          ),
        )
        controller.close()
      },
    })
    globalThis.fetch = vi.fn(
      async () => new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
    )
    const res = await aiAskQuestionStream({ messages: [{ role: 'user', content: 'hi' }] }, () => {})
    expect(res.ok).toBe(false)
    expect(res.reason).toContain('超时')
  })

  it('reports a non-SSE, non-JSON body instead of a blank failure', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response('<!doctype html><title>503</title>', {
          status: 503,
          headers: { 'Content-Type': 'text/html' },
        }),
    )
    const res = await aiAskQuestionStream({ messages: [{ role: 'user', content: 'hi' }] }, () => {})
    expect(res.ok).toBe(false)
    expect(res.reason).toMatch(/503/)
  })

  it('falls back to a plain JSON answer when the gateway does not stream', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, answer: '整段答案' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    )
    const seen: string[] = []
    const res = await aiAskQuestionStream({ messages: [{ role: 'user', content: 'hi' }] }, (c) => seen.push(c))
    expect(res).toEqual({ ok: true, answer: '整段答案' })
    expect(seen).toEqual(['整段答案'])
  })
})

describe('aiAskQuestionStream: cancellation and timeouts', () => {
  it('an external abort reports 已取消, not a timeout', async () => {
    const ctrl = new AbortController()
    globalThis.fetch = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => hangingResponse(init))
    const p = aiAskQuestionStream({ messages: [{ role: 'user', content: 'hi' }] }, () => {}, ctrl.signal)
    setTimeout(() => ctrl.abort(), 50)
    const res = await p
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('已取消')
  })

  it('an already-aborted caller signal returns immediately without any request', async () => {
    const fetchSpy = vi.fn()
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    const ctrl = new AbortController()
    ctrl.abort()
    const res = await aiAskQuestionStream({ messages: [{ role: 'user', content: 'hi' }] }, () => {}, ctrl.signal)
    expect(res.reason).toBe('已取消')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('a silent server produces a timeout that names "no content"', async () => {
    globalThis.fetch = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => hangingResponse(init))
    const res = await aiAskQuestionStream({ messages: [{ role: 'user', content: 'hi' }] }, () => {})
    expect(res.ok).toBe(false)
    expect(res.reason).toMatch(/没有返回任何内容/)
  })
})

describe('aiAskQuestion / postJson', () => {
  it('parses a JSON success', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, answer: '答案' }), {
          headers: { 'Content-Type': 'application/json' },
        }),
    )
    const res = await aiAskQuestion({ question: { type: 'single', stem: 'x', options: [] } })
    expect(res).toEqual({ ok: true, answer: '答案' })
  })

  it('reports a non-JSON error page instead of returning it as success', async () => {
    globalThis.fetch = vi.fn(async () => new Response('<html>oops</html>', { status: 502 }))
    const res = await aiAskQuestion({ question: { type: 'single', stem: 'x', options: [] } })
    expect(res.ok).toBe(false)
    expect(res.reason).toMatch(/502/)
  })

  it('reports a transport failure as 网络错误', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    })
    const res = await aiAskQuestion({ question: { type: 'single', stem: 'x', options: [] } })
    expect(res.ok).toBe(false)
    expect(res.reason).toMatch(/网络错误/)
  })
})

describe('aiStatus', () => {
  it('never throws when the proxy is unreachable', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    })
    const s = await aiStatus()
    expect(s.ok).toBe(false)
    expect(s.configured).toBe(false)
    expect(s.message).toMatch(/AI 服务不可用/)
  })

  it('passes through a healthy status payload', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, configured: true, model: 'm', message: 'ok' }), {
          headers: { 'Content-Type': 'application/json' },
        }),
    )
    const s = await aiStatus()
    expect(s.configured).toBe(true)
    expect(s.model).toBe('m')
  })
})
