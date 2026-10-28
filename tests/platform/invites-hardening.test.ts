/**
 * Invite hardening: batch caps, reviewer daily quota (Beijing day, atomic),
 * typed-count confirmation, reserved test domains, revoke/resend ownership, batch revoke, audit.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.setConfig({ testTimeout: 120_000 })
import { makeHarness, HOST, type Harness } from '../sync/test-harness'
import { handlePlatform, type ProtectedEnv } from '../../worker/platform/http'
import { handlePublic } from '../../worker/platform/public'
import { _resetAiGuards } from '../../worker/ai'
import { lifecycleTick } from '../../worker/platform/core'
import { bjDayWin } from '../../worker/platform/admin'

const DAY = 86_400_000
const WELCOME = 'https://welcome.test'
const OWNER = 'owner@x.com'
const REV = 'rev@x.com'
const REV2 = 'rev2@x.com'
let H: Harness
let env: ProtectedEnv
let clock: number

beforeEach(async () => {
  H = await makeHarness()
  _resetAiGuards()
  clock = Date.UTC(2026, 9, 26, 2, 0, 0) // 10:00 Beijing
  env = {
    ...(H.env as unknown as ProtectedEnv),
    SUPER_OWNERS: OWNER,
    PLATFORM_SECRET: 'test-secret',
    PLATFORM_STAGE: 'test',
    MAIL_PROVIDER: 'outbox',
    WELCOME_URL: WELCOME,
    APP_URL: HOST,
  }
})
afterEach(async () => {
  await H.dispose()
})
const auth = () => ({ fetchJwks: async () => H.issuer.jwks })
async function api(method: string, p: string, email: string | null, body?: unknown) {
  const headers: Record<string, string> = { 'X-ExamPilot-Client': '1' }
  if (email) headers['Cf-Access-Jwt-Assertion'] = await H.issuer.token(email)
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    headers['Origin'] = HOST
  }
  const res = (await handlePlatform(
    new Request(HOST + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
    env,
    { now: () => clock, auth: auth() },
  ))!
  const text = await res.text()
  let json: any = null
  try {
    json = JSON.parse(text)
  } catch {
    json = text
  }
  return { status: res.status, json }
}
async function login(email: string) {
  const { handleApi } = await import('../../worker/api')
  await handleApi(
    new Request(HOST + '/api/sync/me', {
      headers: { 'X-ExamPilot-Sync': '1', 'Cf-Access-Jwt-Assertion': await H.issuer.token(email) },
    }),
    env as never,
    { now: () => clock, auth: auth() },
  )
}
async function setup() {
  await login(OWNER)
  for (const r of [REV, REV2]) {
    await login(r)
    expect(
      (
        await api('POST', '/api/admin/member/action', OWNER, {
          email: r,
          action: 'role',
          role: 'reviewer',
          confirm: true,
        })
      ).status,
    ).toBe(200)
  }
}
const emails = (n: number, p = 'u') => Array.from({ length: n }, (_, i) => `${p}${i}@example.edu`)
const count = async (sql: string, ...b: unknown[]) =>
  (
    await H.raw
      .prepare(sql)
      .bind(...b)
      .first<any>()
  ).n as number
const invRow = async (email: string) =>
  H.raw
    .prepare(`SELECT * FROM invites WHERE email = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`)
    .bind(email)
    .first<any>()

describe('batch caps and typed confirmation', () => {
  it('reviewer: 50 per request, super: 200; over the cap is refused whole, nothing created', async () => {
    await setup()
    const r = await api('POST', '/api/admin/invites', REV, { emails: emails(51), confirmCount: 51 })
    expect(r.status).toBe(400)
    expect(r.json.error).toBe('too_many')
    expect(await count('SELECT COUNT(*) AS n FROM invites')).toBe(0)
    expect((await api('POST', '/api/admin/invites', REV, { emails: emails(50), confirmCount: 50 })).status).toBe(200)
    expect(
      (await api('POST', '/api/admin/invites', OWNER, { emails: emails(201, 's'), confirmCount: 201 })).json.error,
    ).toBe('too_many')
    expect(
      (await api('POST', '/api/admin/invites', OWNER, { emails: emails(200, 's'), confirmCount: 200 })).status,
    ).toBe(200)
    expect(await count('SELECT COUNT(*) AS n FROM invites')).toBe(250)
  })
  it('more than 20 needs the exact typed count (server-side)', async () => {
    await setup()
    expect((await api('POST', '/api/admin/invites', REV, { emails: emails(21) })).json.error).toBe('confirm_count')
    expect((await api('POST', '/api/admin/invites', REV, { emails: emails(21), confirmCount: 20 })).json.error).toBe(
      'confirm_count',
    )
    expect(await count('SELECT COUNT(*) AS n FROM invites')).toBe(0)
    expect((await api('POST', '/api/admin/invites', REV, { emails: emails(20) })).status).toBe(200)
    expect((await api('POST', '/api/admin/invites', REV, { emails: emails(21, 'v'), confirmCount: 21 })).status).toBe(
      200,
    )
  })
})

describe('reviewer daily quota (Beijing day)', () => {
  it('200 per Beijing day; the batch that would exceed is refused whole; resets at Beijing midnight; super unlimited', async () => {
    await setup()
    for (let i = 0; i < 3; i++)
      expect(
        (await api('POST', '/api/admin/invites', REV, { emails: emails(50, 'd' + i), confirmCount: 50 })).status,
      ).toBe(200)
    expect((await api('POST', '/api/admin/invites', REV, { emails: emails(40, 'd3'), confirmCount: 40 })).status).toBe(
      200,
    ) // 190
    const over = await api('POST', '/api/admin/invites', REV, { emails: emails(11, 'd4') })
    expect(over.status).toBe(429)
    expect(over.json.error).toBe('daily_limit')
    expect(over.json.used).toBe(190)
    expect(await count(`SELECT COUNT(*) AS n FROM invites WHERE email LIKE 'd4%'`)).toBe(0) // not truncated
    expect((await api('POST', '/api/admin/invites', REV, { emails: emails(10, 'd5') })).status).toBe(200) // exactly 200
    expect((await api('POST', '/api/admin/invites', REV, { emails: ['one@example.edu'] })).status).toBe(429)
    // another reviewer has their own quota
    expect((await api('POST', '/api/admin/invites', REV2, { emails: ['other@example.edu'] })).status).toBe(200)
    // super is not limited per day
    expect(
      (await api('POST', '/api/admin/invites', OWNER, { emails: emails(200, 'su'), confirmCount: 200 })).status,
    ).toBe(200)
    expect(
      (await api('POST', '/api/admin/invites', OWNER, { emails: emails(200, 'sv'), confirmCount: 200 })).status,
    ).toBe(200)
    // 15:59:59 UTC is still the same Beijing day; 16:00 UTC is the next one
    clock = Date.UTC(2026, 9, 26, 15, 59, 59)
    expect((await api('POST', '/api/admin/invites', REV, { emails: ['late1@example.edu'] })).status).toBe(429)
    clock = Date.UTC(2026, 9, 26, 16, 0, 0)
    expect((await api('POST', '/api/admin/invites', REV, { emails: ['late2@example.edu'] })).status).toBe(200)
  })
  it('parallel requests cannot overshoot the quota', async () => {
    await setup()
    for (let i = 0; i < 3; i++)
      await api('POST', '/api/admin/invites', REV, { emails: emails(50, 'p' + i), confirmCount: 50 })
    // 150 used; 4 parallel batches of 20 → at most 2 fit (40 ≤ 50, 60 > 50)
    const rs = await Promise.all(
      [0, 1, 2, 3].map((k) => api('POST', '/api/admin/invites', REV, { emails: emails(20, 'q' + k) })),
    )
    const okN = rs.filter((r) => r.status === 200).length
    expect(okN).toBe(2)
    expect(rs.filter((r) => r.status === 429)).toHaveLength(2)
    const created = await count(`SELECT COUNT(*) AS n FROM invites WHERE created_by = ?`, REV)
    expect(created).toBe(190)
    const used = await H.raw
      .prepare('SELECT n FROM rate_buckets WHERE key = ? AND win = ?')
      .bind('invite_day:' + REV, bjDayWin(clock))
      .first<any>()
    expect(used.n).toBe(190)
  })
  it('entries that are not created (duplicates, members, reserved) do not consume quota', async () => {
    await setup()
    await api('POST', '/api/admin/invites', REV, { emails: ['dup@example.edu'] })
    await api('POST', '/api/admin/invites', REV, { emails: ['dup@example.edu', 'x@a.invalid', 'new@example.edu'] })
    const used = await H.raw
      .prepare('SELECT n FROM rate_buckets WHERE key = ? AND win = ?')
      .bind('invite_day:' + REV, bjDayWin(clock))
      .first<any>()
    expect(used.n).toBe(2)
  })
})

describe('reserved test domains', () => {
  it('refused with reserved_email at the normal entry; lookalike real domains are fine', async () => {
    await setup()
    const bad = [
      'a@b.invalid',
      'a@lab.exampilot.invalid',
      'a@x.test',
      'a@x.example',
      'a@example.com',
      'a@sub.example.net',
      'a@example.org',
      'a@dev.localhost',
    ]
    const good = ['a@myexample.com', 'a@example.com.cn', 'a@testing.io', 'a@invalid-mail.com', 'a@examples.org']
    const r = await api('POST', '/api/admin/invites', OWNER, { emails: [...bad, ...good] })
    expect(r.status).toBe(200)
    const by = Object.fromEntries(r.json.results.map((x: any) => [x.email, x]))
    for (const e of bad) expect(by[e].reason).toBe('reserved_email')
    for (const e of good) expect(by[e].ok).toBe(true)
    expect(await count(`SELECT COUNT(*) AS n FROM invites`)).toBe(good.length)
    expect(await count(`SELECT COUNT(*) AS n FROM mail_outbox WHERE template = 'invite'`)).toBe(good.length)
  })
  it('an old reserved-domain invite (revoked) cannot be resent or re-invited by anyone', async () => {
    await setup()
    await H.raw
      .prepare(
        `INSERT INTO invites (id, email, token_hash, status, created_by, created_at, expires_at, version) VALUES ('inv_old', 'wb1@example.invalid', 'h1', 'revoked', ?, ?, ?, 2)`,
      )
      .bind(REV, clock - DAY, clock + 6 * DAY)
      .run()
    for (const who of [REV, OWNER]) {
      const r = await api('POST', '/api/admin/invites/resend', who, { id: 'inv_old' })
      expect(r.status).toBe(409)
      expect(r.json.error).toBe('reserved_email')
    }
    const row = await H.raw.prepare(`SELECT status, version FROM invites WHERE id = 'inv_old'`).first<any>()
    expect(row).toEqual({ status: 'revoked', version: 2 })
    expect(await count(`SELECT COUNT(*) AS n FROM invites WHERE email = 'wb1@example.invalid'`)).toBe(1)
  })
})

describe('revoke / resend ownership', () => {
  it('reviewer revokes only own pending invites; super revokes any', async () => {
    await setup()
    await api('POST', '/api/admin/invites', REV, { emails: ['r1@example.edu'] })
    await api('POST', '/api/admin/invites', REV2, { emails: ['r2@example.edu'] })
    const i1 = await invRow('r1@example.edu')
    const i2 = await invRow('r2@example.edu')
    const x = await api('POST', '/api/admin/invites/revoke', REV, { id: i2.id })
    expect(x.status).toBe(403)
    expect((await invRow('r2@example.edu')).status).toBe('pending')
    expect((await api('POST', '/api/admin/invites/revoke', REV, { id: i1.id, version: i1.version })).json.changed).toBe(
      true,
    )
    expect((await api('POST', '/api/admin/invites/revoke', OWNER, { id: i2.id })).json.changed).toBe(true)
    // stale version
    await api('POST', '/api/admin/invites', REV, { emails: ['r3@example.edu'] })
    const i3 = await invRow('r3@example.edu')
    expect((await api('POST', '/api/admin/invites/revoke', REV, { id: i3.id, version: i3.version + 5 })).status).toBe(
      409,
    )
    expect(await count(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'invite.revoke'`)).toBe(2)
  })
  it('expired: reviewer may resend own, not others; revoked: only super re-invites, old token stays dead', async () => {
    await setup()
    await api('POST', '/api/admin/invites', REV, { emails: ['e1@example.edu'] })
    await api('POST', '/api/admin/invites', REV2, { emails: ['e2@example.edu'] })
    clock += 7 * DAY + 1
    await lifecycleTick(env, clock)
    const e1 = await invRow('e1@example.edu')
    const e2 = await invRow('e2@example.edu')
    expect(e1.status).toBe('expired')
    expect((await api('POST', '/api/admin/invites/resend', REV, { id: e2.id })).status).toBe(403)
    const ok = await api('POST', '/api/admin/invites/resend', REV, { id: e1.id })
    expect(ok.status).toBe(200)
    expect(ok.json.kind).toBe('resend_expired')
    // revoked → reviewer refused (even own), super allowed; old row stays revoked
    const fresh = await invRow('e1@example.edu')
    await api('POST', '/api/admin/invites/revoke', REV, { id: fresh.id })
    const rv = await api('POST', '/api/admin/invites/resend', REV, { id: fresh.id })
    expect(rv.status).toBe(403)
    const sv = await api('POST', '/api/admin/invites/resend', OWNER, { id: fresh.id })
    expect(sv.status).toBe(200)
    expect(sv.json.kind).toBe('reinvite_revoked')
    const old = await H.raw.prepare('SELECT status FROM invites WHERE id = ?').bind(fresh.id).first<any>()
    expect(old.status).toBe('revoked')
    // the old (revoked) invite's token cannot be accepted
    const tokOld = await H.raw
      .prepare(`SELECT params FROM mail_outbox WHERE dedupe_key = ?`)
      .bind('invite:' + fresh.id)
      .first<any>()
    const pub = publicClient()
    await verify(pub, 'e1@example.edu')
    expect((await pub('POST', '/api/public/invite/accept', { token: JSON.parse(tokOld.params).token })).status).toBe(
      410,
    )
    const actions = (
      await H.raw.prepare(`SELECT action FROM audit_log WHERE action LIKE 'invite.re%' ORDER BY id`).all<any>()
    ).results.map((r: any) => r.action)
    expect(actions).toEqual(['invite.resend_expired', 'invite.revoke', 'invite.reinvite_revoked'])
  })
})

describe('batch revoke', () => {
  it('needs typed count, checks ownership and version per item, audits each and the batch', async () => {
    await setup()
    await api('POST', '/api/admin/invites', REV, { emails: ['b1@example.edu', 'b2@example.edu', 'b3@example.edu'] })
    await api('POST', '/api/admin/invites', REV2, { emails: ['c1@example.edu'] })
    const rows = await Promise.all(['b1@example.edu', 'b2@example.edu', 'b3@example.edu', 'c1@example.edu'].map(invRow))
    const items = rows.map((r) => ({ id: r.id, version: r.version }))
    items[2].version += 1 // stale
    expect((await api('POST', '/api/admin/invites/revoke-batch', REV, { items })).json.error).toBe('confirm_count')
    const r = await api('POST', '/api/admin/invites/revoke-batch', REV, { items, confirmCount: 4 })
    expect(r.status).toBe(200)
    expect(r.json.revoked).toBe(2)
    const reasons = Object.fromEntries(r.json.results.map((x: any) => [x.id, x.reason ?? 'ok']))
    expect(reasons[rows[2].id]).toBe('stale_version')
    expect(reasons[rows[3].id]).toBe('forbidden')
    expect((await invRow('c1@example.edu')).status).toBe('pending')
    expect(await count(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'invite.revoke'`)).toBe(2)
    expect(await count(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'invite.revoke_batch'`)).toBe(1)
    expect(
      (
        await api('POST', '/api/admin/invites/revoke-batch', REV, {
          items: Array.from({ length: 51 }, (_, i) => ({ id: 'x' + i, version: 1 })),
          confirmCount: 51,
        })
      ).json.error,
    ).toBe('too_many')
    // a plain user has no admin route at all
    await login('plain@x.com')
    expect(
      (await api('POST', '/api/admin/invites/revoke-batch', 'plain@x.com', { items: items.slice(3), confirmCount: 1 }))
        .status,
    ).toBe(403)
  })
})

describe('business rules kept', () => {
  it('a manual invite grants nothing until the invited address verifies and accepts', async () => {
    await setup()
    await api('POST', '/api/admin/invites', REV, { emails: ['m1@example.edu'] })
    expect(await count(`SELECT COUNT(*) AS n FROM members WHERE email = 'm1@example.edu'`)).toBe(0)
    const inv = await invRow('m1@example.edu')
    expect(inv.expires_at - inv.created_at).toBe(7 * DAY)
  })
})

/* public client (welcome) */
function publicClient() {
  let cookie = ''
  return async (method: string, p: string, body?: unknown) => {
    const headers: Record<string, string> = { 'CF-Connecting-IP': '203.0.113.9' }
    if (cookie) headers.Cookie = cookie
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json'
      headers.Origin = WELCOME
      headers['X-ExamPilot-Public'] = '1'
    }
    const res = await handlePublic(
      new Request(WELCOME + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
      env,
      { now: () => clock },
    )
    const sc = res.headers.get('Set-Cookie')
    if (sc) cookie = sc.split(';')[0]
    return { status: res.status, json: (await res.json()) as any }
  }
}
async function verify(pub: ReturnType<typeof publicClient>, email: string, purpose = 'invite') {
  expect((await pub('POST', '/api/public/otp', { email, purpose })).status).toBe(200)
  const r = await H.raw
    .prepare(
      `SELECT params FROM mail_outbox WHERE to_email = ? AND template = 'otp' ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .bind(email)
    .first<{ params: string }>()
  expect((await pub('POST', '/api/public/verify', { email, code: JSON.parse(r!.params).code })).status).toBe(200)
}

describe('lab applications (staging test data) stay isolated when a reviewer decides them', () => {
  it('approve → lab member only, never touches the Access API, its mail is dead (test_address)', async () => {
    await setup()
    const e = 'lab-123456-a1@lab.exampilot.invalid'
    await H.raw
      .prepare(
        `INSERT INTO applications (id, email, note, status, created_at, version) VALUES ('app_lab123456_a1', ?, '【测试数据】', 'pending', ?, 1)`,
      )
      .bind(e, clock)
      .run()
    const calls: string[] = []
    env = { ...env, CF_ACCESS_TOKEN: 't', ACCESS_ACCOUNT_ID: 'acc', ACCESS_POLICY_ID: 'pol' } as ProtectedEnv
    const orig = globalThis.fetch
    globalThis.fetch = (async (u: RequestInfo | URL) => {
      calls.push(String(u))
      return new Response('{}', { status: 500 })
    }) as typeof fetch
    try {
      const r = await api('POST', '/api/admin/applications/decide', REV, {
        items: [{ id: 'app_lab123456_a1', version: 1 }],
        decision: 'approve',
      })
      expect(r.json.results[0].ok).toBe(true)
      const again = await api('POST', '/api/admin/applications/decide', REV, {
        items: [{ id: 'app_lab123456_a1', version: 1 }],
        decision: 'approve',
      })
      expect(again.json.results[0].reason).toBe('already_decided')
      await new Promise((res) => setTimeout(res, 300))
    } finally {
      globalThis.fetch = orig
    }
    expect(calls.filter((u) => u.includes('cloudflare.com'))).toHaveLength(0)
    const m = await H.raw.prepare('SELECT status, access_state FROM members WHERE email = ?').bind(e).first<any>()
    expect(m.status).toBe('active')
    const { drainOutbox } = await import('../../worker/platform/mail')
    await drainOutbox(env, clock)
    const o = await H.raw.prepare(`SELECT status, last_error FROM mail_outbox WHERE to_email = ?`).bind(e).all<any>()
    expect(o.results.length).toBeGreaterThan(0)
    for (const x of o.results) expect([x.status, x.last_error]).toEqual(['dead', 'test_address'])
  })
})
