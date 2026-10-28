/**
 * Revocation vs. live Access sessions (2026-10-26): a still-valid Access JWT must not reach the
 * question-bank static files, /api/version or the learning APIs once the member lost access.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.setConfig({ testTimeout: 60_000 })
import { makeHarness, TEAM, AUD, type Harness } from '../sync/test-harness'
import worker, { staticGate } from '../../worker/entry'
import { deletedTag } from '../../worker/platform/core'
import { syncAccess } from '../../worker/platform/access'
import { FILES } from '../../worker/assets.generated.js'

const OWNER = 'owner@x.com'
let H: Harness
let env: any
const realFetch = globalThis.fetch
beforeEach(async () => {
  H = await makeHarness()
  env = {
    ...H.env,
    SUPER_OWNERS: OWNER,
    PLATFORM_SECRET: 's',
    PLATFORM_STAGE: 'test',
    MAIL_PROVIDER: 'outbox',
    WELCOME_URL: 'https://w.test',
    APP_URL: 'https://app.test',
  }
  // the Worker fetches the team's JWKS itself
  globalThis.fetch = (async (u: RequestInfo | URL, init?: RequestInit) =>
    String(u) === `${TEAM}/cdn-cgi/access/certs`
      ? new Response(JSON.stringify(H.issuer.jwks))
      : realFetch(u as never, init)) as typeof fetch
})
afterEach(async () => {
  globalThis.fetch = realFetch
  await H.dispose()
})
const now = Date.now()
async function member(email: string, status = 'active', accStatus: string | null = null) {
  let acc: string | null = null
  if (accStatus) {
    acc = 'acc_' + email.split('@')[0]
    await H.raw
      .prepare(`INSERT INTO accounts (id, created_at, bank_fp, status) VALUES (?, ?, 'fp-test', ?)`)
      .bind(acc, now, accStatus)
      .run()
  }
  await H.raw
    .prepare(
      `INSERT INTO members (email, account_id, role, status, source, created_at, status_at) VALUES (?, ?, 'user', ?, 'invite', ?, ?)`,
    )
    .bind(email, acc, status, now, now)
    .run()
}
const setStatus = (email: string, s: string) =>
  H.raw.prepare('UPDATE members SET status = ? WHERE email = ?').bind(s, email).run()
async function get(
  p: string,
  email: string | null,
  headers: Record<string, string> = {},
  host = 'https://app-staging.getexampilot.site',
) {
  const h: Record<string, string> = { ...headers }
  if (email) h['Cf-Access-Jwt-Assertion'] = await H.issuer.token(email)
  return worker.fetch(new Request(host + p, { headers: h }), env)
}
const ASSET = () =>
  Object.keys(FILES as Record<string, string>).find((k: string) => k.startsWith('/assets/') && k.endsWith('.js'))!

describe('staticGate: current standing, not just the token', () => {
  it('maps every member state; unknown-but-never-deleted = allowed like the API gate; DB failure = closed', async () => {
    const x = { fetchJwks: async () => H.issuer.jwks }
    const req = async (e: string) =>
      new Request('https://app.test/', { headers: { 'Cf-Access-Jwt-Assertion': await H.issuer.token(e) } })
    await member('ok@x.com')
    await member('okacc@x.com', 'active', 'active')
    await member('rev@x.com', 'revoked')
    await member('clo@x.com', 'closing')
    await member('del@x.com', 'deleted')
    await member('accoff@x.com', 'active', 'disabled')
    await H.raw
      .prepare(
        `INSERT INTO deletion_log (id, email_hash, account_id, reason, deleted_at) VALUES ('d1', ?, NULL, 'self_close', ?)`,
      )
      .bind(await deletedTag('gone@x.com'), now)
      .run()
    const v = async (e: string) => {
      const r = await staticGate(await req(e), env, x)
      return r.ok ? 'ok' : r.code
    }
    expect(await v('ok@x.com')).toBe('ok')
    expect(await v('okacc@x.com')).toBe('ok')
    expect(await v('rev@x.com')).toBe('ACCOUNT_REVOKED')
    expect(await v('clo@x.com')).toBe('ACCOUNT_CLOSING')
    expect(await v('del@x.com')).toBe('ACCOUNT_DELETED')
    expect(await v('accoff@x.com')).toBe('ACCOUNT_REVOKED')
    expect(await v('gone@x.com')).toBe('ACCOUNT_DELETED')
    expect(await v('handadded@x.com')).toBe('ok')
    expect(await v(OWNER)).toBe('ok')
    // no token / foreign audience
    expect((await staticGate(new Request('https://app.test/'), env, x)).ok).toBe(false)
    const foreign = new Request('https://app.test/', {
      headers: { 'Cf-Access-Jwt-Assertion': await H.issuer.token('ok@x.com', { aud: ['other'] }) },
    })
    expect(await staticGate(foreign, env, x)).toEqual({ ok: false, status: 401, code: 'SESSION' })
    const forged = new Request('https://app.test/', {
      headers: {
        'Cf-Access-Jwt-Assertion': await H.issuer.sign(
          { aud: [AUD], email: 'ok@x.com', exp: 9e9, iss: TEAM },
          { key: H.issuer.otherKey },
        ),
      },
    })
    expect((await staticGate(forged, env, x)).ok).toBe(false)
    const expired = new Request('https://app.test/', {
      headers: {
        'Cf-Access-Jwt-Assertion': await H.issuer.token('ok@x.com', { exp: Math.floor(Date.now() / 1000) - 3600 }),
      },
    })
    expect((await staticGate(expired, env, x)).ok).toBe(false)
    expect((await staticGate(await req('ok@x.com'), { ...env, ACCESS_AUD: '' }, x)).ok).toBe(false) // unconfigured = closed
    // database down → refuse, never fall back to the token alone
    const broken = {
      ...env,
      DB: {
        prepare: () => {
          throw new Error('D1 down')
        },
      },
    }
    expect(await staticGate(await req('ok@x.com'), broken, x)).toEqual({ ok: false, status: 503, code: 'DB' })
    // the gate never writes
    expect(
      (await H.raw.prepare(`SELECT COUNT(*) AS n FROM members WHERE email = 'handadded@x.com'`).first<any>()).n,
    ).toBe(0)
  })
})

describe('Worker: static bank, /api/version and APIs after revocation (same live JWT)', () => {
  for (const host of ['https://app-staging.getexampilot.site', 'https://exampilot-sync-staging.example.workers.dev']) {
    it(`revoked / closing lose access at once on ${new URL(host).host}; caching revalidates through the gate`, async () => {
      await member('stu@x.com')
      const tok = await H.issuer.token('stu@x.com') // one session for the whole test
      const g = (p: string, extra: Record<string, string> = {}) =>
        worker.fetch(new Request(host + p, { headers: { 'Cf-Access-Jwt-Assertion': tok, ...extra } }), env)
      const asset = ASSET()
      const r1 = await g('/')
      expect(r1.status).toBe(200)
      expect(r1.headers.get('cache-control')).toBe('private, no-cache')
      const a1 = await g(asset)
      expect(a1.status).toBe(200)
      const et = a1.headers.get('etag')!
      expect(et).toMatch(/^"[0-9a-f]{24}"$/)
      expect((await g(asset, { 'If-None-Match': et })).status).toBe(304)
      expect((await g('/api/version')).status).toBe(200)
      // revoke: the very same token is refused everywhere, including a conditional request (no 304)
      await setStatus('stu@x.com', 'revoked')
      for (const p of ['/', '/index.html', asset, '/api/version', '/some/deep/link']) {
        const r = await g(p)
        expect(r.status, p).toBe(403)
        expect(r.headers.get('cache-control')).toContain('no-store')
      }
      expect((await g(asset, { 'If-None-Match': et })).status).toBe(403)
      expect(JSON.parse(await (await g(asset)).text()).code).toBe('ACCOUNT_REVOKED')
      const api = await worker.fetch(
        new Request(host + '/api/sync/me', { headers: { 'Cf-Access-Jwt-Assertion': tok, 'X-ExamPilot-Sync': '1' } }),
        env,
      )
      expect(api.status).toBe(403)
      const ai = await worker.fetch(
        new Request(host + '/api/ai/status', {
          headers: { 'Cf-Access-Jwt-Assertion': tok, 'X-ExamPilot-Client': '1' },
        }),
        env,
      )
      expect(ai.status).toBe(403)
      const me = await worker.fetch(
        new Request(host + '/api/me/status', {
          headers: { 'Cf-Access-Jwt-Assertion': tok, 'X-ExamPilot-Client': '1' },
        }),
        env,
      )
      expect(me.status).toBe(403)
      // closing (self-deletion cool-down) is refused too; re-activation restores access with the same token
      await setStatus('stu@x.com', 'closing')
      expect(JSON.parse(await (await g('/api/version')).text()).code).toBe('ACCOUNT_CLOSING')
      await setStatus('stu@x.com', 'active')
      expect((await g('/')).status).toBe(200)
      expect((await g(asset, { 'If-None-Match': et })).status).toBe(304)
    })
  }
  it('an active member is never blocked; anonymous requests are refused', async () => {
    await member('fine@x.com')
    for (const p of ['/', ASSET(), '/api/version']) expect((await get(p, 'fine@x.com')).status).toBe(200)
    for (const p of ['/', ASSET(), '/api/version']) expect((await get(p, null)).status).toBe(401)
  })
  it('a deleted address with a live session is not re-created by the API gate', async () => {
    await H.raw
      .prepare(
        `INSERT INTO deletion_log (id, email_hash, account_id, reason, deleted_at) VALUES ('d2', ?, NULL, 'admin_revoke', ?)`,
      )
      .bind(await deletedTag('purged@x.com'), now)
      .run()
    const r = await H.call('GET', '/api/sync/me', { email: 'purged@x.com' })
    expect(r.status).toBe(403)
    expect(r.json.code).toBe('ACCOUNT_DELETED')
    expect((await H.raw.prepare(`SELECT COUNT(*) AS n FROM members WHERE email = 'purged@x.com'`).first<any>()).n).toBe(
      0,
    )
    expect((await get('/', 'purged@x.com')).status).toBe(403)
    // an address never deleted is still auto-admitted (hand-added to Access), as before
    expect((await H.call('GET', '/api/sync/me', { email: 'hand@x.com' })).status).toBe(200)
  })
})

describe('Access session revocation on removal (optional, organization-wide)', () => {
  function fakeCf(initial: string[]) {
    let include: any[] = initial.map((email) => ({ email: { email } }))
    const calls: string[] = []
    const f = (async (u: RequestInfo | URL, init?: RequestInit) => {
      calls.push(
        (init?.method || 'GET') + ' ' + String(u).replace('https://api.cloudflare.com/client/v4/accounts/A', ''),
      )
      if (String(u).endsWith('/revoke_user')) return new Response(JSON.stringify({ success: true, result: true }))
      if (init?.method === 'PUT') include = JSON.parse(String(init.body)).include
      return new Response(
        JSON.stringify({
          success: true,
          result: { id: 'P', name: 'Allow', decision: 'allow', include, exclude: [], require: [] },
        }),
      )
    }) as typeof fetch
    return { f, calls }
  }
  const cfEnv = (extra = {}) => ({
    ...env,
    CF_ACCESS_TOKEN: 'tok',
    ACCESS_ACCOUNT_ID: 'A',
    ACCESS_POLICY_ID: 'P',
    ...extra,
  })
  it('off by default: removal only edits the policy; on: also ends the removed user’s sessions, audited', async () => {
    for (const on of [false, true]) {
      await H.raw.prepare('DELETE FROM members').run()
      await member('gone' + on + '@x.com', 'revoked')
      await H.raw.prepare(`UPDATE members SET access_state = 'pending'`).run()
      const cf = fakeCf([OWNER, 'gone' + on + '@x.com'])
      const r = await syncAccess(cfEnv(on ? { ACCESS_REVOKE_SESSIONS: '1' } : {}), now, { fetchImpl: cf.f })
      expect(r.removed).toEqual(['gone' + on + '@x.com'])
      expect(cf.calls.filter((c) => c.includes('revoke_user'))).toHaveLength(on ? 1 : 0)
    }
    const a = await H.raw.prepare(`SELECT detail FROM audit_log WHERE action = 'access.revoke_sessions'`).all<any>()
    expect(a.results.map((x: any) => JSON.parse(x.detail))).toEqual([{ requested: 1, revoked: 1 }])
  })
})
