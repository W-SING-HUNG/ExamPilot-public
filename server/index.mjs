#!/usr/bin/env node
/**
 * ExamPilot AI proxy server (no external dependencies).
 * Keeps the Sub2API key server-side. OpenAI-compatible /chat/completions protocol.
 *
 * Endpoints:
 *   GET  /api/ai/status
 *   POST /api/ai/qa     { question, userAnswer, questionContext }
 *   POST /api/ai/grade  { qid, stem, userAnswer, chapter, kind }
 *   POST /api/ai/config { baseUrl, apiKey, model, timeoutMs }   (local only, see ALLOW_CONFIG_WRITE)
 *
 * Never fabricates AI availability: when unconfigured it returns ok:false.
 *
 * Security boundary:
 *   - LOOPBACK ONLY. A non-loopback AI_HOST is REFUSED at startup. The proxy has
 *     no user authentication, and it both spends AI quota (/api/ai/qa,
 *     /api/ai/grade) and can rewrite the gateway credentials
 *     (/api/ai/config), so it must never be reachable from the LAN or internet.
 *     There is deliberately NO override flag: use an SSH tunnel or a reverse
 *     proxy with real authentication if remote access is ever required.
 *   - Serves only loopback peers, checked per request as well as at bind time.
 *   - CORS allows only the local dev/preview origins, not `*`.
 *   - The API key is never returned to the browser and never logged.
 *   - /api/ai/config additionally requires a trusted local Origin.
 */
import http from 'node:http'
import { loadAiConfig, saveAiConfig, isConfigured } from './config.mjs'

const PORT = Number(process.env.AI_PORT || 8787)
const REQUESTED_HOST = process.env.AI_HOST || '127.0.0.1'
const CONFIG_TOKEN = process.env.AI_CONFIG_TOKEN || ''

/** True for loopback addresses (IPv4/IPv6, including IPv4-mapped forms). */
function isLoopbackAddress(addr) {
  if (!addr) return false
  const a = String(addr).replace(/^::ffff:/i, '')
  return a === '127.0.0.1' || a === '::1' || a === 'localhost' || a.startsWith('127.')
}

function isLoopbackHost(host) {
  return isLoopbackAddress(host)
}

// Refuse to expose an unauthenticated, quota-spending proxy on a network interface.
if (!isLoopbackHost(REQUESTED_HOST)) {
  console.error(
    `[ExamPilot AI proxy] 拒绝启动：AI_HOST=${REQUESTED_HOST} 不是回环地址。\n` +
      '  该代理没有用户身份认证，且同时提供消耗 AI 额度的接口（/api/ai/qa、/api/ai/grade）\n' +
      '  与可改写网关凭据的接口（/api/ai/config），因此不允许绑定到非回环地址。\n' +
      '  如确需远程访问，请使用 SSH 隧道或带有真实身份认证的反向代理，不要直接暴露本服务。',
  )
  process.exit(1)
}

const HOST = REQUESTED_HOST
const cfg = await loadAiConfig()

// Origins permitted to call this proxy. Vite dev/preview ports only.
// Extra origins can be opted into explicitly with AI_ALLOWED_ORIGINS
// (comma-separated) — e.g. when the dev server runs on a non-default port.
// This is deliberately opt-in: silently trusting arbitrary loopback ports would
// let any unrelated local page repoint the gateway (and receive the real key).
const ALLOWED_ORIGINS = new Set([
  `http://localhost:5173`,
  `http://127.0.0.1:5173`,
  `http://localhost:4173`,
  `http://127.0.0.1:4173`,
  ...(process.env.AI_ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
])

const DISCLAIMER = '本评阅由 AI 生成，仅作参考评阅，非官方标准答案或分数；请以题库原答案和课堂讲授为准。'

function send(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    // Never expose the key or config to the browser
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

/** True when the request comes from an allowed local origin (or has no Origin). */
function isTrustedOrigin(req) {
  const origin = req.headers.origin
  if (!origin) return true // curl / direct local request
  return ALLOWED_ORIGINS.has(origin)
}

function applyCors(req, res) {
  const origin = req.headers.origin
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
  }
}

/**
 * Config writes are allowed only for a loopback TCP peer with a trusted origin —
 * plus, when a shared token is configured, a matching token. The whole proxy is
 * already loopback-only; this is defence in depth for the credential endpoint.
 */
function mayWriteConfig(req) {
  const peer = req.socket?.remoteAddress
  if (CONFIG_TOKEN) {
    return req.headers['x-exampilot-config-token'] === CONFIG_TOKEN
  }
  return isLoopbackAddress(peer) && isTrustedOrigin(req)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (c) => {
      data += c
      // Destroying the request mid-read must reject, not resolve with a truncated body.
      if (data.length > 1_000_000) {
        const err = new Error('请求体过大（>1MB）')
        err.code = 'BODY_TOO_LARGE'
        req.destroy()
        reject(err)
      }
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

/**
 * Resolve when the CLIENT goes away, without relying on `req.on('close')`.
 *
 * `req` is a readable stream: on Node >= 16 it is destroyed as soon as the request
 * body has been fully consumed, so `req.on('close')` fires immediately after
 * `readBody()` — long before the client disconnects. Attaching the abort there (as
 * this proxy used to) either cancels the upstream request straight away or misses
 * the real disconnect entirely.
 *
 * `res` is the reliable signal: `res.on('close')` fires exactly once, when the
 * underlying socket is torn down before the response was finished.
 */
function abortWithClient(res, ctrl) {
  const onClose = () => {
    if (!res.writableEnded) ctrl.abort(new Error('client-abort'))
  }
  res.once('close', onClose)
  return () => res.removeListener('close', onClose)
}

/** Stream AI Q&A via Server-Sent Events */
async function streamQaGateway(messages, req, res) {
  const c = await loadAiConfig()
  if (!isConfigured(c)) {
    return send(res, 200, {
      ok: false,
      reason: 'AI 网关未配置（缺少 baseUrl/apiKey/model）',
      code: 'NOT_CONFIGURED',
    })
  }

  const url = c.baseUrl.replace(/\/$/, '') + '/chat/completions'

  /*
   * Three independent deadlines, deliberately kept apart:
   *
   *   CONNECT_TIMEOUT_MS  how long the gateway may take to send response HEADERS.
   *                       This is the "the request never even started" case.
   *   IDLE (c.timeoutMs)  how long the stream may go silent WITHOUT any new bytes.
   *                       A long answer that keeps producing tokens is healthy and
   *                       must not be killed merely for being long.
   *   HARD_CAP            a generous total ceiling (10x the idle budget) so a
   *                       gateway that trickles bytes forever cannot pin the proxy.
   *
   * The old code used ONE timer for all three. That was wrong in both directions:
   * it killed long but healthy answers mid-stream, and a gateway that accepted the
   * TCP connection without ever answering left the rider waiting for their own
   * unrelated browser timer to expire ("一个字都没输出，最终超时").
   */
  const CONNECT_TIMEOUT_MS = Math.min(c.timeoutMs, 30_000)
  const HARD_CAP_MS = Math.max(c.timeoutMs * 10, 120_000)

  const ctrl = new AbortController()
  /** Distinguishes our own aborts from upstream/network failures. */
  const abortReason = { value: '' }

  const abort = (reason) => {
    if (!ctrl.signal.aborted) {
      abortReason.value = reason
      ctrl.abort(new Error(reason))
    }
  }

  let connectTimer = setTimeout(() => abort('connect-timeout'), CONNECT_TIMEOUT_MS)
  const clearConnectTimer = () => {
    if (connectTimer) {
      clearTimeout(connectTimer)
      connectTimer = null
    }
  }

  let idleTimer
  const armIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => abort('idle-timeout'), c.timeoutMs)
  }
  armIdleTimer()

  const hardTimer = setTimeout(() => abort('hard-cap'), HARD_CAP_MS)

  /*
   * Cancel the upstream when the browser goes away.
   *
   * What this does and does NOT prove:
   *   - It removes ONE mechanism by which a gateway can end up generating for a
   *     client that no longer exists, i.e. it can turn a 499 into a clean
   *     cancellation.
   *   - It is NOT established that "the cancel was not propagated" is what
   *     produced the reported `HTTP 499 / Client disconnected before upstream
   *     response / context canceled`. A 499 means the gateway saw ITS OWN client
   *     (this proxy, or whatever sits between them) disappear while the response
   *     was pending. The same log appears when the browser aborts after its own
   *     timeout, when the page is refreshed/closed mid-answer, when an
   *     intermediate reverse proxy or Caddy/Cloudflare times out first, or when
   *     the upstream itself cancels. Attributing it to a single cause requires
   *     the gateway's own request timestamps and request ids.
   *
   * The reason we still attach it: without it, a browser abort left the upstream
   * running to completion, which is exactly the "generating for nobody" shape a
   * 499 log describes. With it, that path cannot happen.
   */
  const detachClient = abortWithClient(res, ctrl)

  const cleanup = () => {
    clearConnectTimer()
    if (idleTimer) clearTimeout(idleTimer)
    clearTimeout(hardTimer)
    detachClient()
  }

  /** Human-readable text for the reason the upstream call was aborted. */
  const abortText = () => {
    if (abortReason.value === 'connect-timeout') {
      return `AI 请求超时（${CONNECT_TIMEOUT_MS}ms 内网关未返回响应头）`
    }
    if (abortReason.value === 'idle-timeout') {
      return `AI 响应超时（超过 ${c.timeoutMs}ms 没有收到新内容）`
    }
    if (abortReason.value === 'hard-cap') {
      return `AI 请求超时（总时长超过 ${HARD_CAP_MS}ms）`
    }
    return ''
  }

  let upstream
  try {
    upstream = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${c.apiKey}`,
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({
        model: c.model,
        messages,
        temperature: 0.3,
        max_tokens: c.maxTokens,
        stream: true,
      }),
      signal: ctrl.signal,
    })
    // Headers are in: the connect deadline no longer applies, the idle one does.
    clearConnectTimer()
  } catch (e) {
    cleanup()
    // The client is gone: nobody is listening, so do not try to answer.
    if (abortReason.value === 'client-abort') return
    const isTimeout = abortReason.value !== ''
    return send(res, isTimeout ? 200 : 502, {
      ok: false,
      reason: isTimeout ? abortText() : `无法连接 AI 网关：${e.message}`,
      code: isTimeout ? 'TIMEOUT' : 'CONNECT_ERROR',
    })
  }

  if (!upstream.ok) {
    cleanup()
    if (abortReason.value === 'client-abort') return
    const errText = await upstream.text().catch(() => '')
    return send(res, 502, {
      ok: false,
      reason: `网关返回 ${upstream.status}: ${errText.slice(0, 300)}`,
      code: 'GATEWAY_ERROR',
    })
  }

  /*
   * `upstream.body` is null for every response without a payload — 204 No Content
   * and HEAD in particular. Calling `.getReader()` on it threw a TypeError inside
   * an async handler, which Node reports as an unhandled rejection and terminates
   * the WHOLE proxy process: every later request (including 保存配置) then failed
   * at the socket level, which the browser shows as "Failed to fetch".
   */
  if (!upstream.body) {
    cleanup()
    if (abortReason.value === 'client-abort') return
    return send(res, 200, {
      ok: false,
      reason: `AI 网关返回了空响应（HTTP ${upstream.status}），未收到任何内容`,
      code: 'EMPTY_UPSTREAM',
    })
  }

  /*
   * Not every OpenAI-compatible deployment honours `stream: true`. When the
   * gateway answers with a single JSON completion instead of an event stream,
   * degrade to the non-streaming path rather than telling the user "no content".
   */
  const upstreamType = upstream.headers.get('content-type') || ''
  if (!upstreamType.includes('text/event-stream')) {
    const text = await upstream.text().catch(() => '')
    cleanup()
    if (abortReason.value === 'client-abort') return
    let content
    try {
      content = JSON.parse(text)?.choices?.[0]?.message?.content
    } catch {
      content = undefined
    }
    if (typeof content !== 'string' || !content.trim()) {
      return send(res, 200, {
        ok: false,
        reason: `AI 网关未返回可解析的内容（HTTP ${upstream.status}，Content-Type=${upstreamType || '未提供'}）`,
        code: 'BAD_RESPONSE',
      })
    }
    // Serve it as a single SSE chunk so the client keeps one code path.
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    res.write(`data: ${JSON.stringify({ type: 'start', model: c.model, provider: 'sub2api' })}\n\n`)
    res.write(`data: ${JSON.stringify({ type: 'chunk', delta: content })}\n\n`)
    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`)
    return res.end()
  }

  // 开启 SSE 响应头
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Defeat any intermediate buffering (nginx & friends) so tokens arrive live.
    'X-Accel-Buffering': 'no',
  })

  // 发送初始元信息
  res.write(`data: ${JSON.stringify({ type: 'start', model: c.model, provider: 'sub2api' })}\n\n`)

  const reader = upstream.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  let sawDone = false
  let wroteAny = false

  /** Write one framed SSE event; stops once the client has gone. */
  const emit = (obj) => {
    if (res.writableEnded || res.destroyed) return false
    res.write(`data: ${JSON.stringify(obj)}\n\n`)
    return true
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      // Bytes arrived: the stream is alive, restart the idle budget.
      armIdleTimer()
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith(':')) continue
        if (trimmed === 'data: [DONE]') {
          sawDone = true
          continue
        }
        // Accept both `data: {...}` (spec) and `data:{...}` (sloppy gateways).
        if (trimmed.startsWith('data:')) {
          const payload = trimmed.slice(5).trim()
          if (!payload || payload === '[DONE]') {
            if (payload === '[DONE]') sawDone = true
            continue
          }
          try {
            const parsed = JSON.parse(payload)
            const delta = parsed.choices?.[0]?.delta?.content
            if (typeof delta === 'string' && delta.length > 0) {
              if (!emit({ type: 'chunk', delta })) return
              wroteAny = true
            }
          } catch {
            // ignore partial json
          }
        }
      }
    }

    // Flush a trailing frame that arrived without a final newline.
    const tail = buffer.trim()
    if (tail.startsWith('data:')) {
      const payload = tail.slice(5).trim()
      if (payload && payload !== '[DONE]') {
        try {
          const parsed = JSON.parse(payload)
          const delta = parsed.choices?.[0]?.delta?.content
          if (typeof delta === 'string' && delta.length > 0) {
            if (!emit({ type: 'chunk', delta })) return
            wroteAny = true
          }
        } catch {
          /* ignore */
        }
      } else if (payload === '[DONE]') {
        sawDone = true
      }
    }

    if (!wroteAny) {
      // A 200 with no usable content is a FAILURE, never an empty "success":
      // the UI must not render a blank answer as if the model had replied.
      emit({
        type: 'error',
        code: abortReason.value !== '' ? 'TIMEOUT' : 'EMPTY_STREAM',
        reason:
          abortReason.value !== ''
            ? abortText()
            : sawDone
              ? 'AI 网关返回了空内容（流中没有可用的 delta）'
              : 'AI 网关未返回可解析的流式内容',
      })
      return
    }
    emit({ type: 'done' })
  } catch (err) {
    // A client abort is expected; anything else is a real upstream failure.
    if (abortReason.value === 'client-abort' || res.destroyed) return
    const reason = abortReason.value !== '' ? abortText() : String(err?.message || err)
    emit({
      type: 'error',
      reason,
      code: abortReason.value === '' ? 'STREAM_ERROR' : 'TIMEOUT',
    })
  } finally {
    cleanup()
    // Ensure the upstream reader is released even when we bailed out early.
    try {
      await reader.cancel()
    } catch {
      /* ignore */
    }
    if (!res.writableEnded) res.end()
  }
}
async function callGateway(messages, signal) {
  const c = await loadAiConfig()
  if (!isConfigured(c)) {
    const err = new Error('AI 网关未配置（缺少 baseUrl/apiKey/model）')
    err.code = 'NOT_CONFIGURED'
    throw err
  }
  const url = c.baseUrl.replace(/\/$/, '') + '/chat/completions'
  const ctrl = new AbortController()
  /** Track WHY we aborted, so a timeout is never reported as a client disconnect. */
  let abortReason = ''
  const abort = (reason) => {
    if (!ctrl.signal.aborted) {
      abortReason = reason
      ctrl.abort(new Error(reason))
    }
  }
  const timer = setTimeout(() => abort('timeout'), c.timeoutMs)
  const onExternalAbort = () => abort('client-abort')
  if (signal) {
    if (signal.aborted) {
      clearTimeout(timer)
      const err = new Error('客户端已断开连接')
      err.code = 'CLIENT_ABORT'
      throw err
    }
    signal.addEventListener('abort', onExternalAbort, { once: true })
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${c.apiKey}`,
      },
      body: JSON.stringify({
        model: c.model,
        messages,
        temperature: 0.3,
        max_tokens: c.maxTokens,
      }),
      signal: ctrl.signal,
    })
    const text = await res.text()
    if (!res.ok) {
      const err = new Error(`网关返回 ${res.status}: ${text.slice(0, 300)}`)
      err.code = 'GATEWAY_ERROR'
      throw err
    }
    let data
    try {
      data = JSON.parse(text)
    } catch {
      const err = new Error(`网关响应不是合法 JSON: ${text.slice(0, 120)}`)
      err.code = 'BAD_RESPONSE'
      throw err
    }
    const content = data?.choices?.[0]?.message?.content
    if (typeof content !== 'string') {
      const err = new Error('网关响应缺少 choices[0].message.content')
      err.code = 'BAD_RESPONSE'
      throw err
    }
    return { content, provider: data.provider || 'sub2api', model: data.model || c.model }
  } catch (e) {
    // Prefer the reason WE recorded over guessing from the error shape: a
    // DOMException AbortError looks identical for a timeout and for a client
    // disconnect, and Node wraps the abort reason in `cause`.
    const root = e?.cause?.name === 'AbortError' || e?.cause ? e.cause : e
    const reasonMsg = String(root?.message || e?.message || '')
    const abortLike =
      abortReason !== '' ||
      root?.name === 'AbortError' ||
      e?.name === 'AbortError' ||
      reasonMsg === 'timeout' ||
      reasonMsg === 'client-abort'

    if (abortReason === 'timeout' || (abortLike && reasonMsg === 'timeout')) {
      const err = new Error(`AI 请求超时（>${c.timeoutMs}ms），请重试或缩短题目长度`)
      err.code = 'TIMEOUT'
      throw err
    }
    if (abortReason === 'client-abort') {
      const err = new Error('客户端已断开连接')
      err.code = 'CLIENT_ABORT'
      throw err
    }
    if (abortLike) {
      const err = new Error('客户端已断开连接')
      err.code = 'CLIENT_ABORT'
      throw err
    }
    if (e?.name === 'TypeError' && /fetch failed/i.test(String(e.message || ''))) {
      const err = new Error(`无法连接 AI 网关（${c.baseUrl}）：${e.cause?.message || e.message}`)
      err.code = 'CONNECT_ERROR'
      throw err
    }
    throw e
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onExternalAbort)
  }
}

function buildQaPrompt(body) {
  // 如果前端直接传递了多轮 messages 历史，则优先支持多轮自由追问对话
  if (Array.isArray(body.messages) && body.messages.length > 0) {
    const sysMsg = {
      role: 'system',
      content:
        '你是《习近平新时代中国特色社会主义思想概论》专业课程 AI。请基于思政教材与题库知识，用自然、直接、专业的中文回答学生的追问。' +
        '要求：1) 针对学生的具体疑问直接作答，不要重复套用固定模板，不要每次都重复全套题目解析；2) 问什么答什么，直截了当；3) 严禁使用 LaTeX 公式语法（禁止 \\rightarrow 等，如需推导直接用文字或箭头“→”）；4) 重点概念加粗。',
    }
    return [sysMsg, ...body.messages]
  }

  const q = body.question || {}
  const ctx = body.questionContext || {}
  const opts = Array.isArray(q.options)
    ? q.options.map((o, i) => `  ${String.fromCharCode(65 + i)}. ${o}`).join('\n')
    : ''
  return [
    {
      role: 'system',
      content:
        '你是《习近平新时代中国特色社会主义思想概论》专业课程 AI。请基于题库与教材知识，用规范、专业、易读的简体中文回答学生。' +
        '首次完整解析题目时的结构要求：\n' +
        '1. 严禁使用 LaTeX 数学公式语法（禁止出现 \\rightarrow, \\Rightarrow, $...$ 等），因果推导请直接使用中文箭头“→”或直白汉字表述。\n' +
        '2. 严禁输出空行堆叠或多余的分割线（不要输出 --- 或 *** 分割线）。\n' +
        '3. 首次解析请分三个板块：\n' +
        '   - 1. 正确答案及依据\n' +
        '   - 2. 各选项逐项解析\n' +
        '   - 3. 学生答错原因分析\n' +
        '4. 选项分析分点罗列，核心概念词加粗，语言简洁干练，重点突出。',
    },
    {
      role: 'user',
      content:
        `章节：${ctx.chapter || '未知'}，题号：${ctx.bankNo ?? '未知'}，题型：${q.type || '未知'}\n` +
        `题干：${q.stem || ''}\n` +
        (opts ? `选项：\n${opts}\n` : '') +
        (q.answer ? `题库答案：${q.answer}\n` : '') +
        `学生的作答：${body.userAnswer || '（未作答）'}`,
    },
  ]
}

function buildGradePrompt(body) {
  return [
    {
      role: 'system',
      content:
        '你是《习近平新时代中国特色社会主义思想概论》阅卷助教，请对学生的简答题/材料分析题作答进行参考性评阅。' +
        '请严格输出 JSON，不要输出任何多余文字，JSON 结构如下：\n' +
        '{"score": 0-100 的整数, "hitPoints": ["命中的采分点"], "missedPoints": ["遗漏的内容"], "deductions": ["扣分依据"], "suggestions": ["修改建议"], "structureNote": "答题结构点评"}\n' +
        '评分必须基于题干要求、核心概念、采分点与材料联系；不得凭空给出标准答案之外的内容。',
    },
    {
      role: 'user',
      content:
        `章节：${body.chapter || '未知'}，题型：${body.kind === 'short' ? '简答题' : '材料分析论述题'}\n` +
        `题干：${body.stem || ''}\n` +
        `学生作答：${body.userAnswer || '（未作答）'}`,
    },
  ]
}

/** Extract JSON from a possibly prose-wrapped model response. */
function extractJson(text) {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1 || end < start) return null
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
}

/**
 * Validate a grade result strictly. A missing or malformed field is a FAILURE,
 * not a zero — we must never report `ok:true` with a fabricated score.
 * Returns { ok: true, result } or { ok: false, reason }.
 */
function validateGrade(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'AI 返回的评阅结果不是 JSON 对象' }
  }
  if (typeof raw.score !== 'number' || !Number.isFinite(raw.score)) {
    return { ok: false, reason: 'AI 评阅结果缺少有效的 score 字段（数字）' }
  }
  if (raw.score < 0 || raw.score > 100) {
    return { ok: false, reason: `AI 评阅 score 超出 0-100 范围：${raw.score}` }
  }
  for (const field of ['hitPoints', 'missedPoints', 'deductions', 'suggestions']) {
    if (!Array.isArray(raw[field])) {
      return { ok: false, reason: `AI 评阅结果缺少 ${field} 数组字段` }
    }
    if (raw[field].some((x) => typeof x !== 'string')) {
      return { ok: false, reason: `AI 评阅结果 ${field} 含非字符串元素` }
    }
  }
  if (typeof raw.structureNote !== 'string') {
    return { ok: false, reason: 'AI 评阅结果缺少 structureNote 字符串字段' }
  }
  return {
    ok: true,
    result: {
      score: Math.round(raw.score),
      maxScore: 100,
      hitPoints: raw.hitPoints.filter((s) => s.trim()),
      missedPoints: raw.missedPoints.filter((s) => s.trim()),
      deductions: raw.deductions.filter((s) => s.trim()),
      suggestions: raw.suggestions.filter((s) => s.trim()),
      structureNote: raw.structureNote,
      disclaimer: DISCLAIMER,
    },
  }
}

const server = http.createServer(async (req, res) => {
  // A malformed Host header would throw inside `new URL`; answer instead of crashing.
  let url
  try {
    url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`)
  } catch {
    return send(res, 400, { ok: false, message: 'Bad request' })
  }
  applyCors(req, res)
  if (req.method === 'OPTIONS') {
    // Only echo CORS headers for trusted origins; otherwise a bare 204.
    if (req.headers.origin && !ALLOWED_ORIGINS.has(req.headers.origin)) {
      res.writeHead(403, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ ok: false, message: 'Origin not allowed' }))
    }
    res.writeHead(204)
    return res.end()
  }

  // Per-request loopback enforcement. The bind-time check already prevents a
  // network bind, but this makes the guarantee explicit and covers a socket
  // forwarded to us by another local process.
  if (!isLoopbackAddress(req.socket?.remoteAddress)) {
    return send(res, 403, {
      ok: false,
      message: '本代理仅接受来自本机（回环地址）的请求，拒绝远程访问。',
    })
  }

  if (req.method === 'GET' && url.pathname === '/api/ai/status') {
    /*
     * Guarded like every other route, for defence in depth.
     *
     * Note on reachability: `loadAiConfig()` (server/config.mjs) already catches
     * its own read/parse failures and falls back to defaults, so in practice this
     * await rarely rejects. The guard is kept anyway because the fatal-error
     * policy below makes ANY escaped rejection process-fatal, and a future change
     * to config loading must not be able to turn a status probe into a crash.
     */
    try {
      const c = await loadAiConfig()
      const configured = isConfigured(c)
      // 为了方便用户在前端修改配置，在状态中回显非敏感的基础配置信息（API Key 保持脱敏）
      const maskedKey = c.apiKey ? `${c.apiKey.slice(0, 3)}****${c.apiKey.slice(-4)}` : ''
      return send(res, 200, {
        ok: configured,
        configured,
        provider: 'sub2api',
        model: c.model || '',
        baseUrl: c.baseUrl || '',
        hasKey: Boolean(c.apiKey),
        maskedKey,
        timeoutMs: c.timeoutMs || 60000,
        message: configured
          ? `AI 网关已配置（model=${c.model}）`
          : 'AI 网关未配置：请在 server/ai-config.json 或环境变量 AI_BASE_URL/AI_API_KEY/AI_MODEL 中设置。',
      })
    } catch (e) {
      return send(res, 200, {
        ok: false,
        configured: false,
        provider: 'sub2api',
        model: '',
        baseUrl: '',
        hasKey: false,
        maskedKey: '',
        timeoutMs: 60000,
        message: `无法读取 AI 配置（${String(e?.message || e)}）。刷题、评分与本地记录不受影响。`,
      })
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/ai/config') {
    // Config writes require a loopback peer with a trusted origin, or the
    // configured shared token when one was set.
    if (!mayWriteConfig(req)) {
      return send(res, 403, {
        ok: false,
        message: '配置写入仅允许来自本机的受信任来源（配置了共享密钥时需提供 x-exampilot-config-token）',
      })
    }
    try {
      let body
      try {
        body = JSON.parse((await readBody(req)) || '{}')
      } catch (e) {
        return send(res, 400, {
          ok: false,
          message: `请求体不是合法 JSON：${String(e?.message || e)}`,
          code: 'BAD_REQUEST_BODY',
        })
      }
      const current = await loadAiConfig()
      // 如果提交的 apiKey 为空且服务端原本已有 apiKey，则保留原 apiKey（方便只修改 model 或 baseUrl）
      const newApiKey = String(body.apiKey || '').trim() || current.apiKey || ''
      const saved = await saveAiConfig({
        baseUrl: String(body.baseUrl || '').trim(),
        apiKey: newApiKey,
        model: String(body.model || '').trim(),
        timeoutMs: Number(body.timeoutMs) || 60000,
      })
      return send(res, 200, {
        ok: true,
        configured: isConfigured(saved),
        model: saved.model,
        message: isConfigured(saved) ? '配置已保存' : '配置已保存，但尚未填写完整',
      })
    } catch (e) {
      return send(res, 400, { ok: false, message: String(e.message || e) })
    }
  }

  if (req.method === 'POST' && (url.pathname === '/api/ai/qa' || url.pathname === '/api/ai/grade')) {
    try {
      let body
      try {
        body = JSON.parse((await readBody(req)) || '{}')
      } catch (e) {
        // A malformed request body is a CLIENT error. Reporting it as 502 would
        // wrongly blame the upstream gateway and send anyone debugging this to
        // the wrong place (this is how "is the gateway down?" red herrings start).
        return send(res, 400, {
          ok: false,
          reason: `请求体不是合法 JSON：${String(e?.message || e)}`,
          code: 'BAD_REQUEST_BODY',
        })
      }

      const isStream =
        url.pathname === '/api/ai/qa' && (body.stream === true || req.headers.accept?.includes('text/event-stream'))

      const messages = url.pathname === '/api/ai/qa' ? buildQaPrompt(body) : buildGradePrompt(body)

      // 如果客户端请求流式传输，分发给 SSE 流式处理器
      if (isStream) {
        return streamQaGateway(messages, req, res)
      }

      const ac = new AbortController()
      // Watch the RESPONSE, not the request: `req` is destroyed as soon as its
      // body has been read, so `req.on('close')` would abort every call instantly.
      const detach = abortWithClient(res, ac)
      try {
        const { content, provider, model } = await callGateway(messages, ac.signal)
        if (url.pathname === '/api/ai/qa') {
          return send(res, 200, { ok: true, answer: content, provider, model })
        }
        const raw = extractJson(content)
        if (!raw) {
          // Explicit failure — never fabricate a 0-score "successful" review
          return send(res, 200, {
            ok: false,
            reason: 'AI 未返回可解析的 JSON 评阅结果，本次评阅失败（未给出参考分）',
            code: 'BAD_GRADE_FORMAT',
          })
        }
        const v = validateGrade(raw)
        if (!v.ok) {
          return send(res, 200, { ok: false, reason: v.reason, code: 'BAD_GRADE_FORMAT' })
        }
        return send(res, 200, { ok: true, result: v.result, provider, model })
      } finally {
        detach()
      }
    } catch (e) {
      const code = e.code || ''
      // Degrade gracefully: all failures surface as ok:false + reason, never a fabricated answer
      const status = code === 'NOT_CONFIGURED' ? 200 : code === 'TIMEOUT' || code === 'CLIENT_ABORT' ? 200 : 502
      // The client is gone; writing a body would just fail. Answering 200 keeps
      // the intent explicit for callers that still manage to read it.
      if (code === 'CLIENT_ABORT' && res.destroyed) return
      return send(res, status, { ok: false, reason: e.message || String(e), code })
    }
  }

  send(res, 404, { ok: false, message: 'Not found' })
})

/*
 * Error policy.
 *
 * The crash that caused "AI 一个字都没输出 / 保存失败：Failed to fetch" was a
 * `TypeError` inside an async request handler. That is now prevented at the
 * source: `upstream.body` is checked before `getReader()`, and every request path
 * has its own try/catch. Suppressing errors globally would be the wrong medicine —
 * it hides real bugs and leaves the process in an unknown state.
 *
 * Therefore: unexpected rejections/exceptions are LOGGED LOUDLY and the process
 * exits non-zero, so a supervisor (or the developer) sees it instead of serving a
 * silently broken endpoint. Only a deliberately allow-listed set of benign,
 * per-request failures keeps the process alive.
 */
function fatal(kind, err) {
  console.error(`[ExamPilot AI proxy] 致命错误（${kind}），进程退出以避免继续提供错误服务：`, err)
  process.exit(1)
}

process.on('unhandledRejection', (reason) => {
  fatal('unhandledRejection', reason)
})
process.on('uncaughtException', (err) => {
  fatal('uncaughtException', err)
})

server.on('clientError', (err, socket) => {
  // A client that hangs up mid-request is normal and is NOT fatal: answer with a
  // bare 400 when the socket is still writable, then move on.
  if (err?.code === 'ECONNRESET' || err?.code === 'EPIPE') {
    socket.destroy()
    return
  }
  if (socket.writable && !socket.destroyed) {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
  } else {
    socket.destroy()
  }
})

server.listen(PORT, HOST, () => {
  console.log(`[ExamPilot AI proxy] listening on http://${HOST}:${PORT}`)
  console.log(`[ExamPilot AI proxy] configured=${isConfigured(cfg)} model=${cfg.model || '(unset)'}`)
  console.log('[ExamPilot AI proxy] 仅接受本机（回环地址）请求；如需远程访问请使用 SSH 隧道。')
  if (!isConfigured(cfg)) {
    console.log('[ExamPilot AI proxy] 提示：AI 网关未配置；刷题、评分与本地记录不受影响。')
  }
})
