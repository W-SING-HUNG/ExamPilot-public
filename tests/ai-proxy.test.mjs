/**
 * AI proxy contract tests (node:test).
 * Covers: unconfigured, gateway HTTP error, success (QA), success (grade JSON),
 * malformed JSON, incomplete grade fields, timeout, CORS allow/deny, 404,
 * config-write origin restriction, and key non-leakage.
 * Run: node tests/ai-proxy.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const PROXY_PORT = 8791
const BASE = `http://127.0.0.1:${PROXY_PORT}`

// Every proxy spawned by this suite writes to its OWN config file, so a test
// can never pollute the developer's real server/ai-config.json.
const TMP_DIR = mkdtempSync(path.join(tmpdir(), 'exampilot-ai-test-'))
const CONFIG_PATH = path.join(TMP_DIR, 'ai-config.json')

let proxy

async function startProxy(env = {}) {
  proxy = spawn(process.execPath, [path.join(ROOT, 'server', 'index.mjs')], {
    env: {
      ...process.env,
      AI_PORT: String(PROXY_PORT),
      AI_CONFIG_PATH: CONFIG_PATH,
      AI_BASE_URL: '',
      AI_API_KEY: '',
      AI_MODEL: '',
      AI_CONFIG_TOKEN: '',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  proxy.stdout.on('data', (d) => {
    log += d
  })
  proxy.stderr.on('data', (d) => {
    log += d
  })
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${BASE}/api/ai/status`)
      if (r.ok) return log
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error('proxy did not start: ' + log)
}

const stopProxy = () => proxy && proxy.kill('SIGTERM')

process.on('exit', () => {
  try {
    rmSync(TMP_DIR, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

/**
 * Spawn the proxy and capture its exit code + output, without waiting for it to
 * serve. Used to assert that unsafe configurations are REFUSED at startup.
 */
function spawnProxyExpectingExit(env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.mjs')], {
      env: {
        ...process.env,
        AI_PORT: String(PROXY_PORT + 50),
        AI_CONFIG_PATH: CONFIG_PATH,
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', (d) => {
      out += d
    })
    child.stderr.on('data', (d) => {
      out += d
    })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve({ code: null, out: out + '\n[timeout: still running]' })
    }, 6000)
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve({ code, out })
    })
  })
}

/** Start a stub gateway with a scripted response. */
async function startStub(port, script) {
  const child = spawn(
    process.execPath,
    [
      '-e',
      `
    const http = require('http')
    const httpPort = ${port}
    http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        globalThis.__lastRequest = { url: req.url, method: req.method, headers: req.headers, body }
        ;(${script})(req, res)
      })
    }).listen(httpPort, '127.0.0.1', () => console.log('stub-ready'))
  `,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  for (let i = 0; i < 40; i++) {
    try {
      await fetch(`http://127.0.0.1:${port}/chat/completions`, { method: 'POST', body: '{}' })
      break
    } catch {}
    await new Promise((r) => setTimeout(r, 100))
  }
  return child
}

const OK_SCRIPT = `(req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ choices: [{ message: { content: '答案是 B，因为……' } }], model: 'stub-model', provider: 'stub' }))
}`

const GRADE_SCRIPT = `(req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ score: 82, hitPoints: ['概念准确'], missedPoints: ['缺少材料联系'], deductions: ['结构不完整'], suggestions: ['补充分点'], structureNote: '总体清晰' }) } }] }))
}`

const ERROR_SCRIPT = `(req, res) => {
  res.writeHead(500, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: { message: 'upstream boom' } }))
}`

const SLOW_SCRIPT = `(req, res) => {
  setTimeout(() => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: 'late' } }] })) }, 3000)
}`

const BAD_JSON_SCRIPT = `(req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end('not-json-at-all')
}`

// A grade response that is valid JSON but missing required fields.
const INCOMPLETE_GRADE_SCRIPT = `(req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ score: 70 }) } }] }))
}`

// A grade response that is plain prose with no JSON at all.
const GRADE_PLAIN_TEXT_SCRIPT = `(req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ choices: [{ message: { content: '这位同学答得不错，我给他 80 分吧。' } }] }))
}`

// A grade response whose score is not a number.
const BAD_SCORE_SCRIPT = `(req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ score: 'high', hitPoints: [], missedPoints: [], deductions: [], suggestions: [], structureNote: 'x' }) } }] }))
}`

// A grade response with an out-of-range score.
const OUT_OF_RANGE_SCRIPT = `(req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ score: 150, hitPoints: [], missedPoints: [], deductions: [], suggestions: [], structureNote: 'x' }) } }] }))
}`

test('AI proxy: unconfigured gateway', async (t) => {
  await startProxy()
  t.after(stopProxy)

  const status = await (await fetch(`${BASE}/api/ai/status`)).json()
  assert.equal(status.configured, false)
  assert.equal(status.ok, false)
  assert.match(status.message, /未配置/)

  const qa = await fetch(`${BASE}/api/ai/qa`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: { type: 'single', stem: '测试', options: ['a', 'b'] }, userAnswer: 'A' }),
  })
  const qaBody = await qa.json()
  assert.equal(qa.status, 200, 'must not 5xx when unconfigured — frontend degrades gracefully')
  assert.equal(qaBody.ok, false)
  assert.match(qaBody.reason, /未配置/)

  const grade = await fetch(`${BASE}/api/ai/grade`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ qid: 'Q001', stem: 'x', userAnswer: 'y', kind: 'short' }),
  })
  const gradeBody = await grade.json()
  assert.equal(gradeBody.ok, false)

  const nf = await fetch(`${BASE}/nope`)
  assert.equal(nf.status, 404)
})

test('AI proxy: CORS allows only local dev origins', async (t) => {
  await startProxy()
  t.after(stopProxy)

  // allowed origin is echoed
  const ok = await fetch(`${BASE}/api/ai/qa`, {
    method: 'OPTIONS',
    headers: { Origin: 'http://localhost:5173' },
  })
  assert.equal(ok.status, 204)
  assert.equal(ok.headers.get('access-control-allow-origin'), 'http://localhost:5173')

  // an arbitrary remote origin is rejected and gets no ACAO header
  const bad = await fetch(`${BASE}/api/ai/qa`, {
    method: 'OPTIONS',
    headers: { Origin: 'https://evil.example.com' },
  })
  assert.equal(bad.status, 403)
  assert.equal(bad.headers.get('access-control-allow-origin'), null)

  // a plain GET from a foreign origin gets no ACAO header either
  const statusRes = await fetch(`${BASE}/api/ai/status`, { headers: { Origin: 'https://evil.example.com' } })
  assert.equal(statusRes.headers.get('access-control-allow-origin'), null)
})

test('AI proxy: config writes are restricted to trusted local origins', async (t) => {
  await startProxy()
  t.after(stopProxy)

  // remote web page may not repoint the proxy
  const denied = await fetch(`${BASE}/api/ai/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example.com' },
    body: JSON.stringify({ baseUrl: 'https://evil.example.com/v1', apiKey: 'stolen', model: 'x' }),
  })
  assert.equal(denied.status, 403)
  assert.equal((await denied.json()).ok, false)

  // still unconfigured afterwards
  const status = await (await fetch(`${BASE}/api/ai/status`)).json()
  assert.equal(status.configured, false)
})

test('AI proxy: never returns the API key to the browser', async (t) => {
  const stub = await startStub(8797, OK_SCRIPT)
  await startProxy({ AI_BASE_URL: 'http://127.0.0.1:8797/v1', AI_API_KEY: 'super-secret-key-xyz', AI_MODEL: 'm' })
  t.after(() => {
    stopProxy()
    stub.kill('SIGTERM')
  })

  const status = await (await fetch(`${BASE}/api/ai/status`)).text()
  assert.ok(!status.includes('super-secret-key-xyz'), 'status must not leak the key')

  const qa = await (
    await fetch(`${BASE}/api/ai/qa`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: { stem: 'x' }, userAnswer: '' }),
    })
  ).text()
  assert.ok(!qa.includes('super-secret-key-xyz'), 'qa response must not leak the key')
})

test('AI proxy: QA success proxies to gateway', async (t) => {
  const stub = await startStub(8792, OK_SCRIPT)
  await startProxy({ AI_BASE_URL: 'http://127.0.0.1:8792/v1', AI_API_KEY: 'key-123', AI_MODEL: 'stub-model' })
  t.after(() => {
    stopProxy()
    stub.kill('SIGTERM')
  })

  const status = await (await fetch(`${BASE}/api/ai/status`)).json()
  assert.equal(status.configured, true)
  assert.equal(status.model, 'stub-model')

  const r = await fetch(`${BASE}/api/ai/qa`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      question: { type: 'single', stem: '测试题', options: ['a', 'b'], answer: 'B' },
      userAnswer: 'A',
      questionContext: { chapter: '导论', bankNo: 1 },
    }),
  })
  const j = await r.json()
  assert.equal(r.status, 200)
  assert.equal(j.ok, true)
  assert.match(j.answer, /答案是 B/)
  assert.equal(j.model, 'stub-model')
})

test('AI proxy: grade success returns normalized result with disclaimer', async (t) => {
  const stub = await startStub(8793, GRADE_SCRIPT)
  await startProxy({ AI_BASE_URL: 'http://127.0.0.1:8793/v1', AI_API_KEY: 'key-123', AI_MODEL: 'stub-model' })
  t.after(() => {
    stopProxy()
    stub.kill('SIGTERM')
  })

  const r = await fetch(`${BASE}/api/ai/grade`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      qid: 'Q001',
      stem: '请回答两个结合',
      userAnswer: '两个结合是……',
      chapter: '导论',
      kind: 'short',
    }),
  })
  const j = await r.json()
  assert.equal(r.status, 200)
  assert.equal(j.ok, true)
  assert.equal(j.result.score, 82)
  assert.equal(j.result.maxScore, 100)
  assert.deepEqual(j.result.hitPoints, ['概念准确'])
  assert.deepEqual(j.result.missedPoints, ['缺少材料联系'])
  assert.match(j.result.disclaimer, /参考评阅/)
  assert.match(j.result.disclaimer, /非官方/)
})

test('AI proxy: gateway HTTP 500 -> ok:false, never a fabricated answer', async (t) => {
  const stub = await startStub(8794, ERROR_SCRIPT)
  await startProxy({ AI_BASE_URL: 'http://127.0.0.1:8794/v1', AI_API_KEY: 'key-123', AI_MODEL: 'm' })
  t.after(() => {
    stopProxy()
    stub.kill('SIGTERM')
  })

  const r = await fetch(`${BASE}/api/ai/qa`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: { stem: 'x' }, userAnswer: '' }),
  })
  const j = await r.json()
  assert.equal(j.ok, false)
  assert.match(j.reason, /500/)
  assert.equal(j.answer, undefined)
})

test('AI proxy: gateway non-JSON body -> ok:false', async (t) => {
  const stub = await startStub(8795, BAD_JSON_SCRIPT)
  await startProxy({ AI_BASE_URL: 'http://127.0.0.1:8795/v1', AI_API_KEY: 'key-123', AI_MODEL: 'm' })
  t.after(() => {
    stopProxy()
    stub.kill('SIGTERM')
  })

  const r = await fetch(`${BASE}/api/ai/qa`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: { stem: 'x' }, userAnswer: '' }),
  })
  const j = await r.json()
  assert.equal(j.ok, false)
})

test('AI proxy: timeout -> ok:false with 超时 reason', async (t) => {
  const stub = await startStub(8796, SLOW_SCRIPT)
  await startProxy({
    AI_BASE_URL: 'http://127.0.0.1:8796/v1',
    AI_API_KEY: 'key-123',
    AI_MODEL: 'm',
    AI_TIMEOUT_MS: '800',
  })
  t.after(() => {
    stopProxy()
    stub.kill('SIGTERM')
  })

  const r = await fetch(`${BASE}/api/ai/qa`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: { stem: 'x' }, userAnswer: '' }),
  })
  const j = await r.json()
  assert.equal(r.status, 200, 'timeout must not be a 5xx')
  assert.equal(j.ok, false)
  assert.match(j.reason, /超时/)
  assert.equal(j.answer, undefined)
})

// ---- strict grade validation: never fabricate a 0-score "success" ----

async function gradeWithStub(t, port, script) {
  const stub = await startStub(port, script)
  await startProxy({ AI_BASE_URL: `http://127.0.0.1:${port}/v1`, AI_API_KEY: 'k', AI_MODEL: 'm' })
  t.after(() => {
    stopProxy()
    stub.kill('SIGTERM')
  })
  const r = await fetch(`${BASE}/api/ai/grade`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ qid: 'Q1', stem: 'x', userAnswer: 'y', chapter: '导论', kind: 'short' }),
  })
  return { status: r.status, body: await r.json() }
}

test('AI proxy: grade with unparseable JSON -> ok:false (no fabricated 0)', async (t) => {
  const { body } = await gradeWithStub(t, 8801, GRADE_PLAIN_TEXT_SCRIPT)
  assert.equal(body.ok, false, 'must not report success with a fabricated score')
  assert.equal(body.result, undefined)
  assert.match(body.reason, /无法解析|未返回/)
  assert.equal(body.code, 'BAD_GRADE_FORMAT')
})

test('AI proxy: grade missing required fields -> ok:false with a specific reason', async (t) => {
  const { body } = await gradeWithStub(t, 8802, INCOMPLETE_GRADE_SCRIPT)
  assert.equal(body.ok, false)
  assert.equal(body.result, undefined)
  assert.match(body.reason, /hitPoints|数组字段/)
  assert.equal(body.code, 'BAD_GRADE_FORMAT')
})

test('AI proxy: grade with a non-numeric score -> ok:false', async (t) => {
  const { body } = await gradeWithStub(t, 8803, BAD_SCORE_SCRIPT)
  assert.equal(body.ok, false)
  assert.match(body.reason, /score/)
  assert.equal(body.code, 'BAD_GRADE_FORMAT')
})

test('AI proxy: grade with an out-of-range score -> ok:false', async (t) => {
  const { body } = await gradeWithStub(t, 8804, OUT_OF_RANGE_SCRIPT)
  assert.equal(body.ok, false)
  assert.match(body.reason, /0-100/)
  assert.equal(body.code, 'BAD_GRADE_FORMAT')
})

test('AI proxy: valid grade still succeeds with all fields', async (t) => {
  const { status, body } = await gradeWithStub(t, 8805, GRADE_SCRIPT)
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.result.score, 82)
  assert.equal(body.result.maxScore, 100)
})

// ---- listen-address hardening (loopback only, no remote mode) -------------

test('AI proxy: REFUSES a non-loopback host outright', async () => {
  for (const host of ['0.0.0.0', '192.168.1.10', '::']) {
    const { code, out } = await spawnProxyExpectingExit({
      AI_HOST: host,
      AI_BASE_URL: '',
      AI_API_KEY: '',
      AI_MODEL: '',
    })
    assert.equal(code, 1, `host ${host} must be refused instead of exposing the proxy`)
    assert.match(out, /拒绝启动/)
    assert.match(out, /回环地址/)
  }
})

test('AI proxy: there is NO override flag that enables remote binding', async () => {
  // Previously AI_ALLOW_REMOTE=1 (plus a token) permitted a network bind. That
  // escape hatch is gone: the proxy must refuse regardless.
  const { code, out } = await spawnProxyExpectingExit({
    AI_HOST: '0.0.0.0',
    AI_ALLOW_REMOTE: '1',
    AI_CONFIG_TOKEN: 'shared-secret',
  })
  assert.equal(code, 1, 'remote binding must be impossible even with the legacy flags')
  assert.match(out, /拒绝启动/)
})

test('AI proxy: loopback host still starts normally', async (t) => {
  const log = await startProxy({ AI_HOST: '127.0.0.1' })
  t.after(stopProxy)
  assert.match(log, /listening on http:\/\/127\.0\.0\.1/)
  const r = await fetch(`${BASE}/api/ai/status`)
  assert.equal(r.status, 200)
})

test('AI proxy: quota-spending endpoints are reachable from loopback (offline-safe)', async (t) => {
  // Unconfigured: QA/grade must still answer with ok:false rather than an auth
  // error, proving the loopback guard does not block the normal local flow.
  await startProxy({ AI_HOST: '127.0.0.1' })
  t.after(stopProxy)
  for (const path of ['/api/ai/qa', '/api/ai/grade']) {
    const r = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: { stem: 'x' }, qid: 'q', stem: 'x', userAnswer: '' }),
    })
    assert.equal(r.status, 200, `${path} must be reachable locally`)
    assert.equal((await r.json()).ok, false, `${path} degrades gracefully when unconfigured`)
  }
})

test('AI proxy: config write requires the shared token when one is configured', async (t) => {
  await startProxy({ AI_HOST: '127.0.0.1', AI_CONFIG_TOKEN: 'shared-secret' })
  t.after(stopProxy)

  const denied = await fetch(`${BASE}/api/ai/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseUrl: 'http://x/v1', apiKey: 'k', model: 'm' }),
  })
  assert.equal(denied.status, 403, 'missing token must be refused')

  const allowed = await fetch(`${BASE}/api/ai/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-exampilot-config-token': 'shared-secret' },
    body: JSON.stringify({ baseUrl: 'http://x/v1', apiKey: 'k', model: 'm' }),
  })
  assert.equal(allowed.status, 200)
  assert.equal((await allowed.json()).ok, true)
})
