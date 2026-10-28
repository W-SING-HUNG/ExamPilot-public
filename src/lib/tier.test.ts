import { afterEach, describe, expect, it, vi } from 'vitest'
import { validateOp } from '../sync/protocol'
import { foldLog } from '../sync/fold'

/**
 * Standard / Pro identity (web edition): derived only from the server's
 * /api/ai/status answer, mirrored on <html data-tier>, never upgraded without it.
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
  const dataset: Record<string, string> = {}
  vi.stubGlobal('window', { addEventListener: () => {} })
  vi.stubGlobal('document', { addEventListener: () => {}, visibilityState: 'visible', documentElement: { dataset } })
  return dataset
}
const jsonRes = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } })

describe('tier', () => {
  it('starts pending (neutral) and becomes pro only when the server says allowed', async () => {
    const ds = webEdition()
    let answer: (r: Response) => void = () => {}
    vi.stubGlobal('fetch', () => new Promise<Response>((r) => (answer = r)))
    const a = await import('./ai-access')
    expect(ds.tier).toBe('pending')
    expect(a.tierOf(a.getAiAccess())).toBe('pending')
    answer(jsonRes({ ok: true, allowed: true, admin: false, configured: true }))
    await a.refreshAiAccess(true)
    await new Promise((r) => setTimeout(r, 0))
    expect(ds.tier).toBe('pro')
  })

  it('admin without a grant is standard (admin and Pro are independent)', async () => {
    const ds = webEdition()
    vi.stubGlobal('fetch', async () => jsonRes({ ok: true, allowed: false, admin: true }))
    const a = await import('./ai-access')
    await a.refreshAiAccess(true)
    expect(ds.tier).toBe('standard')
    expect(a.getAiAccess().admin).toBe(true)
  })

  it('network failure or a non-JSON (Access login) page never yields pro', async () => {
    const ds = webEdition()
    vi.stubGlobal(
      'fetch',
      async () => new Response('<html>login</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }),
    )
    const a = await import('./ai-access')
    await a.refreshAiAccess(true)
    expect(ds.tier).toBe('standard')
    vi.resetModules()
    const ds2 = webEdition()
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('offline')
    })
    const b = await import('./ai-access')
    await b.refreshAiAccess(true)
    expect(ds2.tier).toBe('standard')
  })

  it('a server refusal after grant drops back to standard at once', async () => {
    const ds = webEdition()
    vi.stubGlobal('fetch', async () => jsonRes({ ok: true, allowed: true }))
    const a = await import('./ai-access')
    await a.refreshAiAccess(true)
    expect(ds.tier).toBe('pro')
    a.markAiForbidden()
    expect(ds.tier).toBe('standard')
  })
})

describe('proWelcomed setting (synced, one-time Pro welcome)', () => {
  const op = (patch: unknown) => ({ id: 'op-1', kind: 'settings', body: { patch }, createdAt: 1, epoch: 1 })
  it('accepts a boolean, refuses anything else', () => {
    expect(validateOp(op({ proWelcomed: true }))).toBeNull()
    expect(validateOp(op({ proWelcomed: 'yes' }))).toBe('bad proWelcomed')
  })
  it('defaults to false (an account that never saw the welcome)', () => {
    expect(foldLog([]).settings.proWelcomed).toBe(false)
  })
})
