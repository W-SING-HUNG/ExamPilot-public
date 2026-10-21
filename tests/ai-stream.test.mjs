/**
 * AI proxy streaming/robustness regression tests (node:test).
 *
 * These guard the failures reported in the field:
 *   - "AI 助手请求后一个字都没输出，最终超时"
 *   - "保存失败：Failed to fetch" after a bad upstream response
 *   - HTTP 499 / "context canceled" at the gateway because the client abort was
 *     never propagated upstream
 *
 * Run: node tests/ai-stream.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import http from 'node:http'
import net from 'node:net'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

const PROXY_PORT = 8961
const BASE = `http://127.0.0.1:${PROXY_PORT}`

const TMP_DIR = mkdtempSync(path.join(tmpdir(), 'exampilot-stream-test-'))
const CONFIG_PATH = path.join(TMP_DIR, 'ai-config.json')

let proxy
let gateway
let gatewayPort = 0

/** Mock OpenAI-compatible gateway; `behaviour` selects the response script. */
function makeGateway(behaviour) {
  const state = { requests: 0, upstreamClosedEarly: 0, upstreamCompleted: 0 }
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      state.requests++
      let isStream = false
      try {
        isStream = JSON.parse(body).stream === true
      } catch {
        /* ignore */
      }
      req.socket.on('close', () => {
        if (!res.writableEnded) state.upstreamClosedEarly++
      })
      const done = () => {
        if (!res.writableEnded) {
          state.upstreamCompleted++
        }
      }

      if (!isStream) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ message: { content: '非流式答案' } }], provider: 'stub', model: 'stub' }))
        done()
        return
      }

      switch (behaviour) {
        case 'sse-standard': {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' })
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '第一段' } }] })}\n\n`)
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '第二段' } }] })}\n\n`)
          res.end('data: [DONE]\n\n')
          done()
          return
        }
        case 'sse-nospace': {
          // Some gateways omit the space after `data:`.
          res.writeHead(200, { 'Content-Type': 'text/event-stream' })
          res.write(`data:${JSON.stringify({ choices: [{ delta: { content: '甲' } }] })}\n\n`)
          res.end(`data:${JSON.stringify({ choices: [{ delta: { content: '乙' } }] })}\n\ndata:[DONE]\n\n`)
          done()
          return
        }
        case 'json-not-sse': {
          // Gateway ignores stream:true and answers with a single completion.
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ choices: [{ message: { content: '一次性整段答案' } }] }))
          done()
          return
        }
        case 'empty-body': {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' })
          res.end()
          done()
          return
        }
        case 'no-content': {
          // 204 No Content: body is null. This used to crash the whole proxy.
          res.writeHead(204)
          res.end()
          done()
          return
        }
        case 'never-headers': {
          // Accept the connection, never answer.
          return
        }
        case 'stall-open': {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' })
          res.write(': keepalive\n\n')
          return
        }
        case 'long-slow-stream': {
          // Emits a token every 120ms for ~1.8s: longer than the idle budget's
          // *connect* phase, but never idle, so it must run to completion.
          res.writeHead(200, { 'Content-Type': 'text/event-stream' })
          let i = 0
          const timer = setInterval(() => {
            if (res.destroyed) return clearInterval(timer)
            if (i < 15) {
              res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `${i};` } }] })}\n\n`)
              i++
            } else {
              clearInterval(timer)
              res.end('data: [DONE]\n\n')
              done()
            }
          }, 120)
          return
        }
        case 'multi-byte-split': {
          // A UTF-8 character split across two TCP writes must not corrupt.
          res.writeHead(200, { 'Content-Type': 'text/event-stream' })
          const frame = Buffer.from(
            `data: ${JSON.stringify({ choices: [{ delta: { content: '中文多字节' } }] })}\n\n`,
            'utf-8',
          )
          const cut = frame.indexOf(Buffer.from('中', 'utf-8')) + 1
          res.write(frame.subarray(0, cut))
          setTimeout(() => {
            res.write(frame.subarray(cut))
            res.end('data: [DONE]\n\n')
            done()
          }, 100)
          return
        }
        case 'http-500': {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: { message: 'upstream boom' } }))
          done()
          return
        }
        case 'dies-mid-stream': {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' })
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '半句' } }] })}\n\n`)
          setTimeout(() => res.socket?.destroy(), 120)
          return
        }
        default: {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' })
          res.end('data: [DONE]\n\n')
          done()
        }
      }
    })
  })
  return { server, state }
}

function waitPort(port, host = '127.0.0.1', tries = 80) {
  return new Promise((resolve) => {
    let n = 0
    const tick = () => {
      const s = net.connect(port, host)
      s.once('connect', () => {
        s.destroy()
        resolve(true)
      })
      s.once('error', () => {
        s.destroy()
        if (++n > tries) resolve(false)
        else setTimeout(tick, 100)
      })
    }
    tick()
  })
}

async function startPair(behaviour, { timeoutMs = 4000 } = {}) {
  const gw = makeGateway(behaviour)
  gateway = gw.server
  gateway.__state = gw.state
  await new Promise((r) => gateway.listen(0, '127.0.0.1', r))
  gatewayPort = gateway.address().port

  writeFileSync(
    CONFIG_PATH,
    JSON.stringify({
      baseUrl: `http://127.0.0.1:${gatewayPort}/v1`,
      // Placeholder by the repository's own convention (see the `fake|dummy|
      // sample` value allowlist in tools/public-info-check.mjs `assigned-secret`).
      // A literal that merely *looks* like a key trips the information-governance
      // gate; naming it `fake-...` is what that allowlist is for.
      apiKey: 'fake-api-key-for-tests',
      model: 'stub-model',
      timeoutMs,
    }),
    'utf-8',
  )

  proxy = spawn(process.execPath, [path.join(ROOT, 'server', 'index.mjs')], {
    env: {
      ...process.env,
      AI_PORT: String(PROXY_PORT),
      AI_CONFIG_PATH: CONFIG_PATH,
      AI_BASE_URL: '',
      AI_API_KEY: '',
      AI_MODEL: '',
      AI_CONFIG_TOKEN: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  proxy.__log = ''
  proxy.stdout.on('data', (d) => (proxy.__log += d))
  proxy.stderr.on('data', (d) => (proxy.__log += d))

  const up = await waitPort(PROXY_PORT)
  if (!up) throw new Error(`proxy did not start: ${proxy.__log}`)
  return gateway.__state
}

async function stopPair() {
  for (const p of [proxy, gateway]) {
    if (!p) continue
    try {
      p.kill('SIGTERM')
    } catch {
      /* ignore */
    }
  }
  if (gateway) await new Promise((r) => gateway.close(r)).catch(() => {})
  await new Promise((r) => setTimeout(r, 100))
  proxy = null
  gateway = null
}

process.on('exit', () => {
  try {
    rmSync(TMP_DIR, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

/** Parse an SSE body into the proxy's own typed events. */
function parseEvents(text) {
  const events = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t.startsWith('data:')) continue
    try {
      events.push(JSON.parse(t.slice(5).trim()))
    } catch {
      /* ignore */
    }
  }
  return events
}

/**
 * The proxy answers with plain JSON when it fails before the stream opens
 * (timeouts, connect errors). Normalize both shapes to one event list.
 */
function outcome(text) {
  const events = parseEvents(text)
  if (events.length > 0) return events
  try {
    const json = JSON.parse(text.trim())
    return [{ type: json.ok ? 'json-ok' : 'error', reason: json.reason, code: json.code, answer: json.answer }]
  } catch {
    return []
  }
}

async function streamQuestion({ timeoutMs = 15000 } = {}) {
  const ctrl = new AbortController()
  const killer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(`${BASE}/api/ai/qa`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ messages: [{ role: 'user', content: '测试' }], stream: true }),
      signal: ctrl.signal,
    })
    return { status: res.status, text: await res.text() }
  } finally {
    clearTimeout(killer)
  }
}

const deltasOf = (events) =>
  events
    .filter((e) => e.type === 'chunk')
    .map((e) => e.delta)
    .join('')
const errorOf = (events) => events.find((e) => e.type === 'error')

// ---------------------------------------------------------------- streaming

test('streams a standard SSE answer', async (t) => {
  await startPair('sse-standard')
  t.after(stopPair)
  const { status, text } = await streamQuestion()
  assert.equal(status, 200)
  const events = outcome(text)
  assert.equal(deltasOf(events), '第一段第二段')
  assert.ok(events.some((e) => e.type === 'done'))
  // exactly one `done`, not one per upstream [DONE] line plus one at the end
  assert.equal(events.filter((e) => e.type === 'done').length, 1)
})

test('accepts `data:` frames without the space (sloppy gateways)', async (t) => {
  await startPair('sse-nospace')
  t.after(stopPair)
  const events = outcome((await streamQuestion()).text)
  assert.equal(deltasOf(events), '甲乙')
})

test('degrades to a single chunk when the gateway ignores stream:true', async (t) => {
  await startPair('json-not-sse')
  t.after(stopPair)
  const events = outcome((await streamQuestion()).text)
  assert.equal(deltasOf(events), '一次性整段答案')
  assert.ok(events.some((e) => e.type === 'done'))
})

test('a long but continuously streaming answer is NOT cut off', async (t) => {
  // idle budget is 800ms; the stream is silent for at most 120ms at a time.
  await startPair('long-slow-stream', { timeoutMs: 800 })
  t.after(stopPair)
  const events = outcome((await streamQuestion()).text)
  assert.equal(deltasOf(events), Array.from({ length: 15 }, (_, i) => `${i};`).join(''))
  assert.equal(errorOf(events), undefined, 'a healthy long answer must not report a timeout')
})

test('UTF-8 split across TCP writes is decoded correctly', async (t) => {
  await startPair('multi-byte-split')
  t.after(stopPair)
  const events = outcome((await streamQuestion()).text)
  assert.equal(deltasOf(events), '中文多字节')
})

// ------------------------------------------------------- honest failure modes

test('empty stream -> explicit error, never a silent success', async (t) => {
  await startPair('empty-body')
  t.after(stopPair)
  const events = outcome((await streamQuestion()).text)
  const err = errorOf(events)
  assert.ok(err, 'an empty stream must surface an error')
  assert.equal(err.code, 'EMPTY_STREAM')
  assert.equal(deltasOf(events), '')
})

test('204 No Content does NOT crash the proxy and answers with an explicit error', async (t) => {
  await startPair('no-content')
  t.after(stopPair)
  const { text } = await streamQuestion()
  assert.equal(errorOf(outcome(text))?.code, 'EMPTY_UPSTREAM')

  // The process must still be alive and serving: this is what made the settings
  // page report "Failed to fetch" — the crash killed every later request.
  assert.equal(proxy.exitCode, null, `proxy crashed: ${proxy.__log}`)
  const health = await fetch(`${BASE}/api/ai/status`)
  assert.equal(health.status, 200)
})

test('a gateway that never sends headers times out with a clear reason', async (t) => {
  await startPair('never-headers', { timeoutMs: 700 })
  t.after(stopPair)
  const started = Date.now()
  const events = outcome((await streamQuestion()).text)
  const elapsed = Date.now() - started
  const err = errorOf(events)
  assert.ok(err, 'must report a timeout instead of hanging')
  assert.equal(err.code, 'TIMEOUT')
  assert.match(err.reason, /超时/)
  assert.ok(elapsed < 5000, `timed out too slowly: ${elapsed}ms`)
})

test('a stream that opens then goes silent times out with a clear reason', async (t) => {
  await startPair('stall-open', { timeoutMs: 600 })
  t.after(stopPair)
  const err = errorOf(outcome((await streamQuestion()).text))
  assert.ok(err)
  assert.equal(err.code, 'TIMEOUT')
  assert.match(err.reason, /超时/)
})

test('upstream HTTP 500 is reported, not masked', async (t) => {
  await startPair('http-500')
  t.after(stopPair)
  const { status, text } = await streamQuestion()
  assert.equal(status, 502)
  assert.match(text, /500/)
})

test('an upstream dying mid-stream keeps the partial text and reports the break', async (t) => {
  await startPair('dies-mid-stream')
  t.after(stopPair)
  const events = outcome((await streamQuestion()).text)
  assert.equal(deltasOf(events), '半句', 'partial output must not be discarded')
  assert.ok(errorOf(events), 'the break must be reported')
})

// ------------------------------------------------- client abort -> no 499 leak

test('a client abort cancels the UPSTREAM request (no 499 / context canceled)', async (t) => {
  const state = await startPair('long-slow-stream', { timeoutMs: 30000 })
  t.after(stopPair)

  const ctrl = new AbortController()
  let received = 0
  const res = await fetch(`${BASE}/api/ai/qa`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }], stream: true }),
    signal: ctrl.signal,
  })
  const reader = res.body.getReader()
  for (let i = 0; i < 3; i++) {
    const { done } = await reader.read()
    if (done) break
    received++
  }
  assert.ok(received > 0, 'the stream must have started')
  ctrl.abort()

  // Give the proxy a moment to propagate the cancellation.
  const deadline = Date.now() + 4000
  while (Date.now() < deadline && state.upstreamClosedEarly === 0) {
    await new Promise((r) => setTimeout(r, 100))
  }
  assert.equal(
    state.upstreamClosedEarly,
    1,
    'the proxy must cancel the gateway request so it stops generating after the user left',
  )
  assert.equal(proxy.exitCode, null)
})

test('a client abort does not crash the proxy or poison later requests', async (t) => {
  await startPair('long-slow-stream', { timeoutMs: 30000 })
  t.after(stopPair)

  for (let i = 0; i < 3; i++) {
    const ctrl = new AbortController()
    const res = await fetch(`${BASE}/api/ai/qa`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }], stream: true }),
      signal: ctrl.signal,
    })
    const reader = res.body.getReader()
    await reader.read()
    ctrl.abort()
    await new Promise((r) => setTimeout(r, 150))
  }

  assert.equal(proxy.exitCode, null, `proxy crashed: ${proxy.__log}`)
  // The config endpoint — the one behind "保存失败" — must still answer.
  const saved = await fetch(`${BASE}/api/ai/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      baseUrl: `http://127.0.0.1:${gatewayPort}/v1`,
      apiKey: '',
      model: 'stub-model',
      timeoutMs: 30000,
    }),
  })
  assert.equal(saved.status, 200)
  assert.equal((await saved.json()).ok, true)
})

// ------------------------------------------------------ honest error statuses

test('a malformed request body is a 400, not a 502 that blames the gateway', async (t) => {
  await startPair('sse-standard')
  t.after(stopPair)

  // A 502 here would send anyone debugging to the upstream gateway, which is not
  // involved at all: the failure is entirely client-side.
  for (const p of ['/api/ai/qa', '/api/ai/grade']) {
    const res = await fetch(`${BASE}${p}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    })
    assert.equal(res.status, 400, `${p} must answer 400 for an unparseable body`)
    const body = await res.json()
    assert.equal(body.ok, false)
    assert.equal(body.code, 'BAD_REQUEST_BODY')
  }

  // and the process is unharmed
  assert.equal(proxy.exitCode, null)
})
