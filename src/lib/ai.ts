/**
 * AI client — talks to the local proxy only (no API key in frontend).
 * Graceful degradation: if unavailable, returns {ok:false, reason} so UI can continue.
 */
import { AI_DISABLED_REASON, IS_WEB_EDITION } from './edition'
import { aiUsable, markAiForbidden } from './ai-access'

/** Web edition: AI calls go to this site's own /api (Access-protected); no client-side gateway settings. */
const WEB_HEADERS: Record<string, string> = IS_WEB_EDITION ? { 'X-ExamPilot-Client': '1' } : {}
const WEB_NO_ACCESS = '当前账号暂不能使用 AI'
const WEB_SESSION_EXPIRED = '登录已失效，请刷新页面重新登录后再试'

/** Server said "no AI for this account": hide AI right away (web edition). */
function noteForbidden(status: number, data: unknown) {
  if (!IS_WEB_EDITION) return
  const d = data as { error?: string; code?: string } | null
  // Only a definitive refusal hides AI. 503 AI_PERMISSION_UNAVAILABLE is a failed
  // check (shown as an error, retryable), not a revoked grant (N-01).
  if (status === 403 && d?.error === 'ai_forbidden' && d?.code !== 'AI_PERMISSION_UNAVAILABLE') markAiForbidden()
}

export interface AiConfig {
  baseUrl: string
  model: string
  timeoutMs: number
}

const DEFAULT_CONFIG: AiConfig = {
  baseUrl: '/api',
  model: 'default',
  timeoutMs: 60000,
}

export interface AiQaRequest {
  question?: { type: string; stem: string; options: string[]; answer?: string | null }
  userAnswer?: string
  questionContext?: { chapter: string; bankNo: number }
  messages?: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>
  /** web edition: let the model search the web (real search, cited sources) */
  search?: boolean
  /** web edition: JPEG/PNG data URIs attached to the last user message */
  images?: string[]
}

export interface AiQaResponse {
  ok: boolean
  answer?: string
  reason?: string
  provider?: string
  model?: string
  /** server error code (web), e.g. BUSY */
  code?: string
  /** BUSY: seconds until a concurrency slot frees up (server lease expiry) */
  retryAfter?: number
}

export interface AiGradeRequest {
  qid: string
  stem: string
  userAnswer: string
  chapter: string
  kind: 'short' | 'material'
}

export interface AiGradeResponse {
  ok: boolean
  result?: {
    score: number
    maxScore: number
    hitPoints: string[]
    missedPoints: string[]
    deductions: string[]
    suggestions: string[]
    structureNote: string
    disclaimer: string
  }
  reason?: string
  provider?: string
  model?: string
}

/**
 * POST JSON with both a timeout and an optional caller-supplied signal.
 *
 * The caller's signal exists so the UI can genuinely cancel an in-flight
 * request; aborting produces `{ok:false, reason:'已取消'}` rather than throwing,
 * so callers keep their single error path.
 */
async function postJson<T>(url: string, body: unknown, timeoutMs: number, external?: AbortSignal): Promise<T> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  let cancelled = false
  const onExternalAbort = () => {
    cancelled = true
    ctrl.abort()
  }
  if (external) {
    if (external.aborted) {
      clearTimeout(timer)
      return { ok: false, reason: '已取消' } as unknown as T
    }
    external.addEventListener('abort', onExternalAbort, { once: true })
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...WEB_HEADERS },
      body: JSON.stringify(body),
      signal: ctrl.signal,
      ...(IS_WEB_EDITION
        ? { credentials: 'same-origin' as const, redirect: 'manual' as const, cache: 'no-store' as const }
        : {}),
    })
    if (IS_WEB_EDITION && (res.type === 'opaqueredirect' || res.status === 401)) {
      return { ok: false, reason: WEB_SESSION_EXPIRED } as unknown as T
    }
    const text = await res.text()
    let data: unknown = null
    try {
      data = JSON.parse(text)
    } catch {
      // A non-JSON body means the proxy/network layer answered instead of the API
      // (a dev-proxy 503, an HTML error page). Surface it as a failure, never as a
      // silently empty success.
      return {
        ok: false,
        reason: res.ok
          ? `代理返回了非 JSON 响应（HTTP ${res.status}）：${text.slice(0, 160)}`
          : `请求失败（HTTP ${res.status}）：${text.slice(0, 160)}`,
      } as unknown as T
    }
    noteForbidden(res.status, data)
    return data as T
  } catch (e) {
    if ((e as Error).name === 'AbortError') {
      return { ok: false, reason: cancelled ? '已取消' : `请求超时（>${timeoutMs}ms）` } as unknown as T
    }
    return { ok: false, reason: `网络错误：${(e as Error).message}` } as unknown as T
  } finally {
    clearTimeout(timer)
    external?.removeEventListener('abort', onExternalAbort)
  }
}

export function getAiConfig(): AiConfig {
  // Web edition: fixed — the browser can never point AI calls elsewhere.
  if (IS_WEB_EDITION) return DEFAULT_CONFIG
  try {
    const raw = localStorage.getItem('exampilot.ai.config')
    if (raw) {
      const parsed = JSON.parse(raw)
      return { ...DEFAULT_CONFIG, ...parsed }
    }
  } catch {
    /* ignore */
  }
  return DEFAULT_CONFIG
}

export function setAiConfig(c: Partial<AiConfig>): void {
  if (IS_WEB_EDITION) return
  localStorage.setItem('exampilot.ai.config', JSON.stringify({ ...getAiConfig(), ...c }))
}

export async function aiAskQuestion(req: AiQaRequest, signal?: AbortSignal): Promise<AiQaResponse> {
  if (!aiUsable()) return { ok: false, reason: IS_WEB_EDITION ? WEB_NO_ACCESS : AI_DISABLED_REASON }
  const cfg = getAiConfig()
  return postJson<AiQaResponse>(`${cfg.baseUrl}/ai/qa`, req, cfg.timeoutMs, signal)
}

/**
 * 流式请求 AI 题目答疑 (SSE 打字机输出)。
 * 通过 onChunk 回调实时通知接收到的增量文字，返回最终完整字符串或错误原因。
 *
 * 超时语义（曾经是"一个字都没输出，最终超时"的直接原因）:
 *   - `timeoutMs` 是"多久没有收到任何新内容"的空闲上限，不是整个请求的硬上限。
 *     一次长回答只要持续吐字就不该被杀掉。
 *   - 首字节使用同一个空闲预算，因此网关一直不响应时会在 timeoutMs 后明确报错，
 *     而不是让用户对着"正在思考…"干等到超时。
 *   - 服务端还有自己的 60s 上限；前端把它当作兜底，并在超时文案里说明。
 */
export async function aiAskQuestionStream(
  req: AiQaRequest,
  onChunk: (chunk: string, fullText: string) => void,
  signal?: AbortSignal,
): Promise<AiQaResponse> {
  if (!aiUsable()) return { ok: false, reason: IS_WEB_EDITION ? WEB_NO_ACCESS : AI_DISABLED_REASON }
  const cfg = getAiConfig()
  const ctrl = new AbortController()
  let timedOut = false

  // Idle timer: re-armed every time a chunk arrives.
  let timer: ReturnType<typeof setTimeout> | undefined
  const armIdleTimer = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timedOut = true
      ctrl.abort()
    }, cfg.timeoutMs)
  }
  armIdleTimer()

  let cancelled = false
  const onExternalAbort = () => {
    cancelled = true
    ctrl.abort()
  }
  if (signal) {
    if (signal.aborted) {
      if (timer) clearTimeout(timer)
      return { ok: false, reason: '已取消' }
    }
    signal.addEventListener('abort', onExternalAbort, { once: true })
  }

  let accumulated = ''
  try {
    const res = await fetch(`${cfg.baseUrl}/ai/qa`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        ...WEB_HEADERS,
      },
      body: JSON.stringify({ ...req, stream: true }),
      signal: ctrl.signal,
      ...(IS_WEB_EDITION
        ? { credentials: 'same-origin' as const, redirect: 'manual' as const, cache: 'no-store' as const }
        : {}),
    })
    if (IS_WEB_EDITION && (res.type === 'opaqueredirect' || res.status === 401)) {
      return { ok: false, reason: WEB_SESSION_EXPIRED }
    }

    // 如果服务端不支持 SSE 或直接以普通 JSON 返回（例如未配置、错误等）
    const contentType = res.headers.get('content-type') || ''
    if (!contentType.includes('text/event-stream')) {
      const text = await res.text()
      try {
        const json = JSON.parse(text)
        noteForbidden(res.status, json)
        if (json.ok && json.answer) {
          onChunk(json.answer, json.answer)
          return json
        }
        return json
      } catch {
        // Non-JSON body: a dev-proxy 503 / HTML error page. Say so instead of
        // returning a blank failure the UI would show as "生成失败".
        return {
          ok: false,
          reason: res.ok
            ? `代理返回了非 JSON 响应（HTTP ${res.status}）：${text.slice(0, 160)}`
            : `请求失败（HTTP ${res.status}）：${text.slice(0, 160)}`,
        }
      }
    }

    if (!res.body) {
      return { ok: false, reason: '未接收到响应体' }
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder('utf-8')
    let buffer = ''
    let gotText = false

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      // Any bytes at all mean the connection is alive; restart the idle budget.
      armIdleTimer()
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith(':')) continue
        if (trimmed.startsWith('data:')) {
          const payload = trimmed.slice(5).trim()
          if (!payload || payload === '[DONE]') continue
          try {
            const data = JSON.parse(payload)
            if (data.type === 'chunk' && typeof data.delta === 'string' && data.delta) {
              accumulated += data.delta
              gotText = true
              onChunk(data.delta, accumulated)
            } else if (data.type === 'error') {
              if (IS_WEB_EDITION && data.code === 'AI_FORBIDDEN') markAiForbidden()
              return { ok: false, reason: data.reason || '未知流式错误', code: data.code }
            }
          } catch {
            // ignore partial json
          }
        }
      }
    }

    if (!gotText) {
      // The server finished without ever sending text: report a failure, do not
      // present an empty answer as if the model had replied.
      return { ok: false, reason: 'AI 未返回任何内容（流中没有可用文本）' }
    }

    return { ok: true, answer: accumulated }
  } catch (e) {
    if ((e as Error).name === 'AbortError') {
      if (cancelled) return { ok: false, reason: '已取消' }
      if (timedOut) {
        return {
          ok: false,
          reason: accumulated
            ? `响应中断：超过 ${cfg.timeoutMs}ms 没有收到新内容`
            : `AI 服务在 ${cfg.timeoutMs}ms 内没有返回任何内容，请检查网关配置或稍后重试`,
        }
      }
      return { ok: false, reason: `请求超时（>${cfg.timeoutMs}ms）` }
    }
    return { ok: false, reason: `网络错误：${(e as Error).message}` }
  } finally {
    if (timer) clearTimeout(timer)
    signal?.removeEventListener('abort', onExternalAbort)
  }
}

export async function aiGrade(req: AiGradeRequest, signal?: AbortSignal): Promise<AiGradeResponse> {
  if (!aiUsable()) return { ok: false, reason: IS_WEB_EDITION ? WEB_NO_ACCESS : AI_DISABLED_REASON }
  const cfg = getAiConfig()
  return postJson<AiGradeResponse>(`${cfg.baseUrl}/ai/grade`, req, cfg.timeoutMs, signal)
}

export interface AiStatusResponse {
  ok: boolean
  configured: boolean
  provider?: string
  model?: string
  baseUrl?: string
  hasKey?: boolean
  maskedKey?: string
  timeoutMs?: number
  message: string
}

export async function aiStatus(): Promise<AiStatusResponse> {
  if (!aiUsable()) return { ok: false, configured: false, message: IS_WEB_EDITION ? WEB_NO_ACCESS : AI_DISABLED_REASON }
  try {
    const res = await fetch('/api/ai/status', { headers: WEB_HEADERS })
    const text = await res.text()
    try {
      return JSON.parse(text)
    } catch {
      return { ok: false, configured: false, message: text.slice(0, 200) }
    }
  } catch (e) {
    return { ok: false, configured: false, message: `AI 服务不可用：${(e as Error).message}` }
  }
}

/* ---------------- saved chat images (web edition, 2026-10-27) ---------------- */

export interface SavedImageRef {
  id: string
  w: number
  h: number
}
export type SaveImagesResult =
  | { ok: true; images: SavedImageRef[] }
  /** saving is not switched on here: the picture is only used for this question */
  | { ok: false; unavailable: true; reason: string }
  | { ok: false; unavailable?: false; reason: string }

/** Store the compressed copies of the pictures of one message (before the question is sent). */
export async function aiSaveImages(conv: string, dataUris: string[]): Promise<SaveImagesResult> {
  try {
    const res = await fetch('/api/ai/images', {
      method: 'POST',
      headers: { ...WEB_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ conv, images: dataUris }),
    })
    const d = (await res.json().catch(() => null)) as {
      ok?: boolean
      images?: SavedImageRef[]
      error?: string
      reason?: string
    } | null
    if (res.ok && d?.ok && Array.isArray(d.images)) return { ok: true, images: d.images }
    if (res.status === 503 && d?.error === 'media_unavailable')
      return { ok: false, unavailable: true, reason: d.reason || '图片保存功能未开通' }
    noteForbidden(res.status, d)
    if (res.status === 401) return { ok: false, reason: WEB_SESSION_EXPIRED }
    return { ok: false, reason: d?.reason || `图片保存失败（${res.status}）` }
  } catch {
    return { ok: false, reason: '网络异常，图片未能保存，问题没有发送' }
  }
}

const imageCache = new Map<string, Promise<string | null>>()
/** A saved picture of this account as an object URL (null = gone / not allowed). Cached per page. */
export function aiImageUrl(id: string): Promise<string | null> {
  let p = imageCache.get(id)
  if (!p) {
    p = (async () => {
      try {
        const res = await fetch('/api/ai/images/' + encodeURIComponent(id), { headers: WEB_HEADERS })
        if (!res.ok) {
          imageCache.delete(id)
          return null
        }
        return URL.createObjectURL(await res.blob())
      } catch {
        imageCache.delete(id)
        return null
      }
    })()
    imageCache.set(id, p)
  }
  return p
}
/** the same picture as a data URI (to give an earlier conversation's images to a follow-up question) */
export async function aiImageDataUri(id: string): Promise<string | null> {
  const u = await aiImageUrl(id)
  if (!u) return null
  try {
    const b = await (await fetch(u)).blob()
    return await new Promise<string>((res, rej) => {
      const r = new FileReader()
      r.onload = () => res(String(r.result))
      r.onerror = () => rej(r.error)
      r.readAsDataURL(b)
    })
  } catch {
    return null
  }
}
