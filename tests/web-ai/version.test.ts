import { describe, expect, it } from 'vitest'
import { versionResponse } from '../../worker/entry'

describe('GET /api/version (read-only build identity)', () => {
  it('returns only version id/tag, commit and build time — never config or secrets', async () => {
    const env = {
      CF_VERSION: { id: '00000000-0000-4000-8000-000000000000', tag: '' },
      BUILD_COMMIT: 'abc1234',
      BUILD_TIME: String(Date.UTC(2026, 9, 25, 9, 0, 0)),
      AI_API_KEY: 'sk-secret',
      AI_BASE_URL: 'https://gw.example/v1',
      ACCESS_AUD: 'aud',
    }
    const r = versionResponse(env)
    expect(r.headers.get('content-type')).toContain('application/json')
    expect(r.headers.get('cache-control')).toContain('no-store')
    const j = await r.json()
    expect(j).toEqual({
      ok: true,
      version: '00000000-0000-4000-8000-000000000000',
      tag: null,
      commit: 'abc1234',
      builtAt: '2026-10-25T09:00:00.000Z',
    })
    const text = JSON.stringify(j)
    for (const bad of ['sk-secret', 'gw.example', 'aud']) expect(text).not.toContain(bad)
  })
})
