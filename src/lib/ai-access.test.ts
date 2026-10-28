import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * Web edition AI gate: until the server says "allowed", no AI call leaves the
 * browser; a server refusal hides AI again.
 */
afterEach(() => {
  vi.resetModules()
  vi.doUnmock('./edition')
  vi.unstubAllGlobals()
})

function webEdition() {
  vi.doMock('./edition', () => ({
    IS_WEB_EDITION: true,
    WEB_EDITION_MARKER: 'm',
    AI_ENABLED: false,
    AI_DISABLED_REASON: 'x',
    EDITION: 'web',
  }))
  vi.stubGlobal('window', { addEventListener: () => {} })
  vi.stubGlobal('document', {
    addEventListener: () => {},
    visibilityState: 'visible',
    documentElement: { dataset: {} },
  })
}
const jsonRes = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } })

describe('web AI gate', () => {
  it('an account the server does not allow never sends an AI request', async () => {
    webEdition()
    const calls: string[] = []
    vi.stubGlobal('fetch', async (u: string) => {
      calls.push(String(u))
      return jsonRes({ ok: true, allowed: false, admin: false })
    })
    const access = await import('./ai-access')
    const ai = await import('./ai')
    await access.refreshAiAccess(true)
    expect(access.getAiAccess().state).toBe('denied')
    const r = await Promise.all([
      ai.aiAskQuestionStream({ messages: [{ role: 'user', content: 'x' }] }, () => {}),
      ai.aiGrade({ qid: 'q', stem: 's', userAnswer: 'u', chapter: 'c', kind: 'short' }),
      ai.aiAskQuestion({ messages: [] }),
    ])
    expect(r.every((x) => x.ok === false)).toBe(true)
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.every((c) => c === '/api/ai/status')).toBe(true)
  })

  it('N-01: once granted, a failed status check (502 / redirect / 503 unavailable / HTML) keeps AI; only allowed:false hides it', async () => {
    webEdition()
    let mode: 'ok' | '502' | 'unavail' | 'html' | 'denied' = 'ok'
    vi.stubGlobal('fetch', async () => {
      if (mode === 'ok') return jsonRes({ ok: true, allowed: true, admin: false, configured: true, model: 'm' })
      if (mode === '502') return new Response('bad gateway', { status: 502 })
      if (mode === 'unavail') return jsonRes({ ok: false, error: 'status_unavailable' }, 503)
      if (mode === 'html')
        return new Response('<html></html>', { status: 200, headers: { 'Content-Type': 'text/html' } })
      return jsonRes({ ok: true, allowed: false, admin: false })
    })
    const access = await import('./ai-access')
    await access.refreshAiAccess(true)
    expect(access.getAiAccess().state).toBe('granted')
    for (const m of ['502', 'unavail', 'html'] as const) {
      mode = m
      await access.refreshAiAccess(true)
      expect(access.getAiAccess().state).toBe('granted')
    }
    mode = 'denied'
    await access.refreshAiAccess(true)
    expect(access.getAiAccess().state).toBe('denied')
  })

  it('N-01: a 503 AI_PERMISSION_UNAVAILABLE from an AI call is an error, not a revocation', async () => {
    webEdition()
    vi.stubGlobal('fetch', async (u: string) => {
      if (String(u) === '/api/ai/status')
        return jsonRes({ ok: true, allowed: true, admin: false, configured: true, model: 'm' })
      return jsonRes({ ok: false, error: 'ai_forbidden', code: 'AI_PERMISSION_UNAVAILABLE', reason: 'x' }, 503)
    })
    const access = await import('./ai-access')
    const ai = await import('./ai')
    await access.refreshAiAccess(true)
    const g = await ai.aiGrade({ qid: 'q', stem: 's', userAnswer: 'u', chapter: 'c', kind: 'short' })
    expect(g.ok).toBe(false)
    expect(access.getAiAccess().state).toBe('granted')
  })

  it('before the server answers (pending) AI is not usable', async () => {
    webEdition()
    vi.stubGlobal('fetch', () => new Promise(() => {}))
    const access = await import('./ai-access')
    expect(access.getAiAccess().state).toBe('pending')
    expect(access.aiUsable()).toBe(false)
  })

  it('allowed → AI calls go only to this site /api with the client header; a 403 hides AI', async () => {
    webEdition()
    const calls: { url: string; headers: Record<string, string> }[] = []
    let allowed = true
    vi.stubGlobal('fetch', async (u: string, init?: RequestInit) => {
      calls.push({ url: String(u), headers: (init?.headers ?? {}) as Record<string, string> })
      if (String(u) === '/api/ai/status')
        return jsonRes({ ok: true, allowed, admin: false, configured: true, model: 'grok-4.7' })
      return jsonRes({ ok: false, error: 'ai_forbidden', reason: '当前账号没有 AI 使用权限' }, 403)
    })
    vi.stubGlobal('localStorage', {
      getItem: () => JSON.stringify({ baseUrl: 'https://evil.example' }),
      setItem: () => {},
    })
    const access = await import('./ai-access')
    const ai = await import('./ai')
    await access.refreshAiAccess(true)
    expect(access.aiUsable()).toBe(true)
    const g = await ai.aiGrade({ qid: 'q', stem: 's', userAnswer: 'u', chapter: 'c', kind: 'short' })
    expect(g.ok).toBe(false)
    const grade = calls.filter((c) => c.url !== '/api/ai/status')
    expect(grade.map((c) => c.url)).toEqual(['/api/ai/grade']) // localStorage baseUrl ignored on the web
    expect(grade[0].headers['X-ExamPilot-Client']).toBe('1')
    expect(access.aiUsable()).toBe(false) // hidden after the server refused
    allowed = false
  })
})

describe('N01-8: status endpoint unavailable on first load', () => {
  function memStorage(init: Record<string, string> = {}) {
    const m = new Map(Object.entries(init))
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
      setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k),
    })
    return m
  }
  const cacheFor = (acct: string, at = Date.now()) =>
    JSON.stringify({ acct, admin: false, configured: true, model: 'm', at })

  it('502 with no earlier confirmation → unknown (Standard look, AI not usable, notice), never granted', async () => {
    webEdition()
    memStorage()
    vi.stubGlobal('fetch', async () => new Response('bad gateway', { status: 502 }))
    const access = await import('./ai-access')
    access.setAiAccount('acc_1')
    await access.refreshAiAccess(true)
    expect(access.getAiAccess().state).toBe('unknown')
    expect(access.getAiAccess().issue).toBe('server')
    expect(access.aiUsable()).toBe(false)
    expect(access.tierOf(access.getAiAccess())).toBe('standard')
  })

  it('502 after this browser confirmed Pro for the SAME account → Pro kept (cached), notice shown', async () => {
    webEdition()
    memStorage({ 'exampilot.aiAccess.v1': cacheFor('acc_1') })
    vi.stubGlobal('fetch', async () => new Response('bad gateway', { status: 502 }))
    const access = await import('./ai-access')
    access.setAiAccount('acc_1')
    await access.refreshAiAccess(true)
    expect(access.getAiAccess()).toMatchObject({ state: 'granted', cached: true, issue: 'server' })
    expect(access.tierOf(access.getAiAccess())).toBe('pro')
  })

  it('a cached confirmation for ANOTHER account, or an expired one, is ignored', async () => {
    for (const c of [cacheFor('acc_other'), cacheFor('acc_1', Date.now() - 8 * 24 * 3600_000)]) {
      vi.resetModules()
      webEdition()
      memStorage({ 'exampilot.aiAccess.v1': c })
      vi.stubGlobal('fetch', async () => new Response('x', { status: 503 }))
      const access = await import('./ai-access')
      access.setAiAccount('acc_1')
      await access.refreshAiAccess(true)
      expect(access.getAiAccess().state).toBe('unknown')
    }
  })

  it('Access session expired (redirect) → issue session; timeout → issue timeout; recovery clears the notice', async () => {
    webEdition()
    memStorage()
    let mode: 'redirect' | 'hang' | 'ok' = 'redirect'
    vi.stubGlobal('fetch', (_u: string, init?: RequestInit) => {
      if (mode === 'redirect')
        return Promise.resolve({ type: 'opaqueredirect', status: 0, ok: false, headers: new Headers() })
      if (mode === 'hang')
        return new Promise((_r, rej) =>
          init?.signal?.addEventListener('abort', () => rej(new DOMException('a', 'AbortError'))),
        )
      return Promise.resolve(jsonRes({ ok: true, allowed: true, admin: false, configured: true, model: 'm' }))
    })
    vi.useFakeTimers()
    try {
      const access = await import('./ai-access')
      access.setAiAccount('acc_1')
      await access.refreshAiAccess(true)
      expect(access.getAiAccess()).toMatchObject({ state: 'unknown', issue: 'session' })
      mode = 'hang'
      const p = access.refreshAiAccess(true)
      await vi.advanceTimersByTimeAsync(6100)
      await p
      expect(access.getAiAccess()).toMatchObject({ state: 'unknown', issue: 'timeout' })
      mode = 'ok'
      await access.refreshAiAccess(true)
      expect(access.getAiAccess()).toMatchObject({ state: 'granted', issue: null, cached: false })
    } finally {
      vi.useRealTimers()
    }
  })

  it('explicit revocation (allowed:false) and 403 AI_FORBIDDEN clear the cached confirmation', async () => {
    webEdition()
    const m = memStorage({ 'exampilot.aiAccess.v1': cacheFor('acc_1') })
    vi.stubGlobal('fetch', async () => jsonRes({ ok: true, allowed: false, admin: false }))
    const access = await import('./ai-access')
    access.setAiAccount('acc_1')
    await access.refreshAiAccess(true)
    expect(access.getAiAccess().state).toBe('denied')
    expect(m.has('exampilot.aiAccess.v1')).toBe(false)
    m.set('exampilot.aiAccess.v1', cacheFor('acc_1'))
    access.markAiForbidden()
    expect(m.has('exampilot.aiAccess.v1')).toBe(false)
  })
})
