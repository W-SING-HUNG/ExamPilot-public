/**
 * Contract test: the local proxy (server/index.mjs, unchanged) and the Worker
 * port (worker/ai.ts) are driven with the SAME client requests against the SAME
 * recording gateway. Asserts the upstream requests (prompts, model params,
 * stream flag) and the client-visible results/events are identical.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import http from 'node:http'
import net from 'node:net'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeHarness, HOST, type Harness } from '../sync/test-harness'
import { handleAi, _resetAiGuards, type AiEnv } from '../../worker/ai'
import { WEB_ACCURACY_GUARD } from '../../worker/ai-prompts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

type Mode = 'stream-ok' | 'json-ok' | 'grade-ok' | 'grade-bad' | 'empty' | 'http500'
let mode: Mode = 'stream-ok'
const seen: { body: any; auth: string | undefined }[] = []
let gw: http.Server
let gwPort = 0
let proxy: ChildProcess
const PROXY_PORT = 18000 + Math.floor(Math.random() * 1000)
const TMP = mkdtempSync(path.join(os.tmpdir(), 'ep-contract-'))
let H: Harness
let env: AiEnv

const GRADE_JSON = {
  score: 66,
  hitPoints: ['要点一'],
  missedPoints: ['要点二'],
  deductions: ['不完整'],
  suggestions: ['补充'],
  structureNote: '尚可',
}

function waitPort(port: number) {
  return new Promise<boolean>((resolve) => {
    let n = 0
    const tick = () => {
      const s = net.connect(port, '127.0.0.1')
      s.once('connect', () => (s.destroy(), resolve(true)))
      s.once('error', () => (s.destroy(), ++n > 80 ? resolve(false) : setTimeout(tick, 100)))
    }
    tick()
  })
}

beforeAll(async () => {
  gw = http.createServer((req, res) => {
    let data = ''
    req.on('data', (c) => (data += c))
    req.on('end', () => {
      seen.push({ body: JSON.parse(data), auth: req.headers.authorization })
      if (mode === 'http500') {
        res.writeHead(500)
        return res.end('boom')
      }
      if (mode === 'empty') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        return res.end('data: [DONE]\n\n')
      }
      if (mode === 'stream-ok') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        for (const t of ['第一', '段', '回答'])
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`)
        return res.end('data: [DONE]\n\n')
      }
      const content =
        mode === 'grade-ok' ? JSON.stringify(GRADE_JSON) : mode === 'grade-bad' ? '{"score": 120}' : '完整回答'
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content } }], model: 'stub-model' }))
    })
  })
  await new Promise<void>((r) => gw.listen(0, '127.0.0.1', () => r()))
  gwPort = (gw.address() as net.AddressInfo).port
  const cfg = path.join(TMP, 'ai-config.json')
  writeFileSync(
    cfg,
    JSON.stringify({
      baseUrl: `http://127.0.0.1:${gwPort}/v1`,
      apiKey: 'fake-api-key-for-tests',
      model: 'stub-model',
      timeoutMs: 8000,
    }),
  )
  proxy = spawn(process.execPath, [path.join(ROOT, 'server', 'index.mjs')], {
    env: {
      ...process.env,
      AI_PORT: String(PROXY_PORT),
      AI_CONFIG_PATH: cfg,
      AI_BASE_URL: '',
      AI_API_KEY: '',
      AI_MODEL: '',
      AI_CONFIG_TOKEN: '',
    },
    stdio: 'ignore',
  })
  if (!(await waitPort(PROXY_PORT))) throw new Error('local proxy did not start')

  H = await makeHarness()
  env = {
    ...H.env,
    AI_BASE_URL: `http://127.0.0.1:${gwPort}/v1`,
    AI_API_KEY: 'fake-api-key-for-tests',
    AI_MODEL: 'stub-model',
    AI_TIMEOUT_MS: '8000',
  }
  const me = await H.call('GET', '/api/sync/me', { email: 'c@x.com' })
  await H.raw
    .prepare(
      `INSERT INTO pro_grants (id, email, source, kind, duration_ms, starts_at, state, created_by, created_at) VALUES ('pg_c', 'c@x.com', 'admin', 'permanent', 0, 0, 'active', 'test', 0)`,
    )
    .run()
}, 30000)

afterAll(async () => {
  proxy?.kill('SIGTERM')
  await new Promise((r) => gw.close(r))
  await H.dispose()
  rmSync(TMP, { recursive: true, force: true })
})

async function viaLocal(p: string, body: unknown, stream: boolean) {
  const res = await fetch(`http://127.0.0.1:${PROXY_PORT}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(stream ? { Accept: 'text/event-stream' } : {}) },
    body: JSON.stringify(body),
  })
  return { status: res.status, type: res.headers.get('content-type') || '', text: await res.text() }
}
async function viaWorker(p: string, body: unknown, stream: boolean) {
  _resetAiGuards()
  const res = await handleAi(
    new Request(HOST + p, {
      method: 'POST',
      headers: {
        'X-ExamPilot-Client': '1',
        'Content-Type': 'application/json',
        Origin: HOST,
        'Cf-Access-Jwt-Assertion': await H.issuer.token('c@x.com'),
        ...(stream ? { Accept: 'text/event-stream' } : {}),
      },
      body: JSON.stringify(body),
    }),
    env,
    { auth: { fetchJwks: async () => H.issuer.jwks } },
  )
  return { status: res.status, type: res.headers.get('content-type') || '', text: await res.text() }
}
const events = (t: string) =>
  t
    .split('\n')
    .filter((l) => l.trim().startsWith('data:'))
    .map((l) => JSON.parse(l.trim().slice(5)))

async function both(p: string, body: any, m: Mode, stream = false) {
  mode = m
  seen.length = 0
  const a = await viaLocal(p, body, stream)
  const b = await viaWorker(p, body, stream)
  expect(seen.length).toBe(2)
  return { local: a, worker: b, upLocal: seen[0], upWorker: stripWebGuard(seen[1]) }
}

/**
 * The Worker adds exactly one web-only system message (WEB_ACCURACY_GUARD) right
 * after the leading system prompt. Assert it is there exactly once, then compare
 * everything else byte-for-byte with the desktop proxy as before.
 */
function stripWebGuard(up: any) {
  const msgs = up?.body?.messages
  if (!Array.isArray(msgs)) return up
  const hits = msgs.filter((x: any) => x.role === 'system' && x.content === WEB_ACCURACY_GUARD)
  expect(hits.length).toBe(1)
  return { ...up, body: { ...up.body, messages: msgs.filter((x: any) => x.content !== WEB_ACCURACY_GUARD) } }
}

const QUESTION_BODY = {
  question: { type: 'single', stem: '新时代的主要矛盾是？', options: ['甲', '乙', '丙', '丁'], answer: 'B' },
  userAnswer: 'A',
  questionContext: { chapter: '第一章', bankNo: 12 },
}
const FLOAT_FIRST = {
  messages: [
    { role: 'system', content: '你是……专业课程助教（客户端首题提示词）' },
    { role: 'user', content: '【题目详情】\n章节：第一章\n题干：…' },
  ],
}
const MULTI_TURN = {
  messages: [
    { role: 'user', content: '什么是新发展理念？' },
    { role: 'assistant', content: '创新、协调、绿色、开放、共享。' },
    { role: 'user', content: '哪个最重要？' },
  ],
}
const GRADE = { qid: 'Q9', stem: '论述……', userAnswer: '我的作答', chapter: '第七章', kind: 'material' }

describe('local proxy ⇄ worker contract', () => {
  it.each([
    ['question mode', QUESTION_BODY],
    ['floating first question (client system prompt)', FLOAT_FIRST],
    ['multi-turn follow-up', MULTI_TURN],
  ])('QA non-stream, %s: identical upstream request and identical answer', async (_n, body) => {
    const r = await both('/api/ai/qa', body, 'json-ok')
    expect(r.upWorker.body).toEqual(r.upLocal.body)
    expect(r.upWorker.auth).toBe(r.upLocal.auth)
    expect(JSON.parse(r.worker.text)).toEqual(JSON.parse(r.local.text))
  })

  it.each([
    ['question mode', QUESTION_BODY],
    ['multi-turn', MULTI_TURN],
  ])('QA stream, %s: identical upstream request and identical SSE events', async (_n, body) => {
    const r = await both('/api/ai/qa', { ...body, stream: true }, 'stream-ok', true)
    expect(r.upWorker.body).toEqual(r.upLocal.body)
    expect(r.upWorker.body.stream).toBe(true)
    expect(r.worker.type).toContain('text/event-stream')
    expect(events(r.worker.text)).toEqual(events(r.local.text))
  })

  it('QA stream, gateway ignores stream:true: same single-chunk degradation', async () => {
    const r = await both('/api/ai/qa', { ...MULTI_TURN, stream: true }, 'json-ok', true)
    expect(events(r.worker.text)).toEqual(events(r.local.text))
  })

  it('QA stream, empty stream: same explicit error event', async () => {
    const r = await both('/api/ai/qa', { ...MULTI_TURN, stream: true }, 'empty', true)
    expect(events(r.worker.text)).toEqual(events(r.local.text))
    expect(events(r.worker.text).pop()).toMatchObject({ type: 'error', code: 'EMPTY_STREAM' })
  })

  it('QA, gateway HTTP 500: same status and reason', async () => {
    const r = await both('/api/ai/qa', { ...MULTI_TURN, stream: true }, 'http500', true)
    expect(r.worker.status).toBe(r.local.status)
    expect(JSON.parse(r.worker.text)).toEqual(JSON.parse(r.local.text))
  })

  it('grade, valid: identical upstream prompt and identical result (incl. disclaimer)', async () => {
    const r = await both('/api/ai/grade', GRADE, 'grade-ok')
    expect(r.upWorker.body).toEqual(r.upLocal.body)
    expect(JSON.parse(r.worker.text)).toEqual(JSON.parse(r.local.text))
    expect(JSON.parse(r.worker.text).result.score).toBe(66)
  })

  it('grade, short-answer kind: identical prompt', async () => {
    const r = await both('/api/ai/grade', { ...GRADE, kind: 'short' }, 'grade-ok')
    expect(r.upWorker.body).toEqual(r.upLocal.body)
  })

  it('grade, out-of-range score: both refuse with the same reason', async () => {
    const r = await both('/api/ai/grade', GRADE, 'grade-bad')
    expect(JSON.parse(r.worker.text)).toEqual(JSON.parse(r.local.text))
    expect(JSON.parse(r.worker.text).ok).toBe(false)
  })
})
