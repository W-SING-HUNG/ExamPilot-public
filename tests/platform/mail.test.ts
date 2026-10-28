/**
 * Brevo hand-off guards (2026-10-27): cut-off for test-period mail, stale drop, daily free-quota cap,
 * honest OTP result (provider failure ⇒ not "sent"), reserved test domains never leave the system.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.setConfig({ testTimeout: 60_000 })
import { makeHarness, type Harness } from '../sync/test-harness'
import { drainOutbox, enqueueMail, releaseHeld, renderMail, mailConfigured } from '../../worker/platform/mail'
import { handlePublic } from '../../worker/platform/public'

const DAY = 86_400_000
const W = 'https://welcome.test'
let H: Harness
let env: any
let clock: number
beforeEach(async () => {
  H = await makeHarness()
  clock = Date.UTC(2026, 9, 27, 4, 0, 0)
  env = {
    ...H.env,
    SUPER_OWNERS: 'owner@x.com',
    PLATFORM_SECRET: 's',
    PLATFORM_STAGE: 'test',
    MAIL_PROVIDER: 'outbox',
    WELCOME_URL: W,
    APP_URL: 'https://app.test',
  }
})
afterEach(async () => H.dispose())
const brevo = (extra = {}) => ({
  ...env,
  MAIL_PROVIDER: 'brevo',
  BREVO_API_KEY: 'k',
  MAIL_FROM: 'no-reply@notify.example.org',
  MAIL_SEND_AFTER: String(clock - 60_000),
  ...extra,
})
function fakeBrevo(status = 201) {
  const calls: any[] = []
  const f = (async (u: any, init: any) => {
    calls.push({ u: String(u), body: JSON.parse(init.body), key: init.headers['api-key'] })
    return new Response(
      status < 300 ? JSON.stringify({ messageId: '<m' + calls.length + '@brevo>' }) : '{"code":"unauthorized"}',
      { status },
    )
  }) as typeof fetch
  return { f, calls }
}
const row = (dk: string) =>
  H.raw.prepare('SELECT status, last_error, attempts FROM mail_outbox WHERE dedupe_key = ?').bind(dk).first<any>()

describe('mail provider guards', () => {
  it('not configured without key, sender AND cut-off', () => {
    expect(mailConfigured(brevo())).toBe(true)
    expect(mailConfigured(brevo({ MAIL_SEND_AFTER: '' }))).toBe(false)
    expect(mailConfigured(brevo({ BREVO_API_KEY: '' }))).toBe(false)
    expect(mailConfigured(brevo({ MAIL_FROM: '' }))).toBe(false)
  })
  it('mail created before the cut-off (test period) is never sent, even if re-queued or released', async () => {
    await enqueueMail(env, 'old@x.com', 'apply_approved', {}, 'old1', clock - DAY) // before cut-off
    await enqueueMail(env, 'new@x.com', 'apply_approved', {}, 'new1', clock)
    await H.raw.prepare(`UPDATE mail_outbox SET status = 'held'`).run()
    const b = fakeBrevo()
    await releaseHeld(brevo(), clock)
    const r = await drainOutbox(brevo(), clock, { fetchImpl: b.f })
    expect(r.sent).toBe(1)
    expect(b.calls.map((c) => c.body.to[0].email)).toEqual(['new@x.com'])
    expect((await row('old1')).status).toBe('dead')
    expect((await row('old1')).last_error).toBe('before_mail_cutoff')
    // a manual re-queue of the old row still cannot send it
    await H.raw.prepare(`UPDATE mail_outbox SET status = 'queued', next_at = 0 WHERE dedupe_key = 'old1'`).run()
    await drainOutbox(brevo(), clock + 1000, { fetchImpl: b.f })
    expect(b.calls).toHaveLength(1)
  })
  it('stale codes and stale notices are dropped, not sent late', async () => {
    const e = brevo({ MAIL_SEND_AFTER: String(clock - 10 * DAY) })
    await enqueueMail(e, 'a@x.com', 'otp', { code: '123456', purpose: 'apply' }, 'otp:x', clock - 11 * 60_000)
    await enqueueMail(e, 'a@x.com', 'apply_approved', {}, 'ap:x', clock - 4 * DAY)
    const b = fakeBrevo()
    const r = await drainOutbox(e, clock, { fetchImpl: b.f })
    expect(r.sent).toBe(0)
    expect((await row('otp:x')).last_error).toBe('stale')
    expect((await row('ap:x')).last_error).toBe('stale')
  })
  it('daily free-quota cap defers to the next Beijing day instead of sending more', async () => {
    const e = brevo({ MAIL_DAILY_CAP: '2' })
    for (let i = 0; i < 4; i++) await enqueueMail(e, `u${i}@x.com`, 'account_ready', {}, 'cap' + i, clock)
    const b = fakeBrevo()
    const r = await drainOutbox(e, clock, { fetchImpl: b.f })
    expect(r.sent).toBe(2)
    expect(r.deferred).toBe(2)
    expect(b.calls).toHaveLength(2)
    const again = await drainOutbox(e, clock + 60_000, { fetchImpl: b.f })
    expect(again.sent).toBe(0) // still today; rows wait for tomorrow
    const tomorrow = Date.UTC(2026, 9, 27, 16, 10, 0) // 00:10 Beijing next day
    const t = await drainOutbox(e, tomorrow, { fetchImpl: b.f })
    expect(t.sent).toBe(2)
  })
  it('reserved test domains never reach the provider', async () => {
    await enqueueMail(env, 'lab-1@lab.exampilot.invalid', 'invite', { token: 't', expiresAt: clock }, 'r1', clock)
    const b = fakeBrevo()
    await drainOutbox(brevo(), clock, { fetchImpl: b.f })
    expect(b.calls).toHaveLength(0)
    expect((await row('r1')).last_error).toBe('test_address')
  })
  it('example.* fixtures are accepted by the invite flow but never handed to the provider', async () => {
    // The invitation tests use @example.edu so the happy path can run end to end.
    // That namespace resolves to nobody, so the sender must refuse it even when a
    // real provider is configured — otherwise a test fixture becomes a live send.
    await enqueueMail(env, 'student@example.edu', 'invite', { token: 't', expiresAt: clock }, 'r-ex', clock)
    const b = fakeBrevo()
    const r = await drainOutbox(brevo(), clock, { fetchImpl: b.f })
    expect(b.calls).toHaveLength(0)
    expect(r.dropped).toBe(1)
    expect((await row('r-ex')).last_error).toBe('test_address')
  })
  it('retries are limited and the key only travels in the api-key header', async () => {
    await enqueueMail(env, 'x@x.com', 'account_ready', {}, 'k1', clock)
    const b = fakeBrevo(401)
    let t = clock
    for (let i = 0; i < 10; i++) {
      await drainOutbox(brevo(), t, { fetchImpl: b.f })
      t += 7 * 3600_000
      if ((await row('k1')).status === 'dead') break
    }
    // after the back-off ladder the row is dead (or stale), never sent; at most 6 attempts
    expect(['dead']).toContain((await row('k1')).status)
    expect(b.calls.length).toBeLessThanOrEqual(6)
    expect(b.calls.every((c) => c.key === 'k' && !JSON.stringify(c.body).includes('"k"'))).toBe(true)
  })
  it('staging needs an explicit recipient allow-list; others are retired, never sent later', async () => {
    const st = (extra = {}) => brevo({ PLATFORM_STAGE: 'staging', ...extra })
    expect(mailConfigured(st())).toBe(false)
    expect(mailConfigured(st({ MAIL_ALLOWLIST: 'ok@x.com' }))).toBe(true)
    const e = st({ MAIL_ALLOWLIST: ' OK@x.com , other-not-an-address ' })
    await enqueueMail(e, 'ok@x.com', 'account_ready', {}, 'al1', clock)
    await enqueueMail(e, 'stranger@x.com', 'account_ready', {}, 'al2', clock)
    const b = fakeBrevo()
    const r = await drainOutbox(e, clock, { fetchImpl: b.f })
    expect(b.calls.map((c) => c.body.to[0].email)).toEqual(['ok@x.com'])
    expect(r.dropped).toBe(1)
    expect((await row('al2')).status).toBe('dead')
    expect((await row('al2')).last_error).toBe('not_allowlisted')
    await H.raw.prepare(`UPDATE mail_outbox SET status = 'queued', next_at = 0 WHERE dedupe_key = 'al2'`).run()
    await drainOutbox(e, clock + 1000, { fetchImpl: b.f })
    expect(b.calls).toHaveLength(1)
  })
  it('new lifecycle templates render with the right links', () => {
    expect(renderMail(env, 'inactive_stopped', { deleteAfter: clock }).text).toContain(W + '/apply')
    expect(renderMail(env, 'delete_soon', { deleteAfter: clock, reason: 'self_close' }).text).toContain(W + '/account')
    expect(renderMail(env, 'delete_soon', { deleteAfter: clock, reason: 'admin_revoke' }).text).not.toContain(
      '/account',
    )
    expect(renderMail(env, 'close_cancelled', {}).text).toContain('https://app.test')
  })
})

describe('public OTP is honest about delivery', () => {
  async function otp(e: any, f: typeof fetch, email = 'p@x.com') {
    const res = await handlePublic(
      new Request(W + '/api/public/otp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: W,
          'X-ExamPilot-Public': '1',
          'CF-Connecting-IP': '203.0.113.7',
        },
        body: JSON.stringify({ email, purpose: 'apply' }),
      }),
      e,
      { now: () => clock, fetchImpl: f },
    )
    return { status: res.status, json: (await res.json()) as any }
  }
  it('resend needs a real 60 s gap (not just a new clock minute) and only the newest code works', async () => {
    const ok = fakeBrevo()
    clock = Date.UTC(2026, 9, 27, 4, 0, 50) // 10 s before a minute boundary
    expect((await otp(brevo({ MAIL_SEND_AFTER: String(clock - 60_000) }), ok.f, 'g@x.com')).status).toBe(200)
    clock += 20_000 // next clock minute, but only 20 s later
    const r = await otp(brevo({ MAIL_SEND_AFTER: String(clock - 80_000) }), ok.f, 'g@x.com')
    expect(r.status).toBe(429)
    expect(ok.calls).toHaveLength(1)
    clock += 50_000
    expect((await otp(brevo({ MAIL_SEND_AFTER: String(clock - 130_000) }), ok.f, 'g@x.com')).status).toBe(200)
    const live = await H.raw
      .prepare(`SELECT COUNT(*) n FROM email_otps WHERE email = 'g@x.com' AND used_at IS NULL`)
      .first<any>()
    expect(live.n).toBe(1)
  })
  it('provider accepted ⇒ sent:true; provider error ⇒ 503 and the code is void', async () => {
    const ok = fakeBrevo()
    const a = await otp(brevo(), ok.f)
    expect(a.status).toBe(200)
    expect(a.json.sent).toBe(true)
    expect(ok.calls).toHaveLength(1)
    // the code never stays readable in the outbox once the provider took it
    expect(
      (await H.raw.prepare(`SELECT params FROM mail_outbox WHERE template = 'otp' AND status = 'sent'`).first<any>())
        .params,
    ).toBe('{"scrubbed":true}')
    clock += 2 * 60_000
    const bad = fakeBrevo(500)
    const b = await otp(brevo(), bad.f, 'q@x.com')
    expect(b.status).toBe(503)
    expect(b.json.error).toBe('mail_failed')
    const o = await H.raw.prepare(`SELECT used_at FROM email_otps WHERE email = 'q@x.com'`).first<any>()
    expect(o.used_at).not.toBeNull()
    expect(
      await H.raw.prepare(`SELECT status, params FROM mail_outbox WHERE to_email = 'q@x.com'`).first<any>(),
    ).toEqual({ status: 'dead', params: '{"scrubbed":true}' })
    // and the failed row is not retried later
    await drainOutbox(brevo(), clock + 10 * 60_000, { fetchImpl: ok.f })
    expect(ok.calls).toHaveLength(1)
  })
  it('quota reached ⇒ 503 mail_quota; reserved address ⇒ 400', async () => {
    const e = brevo({ MAIL_DAILY_CAP: '1' })
    await enqueueMail(e, 'z@x.com', 'account_ready', {}, 'z', clock)
    const b = fakeBrevo()
    await drainOutbox(e, clock, { fetchImpl: b.f })
    const r = await otp(e, b.f, 'w@x.com')
    expect(r.status).toBe(503)
    expect(r.json.error).toBe('mail_quota')
    clock += 2 * 60_000
    const v = await otp(brevo(), b.f, 'someone@lab.exampilot.invalid')
    expect(v.status).toBe(400)
  })
  it('staging refuses before any mail work when Turnstile is not configured', async () => {
    const r = await otp({ ...env, PLATFORM_STAGE: 'staging', TURNSTILE_SECRET: '' }, fakeBrevo().f)
    expect(r.status).toBe(400) // Turnstile not configured is refused first in staging
  })
})
