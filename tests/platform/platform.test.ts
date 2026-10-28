/**
 * Platform integration tests on a real D1 (Miniflare SQLite) with the real schema:
 * waitlist, invites, two-level admins, Access sync, Pro ledger, referrals,
 * lifecycle (revoke / self-close / inactivity / purge) and the AI gate.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeHarness, HOST, type Harness } from '../sync/test-harness'
import { handlePlatform, runCron, type ProtectedEnv } from '../../worker/platform/http'
import { handlePublic } from '../../worker/platform/public'
import { handleAi, _resetAiGuards } from '../../worker/ai'
import { lifecycleTick, purgeMember, addMonths, reconcileDeletions } from '../../worker/platform/core'
import { syncAccess } from '../../worker/platform/access'
import { drainOutbox } from '../../worker/platform/mail'
import { csvCell } from '../../worker/platform/util'

const DAY = 86_400_000
const WELCOME = 'https://welcome.test'
const OWNER = 'owner@x.com'
let H: Harness
let env: ProtectedEnv
let clock: number

beforeEach(async () => {
  H = await makeHarness()
  _resetAiGuards()
  clock = Date.UTC(2026, 9, 26, 2, 0, 0)
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
let idemSeq = 0
async function api(
  method: string,
  p: string,
  email: string | null,
  body?: unknown,
  extra: Record<string, unknown> = {},
) {
  // like the admin UI: every new time-adding Pro request carries its own idempotency key
  if (
    p === '/api/admin/pro' &&
    body &&
    typeof body === 'object' &&
    !('idem' in (body as object)) &&
    ['grant', 'adjust'].includes((body as { action?: string }).action || '')
  )
    body = { ...(body as object), idem: 'testidem' + String(++idemSeq).padStart(6, '0') }
  const headers: Record<string, string> = { 'X-ExamPilot-Client': '1' }
  if (email) headers['Cf-Access-Jwt-Assertion'] = await H.issuer.token(email)
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    headers['Origin'] = HOST
  }
  const req = new Request(HOST + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const res = (await handlePlatform(req, { ...env, ...extra } as ProtectedEnv, { now: () => clock, auth: auth() }))!
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
  return syncMe(email)
}
async function syncMe(email: string) {
  const headers: Record<string, string> = {
    'X-ExamPilot-Sync': '1',
    'Cf-Access-Jwt-Assertion': await H.issuer.token(email),
  }
  const { handleApi } = await import('../../worker/api')
  const res = await handleApi(new Request(HOST + '/api/sync/me', { headers }), env as never, {
    now: () => clock,
    auth: auth(),
  })
  return { status: res.status, json: await res.json() }
}

/* ---- public (welcome) side with a cookie jar ---- */
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
async function lastCode(email: string) {
  const r = await H.raw
    .prepare(
      `SELECT params FROM mail_outbox WHERE to_email = ? AND template = 'otp' ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .bind(email)
    .first<{ params: string }>()
  return JSON.parse(r!.params).code as string
}
async function verify(pub: ReturnType<typeof publicClient>, email: string, purpose = 'apply') {
  expect((await pub('POST', '/api/public/otp', { email, purpose })).status).toBe(200)
  const code = await lastCode(email)
  const v = await pub('POST', '/api/public/verify', { email, code })
  expect(v.status).toBe(200)
}
async function apply(email: string, extra: Record<string, unknown> = {}) {
  const pub = publicClient()
  await verify(pub, email)
  return pub('POST', '/api/public/apply', { note: '想复习', ...extra })
}
async function mails(email: string, template?: string) {
  const r = await H.raw
    .prepare(`SELECT template FROM mail_outbox WHERE to_email = ?${template ? ' AND template = ?' : ''}`)
    .bind(...(template ? [email, template] : [email]))
    .all<{ template: string }>()
  return r.results.map((x) => x.template)
}
async function owner() {
  await login(OWNER)
}
async function decide(email: string, decision: 'approve' | 'reject', as = OWNER, extra: Record<string, unknown> = {}) {
  const list = await api('GET', '/api/admin/applications?status=pending&q=' + encodeURIComponent(email), as)
  const row = list.json.rows.find((r: any) => r.email === email)
  return api('POST', '/api/admin/applications/decide', as, {
    items: [{ id: row.id, version: row.version }],
    decision,
    internal: '内部原因',
    ...extra,
  })
}

/* =============================================================== */
describe('membership gate', () => {
  it('existing identities are members; Access-only e-mails become Standard members; revoked cannot use any API', async () => {
    await owner()
    expect((await login('stu@x.com')).status).toBe(200)
    const m = await H.raw
      .prepare('SELECT status, source, role FROM members WHERE email = ?')
      .bind('stu@x.com')
      .first<any>()
    expect(m).toMatchObject({ status: 'active', source: 'access', role: 'user' })
    const r = await api('POST', '/api/admin/member/action', OWNER, {
      email: 'stu@x.com',
      action: 'revoke',
      confirm: true,
    })
    expect(r.status).toBe(200)
    // a still-valid Access token is refused everywhere
    expect((await syncMe('stu@x.com')).status).toBe(403)
    expect((await api('GET', '/api/me/account', 'stu@x.com')).status).toBe(403)
    const aiRes = await handleAi(
      new Request(HOST + '/api/ai/status', {
        headers: { 'X-ExamPilot-Client': '1', 'Cf-Access-Jwt-Assertion': await H.issuer.token('stu@x.com') },
      }),
      env as never,
      { now: () => clock, auth: auth() },
    )
    expect(aiRes.status).toBe(403)
  })

  it('the owner cannot be revoked, demoted or closed', async () => {
    await owner()
    await login('boss2@x.com')
    await api('POST', '/api/admin/member/action', OWNER, {
      email: 'boss2@x.com',
      action: 'role',
      role: 'super',
      confirm: true,
    })
    expect(
      (await api('POST', '/api/admin/member/action', 'boss2@x.com', { email: OWNER, action: 'revoke', confirm: true }))
        .status,
    ).toBe(409)
    expect(
      (
        await api('POST', '/api/admin/member/action', 'boss2@x.com', {
          email: OWNER,
          action: 'role',
          role: 'user',
          confirm: true,
        })
      ).status,
    ).toBe(409)
    const st = await api('GET', '/api/admin/whoami', OWNER)
    expect(st.json).toMatchObject({ role: 'super', owner: true })
  })
})

describe('waitlist', () => {
  it('apply → verify → pending, duplicate refused, approve → member + Access pending + mails', async () => {
    await owner()
    const a = await apply('new@x.com')
    expect(a.status).toBe(200)
    expect(a.json.applications[0].status).toBe('pending')
    clock += 61_000
    expect((await apply('new@x.com')).json.error).toBe('pending_exists')
    expect(await mails('new@x.com', 'apply_received')).toHaveLength(1)
    const d = await decide('new@x.com', 'approve')
    expect(d.json.results[0].ok).toBe(true)
    const m = await H.raw
      .prepare('SELECT status, role, access_state FROM members WHERE email = ?')
      .bind('new@x.com')
      .first<any>()
    expect(m).toMatchObject({ status: 'active', role: 'user' })
    expect(m.access_state).not.toBe('ok') // no CF token in tests → never shown as done
    expect(await mails('new@x.com', 'apply_approved')).toHaveLength(1)
    // status page reflects it and never claims login works while Access is not done
    const pub = publicClient()
    clock += 61_000 // one code per minute per address
    await verify(pub, 'new@x.com', 'status')
    const me = await pub('GET', '/api/public/me')
    expect(me.json.member).toMatchObject({ status: 'active', canLogin: false, accessPending: true })
  })

  it('concurrent approve + reject on one application: exactly one decision, one member, one mail', async () => {
    await owner()
    await apply('race@x.com')
    const list = await api('GET', '/api/admin/applications?status=pending&q=' + encodeURIComponent('race@x.com'), OWNER)
    const row = list.json.rows.find((r: any) => r.email === 'race@x.com')
    const body = (decision: string) => ({ items: [{ id: row.id, version: row.version }], decision, internal: '并发' })
    const rs = await Promise.all([
      api('POST', '/api/admin/applications/decide', OWNER, body('approve')),
      api('POST', '/api/admin/applications/decide', OWNER, body('approve')),
      api('POST', '/api/admin/applications/decide', OWNER, body('reject')),
    ])
    const oks = rs.filter((r) => r.json.results?.[0]?.ok).length
    expect(oks).toBe(1)
    const a = await H.raw.prepare('SELECT status FROM applications WHERE id = ?').bind(row.id).first<any>()
    expect(['approved', 'rejected']).toContain(a.status)
    const nMembers = (await H.raw.prepare(`SELECT COUNT(*) n FROM members WHERE email = 'race@x.com'`).first<any>()).n
    expect(nMembers).toBe(a.status === 'approved' ? 1 : 0)
    const decided = [...(await mails('race@x.com', 'apply_approved')), ...(await mails('race@x.com', 'apply_rejected'))]
    expect(decided).toHaveLength(1)
  })

  it('OTP: wrong code counts, single use, expiry; the send answer never reveals membership', async () => {
    await owner()
    const pub = publicClient()
    const a = await pub('POST', '/api/public/otp', { email: OWNER, purpose: 'status' })
    const b = await pub('POST', '/api/public/otp', { email: 'nobody-' + Date.now() + '@x.com', purpose: 'status' })
    expect(a.json).toEqual(b.json)
    const code = await lastCode(OWNER)
    expect(
      (await pub('POST', '/api/public/verify', { email: OWNER, code: code === '000000' ? '111111' : '000000' })).status,
    ).toBe(400)
    expect((await pub('POST', '/api/public/verify', { email: OWNER, code })).status).toBe(200)
    expect((await pub('POST', '/api/public/verify', { email: OWNER, code })).status).toBe(400) // used
    clock += 60_000 * 2
    await pub('POST', '/api/public/otp', { email: 'late@x.com', purpose: 'status' })
    const c2 = await lastCode('late@x.com')
    clock += 11 * 60_000
    expect((await pub('POST', '/api/public/verify', { email: 'late@x.com', code: c2 })).status).toBe(400)
    const stored = await H.raw
      .prepare('SELECT code_hash FROM email_otps WHERE email = ?')
      .bind('late@x.com')
      .first<any>()
    expect(stored.code_hash).not.toContain(c2)
  })

  it('reject → 7-day cooldown; admin may still invite during cooldown; internal note is not mailed', async () => {
    await owner()
    await apply('rj@x.com')
    const r = await decide('rj@x.com', 'reject', OWNER, { internal: '内部：资料不全', publicNote: '名额已满' })
    expect(r.json.results[0].ok).toBe(true)
    const mail = await H.raw
      .prepare(`SELECT params FROM mail_outbox WHERE to_email = ? AND template = 'apply_rejected'`)
      .bind('rj@x.com')
      .first<any>()
    expect(mail.params).toContain('名额已满')
    expect(mail.params).not.toContain('资料不全')
    clock += 3 * DAY
    expect((await apply('rj@x.com')).json.error).toBe('cooldown')
    const inv = await api('POST', '/api/admin/invites', OWNER, { emails: ['rj@x.com'] })
    expect(inv.json.results[0].ok).toBe(true)
    clock += 4 * DAY + 1000
    expect((await apply('rj@x.com')).status).toBe(200)
  })

  it('paused: new applications refused, pending ones still reviewable, invites still accepted', async () => {
    await owner()
    await apply('p1@x.com')
    await api('POST', '/api/admin/settings', OWNER, { applications_open: false })
    expect((await apply('p2@x.com')).json.error).toBe('paused')
    expect((await decide('p1@x.com', 'approve')).json.results[0].ok).toBe(true)
  })

  it('two admins deciding the same application: exactly one wins', async () => {
    await owner()
    await login('rev@x.com')
    await api('POST', '/api/admin/member/action', OWNER, {
      email: 'rev@x.com',
      action: 'role',
      role: 'reviewer',
      confirm: true,
    })
    await apply('race@x.com')
    const list = await api('GET', '/api/admin/applications?status=pending', OWNER)
    const row = list.json.rows[0]
    const [x, y] = await Promise.all([
      api('POST', '/api/admin/applications/decide', OWNER, {
        items: [{ id: row.id, version: row.version }],
        decision: 'approve',
      }),
      api('POST', '/api/admin/applications/decide', 'rev@x.com', {
        items: [{ id: row.id, version: row.version }],
        decision: 'reject',
        internal: 'x',
      }),
    ])
    const wins = [x.json.results[0].ok, y.json.results[0].ok].filter(Boolean)
    expect(wins).toHaveLength(1)
    const n = await H.raw
      .prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE action IN ('application.approve','application.reject')`)
      .first<any>()
    expect(n.n).toBe(1)
  })

  it('reviewer: applications + invites only, every super route refused server-side', async () => {
    await owner()
    await login('rev@x.com')
    await api('POST', '/api/admin/member/action', OWNER, {
      email: 'rev@x.com',
      action: 'role',
      role: 'reviewer',
      confirm: true,
    })
    expect((await api('GET', '/api/admin/applications', 'rev@x.com')).status).toBe(200)
    expect((await api('POST', '/api/admin/invites', 'rev@x.com', { emails: ['i@x.com'] })).status).toBe(200)
    for (const [m, p, b] of [
      ['GET', '/api/admin/members', undefined],
      ['GET', '/api/admin/member/stats?email=' + OWNER, undefined],
      ['POST', '/api/admin/pro', { email: 'rev@x.com', action: 'grant', kind: 'permanent', confirm: true }],
      ['POST', '/api/admin/member/action', { email: 'i@x.com', action: 'revoke', confirm: true }],
      ['POST', '/api/admin/member/action', { email: 'rev@x.com', action: 'role', role: 'super', confirm: true }],
      ['GET', '/api/admin/audit', undefined],
      ['GET', '/api/admin/export?type=rewards', undefined],
      ['POST', '/api/admin/settings', { applications_open: false }],
      ['GET', '/api/admin/referrals', undefined],
    ] as const)
      expect((await api(m, p, 'rev@x.com', b)).status, p).toBe(403)
    // ordinary users get nothing
    await login('u@x.com')
    expect((await api('GET', '/api/admin/applications', 'u@x.com')).status).toBe(403)
    // reviewers do not see super-only notices
    const n = await api('GET', '/api/admin/notices?state=all', 'rev@x.com')
    expect(n.json.rows.every((r: any) => r.kind === 'application')).toBe(true)
  })

  it('reviewer decides applications through the real route: audited, idempotent, no Pro, no mail claimed as sent, no super powers', async () => {
    await owner()
    await login('rev@x.com')
    await api('POST', '/api/admin/member/action', OWNER, {
      email: 'rev@x.com',
      action: 'role',
      role: 'reviewer',
      confirm: true,
    })
    await apply('ra@x.com')
    await apply('rr@x.com')
    const list = await api('GET', '/api/admin/applications?status=pending', 'rev@x.com')
    expect(list.status).toBe(200)
    const ra = list.json.rows.find((r: any) => r.email === 'ra@x.com')
    const rr = list.json.rows.find((r: any) => r.email === 'rr@x.com')
    expect(ra.reject_internal ?? null).toBeNull() // internal notes are super-only
    const body = { items: [{ id: ra.id, version: ra.version }], decision: 'approve' }
    const ok = await api('POST', '/api/admin/applications/decide', 'rev@x.com', body)
    expect(ok.status).toBe(200)
    expect(ok.json.results).toEqual([{ id: ra.id, ok: true }])
    // the same request again (double click / retry): refused, nothing granted twice
    const again = await api('POST', '/api/admin/applications/decide', 'rev@x.com', body)
    expect(again.json.results).toEqual([{ id: ra.id, ok: false, reason: 'already_decided' }])
    // a stale version from a second tab is refused too
    const stale = await api('POST', '/api/admin/applications/decide', 'rev@x.com', {
      items: [{ id: rr.id, version: rr.version + 7 }],
      decision: 'approve',
    })
    expect(stale.json.results[0]).toMatchObject({ ok: false, reason: 'stale_version' })
    const rej = await api('POST', '/api/admin/applications/decide', 'rev@x.com', {
      items: [{ id: rr.id, version: rr.version }],
      decision: 'reject',
      internal: '资料不全',
      publicNote: '名额已满',
    })
    expect(rej.json.results).toEqual([{ id: rr.id, ok: true }])
    // reject needs an internal reason
    await apply('rz@x.com')
    const rz = (await api('GET', '/api/admin/applications?status=pending&q=rz', 'rev@x.com')).json.rows[0]
    expect(
      (
        await api('POST', '/api/admin/applications/decide', 'rev@x.com', {
          items: [{ id: rz.id, version: rz.version }],
          decision: 'reject',
        })
      ).json.error,
    ).toBe('reason_required')
    // state: one admitted Standard member, no Pro, Access not claimed as done
    const m = await H.raw
      .prepare('SELECT role, status, access_state FROM members WHERE email = ?')
      .bind('ra@x.com')
      .first<any>()
    expect(m).toMatchObject({ role: 'user', status: 'active' })
    expect(m.access_state).not.toBe('ok')
    expect(
      (
        await H.raw
          .prepare(`SELECT COUNT(*) AS n FROM pro_grants WHERE email = 'ra@x.com' AND source <> 'legacy'`)
          .first<any>()
      ).n,
    ).toBe(0)
    expect((await H.raw.prepare(`SELECT COUNT(*) AS n FROM members WHERE email = 'rr@x.com'`).first<any>()).n).toBe(0)
    // audit: exactly one row per decision, by the reviewer, as reviewer
    const au = await H.raw
      .prepare(
        `SELECT actor, actor_role, action, target FROM audit_log WHERE action IN ('application.approve','application.reject') ORDER BY at, id`,
      )
      .all<any>()
    expect(au.results).toEqual([
      { actor: 'rev@x.com', actor_role: 'reviewer', action: 'application.approve', target: ra.id },
      { actor: 'rev@x.com', actor_role: 'reviewer', action: 'application.reject', target: rr.id },
    ])
    // mail: one notice each, queued or held — never marked sent without a provider
    const mo = await H.raw
      .prepare(
        `SELECT to_email, template, status, sent_at FROM mail_outbox WHERE template IN ('apply_approved','apply_rejected') ORDER BY to_email`,
      )
      .all<any>()
    expect(mo.results.map((x: any) => [x.to_email, x.template])).toEqual([
      ['ra@x.com', 'apply_approved'],
      ['rr@x.com', 'apply_rejected'],
    ])
    expect(mo.results.every((x: any) => x.status !== 'sent' && x.sent_at === null)).toBe(true)
    // the reviewer still has no super powers, before or after deciding
    for (const [mth, path, b] of [
      ['POST', '/api/admin/pro', { email: 'ra@x.com', action: 'grant', kind: 'permanent', confirm: true }],
      ['POST', '/api/admin/member/action', { email: OWNER, action: 'revoke', confirm: true }],
      ['POST', '/api/admin/member/action', { email: 'rev@x.com', action: 'role', role: 'super', confirm: true }],
      ['GET', '/api/admin/member?email=' + encodeURIComponent('ra@x.com'), undefined],
      ['GET', '/api/admin/member/stats?email=' + encodeURIComponent(OWNER), undefined],
    ] as const)
      expect((await api(mth, path, 'rev@x.com', b)).status, path).toBe(403)
    for (const path of ['/api/admin/ai-users', '/api/admin/ai-log'])
      expect(
        (
          await handleAi(
            new Request(HOST + path, {
              headers: { 'X-ExamPilot-Client': '1', 'Cf-Access-Jwt-Assertion': await H.issuer.token('rev@x.com') },
            }),
            env as never,
            { now: () => clock, auth: auth() },
          )
        ).status,
        path,
      ).toBe(403)
    expect((await H.raw.prepare('SELECT status FROM members WHERE email = ?').bind(OWNER).first<any>()).status).toBe(
      'active',
    )
    expect((await api('GET', '/api/admin/whoami', OWNER)).json.role).toBe('super')
  })
})

describe('invites', () => {
  async function inviteToken(email: string) {
    // the token is only in the mail params (never stored in invites)
    const r = await H.raw
      .prepare(
        `SELECT params FROM mail_outbox WHERE to_email = ? AND template = 'invite' ORDER BY created_at DESC LIMIT 1`,
      )
      .bind(email)
      .first<any>()
    return JSON.parse(r.params).token as string
  }
  it('invite → verify → accept → member; double accept is harmless; other e-mail cannot use it', async () => {
    await owner()
    await api('POST', '/api/admin/invites', OWNER, { emails: 'a1@x.com, a2@x.com\nbad' })
    const t = await inviteToken('a1@x.com')
    const other = publicClient()
    await verify(other, 'a2@x.com', 'invite')
    expect((await other('POST', '/api/public/invite/accept', { token: t })).status).toBe(404)
    const pub = publicClient()
    await verify(pub, 'a1@x.com', 'invite')
    const r = await pub('POST', '/api/public/invite/accept', { token: t })
    expect(r.status).toBe(200)
    const again = await pub('POST', '/api/public/invite/accept', { token: t })
    expect(again.json.already).toBe(true)
    const n = await H.raw.prepare('SELECT COUNT(*) AS n FROM members WHERE email = ?').bind('a1@x.com').first<any>()
    expect(n.n).toBe(1)
    expect(await mails('a1@x.com', 'account_ready')).toHaveLength(1)
  })
  it('expires after 7 days; resend issues a fresh one', async () => {
    await owner()
    await api('POST', '/api/admin/invites', OWNER, { emails: ['late@x.com'] })
    const t = await inviteToken('late@x.com')
    clock += 7 * DAY + 1
    await lifecycleTick(env, clock)
    const pub = publicClient()
    await verify(pub, 'late@x.com', 'invite')
    expect((await pub('POST', '/api/public/invite/accept', { token: t })).status).toBe(410)
    const list = await api('GET', '/api/admin/invites?q=late', OWNER)
    expect(list.json.rows[0].status).toBe('expired')
    await api('POST', '/api/admin/invites/resend', OWNER, { id: list.json.rows[0].id })
    const t2 = await inviteToken('late@x.com')
    expect(t2).not.toBe(t)
    expect((await pub('POST', '/api/public/invite/accept', { token: t2 })).status).toBe(200)
  })
})

describe('Access allow-list sync', () => {
  function fakeCf(initial: string[], opts: { extraRule?: boolean; failPut?: boolean } = {}) {
    let include: any[] = initial.map((email) => ({ email: { email } }))
    if (opts.extraRule) include.push({ everyone: {} })
    const calls: string[] = []
    const f = (async (u: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method || 'GET'
      calls.push(method)
      expect(String(u)).toBe('https://api.cloudflare.com/client/v4/accounts/A/access/policies/P')
      expect((init?.headers as any).Authorization).toBe('Bearer tok')
      if (method === 'PUT') {
        if (opts.failPut)
          return new Response(JSON.stringify({ success: false, errors: [{ message: 'boom' }] }), { status: 500 })
        include = JSON.parse(String(init!.body)).include
      }
      return new Response(
        JSON.stringify({
          success: true,
          result: { id: 'P', name: 'Allow', decision: 'allow', include, exclude: [], require: [] },
        }),
      )
    }) as typeof fetch
    return { f, calls, emails: () => include.map((r) => r.email?.email) }
  }
  const cfEnv = () => ({ ...env, CF_ACCESS_TOKEN: 'tok', ACCESS_ACCOUNT_ID: 'A', ACCESS_POLICY_ID: 'P' })

  it('adds approved, removes revoked, keeps manual entries and the owner, verifies', async () => {
    await owner()
    await login('keep@x.com')
    await apply('n1@x.com')
    await decide('n1@x.com', 'approve')
    await api('POST', '/api/admin/member/action', OWNER, { email: 'keep@x.com', action: 'revoke', confirm: true })
    const cf = fakeCf([OWNER, 'keep@x.com', 'manual@x.com'])
    const r = await syncAccess(cfEnv(), clock, { fetchImpl: cf.f })
    expect(r.error).toBeUndefined()
    expect(cf.emails().sort()).toEqual([OWNER, 'manual@x.com', 'n1@x.com'].sort())
    expect(cf.calls).toEqual(['GET', 'PUT', 'GET'])
    const m = await H.raw.prepare('SELECT access_state FROM members WHERE email = ?').bind('n1@x.com').first<any>()
    expect(m.access_state).toBe('ok')
    // idempotent: nothing pending → no call
    const again = await syncAccess(cfEnv(), clock, { fetchImpl: cf.f })
    expect(again.ran).toBe(false)
  })
  it('never touches a policy with non-email rules; failures stay visible and retry', async () => {
    await owner()
    await apply('n2@x.com')
    await decide('n2@x.com', 'approve')
    const bad = fakeCf([OWNER], { extraRule: true })
    const r = await syncAccess(cfEnv(), clock, { fetchImpl: bad.f })
    expect(r.error).toMatch(/unexpected_rule/)
    expect(bad.calls).toEqual(['GET'])
    const failing = fakeCf([OWNER], { failPut: true })
    const r2 = await syncAccess(cfEnv(), clock, { fetchImpl: failing.f })
    expect(r2.error).toMatch(/cloudflare PUT 500/)
    let m = await H.raw
      .prepare('SELECT access_state, access_attempts FROM members WHERE email = ?')
      .bind('n2@x.com')
      .first<any>()
    expect(m.access_state).toBe('failed')
    const ok = fakeCf([OWNER])
    await syncAccess(cfEnv(), clock, { fetchImpl: ok.f })
    m = await H.raw.prepare('SELECT access_state FROM members WHERE email = ?').bind('n2@x.com').first<any>()
    expect(m.access_state).toBe('ok')
  })
})

describe('Pro & referrals', () => {
  async function refLink(email: string) {
    const r = await api('GET', '/api/me/referral', email)
    return r.json.link.token as string
  }
  async function referAndActivate(referrer: string, referee: string) {
    const t = await refLink(referrer)
    const a = await apply(referee, { ref: t, consent: true })
    expect(a.status).toBe(200)
    await decide(referee, 'approve')
    await login(referee) // first verified login = activation
  }
  async function pro(email: string) {
    return (await api('GET', '/api/me/account', email)).json.pro
  }

  it('one successful referral = +7 days, once; admin 30 d + 2 referrals = 44 d', async () => {
    await owner()
    await login('r@x.com')
    await api('POST', '/api/admin/pro', OWNER, {
      email: 'r@x.com',
      action: 'grant',
      kind: 'days',
      days: 30,
      confirm: true,
    })
    await referAndActivate('r@x.com', 'f1@x.com')
    await referAndActivate('r@x.com', 'f2@x.com')
    await login('f1@x.com') // second login: no second reward
    const p = await pro('r@x.com')
    expect(p.until).toBe(clock + 44 * DAY)
    const n = await H.raw
      .prepare(`SELECT COUNT(*) AS n FROM pro_grants WHERE email = 'r@x.com' AND source = 'referral'`)
      .first<any>()
    expect(n.n).toBe(2)
    const mine = await api('GET', '/api/me/referral', 'r@x.com')
    expect(mine.json).toMatchObject({ total: 2, success: 2, rewardDays: 14 })
    expect(JSON.stringify(mine.json)).not.toContain('f1@x.com') // masked only
    expect(JSON.stringify(mine.json)).not.toContain('想复习') // no application text
  })

  it('no reward before activation; self-referral refused; regenerated link kills the old one but keeps history', async () => {
    await owner()
    await login('r@x.com')
    const t = await refLink('r@x.com')
    expect((await apply('r@x.com', { ref: t, consent: true })).json.error).not.toBe(undefined)
    await apply('f@x.com', { ref: t, consent: true })
    await decide('f@x.com', 'approve')
    expect((await pro('r@x.com')).tier).toBe('standard') // approved but not activated
    await api('POST', '/api/me/referral', 'r@x.com', { action: 'regenerate' })
    expect((await apply('g@x.com', { ref: t, consent: true })).json.error).toBe('bad_ref')
    await login('f@x.com')
    expect((await pro('r@x.com')).tier).toBe('pro')
  })

  it('permanent Pro keeps permanent; rewards are recorded only', async () => {
    await owner()
    await login('perm@x.com')
    await api('POST', '/api/admin/pro', OWNER, {
      email: 'perm@x.com',
      action: 'grant',
      kind: 'permanent',
      confirm: true,
    })
    await referAndActivate('perm@x.com', 'q@x.com')
    const p = await pro('perm@x.com')
    expect(p).toMatchObject({ permanent: true, until: null })
  })

  it('expiry: reminders at 3 d and 1 d, expiry notice, Standard keeps read-only AI history (new AI refused)', async () => {
    await owner()
    await login('e@x.com')
    await api('POST', '/api/admin/pro', OWNER, {
      email: 'e@x.com',
      action: 'grant',
      kind: 'days',
      days: 7,
      confirm: true,
    })
    const start = clock
    await lifecycleTick(env, start + 4 * DAY + 60_000)
    await lifecycleTick(env, start + 4 * DAY + 120_000) // idempotent
    await lifecycleTick(env, start + 6 * DAY + 60_000)
    await lifecycleTick(env, start + 7 * DAY + 60_000)
    expect((await mails('e@x.com')).filter((t) => t.startsWith('pro_')).sort()).toEqual([
      'pro_expired',
      'pro_remind1',
      'pro_remind3',
    ])
    clock = start + 7 * DAY + 60_000
    const st = await handleAi(
      new Request(HOST + '/api/ai/qa', {
        method: 'POST',
        headers: {
          'X-ExamPilot-Client': '1',
          'Content-Type': 'application/json',
          Origin: HOST,
          'Cf-Access-Jwt-Assertion': await H.issuer.token('e@x.com'),
        },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
      }),
      env as never,
      { now: () => clock, auth: auth() },
    )
    expect(st.status).toBe(403)
    expect((await pro('e@x.com')).tier).toBe('standard')
  })

  it('a 2-day grant gets only the 1-day reminder (no late 3-day one)', async () => {
    await owner()
    await login('s@x.com')
    await api('POST', '/api/admin/pro', OWNER, {
      email: 's@x.com',
      action: 'grant',
      kind: 'days',
      days: 2,
      confirm: true,
    })
    for (let h = 1; h <= 50; h += 2) await lifecycleTick(env, clock + h * 3_600_000)
    expect((await mails('s@x.com')).filter((t) => t.startsWith('pro_')).sort()).toEqual(['pro_expired', 'pro_remind1'])
  }, 60_000)

  it('force suspension: AI blocked, freeze keeps remaining days, rewards wait until lifted', async () => {
    await owner()
    await login('z@x.com')
    await api('POST', '/api/admin/pro', OWNER, {
      email: 'z@x.com',
      action: 'grant',
      kind: 'days',
      days: 10,
      confirm: true,
    })
    clock += DAY
    await api('POST', '/api/admin/pro', OWNER, { email: 'z@x.com', action: 'suspend', mode: 'freeze', confirm: true })
    expect((await pro('z@x.com')).active).toBe(false)
    await referAndActivate('z@x.com', 'zz@x.com')
    clock += 5 * DAY
    expect((await pro('z@x.com')).remainingMs).toBe(9 * DAY)
    await api('POST', '/api/admin/pro', OWNER, { email: 'z@x.com', action: 'lift', confirm: true })
    const p = await pro('z@x.com')
    expect(p.active).toBe(true)
    expect(p.until).toBe(clock + 16 * DAY) // 9 frozen + 7 released reward
  })

  it('ordinary revoke removes admin Pro only; referral rewards stay', async () => {
    await owner()
    await login('o@x.com')
    await api('POST', '/api/admin/pro', OWNER, { email: 'o@x.com', action: 'grant', kind: 'permanent', confirm: true })
    await referAndActivate('o@x.com', 'oo@x.com')
    await api('POST', '/api/admin/pro', OWNER, { email: 'o@x.com', action: 'revoke_admin', confirm: true })
    const p = await pro('o@x.com')
    expect(p).toMatchObject({ permanent: false, tier: 'pro' })
    expect(p.until).toBe(clock + 7 * DAY)
  })

  it('flagged referral: reward frozen → reviewed invalid (only unused removed) → one appeal → upheld restores', async () => {
    await owner()
    await login('bad@x.com')
    const t = await refLink('bad@x.com')
    for (let i = 0; i < 5; i++) await apply(`b${i}@x.com`, { ref: t, consent: true }) // burst → 6th is flagged
    await apply('b5@x.com', { ref: t, consent: true })
    await decide('b5@x.com', 'approve')
    await login('b5@x.com')
    const ref = await H.raw.prepare(`SELECT * FROM referrals WHERE referee_email = 'b5@x.com'`).first<any>()
    expect(ref.status).toBe('held')
    expect(ref.review).toBe('pending')
    expect((await pro('bad@x.com')).tier).toBe('standard')
    const notices = await api('GET', '/api/admin/notices', OWNER)
    expect(notices.json.rows.some((n: any) => n.kind === 'referral_flagged')).toBe(true)
    await api('POST', '/api/admin/referrals/review', OWNER, { id: ref.id, verdict: 'invalid', confirm: true })
    expect((await api('POST', '/api/me/appeal', 'bad@x.com', { referralId: ref.id, text: '同学是真的' })).status).toBe(
      200,
    )
    expect((await api('POST', '/api/me/appeal', 'bad@x.com', { referralId: ref.id, text: '再申诉' })).status).toBe(409)
    const ap = await api('GET', '/api/admin/appeals?status=open', OWNER)
    await api('POST', '/api/admin/appeals/decide', OWNER, { id: ap.json.rows[0].id, verdict: 'upheld', confirm: true })
    const p = await pro('bad@x.com')
    expect(p.until).toBe(clock + 7 * DAY)
  }, 60_000)

  it('violation found after use: only the unused part is taken back; no negative, no debt', async () => {
    await owner()
    await login('v@x.com')
    await referAndActivate('v@x.com', 'vv@x.com')
    const ref = await H.raw.prepare(`SELECT * FROM referrals WHERE referee_email = 'vv@x.com'`).first<any>()
    expect(ref.status).toBe('rewarded')
    clock += 1000 // the admin gift queues after the reward (FIFO by start time)
    await api('POST', '/api/admin/pro', OWNER, {
      email: 'v@x.com',
      action: 'grant',
      kind: 'days',
      days: 30,
      confirm: true,
    })
    clock += 3 * DAY
    await api('POST', '/api/admin/referrals/review', OWNER, { id: ref.id, verdict: 'invalid', confirm: true })
    const g = await H.raw
      .prepare(`SELECT revoked_unused_ms FROM pro_grants WHERE id = ?`)
      .bind(ref.grant_id)
      .first<any>()
    expect(g.revoked_unused_ms).toBe(4 * DAY - 1000)
    const p = await pro('v@x.com')
    expect(p.remainingMs).toBe(30 * DAY) // admin gift untouched
  })

  it('manual reissue and correction are recorded with a reason; history is never deleted', async () => {
    await owner()
    await login('m@x.com')
    expect(
      (
        await api('POST', '/api/admin/pro', OWNER, {
          email: 'm@x.com',
          action: 'adjust',
          days: 7,
          source: 'referral_manual',
          confirm: true,
        })
      ).status,
    ).toBe(400)
    await api('POST', '/api/admin/pro', OWNER, {
      email: 'm@x.com',
      action: 'adjust',
      days: 7,
      source: 'referral_manual',
      reason: '漏发',
      confirm: true,
    })
    const g = await H.raw.prepare(`SELECT id, source FROM pro_grants WHERE email = 'm@x.com'`).first<any>()
    expect(g.source).toBe('referral_manual')
    await api('POST', '/api/admin/pro', OWNER, {
      email: 'm@x.com',
      action: 'correct',
      grantId: g.id,
      reason: '发错了',
      confirm: true,
    })
    const n = await H.raw.prepare(`SELECT COUNT(*) AS n FROM pro_grants WHERE email = 'm@x.com'`).first<any>()
    expect(n.n).toBe(1)
    expect((await pro('m@x.com')).tier).toBe('standard')
    const a = await H.raw
      .prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE action IN ('pro.adjust','pro.correct')`)
      .first<any>()
    expect(a.n).toBe(2)
  })
})

describe('lifecycle', () => {
  it('admin revoke → data kept 7 days → restore cancels deletion', async () => {
    await owner()
    await login('k@x.com')
    await api('POST', '/api/admin/member/action', OWNER, { email: 'k@x.com', action: 'revoke', confirm: true })
    clock += 6 * DAY
    await lifecycleTick(env, clock)
    await api('POST', '/api/admin/member/action', OWNER, { email: 'k@x.com', action: 'restore' })
    clock += 2 * DAY
    await lifecycleTick(env, clock)
    expect((await syncMe('k@x.com')).status).toBe(200)
  })

  it('after 7 days the revoked account is purged — only that account', async () => {
    await owner()
    const a = await login('gone@x.com')
    await login('stay@x.com')
    // learning data for both
    for (const e of ['gone@x.com', 'stay@x.com']) {
      const me = await syncMe(e)
      await H.raw
        .prepare(
          `INSERT INTO ops (account_id, seq, op_id, client_id, epoch, kind, body, created_at, received_at) VALUES (?, 1, 'op1', 'c', 1, 'attempt', '{}', 0, 0)`,
        )
        .bind(me.json.accountId)
        .run()
    }
    await api('POST', '/api/admin/member/action', OWNER, { email: 'gone@x.com', action: 'revoke', confirm: true })
    expect((await purgeMember(env, clock + 6 * DAY, 'gone@x.com')).reason).toBe('not_due')
    clock += 7 * DAY + 1
    const r = await lifecycleTick(env, clock)
    expect(r.purged).toBe(1)
    const gone = await H.raw
      .prepare('SELECT COUNT(*) AS n FROM ops WHERE account_id = ?')
      .bind(a.json.accountId)
      .first<any>()
    expect(gone.n).toBe(0)
    const total = await H.raw.prepare('SELECT COUNT(*) AS n FROM ops').first<any>()
    expect(total.n).toBe(1)
    expect(await H.raw.prepare('SELECT 1 FROM members WHERE email = ?').bind('gone@x.com').first()).toBeNull()
    // running it again does nothing
    expect((await lifecycleTick(env, clock + 1000)).purged).toBe(0)
  })

  it('self-close with fresh code → closing → restore via the public page within 7 days', async () => {
    await owner()
    await login('c@x.com')
    await api('POST', '/api/me/close/start', 'c@x.com', {})
    const code = await lastCode('c@x.com')
    expect((await api('POST', '/api/me/close/confirm', 'c@x.com', { code, confirm: 'no' })).status).toBe(400)
    expect((await api('POST', '/api/me/close/confirm', 'c@x.com', { code, confirm: '注销' })).status).toBe(200)
    expect((await syncMe('c@x.com')).status).toBe(403)
    const pub = publicClient()
    await verify(pub, 'c@x.com', 'restore')
    expect((await pub('GET', '/api/public/me')).json.member.canRestore).toBe(true)
    expect((await pub('POST', '/api/public/restore', {})).status).toBe(200)
    expect((await syncMe('c@x.com')).status).toBe(200)
  })

  it('6 calendar months inactive: warned 30 days ahead, then stopped, then purged after 7 days; long_retain exempt', async () => {
    await owner()
    await login('idle@x.com')
    await login('kept@x.com')
    await api('POST', '/api/admin/member/action', OWNER, {
      email: 'kept@x.com',
      action: 'retain',
      on: true,
      confirm: true,
    })
    const deadline = addMonths(clock, 6)
    await lifecycleTick(env, deadline - 31 * DAY)
    expect(await mails('idle@x.com', 'inactive_warn')).toHaveLength(0)
    await lifecycleTick(env, deadline - 30 * DAY + 1000)
    expect(await mails('idle@x.com', 'inactive_warn')).toHaveLength(1)
    await lifecycleTick(env, deadline + 1000)
    const m = await H.raw
      .prepare('SELECT status, delete_reason FROM members WHERE email = ?')
      .bind('idle@x.com')
      .first<any>()
    expect(m).toMatchObject({ status: 'revoked', delete_reason: 'inactive' })
    expect(
      (await H.raw.prepare('SELECT status FROM members WHERE email = ?').bind('kept@x.com').first<any>()).status,
    ).toBe('active')
    await lifecycleTick(env, deadline + 7 * DAY + 2000)
    expect(await H.raw.prepare('SELECT 1 FROM members WHERE email = ?').bind('idle@x.com').first()).toBeNull()
  })

  it('turning long_retain off restarts the warning (no immediate stop)', async () => {
    await owner()
    await login('lr@x.com')
    await api('POST', '/api/admin/member/action', OWNER, {
      email: 'lr@x.com',
      action: 'retain',
      on: true,
      confirm: true,
    })
    const later = addMonths(clock, 12)
    clock = later
    await api('POST', '/api/admin/member/action', OWNER, {
      email: 'lr@x.com',
      action: 'retain',
      on: false,
      confirm: true,
    })
    await lifecycleTick(env, later + 1000)
    const m = await H.raw
      .prepare('SELECT status, inactive_warned_at FROM members WHERE email = ?')
      .bind('lr@x.com')
      .first<any>()
    expect(m.status).toBe('active')
    expect(m.inactive_warned_at).not.toBeNull()
    await lifecycleTick(env, later + 29 * DAY)
    expect(
      (await H.raw.prepare('SELECT status FROM members WHERE email = ?').bind('lr@x.com').first<any>()).status,
    ).toBe('active')
    await lifecycleTick(env, later + 30 * DAY + 2000)
    expect(
      (await H.raw.prepare('SELECT status FROM members WHERE email = ?').bind('lr@x.com').first<any>()).status,
    ).toBe('revoked')
  })
})

describe('restore safety', () => {
  it('a deleted account that comes back with a D1 restore is deleted again from the separate ledger', async () => {
    const { Miniflare } = await import('miniflare')
    const mf2 = new Miniflare({
      modules: true,
      script: 'export default { fetch() { return new Response("x") } }',
      d1Databases: { L: 'ledger-' + Math.random() },
    })
    const ledger = await mf2.getD1Database('L')
    await ledger
      .prepare(
        'CREATE TABLE deletions (tag TEXT PRIMARY KEY, account_id TEXT, reason TEXT, deleted_at INTEGER NOT NULL)',
      )
      .run()
    const lenv = { ...env, DELETIONS_DB: ledger as never }
    await owner()
    const me = await login('back@x.com')
    const acc = me.json.accountId
    await api('POST', '/api/admin/member/action', OWNER, { email: 'back@x.com', action: 'revoke', confirm: true })
    // snapshot = what a Time Travel restore would bring back
    const snapAcc = await H.raw.prepare('SELECT * FROM accounts WHERE id = ?').bind(acc).first<any>()
    const snapId = await H.raw.prepare('SELECT * FROM identities WHERE account_id = ?').bind(acc).first<any>()
    clock += 7 * DAY + 1
    expect((await purgeMember(lenv, clock, 'back@x.com')).ok).toBe(true)
    expect((await ledger.prepare('SELECT COUNT(*) AS n FROM deletions').first<any>()).n).toBe(1)
    await H.raw
      .prepare('INSERT INTO accounts (id, created_at, bank_fp) VALUES (?, ?, ?)')
      .bind(snapAcc.id, snapAcc.created_at, snapAcc.bank_fp)
      .run()
    await H.raw
      .prepare('INSERT INTO identities (provider, email, account_id, created_at, last_seen_at) VALUES (?, ?, ?, 0, 0)')
      .bind(snapId.provider, snapId.email, acc)
      .run()
    const again = await reconcileDeletions(lenv, clock)
    expect(again).toEqual([acc])
    expect(await H.raw.prepare('SELECT 1 FROM accounts WHERE id = ?').bind(acc).first()).toBeNull()
    await mf2.dispose()
  }, 30_000)
})

describe('mail, export, cron', () => {
  it('mail is queued idempotently and held (not faked as sent) when no provider is configured', async () => {
    await owner()
    await apply('mm@x.com')
    const r = await drainOutbox(env, clock)
    expect(r.sent).toBe(0)
    const s = await H.raw
      .prepare(`SELECT status FROM mail_outbox WHERE to_email = 'mm@x.com' AND template = 'apply_received'`)
      .first<any>()
    expect(s.status).toBe('held')
  })
  it('brevo provider: sends once, retries with back-off on failure', async () => {
    await owner()
    await apply('bv@x.com')
    let n = 0
    const f = (async () => {
      n++
      return n === 1
        ? new Response('down', { status: 500 })
        : new Response(JSON.stringify({ messageId: 'm1' }), { status: 201 })
    }) as unknown as typeof fetch
    const benv = {
      ...env,
      MAIL_PROVIDER: 'brevo',
      BREVO_API_KEY: 'k',
      MAIL_FROM: 'no-reply@ex.test',
      MAIL_SEND_AFTER: '1700000000001',
    }
    await H.raw.prepare(`UPDATE mail_outbox SET status = 'queued', next_at = 0 WHERE template <> 'otp'`).run()
    const a = await drainOutbox(benv, clock, { fetchImpl: f })
    expect(a.failed).toBeGreaterThan(0)
    const b = await drainOutbox(benv, clock + 2 * 60_000, { fetchImpl: f })
    expect(b.sent).toBeGreaterThan(0)
  })
  it('CSV cells cannot start a formula', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`)
    expect(csvCell('+1')).toBe("'+1")
    expect(csvCell('@a')).toBe("'@a")
  })
  it('cron runs every step without throwing', async () => {
    await owner()
    const r = await runCron(env, clock)
    expect(r.lifecycle).toBeDefined()
  })
})

describe('fix5 final: request-bound idempotency for admin Pro grants', () => {
  async function setup() {
    await login(OWNER)
    await login('idem@x.com')
    const ent = async () => (await api('GET', '/api/admin/member?email=idem%40x.com', OWNER)).json
    const rows = async () =>
      (
        await H.raw
          .prepare("SELECT id, duration_ms FROM pro_grants WHERE email = 'idem@x.com' AND state <> 'revoked'")
          .all<{ id: string; duration_ms: number }>()
      ).results
    return { ent, rows }
  }
  const g7 = (idem?: string, extra: Record<string, unknown> = {}) => ({
    email: 'idem@x.com',
    action: 'grant',
    kind: 'days',
    days: 7,
    reason: 'r',
    confirm: true,
    ...(idem === undefined ? { idem: undefined } : { idem }),
    ...extra,
  })

  it('same key + same request twice adds 7 days once (replay is 200, created:false)', async () => {
    const { rows } = await setup()
    const a = await api('POST', '/api/admin/pro', OWNER, g7('sameKey0001'))
    const b = await api('POST', '/api/admin/pro', OWNER, g7('sameKey0001'))
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    const r = await rows()
    expect(r.length).toBe(1)
    expect(r[0].duration_ms).toBe(7 * DAY)
    const au = (
      await H.raw
        .prepare("SELECT action FROM audit_log WHERE action LIKE 'pro.grant%' ORDER BY id")
        .all<{ action: string }>()
    ).results.map((x) => x.action)
    expect(au).toEqual(['pro.grant', 'pro.grant_replay'])
  })

  it('same key + different request is refused 409 and adds nothing', async () => {
    const { rows } = await setup()
    await api('POST', '/api/admin/pro', OWNER, g7('diffKey0001'))
    const b = await api('POST', '/api/admin/pro', OWNER, g7('diffKey0001', { days: 30 }))
    expect(b.status).toBe(409)
    expect(b.json.error).toBe('idem_conflict')
    const c = await api('POST', '/api/admin/pro', OWNER, { ...g7('diffKey0001'), email: 'other@x.com' })
    expect([404, 409]).toContain(c.status)
    expect((await rows()).length).toBe(1)
  })

  it('missing or malformed key is refused (no silent non-idempotent grant)', async () => {
    const { rows } = await setup()
    const a = await api('POST', '/api/admin/pro', OWNER, {
      email: 'idem@x.com',
      action: 'grant',
      kind: 'days',
      days: 7,
      confirm: true,
      idem: 'qa7d',
    })
    const b = await api('POST', '/api/admin/pro', OWNER, {
      email: 'idem@x.com',
      action: 'grant',
      kind: 'days',
      days: 7,
      confirm: true,
      idem: 'has space here',
    })
    const c = await api('POST', '/api/admin/pro', OWNER, {
      email: 'idem@x.com',
      action: 'grant',
      kind: 'days',
      days: 7,
      confirm: true,
      idem: null,
    })
    for (const x of [a, b, c]) {
      expect(x.status).toBe(400)
      expect(x.json.error).toBe('idem_required')
    }
    expect((await rows()).length).toBe(0)
  })

  it('timeout-style retry (first response lost) and 8 concurrent duplicates still add once', async () => {
    const { rows } = await setup()
    await api('POST', '/api/admin/pro', OWNER, g7('retryKey001')) // response "lost"
    await api('POST', '/api/admin/pro', OWNER, g7('retryKey001')) // client retries
    const res = await Promise.all(
      Array.from({ length: 8 }, () => api('POST', '/api/admin/pro', OWNER, g7('concKey0001'))),
    )
    expect(res.every((x) => x.status === 200)).toBe(true)
    const r = await rows()
    expect(r.length).toBe(2)
    expect(r.reduce((s, x) => s + x.duration_ms, 0)).toBe(14 * DAY)
    const k = (await H.raw.prepare('SELECT COUNT(*) AS n FROM admin_idem').first<{ n: number }>())!.n
    expect(k).toBe(2)
  })

  it('adjust (直接赠送) uses the same protection; distinct keys are distinct grants', async () => {
    const { rows } = await setup()
    const adj = (idem: string) => ({
      email: 'idem@x.com',
      action: 'adjust',
      source: 'admin',
      days: 3,
      reason: '补偿',
      confirm: true,
      idem,
    })
    await api('POST', '/api/admin/pro', OWNER, adj('adjKey00001'))
    await api('POST', '/api/admin/pro', OWNER, adj('adjKey00001'))
    await api('POST', '/api/admin/pro', OWNER, adj('adjKey00002'))
    expect((await rows()).length).toBe(2)
  })

  it('manual mail retry never resurrects policy-retired mail', async () => {
    await login(OWNER)
    const now = clock
    const ins = (id: string, status: string, err: string | null, created: number) =>
      H.raw
        .prepare(
          "INSERT INTO mail_outbox (id, to_email, template, params, dedupe_key, status, attempts, next_at, last_error, created_at) VALUES (?, 'x@real.com', 'apply_approved', '{}', ?, ?, 1, ?, ?, ?)",
        )
        .bind(id, 'k' + id, status, now, err, created)
        .run()
    await ins('m1', 'dead', 'test_address', now)
    await ins('m2', 'dead', 'not_allowlisted', now)
    await ins('m3', 'dead', 'before_mail_cutoff', now - 10 * DAY)
    await ins('m4', 'dead', 'cancelled_before_acceptance', now)
    await ins('m5', 'dead', 'brevo 500: boom', now - 10 * DAY) // before cutoff
    const r = await api('POST', '/api/admin/mail/retry', OWNER, {}, { MAIL_SEND_AFTER: String(now - DAY) })
    expect(r.status).toBe(200)
    const st = (
      await H.raw
        .prepare("SELECT id, status, last_error FROM mail_outbox WHERE id LIKE 'm_' ORDER BY id")
        .all<{ id: string; status: string; last_error: string }>()
    ).results
    expect(st.map((x) => [x.id, x.status, x.last_error])).toEqual([
      ['m1', 'dead', 'test_address'],
      ['m2', 'dead', 'not_allowlisted'],
      ['m3', 'dead', 'before_mail_cutoff'],
      ['m4', 'dead', 'cancelled_before_acceptance'],
      ['m5', 'dead', 'brevo 500: boom'],
    ])
  })
})

describe('fix5 final: referral reward is paid once even under concurrency', () => {
  it('10 concurrent payReferral/onActivated calls → exactly one 7-day grant', async () => {
    const { payReferral, onActivated } = await import('../../worker/platform/core')
    await login(OWNER)
    await login('referrer@x.com')
    await login('referee@x.com')
    await H.raw
      .prepare(
        "INSERT INTO referral_links (id, owner_email, token, status, created_at) VALUES ('rl1', 'referrer@x.com', 'tok1', 'active', ?)",
      )
      .bind(clock)
      .run()
    await H.raw
      .prepare(
        "INSERT INTO referrals (id, referee_email, referrer_email, link_id, status, created_at, activated_at) VALUES ('rf1', 'referee@x.com', 'referrer@x.com', 'rl1', 'approved', ?, ?)",
      )
      .bind(clock, clock)
      .run()
    await Promise.all([
      ...Array.from({ length: 5 }, () => payReferral(env as never, clock, 'rf1')),
      ...Array.from({ length: 5 }, () => onActivated(env as never, 'referee@x.com', clock)),
    ])
    const g = (
      await H.raw
        .prepare("SELECT duration_ms, idem_key FROM pro_grants WHERE email = 'referrer@x.com'")
        .all<{ duration_ms: number; idem_key: string }>()
    ).results
    expect(g).toEqual([{ duration_ms: 7 * DAY, idem_key: 'ref:rf1' }])
  })
})
