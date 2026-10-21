/**
 * Security regression tests for the AI proxy's credential endpoint.
 *
 * `POST /api/ai/config` repoints the gateway. If an attacker can call it, the next
 * AI request sends the REAL API key to a host they chose, so the Origin/loopback
 * checks here are the difference between "a dev convenience" and "key exfiltration".
 *
 * These tests exist because an earlier revision of vite.config.ts rewrote every
 * loopback Origin to `http://localhost:5173`. That made any unrelated local page a
 * trusted caller. The tests below fail against that design and pass against strict
 * same-origin validation.
 *
 * Run: node tests/ai-security.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

const PROXY_PORT = 8971
const PROXY_BASE = `http://127.0.0.1:${PROXY_PORT}`
const VITE_PORT = 5231

const TMP_DIR = mkdtempSync(path.join(tmpdir(), 'exampilot-security-test-'))
const CONFIG_PATH = path.join(TMP_DIR, 'ai-config.json')

const CANARY_HOST = 'http://attacker.example/v1'

const children = []
function track(child, tag) {
  children.push(child)
  if (tag) child.stderr?.on('data', (d) => process.stdout.write(`[${tag}!] ${d}`))
  return child
}

function waitPort(port, host = '127.0.0.1', tries = 100) {
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

let proxy
let proxyLog = ''

async function startProxy(env = {}) {
  writeFileSync(
    CONFIG_PATH,
    JSON.stringify({
      baseUrl: 'http://127.0.0.1:1/v1',
      apiKey: 'fake-should-never-leak-marker',
      model: 'm',
      timeoutMs: 1000,
    }),
    'utf-8',
  )
  proxy = track(
    spawn(process.execPath, [path.join(ROOT, 'server', 'index.mjs')], {
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
    }),
  )
  proxy.__log = ''
  proxy.stdout.on('data', (d) => (proxy.__log += d))
  proxy.stderr.on('data', (d) => (proxy.__log += d))
  const up = await waitPort(PROXY_PORT)
  if (!up) throw new Error(`proxy did not start: ${proxy.__log}`)
  return proxy
}

async function stopProxy() {
  if (proxy) {
    try {
      proxy.kill('SIGTERM')
    } catch {
      /* ignore */
    }
    proxy = null
  }
  await new Promise((r) => setTimeout(r, 120))
}

process.on('exit', () => {
  for (const c of children) {
    try {
      c.kill('SIGTERM')
    } catch {
      /* ignore */
    }
  }
  try {
    rmSync(TMP_DIR, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

const postConfig = (headers) =>
  fetch(`${PROXY_BASE}/api/ai/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ baseUrl: CANARY_HOST, apiKey: '', model: 'canary', timeoutMs: 60000 }),
  })

/** True if the canary gateway was actually written to the config file. */
function canaryWritten() {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')).baseUrl === CANARY_HOST
  } catch {
    return false
  }
}

// --------------------------------------------------------------------------
// The credential endpoint must refuse every foreign caller on its own.
// (The proxy is loopback-only, so the Origin allowlist is the real gate here.)
// --------------------------------------------------------------------------

test('security: a remote origin cannot repoint the gateway', async (t) => {
  await startProxy()
  t.after(stopProxy)

  for (const origin of ['https://evil.example', 'http://attacker.example', 'null']) {
    const res = await postConfig({ Origin: origin })
    assert.equal(res.status, 403, `origin ${origin} must be refused`)
    const body = await res.json()
    assert.equal(body.ok, false)
  }
  assert.equal(canaryWritten(), false, 'a refused write must not touch the config')
})

test('security: an unrelated LOCAL port cannot repoint the gateway', async (t) => {
  await startProxy()
  t.after(stopProxy)

  // This is the exact escalation the removed Origin rewrite enabled: a page the
  // dev server did not serve, but on loopback, was treated as trusted.
  for (const origin of ['http://localhost:8080', 'http://127.0.0.1:9999', 'http://localhost:3000']) {
    const res = await postConfig({ Origin: origin })
    assert.equal(res.status, 403, `local origin ${origin} must NOT be trusted by default`)
  }
  assert.equal(canaryWritten(), false, 'a local-but-foreign page must not repoint the gateway')
})

test('security: the origin allowlist is exact, not a prefix/substring match', async (t) => {
  await startProxy()
  t.after(t.stopProxy ?? stopProxy)

  const nearMisses = [
    'http://localhost:51730', // port that merely starts with 5173
    'http://localhost:5173.evil.example', // host that starts with the allowed one
    'https://localhost:5173', // different scheme
    'http://localhost', // missing the port
    'HTTP://LOCALHOST:5173', // non-canonical casing
  ]
  for (const origin of nearMisses) {
    const res = await postConfig({ Origin: origin })
    assert.equal(res.status, 403, `near-miss origin ${origin} must be refused`)
  }
})

test('security: a genuinely allowed origin may configure the gateway', async (t) => {
  await startProxy()
  t.after(stopProxy)

  const res = await postConfig({ Origin: 'http://localhost:5173' })
  assert.equal(res.status, 200)
  assert.equal((await res.json()).ok, true)
  assert.equal(canaryWritten(), true, 'the allowed origin must really take effect')
})

test('security: extra origins are opt-in via AI_ALLOWED_ORIGINS only', async (t) => {
  await startProxy({ AI_ALLOWED_ORIGINS: 'http://localhost:5210' })
  t.after(stopProxy)

  // explicitly granted
  const allowed = await postConfig({ Origin: 'http://localhost:5210' })
  assert.equal(allowed.status, 200)

  // and nothing else became trusted as a side effect
  const other = await postConfig({ Origin: 'http://localhost:5211' })
  assert.equal(other.status, 403)
  const remote = await postConfig({ Origin: 'https://evil.example' })
  assert.equal(remote.status, 403)
})

test('security: the config file is never readable back and the key never leaks', async (t) => {
  await startProxy()
  t.after(stopProxy)

  const status = await (await fetch(`${PROXY_BASE}/api/ai/status`)).text()
  assert.ok(!status.includes('fake-should-never-leak-marker'), 'status must not leak the key')

  const denied = await (await postConfig({ Origin: 'https://evil.example' })).text()
  assert.ok(!denied.includes('fake-should-never-leak-marker'), 'error must not leak the key')
})

test('security: a config write cannot be smuggled in via the QA/grade endpoints', async (t) => {
  await startProxy()
  t.after(stopProxy)

  // The quota-spending endpoints must never mutate configuration, whatever the body.
  for (const p of ['/api/ai/qa', '/api/ai/grade']) {
    const res = await fetch(`${PROXY_BASE}${p}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      body: JSON.stringify({
        baseUrl: CANARY_HOST,
        apiKey: 'x',
        model: 'canary',
        messages: [{ role: 'user', content: 'hi' }],
        stem: 'x',
        userAnswer: 'y',
      }),
    })
    // It may refuse or fail, but it must not write the gateway.
    await res.text()
  }
  assert.equal(canaryWritten(), false, 'QA/grade must not be a config-write path')
})

test('security: the proxy remains loopback-only and refuses a non-loopback bind', async (t) => {
  // A refused start must exit non-zero rather than expose the proxy.
  const res = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.mjs')], {
      env: { ...process.env, AI_HOST: '0.0.0.0', AI_PORT: String(PROXY_PORT + 40), AI_CONFIG_PATH: CONFIG_PATH },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve({ code: null, out })
    }, 6000)
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve({ code, out })
    })
  })
  assert.equal(res.code, 1)
  assert.match(res.out, /拒绝启动/)
})

// --------------------------------------------------------------------------
// Fatal-error policy: unexpected exceptions must NOT be swallowed.
// --------------------------------------------------------------------------

test('reliability: an unexpected exception is reported and exits non-zero', async (t) => {
  // A proxy that keeps running after an unexpected throw serves a broken endpoint
  // (this is how one bad upstream response used to become "Failed to fetch" on
  // every later request). The policy is: log loudly, exit non-zero, let a
  // supervisor restart. This test pins that policy.
  const preload = path.join(TMP_DIR, 'boom.mjs')
  writeFileSync(preload, `setTimeout(() => { throw new Error('simulated unexpected bug') }, 350)\n`)

  // pathToFileURL handles both Windows drive letters and POSIX paths, so this
  // test behaves the same on the Ubuntu CI runner as it does locally.
  const preloadUrl = pathToFileURL(preload).href
  const res = await new Promise((resolve) => {
    const child = track(
      spawn(process.execPath, ['--import', preloadUrl, path.join(ROOT, 'server', 'index.mjs')], {
        env: {
          ...process.env,
          AI_PORT: String(PROXY_PORT + 41),
          AI_CONFIG_PATH: CONFIG_PATH,
          AI_BASE_URL: '',
          AI_API_KEY: '',
          AI_MODEL: '',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    )
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve({ code: null, out })
    }, 8000)
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve({ code, out })
    })
  })

  assert.notEqual(res.code, null, 'the process must not survive an unexpected exception')
  assert.notEqual(res.code, 0, 'an unexpected exception must exit non-zero')
  assert.match(res.out, /致命错误/, 'the fatal error must be reported in the log')
  assert.match(res.out, /simulated unexpected bug/, 'the original error must not be discarded')
})

test('reliability: a malformed request does not take the proxy down', async (t) => {
  await startProxy()
  t.after(stopProxy)

  // A bad Host header used to throw inside `new URL(...)`.
  const bad = await new Promise((resolve) => {
    const sock = net.connect(PROXY_PORT, '127.0.0.1', () => {
      sock.write('GET /api/ai/status HTTP/1.1\r\nHost: [malformed\r\nConnection: close\r\n\r\n')
    })
    let out = ''
    sock.on('data', (d) => (out += d.toString()))
    sock.on('error', () => resolve({ out }))
    sock.on('close', () => resolve({ out }))
    setTimeout(() => {
      sock.destroy()
      resolve({ out })
    }, 3000)
  })
  assert.ok(!/HTTP\/1\.1 5\d\d/.test(bad.out), 'a malformed request must not produce a 5xx')

  // ...and the process must still be serving afterwards.
  const health = await fetch(`${PROXY_BASE}/api/ai/status`)
  assert.equal(health.status, 200)
  await health.text()
  assert.equal(proxy.exitCode, null)
})

// --------------------------------------------------------------------------
// Through the real Vite dev proxy: the end-to-end attack the rewrite allowed.
//
// vite.config.ts hardcodes the proxy target to 127.0.0.1:8787, so this test must
// run the backend on 8787 to exercise the real proxy path. If something already
// listens there the test skips rather than silently testing the wrong backend.
// --------------------------------------------------------------------------

const VITE_TARGET_PORT = 8787

async function portFree(port) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1')
    s.once('connect', () => {
      s.destroy()
      resolve(false)
    })
    s.once('error', () => {
      s.destroy()
      resolve(true)
    })
  })
}

/**
 * Which loopback host the dev server actually bound. Windows Vite binds `::1`
 * for `localhost`; Linux runners may bind `127.0.0.1`. Probing instead of
 * assuming keeps this suite meaningful on both platforms rather than silently
 * skipping on CI.
 */
async function resolveViteHost({ totalMs = 30000 } = {}) {
  const deadline = Date.now() + totalMs
  while (Date.now() < deadline) {
    for (const h of ['localhost', '127.0.0.1', '::1']) {
      if (await waitPort(VITE_PORT, h, 1)) return h
    }
    await new Promise((r) => setTimeout(r, 120))
  }
  return null
}

test('security: a cross-origin page cannot repoint the gateway via the Vite proxy', async (t) => {
  if (!(await portFree(VITE_TARGET_PORT))) {
    return t.skip(`${VITE_TARGET_PORT} is already in use; cannot isolate the Vite proxy test`)
  }

  // Start the backend on the port the Vite proxy actually targets.
  writeFileSync(
    CONFIG_PATH,
    JSON.stringify({
      baseUrl: 'http://127.0.0.1:1/v1',
      apiKey: 'fake-should-never-leak-marker',
      model: 'm',
      timeoutMs: 1000,
    }),
    'utf-8',
  )
  const backend = track(
    spawn(process.execPath, [path.join(ROOT, 'server', 'index.mjs')], {
      env: {
        ...process.env,
        AI_PORT: String(VITE_TARGET_PORT),
        AI_CONFIG_PATH: CONFIG_PATH,
        AI_BASE_URL: '',
        AI_API_KEY: '',
        AI_MODEL: '',
        AI_CONFIG_TOKEN: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  )
  backend.stderr.on('data', (d) => process.stdout.write(`[backend!] ${d}`))

  const viteBin = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js')
  const vite = track(
    spawn(process.execPath, [viteBin, '--port', String(VITE_PORT), '--strictPort'], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    }),
  )
  vite.stderr.on('data', (d) => process.stdout.write(`[vite!] ${d}`))

  t.after(async () => {
    for (const c of [vite, backend]) {
      try {
        c.kill('SIGTERM')
      } catch {
        /* ignore */
      }
    }
    await new Promise((r) => setTimeout(r, 200))
  })

  const backendUp = await waitPort(VITE_TARGET_PORT)
  if (!backendUp) return t.skip('backend did not start on the Vite proxy target port')

  /*
   * Which host does the dev server actually listen on? On Windows Vite binds
   * `::1` only for `localhost`; on Linux CI runners it may bind `127.0.0.1` or
   * `::1`. Probe instead of assuming, otherwise this test silently skips on the
   * platform it is supposed to protect.
   */
  const viteHost = await resolveViteHost()
  if (!viteHost) return t.skip('vite did not start on any loopback host')

  // `Origin` must be spelled the way a browser would for this host, so the
  // same-origin case is genuinely same-origin.
  const originHost = viteHost === '::1' ? `[::1]` : viteHost
  const appOrigin = `http://${originHost}:${VITE_PORT}`

  const post = (headers) =>
    fetch(`${appOrigin}/api/ai/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ baseUrl: CANARY_HOST, apiKey: '', model: 'canary', timeoutMs: 60000 }),
    })

  // 1. a page the dev server did NOT serve (other local port) must be refused
  const foreign = await post({ Origin: 'http://localhost:8080' })
  assert.equal(foreign.status, 403, 'cross-origin local page must not repoint the gateway')
  assert.equal(canaryWritten(), false)

  // 2. a remote page must be refused
  const remote = await post({ Origin: 'https://evil.example' })
  assert.equal(remote.status, 403)

  // 3. a genuine same-origin call (Origin == Host) still succeeds, so custom
  //    dev ports keep working
  const sameOrigin = await post({ Origin: appOrigin })
  assert.equal(sameOrigin.status, 200, 'the dev server own page must still be able to save')
  assert.equal(canaryWritten(), true)
})

// --------------------------------------------------------------------------
// The Vite dev server must not re-broaden CORS on proxied AI responses.
//
// Vite's default `server.cors` echoes ANY localhost origin into
// Access-Control-Allow-Origin. Because /api is proxied, that header applied to AI
// responses as well, so an unrelated page on another local port could READ
// /api/ai/status and /api/ai/qa bodies. Config writes stayed 403, so no credential
// leaked, but the readable surface must not be widened by the dev server.
// --------------------------------------------------------------------------

test('security: the dev server does not expose AI responses to other local origins', async (t) => {
  if (!(await portFree(VITE_TARGET_PORT))) {
    return t.skip(`${VITE_TARGET_PORT} is already in use; cannot isolate the Vite CORS test`)
  }

  writeFileSync(
    CONFIG_PATH,
    JSON.stringify({ baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'fake-key', model: 'm', timeoutMs: 500 }),
    'utf-8',
  )
  const backend = track(
    spawn(process.execPath, [path.join(ROOT, 'server', 'index.mjs')], {
      env: {
        ...process.env,
        AI_PORT: String(VITE_TARGET_PORT),
        AI_CONFIG_PATH: CONFIG_PATH,
        AI_BASE_URL: '',
        AI_API_KEY: '',
        AI_MODEL: '',
        AI_CONFIG_TOKEN: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  )
  backend.stderr.on('data', () => {})

  const vite = track(
    spawn(
      process.execPath,
      [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(VITE_PORT), '--strictPort'],
      {
        cwd: ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      },
    ),
  )
  vite.stderr.on('data', () => {})

  t.after(async () => {
    for (const c of [vite, backend]) {
      try {
        c.kill('SIGTERM')
      } catch {
        /* ignore */
      }
    }
    await new Promise((r) => setTimeout(r, 200))
  })

  if (!(await waitPort(VITE_TARGET_PORT))) return t.skip('backend did not start')

  const viteHost = await resolveViteHost()
  if (!viteHost) return t.skip('vite did not start on any loopback host')

  /** GET /api/ai/status through Vite with a given Origin; returns the ACAO header. */
  const acaoFor = (origin) =>
    new Promise((resolve) => {
      const req = http.request(
        { host: viteHost, port: VITE_PORT, path: '/api/ai/status', method: 'GET', headers: { Origin: origin } },
        (res) => {
          res.resume()
          res.on('end', () => resolve(res.headers['access-control-allow-origin'] ?? null))
        },
      )
      req.on('error', () => resolve('ERROR'))
      req.end()
    })

  for (const origin of ['http://localhost:8080', 'http://127.0.0.1:9999', 'https://evil.example']) {
    const acao = await acaoFor(origin)
    assert.notEqual(acao, origin, `dev server must not echo ACAO for ${origin} (would expose AI responses)`)
  }
})
