/** Staging lifecycle lab: isolated accounts + simulated time, real lifecycle code. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeHarness, HOST, type Harness } from '../sync/test-harness'
import { handlePlatform, runCron, type ProtectedEnv } from '../../worker/platform/http'
import { syncAccess } from '../../worker/platform/access'
import { drainOutbox, enqueueMail } from '../../worker/platform/mail'

const DAY = 86_400_000
const OWNER = 'owner@x.com'
let H: Harness
let env: ProtectedEnv
let clock: number
beforeEach(async () => {
  H = await makeHarness()
  clock = Date.UTC(2026, 9, 26, 2, 0, 0)
  env = {
    ...(H.env as unknown as ProtectedEnv),
    SUPER_OWNERS: OWNER,
    PLATFORM_SECRET: 's',
    PLATFORM_STAGE: 'staging',
    MAIL_PROVIDER: 'outbox',
    WELCOME_URL: 'https://w.test',
    APP_URL: HOST,
  }
})
afterEach(async () => H.dispose())
const auth = () => ({ fetchJwks: async () => H.issuer.jwks })
async function lab(email: string, body: Record<string, unknown>, stage = 'staging') {
  const headers: Record<string, string> = {
    'X-ExamPilot-Client': '1',
    'Content-Type': 'application/json',
    Origin: HOST,
    'Cf-Access-Jwt-Assertion': await H.issuer.token(email),
  }
  const res = (await handlePlatform(
    new Request(HOST + '/api/admin/test/lab', { method: 'POST', headers, body: JSON.stringify(body) }),
    { ...env, PLATFORM_STAGE: stage } as ProtectedEnv,
    { now: () => clock, auth: auth() },
  ))!
  return { status: res.status, json: (await res.json()) as any }
}
const q = (sql: string, ...a: unknown[]) =>
  env.DB.prepare(sql)
    .bind(...a)
    .all<any>()
    .then((r) => r.results)

describe('lifecycle lab', () => {
  it('only super on staging; real accounts untouched; every rule fires as expected', async () => {
    // a real (non-lab) member that must not be affected
    await env.DB.prepare(
      `INSERT INTO members (email, role, status, source, created_at, last_login_at) VALUES ('real@x.com','user','active','legacy',?,?)`,
    )
      .bind(clock - 300 * DAY, clock - 300 * DAY)
      .run()
    await env.DB.prepare(
      `INSERT INTO members (email, role, status, source, created_at) VALUES ('rev@x.com','user','active','legacy',?)`,
    )
      .bind(clock)
      .run()
    expect((await lab('rev@x.com', { op: 'scenarios' })).status).toBe(403)
    expect((await lab(OWNER, { op: 'scenarios' }, 'production')).status).toBe(404)
    const seed = await lab(OWNER, { op: 'seed' })
    expect(seed.json.ok).toBe(true)
    const run = seed.json.run
    const tick = await lab(OWNER, { op: 'tick', runs: [run] })
    expect(tick.json.ok).toBe(true)
    const st = (await lab(OWNER, { op: 'status', runs: [run] })).json
    const by = Object.fromEntries(st.members.map((m: any) => [m.scenario, m]))
    expect(st.purged.map((x: any) => x.email)).toEqual([expect.stringContaining('del7-due')])
    expect(by['del6'].status).toBe('revoked')
    expect(st.notices.some((n: any) => n.kind === 'delete_soon')).toBe(true)
    expect(by['inactive-warn'].inactive_warned_at).toBe(clock)
    expect(by['inactive-warn'].mail.map((m: any) => m.template)).toEqual(['inactive_warn'])
    expect(by['inactive-warn'].mail[0]).toMatchObject({ status: 'dead', last_error: 'test_address' })
    expect(by['inactive-stop']).toMatchObject({
      status: 'revoked',
      delete_reason: 'inactive',
      delete_after: clock + 7 * DAY,
    })
    expect(by['inactive-fresh'].inactive_warned_at).toBeNull()
    expect(by['retain'].status).toBe('active')
    expect(by['retain'].inactive_warned_at).toBeNull()
    expect(by['pro-3d'].mail.map((m: any) => m.template)).toEqual(['pro_remind3'])
    expect(by['pro-1d'].mail.map((m: any) => m.template)).toEqual(['pro_remind1'])
    expect(by['pro-expired'].pro.tier).toBe('standard')
    expect(by['pro-expired'].mail.map((m: any) => m.template)).toEqual(['pro_expired'])
    expect(by['pro-perm'].pro).toMatchObject({ tier: 'pro', permanent: 1 })
    expect(by['pro-perm'].mail).toEqual([])
    // idempotent
    await lab(OWNER, { op: 'tick', runs: [run] })
    const st2 = (await lab(OWNER, { op: 'status', runs: [run] })).json
    expect(st2.members.reduce((a: number, m: any) => a + m.mail.length, 0)).toBe(
      st.members.reduce((a: number, m: any) => a + m.mail.length, 0),
    )
    // shift: del6 lives one more day -> deleted
    const del6 = by['del6'].email
    expect((await lab(OWNER, { op: 'shift', email: 'real@x.com', days: 1 })).json.error).toBe('not_lab')
    expect((await lab(OWNER, { op: 'shift', email: del6, days: 1 })).json.ok).toBe(true)
    await lab(OWNER, { op: 'tick', runs: [run] })
    const st3 = (await lab(OWNER, { op: 'status', runs: [run] })).json
    expect(st3.purged.length).toBe(2)
    // real member (300 days inactive) untouched by the scoped lab tick
    const real = (await q(`SELECT status, inactive_warned_at FROM members WHERE email='real@x.com'`))[0]
    expect(real).toEqual({ status: 'active', inactive_warned_at: null })
    // clear removes all lab rows
    await lab(OWNER, { op: 'clear', runs: [run] })
    expect((await q(`SELECT COUNT(*) n FROM members WHERE email LIKE '%@lab.exampilot.invalid'`))[0].n).toBe(0)
    expect((await q(`SELECT COUNT(*) n FROM pro_grants WHERE email LIKE 'lab-%'`))[0].n).toBe(0)
  })

  it('mail to reserved/test domains is never handed to the provider, even with Brevo on', async () => {
    let calls = 0
    const f = (async () => {
      calls++
      return new Response('{"messageId":"x"}', { status: 201 })
    }) as typeof fetch
    const e2 = {
      ...env,
      MAIL_PROVIDER: 'brevo',
      BREVO_API_KEY: 'k',
      MAIL_FROM: 'a@b.com',
      MAIL_SEND_AFTER: '1700000000001',
      MAIL_ALLOWLIST: 'real@students.school',
    } as ProtectedEnv
    await enqueueMail(e2, 'loadtest-0001@example.invalid', 'apply_received', {}, 'k1', clock)
    await enqueueMail(e2, 'x@lab.exampilot.invalid', 'pro_remind3', { until: clock }, 'k2', clock)
    await enqueueMail(e2, 'a@example.com', 'apply_received', {}, 'k3', clock)
    await enqueueMail(e2, 'real@students.school', 'pro_remind3', { until: clock }, 'k4', clock)
    await drainOutbox(e2, clock, { fetchImpl: f })
    const rows = await q(`SELECT to_email, status FROM mail_outbox ORDER BY to_email`)
    expect(rows, JSON.stringify(rows)).toHaveLength(4)
    expect(calls, JSON.stringify(await q(`SELECT to_email, status, last_error FROM mail_outbox`))).toBe(1)
    expect(rows.filter((r: any) => r.status === 'dead').length).toBe(3)
  })

  it('reserved-domain members never reach the Access policy; missing Pro projections are backfilled', async () => {
    await env.DB.prepare(
      `INSERT INTO members (email, role, status, source, created_at, access_state) VALUES ('x@lab.exampilot.invalid','user','active','invite',?,'pending')`,
    )
      .bind(clock)
      .run()
    const r = await syncAccess(
      { ...env, CF_ACCESS_TOKEN: 't', ACCESS_ACCOUNT_ID: 'a', ACCESS_POLICY_ID: 'p' } as never,
      clock,
      {
        fetchImpl: (async () => {
          throw new Error('must not call')
        }) as never,
      },
    )
    expect(r.ran).toBe(false)
    expect((await q(`SELECT access_state FROM members WHERE email='x@lab.exampilot.invalid'`))[0].access_state).toBe(
      'ok',
    )
    await env.DB.prepare(
      `INSERT INTO members (email, role, status, source, created_at) VALUES ('p@x.com','user','active','legacy',?)`,
    )
      .bind(clock)
      .run()
    await env.DB.prepare(
      `INSERT INTO pro_grants (id, email, source, kind, duration_ms, starts_at, state, created_by, created_at) VALUES ('g1','p@x.com','legacy','permanent',0,?,'active','m',?)`,
    )
      .bind(clock, clock)
      .run()
    await runCron(env, clock)
    expect((await q(`SELECT tier, permanent FROM pro_state WHERE email='p@x.com'`))[0]).toMatchObject({
      tier: 'pro',
      permanent: 1,
    })
  })
})

describe('lab clear scope', () => {
  it('clears only the named runs; other lab rows (e.g. an approved LABAPP member) and real members stay', async () => {
    const a = (await lab(OWNER, { op: 'seed' })).json.run
    const b = (await lab(OWNER, { op: 'seed' })).json.run
    await env.DB.prepare(
      `INSERT INTO members (email, role, status, source, created_at) VALUES ('lab-645762-a1@lab.exampilot.invalid','user','active','application',?)`,
    )
      .bind(clock)
      .run()
    await env.DB.prepare(
      `INSERT INTO members (email, role, status, source, created_at) VALUES ('real@x.com','user','active','legacy',?)`,
    )
      .bind(clock)
      .run()
    expect((await lab(OWNER, { op: 'clear' })).json.removed).toBe(0) // no runs: nothing
    const r = (await lab(OWNER, { op: 'clear', runs: [a] })).json
    expect(r.ok).toBe(true)
    const left = (await q(`SELECT email FROM members ORDER BY email`)).map((x: any) => x.email)
    expect(left.filter((e: string) => e.startsWith(`lab-${a}-`))).toEqual([])
    expect(left.filter((e: string) => e.startsWith(`lab-${b}-`)).length).toBe(10)
    expect(left).toContain('lab-645762-a1@lab.exampilot.invalid')
    expect(left).toContain('real@x.com')
  }, 30_000)
})

import { verifyTurnstile } from '../../worker/platform/public'
describe('lab tick isolation', () => {
  it('a scoped lab tick never touches real members, other runs or the shared queue; the cron is unchanged', async () => {
    const ins = (email: string, f: string, ...a: unknown[]) =>
      env.DB.prepare(
        `INSERT INTO members (email, role, status, source, created_at${f}) VALUES (?, 'user', ?, 'legacy', ?${a.length > 2 ? ', ?'.repeat(a.length - 2) : ''})`,
      )
        .bind(email, ...a)
        .run()
    // real members, each one a tick away from a lifecycle action
    await env.DB.prepare(
      `INSERT INTO members (email, role, status, source, created_at, last_login_at) VALUES ('due-pro@x.com','user','active','legacy',?,?)`,
    )
      .bind(clock - 40 * DAY, clock - DAY)
      .run()
    await env.DB.prepare(
      `INSERT INTO pro_grants (id, email, source, kind, duration_ms, starts_at, state, created_by, created_at) VALUES ('gp','due-pro@x.com','admin','days',?,?,'active','m',?)`,
    )
      .bind(30 * DAY, clock - 30 * DAY - 3_600_000, clock - 30 * DAY)
      .run()
    await runCron(env, clock - 2 * DAY) // build its Pro projection only
    await ins(
      'due-delete@x.com',
      ', status_at, delete_after, delete_reason',
      'revoked',
      clock - 30 * DAY,
      clock - 8 * DAY,
      clock - DAY,
      'admin_revoke',
    )
    await ins(
      'due-soon@x.com',
      ', status_at, delete_after, delete_reason',
      'revoked',
      clock - 30 * DAY,
      clock - 6 * DAY,
      clock + 3_600_000,
      'admin_revoke',
    )
    await ins('due-warn@x.com', ', last_login_at', 'active', clock - 400 * DAY, clock - 170 * DAY)
    await ins(
      'due-stop@x.com',
      ', last_login_at, inactive_warned_at',
      'active',
      clock - 400 * DAY,
      clock - 200 * DAY,
      clock - 31 * DAY,
    )
    await env.DB.prepare(
      `INSERT INTO invites (id, email, token_hash, status, created_by, created_at, expires_at) VALUES ('iv','inv@x.com','h','pending','m',?,?)`,
    )
      .bind(clock - 9 * DAY, clock - DAY)
      .run()
    await enqueueMail(env, 'someone@example.edu', 'apply_received', {}, 'real-held', clock)
    await env.DB.prepare(
      `UPDATE mail_outbox SET status='held', last_error='mail_not_configured' WHERE to_email='someone@example.edu'`,
    ).run()
    const snap = async () =>
      JSON.stringify([
        await q(`SELECT * FROM members WHERE email LIKE 'due-%' ORDER BY email`),
        await q(`SELECT * FROM pro_state WHERE email NOT LIKE '%@lab.exampilot.invalid' ORDER BY email`),
        await q(`SELECT * FROM invites ORDER BY id`),
        await q(
          `SELECT id, status, last_error FROM mail_outbox WHERE to_email NOT LIKE '%@lab.exampilot.invalid' ORDER BY id`,
        ),
        await q(`SELECT * FROM admin_notices WHERE body NOT LIKE '%.invalid%' ORDER BY id`),
      ])
    const before = await snap()
    const a = (await lab(OWNER, { op: 'seed' })).json.run
    const b = (await lab(OWNER, { op: 'seed' })).json.run
    // refusals
    expect((await lab(OWNER, { op: 'tick' })).json.error).toBe('runs_required')
    expect((await lab(OWNER, { op: 'tick', runs: ['due-delete@x.com'] })).json.error).toBe('runs_required')
    await env.DB.prepare(
      `INSERT INTO members (email, role, status, source, created_at) VALUES ('rv@x.com','reviewer','active','legacy',?)`,
    )
      .bind(clock)
      .run()
    expect((await lab('rv@x.com', { op: 'tick', runs: [a] })).status).toBe(403)
    expect((await lab(OWNER, { op: 'tick', runs: [a] }, 'production')).status).toBe(404)
    expect((await lab(OWNER, { op: 'shift', email: 'due-warn@x.com', days: 1 })).json.error).toBe('not_lab')
    const t = (await lab(OWNER, { op: 'tick', runs: [a] })).json
    expect(t.ok).toBe(true)
    expect(t.lifecycle[a]).toMatchObject({
      purged: 1,
      inactiveWarned: 1,
      inactiveStopped: 1,
      proExpired: 1,
      invitesExpired: 0,
      skippedOutOfScope: 0,
    })
    expect(await snap()).toBe(before) // nothing outside run a changed
    const other = (await lab(OWNER, { op: 'status', runs: [b] })).json
    expect(other.purged).toEqual([])
    expect(other.members.filter((m: any) => m.email.startsWith(`lab-${b}-`)).length).toBe(10)
    expect(
      other.members.reduce((n: number, m: any) => n + m.mail.length, 0),
      JSON.stringify(other.members.map((m: any) => [m.scenario, m.mail])),
    ).toBe(0)
    // the 15-minute cron still processes the real members exactly as before
    await runCron(env, clock)
    const after = Object.fromEntries(
      (await q(`SELECT email, status, inactive_warned_at FROM members WHERE email LIKE 'due-%'`)).map((r: any) => [
        r.email,
        r,
      ]),
    )
    expect(after['due-delete@x.com']).toBeUndefined()
    expect(after['due-warn@x.com'].inactive_warned_at).toBe(clock)
    expect(after['due-stop@x.com'].status).toBe('revoked')
    expect((await q(`SELECT status FROM invites WHERE id='iv'`))[0].status).toBe('expired')
    expect((await q(`SELECT tier FROM pro_state WHERE email='due-pro@x.com'`))[0].tier).toBe('standard')
  }, 30_000)
})

describe('turnstile server check', () => {
  const req = new Request('https://welcome.example.dev/api/public/otp', { headers: { 'CF-Connecting-IP': '1.2.3.4' } })
  const reqAt = (h: string) =>
    new Request(`https://${h}/api/public/otp`, {
      headers: { 'CF-Connecting-IP': '1.2.3.4', Origin: 'https://evil.example' },
    })
  const sv = (j: unknown) => (async () => new Response(JSON.stringify(j))) as unknown as typeof fetch
  it('rejects missing/forged/foreign-host tokens and accepts a valid one', async () => {
    const e = { TURNSTILE_SECRET: 's', TURNSTILE_HOSTNAME: 'welcome.example.dev', PLATFORM_STAGE: 'staging' } as never
    expect(await verifyTurnstile(e, '', req, sv({ success: true, hostname: 'welcome.example.dev' }))).toBe(false)
    expect(
      await verifyTurnstile(e, 'tok', req, sv({ success: false, 'error-codes': ['invalid-input-response'] })),
    ).toBe(false)
    expect(await verifyTurnstile(e, 'tok', req, sv({ success: false, 'error-codes': ['timeout-or-duplicate'] }))).toBe(
      false,
    )
    expect(await verifyTurnstile(e, 'tok', req, sv({ success: true, hostname: 'evil.example' }))).toBe(false)
    expect(await verifyTurnstile(e, 'tok', req, sv({ success: true, hostname: 'welcome.example.dev' }))).toBe(true)
    expect(await verifyTurnstile({ PLATFORM_STAGE: 'staging' } as never, 'tok', req, sv({ success: true }))).toBe(false) // no secret = closed
  })
  it('hostname allow-list: exact members only, and the token host must be the host the request arrived at', async () => {
    const e = {
      TURNSTILE_SECRET: 's',
      TURNSTILE_HOSTNAME: 'old.workers.dev, staging.getexampilot.site',
      PLATFORM_STAGE: 'staging',
    } as never
    const ok = (h: string) => sv({ success: true, hostname: h })
    expect(await verifyTurnstile(e, 'tok', reqAt('old.workers.dev'), ok('old.workers.dev'))).toBe(true)
    expect(await verifyTurnstile(e, 'tok', reqAt('staging.getexampilot.site'), ok('staging.getexampilot.site'))).toBe(
      true,
    )
    expect(await verifyTurnstile(e, 'tok', reqAt('STAGING.getexampilot.site'), ok('staging.getexampilot.site'))).toBe(
      true,
    )
    // token from one allowed host replayed at the other allowed host
    expect(await verifyTurnstile(e, 'tok', reqAt('old.workers.dev'), ok('staging.getexampilot.site'))).toBe(false)
    // lookalikes / suffixes / unlisted hosts
    for (const h of [
      'getexampilot.site',
      'x.staging.getexampilot.site',
      'staging.getexampilot.site.evil.example',
      'evil.example',
      '',
    ])
      expect(await verifyTurnstile(e, 'tok', reqAt(h || 'old.workers.dev'), ok(h))).toBe(false)
  })
})
