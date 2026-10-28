/**
 * Signed-in user endpoints (learning host): account, Pro status, referral link,
 * appeals, self-close (with fresh e-mail code + explicit confirmation).
 */
import { syncAccess } from './access'
import { audit, effectiveRole, entitlementOf, getMember, notice, setStatus, type Member } from './core'
import { drainOutbox, mailConfigured, enqueueMail } from './mail'
import {
  DAY,
  cleanText,
  fail,
  hmac,
  json,
  maskEmail,
  otpCode,
  readJson,
  rid,
  timingSafeEq,
  token,
  type PlatformEnv,
} from './util'

export interface MeCtx {
  env: PlatformEnv
  me: Member
  now: number
  fetchImpl?: typeof fetch
  bg: (p: Promise<unknown>) => void
}

async function referralLink(env: PlatformEnv, email: string, now: number, create: boolean) {
  let l = await env.DB.prepare(
    `SELECT id, token, status, created_at FROM referral_links WHERE owner_email = ? AND status <> 'retired' ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(email)
    .first<{ id: string; token: string; status: string; created_at: number }>()
  if (!l && create) {
    const id = rid('rl')
    const t = token(18)
    await env.DB.prepare(
      `INSERT INTO referral_links (id, owner_email, token, status, created_at) VALUES (?, ?, ?, 'active', ?)`,
    )
      .bind(id, email, t, now)
      .run()
    l = { id, token: t, status: 'active', created_at: now }
  }
  return l
}

export async function handleMe(req: Request, url: URL, c: MeCtx): Promise<Response | null> {
  const { env, me, now } = c
  const p = url.pathname
  const body = req.method === 'POST' ? await readJson(req) : null
  if (req.method === 'POST' && !body) return fail(400, 'bad_request')

  if (p === '/api/me/account' && req.method === 'GET') {
    const e = await entitlementOf(env, me.email, now)
    return json({
      ok: true,
      email: me.email,
      role: effectiveRole(env, me),
      memberSince: me.created_at,
      pro: {
        tier: e.tier,
        active: e.active,
        permanent: e.permanent,
        until: e.until,
        remainingMs: e.remainingMs,
        suspended: e.suspended,
        paused: e.paused,
      },
    })
  }

  if (p === '/api/me/referral' && req.method === 'GET') {
    const l = await referralLink(env, me.email, now, true)
    const rows = await env.DB.prepare(
      `SELECT r.id, r.referee_email, r.status, r.review, r.created_at, r.activated_at, a.status AS app_status, g.duration_ms, g.state AS grant_state, g.created_at AS granted_at,
              (SELECT status FROM appeals x WHERE x.referral_id = r.id) AS appeal
         FROM referrals r LEFT JOIN applications a ON a.id = r.application_id LEFT JOIN pro_grants g ON g.id = r.grant_id
        WHERE r.referrer_email = ? ORDER BY r.created_at DESC LIMIT 200`,
    )
      .bind(me.email)
      .all<Record<string, unknown>>()
    const list = rows.results.map((r) => ({
      id: r.id,
      who: maskEmail(String(r.referee_email).startsWith('deleted:') ? 'deleted@user' : String(r.referee_email)),
      appliedAt: r.created_at,
      review: r.app_status === 'approved' ? '已通过' : r.app_status === 'rejected' ? '未通过' : '待审核',
      status: r.status,
      reward:
        r.status === 'rewarded'
          ? { days: Number(r.duration_ms || 0) / DAY, at: r.granted_at }
          : r.status === 'held'
            ? { held: true }
            : r.status === 'void'
              ? { voided: true }
              : null,
      canAppeal: r.status === 'void' && r.review === 'invalid' && !r.appeal,
      appeal: r.appeal ?? null,
    }))
    const success = list.filter((x) => x.status === 'rewarded').length
    return json({
      ok: true,
      link: l
        ? {
            token: l.token,
            status: l.status,
            createdAt: l.created_at,
            url: `${env.WELCOME_URL || ''}/apply?ref=${l.token}`,
          }
        : null,
      total: list.length,
      success,
      rewardDays: list.reduce((s, x) => s + (x.reward && 'days' in x.reward ? Number(x.reward.days) : 0), 0),
      list,
    })
  }

  if (p === '/api/me/referral' && req.method === 'POST') {
    const action = String(body!.action || '')
    const l = await referralLink(env, me.email, now, true)
    if (!l) return fail(500, 'server_error')
    if (action === 'pause' || action === 'resume') {
      await env.DB.prepare('UPDATE referral_links SET status = ? WHERE id = ? AND status <> ?')
        .bind(action === 'pause' ? 'paused' : 'active', l.id, 'retired')
        .run()
    } else if (action === 'regenerate') {
      // old link stops working at once; applications already submitted keep their referral
      await env.DB.prepare(`UPDATE referral_links SET status = 'retired' WHERE owner_email = ? AND status <> 'retired'`)
        .bind(me.email)
        .run()
      await referralLink(env, me.email, now, true)
    } else return fail(400, 'bad_request')
    await audit(env, now, me.email, 'user', 'referral.' + action, l.id)
    return json({ ok: true })
  }

  if (p === '/api/me/appeal' && req.method === 'POST') {
    const id = String(body!.referralId || '')
    const text = cleanText(body!.text, 1000)
    if (!text) return fail(400, 'bad_request', '请填写申诉内容')
    const r = await env.DB.prepare(`SELECT id, status, review FROM referrals WHERE id = ? AND referrer_email = ?`)
      .bind(id, me.email)
      .first<{ id: string; status: string; review: string | null }>()
    if (!r || r.status !== 'void' || r.review !== 'invalid') return fail(409, 'not_appealable', '这条记录不能申诉')
    try {
      await env.DB.prepare(`INSERT INTO appeals (id, referral_id, email, text, created_at) VALUES (?, ?, ?, ?, ?)`)
        .bind(rid('ap'), id, me.email, text, now)
        .run()
    } catch {
      return fail(409, 'already', '每条记录只能申诉一次')
    }
    const a = await env.DB.prepare('SELECT id FROM appeals WHERE referral_id = ?').bind(id).first<{ id: string }>()
    await notice(env, now, {
      audience: 'super',
      kind: 'appeal',
      title: '新的推荐奖励申诉',
      body: maskEmail(me.email),
      ref: 'appeal:' + a?.id,
      dedupe: 'appeal:' + a?.id,
    })
    await audit(env, now, me.email, 'user', 'appeal.submit', a?.id ?? id)
    return json({ ok: true })
  }

  if (p === '/api/me/close/start' && req.method === 'POST') {
    const code = otpCode()
    const id = rid('otp')
    await env.DB.prepare(
      'INSERT INTO email_otps (id, email, purpose, code_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
      .bind(id, me.email, 'close', await hmac(env, `otp:${id}:${me.email}:${code}`), now, now + 10 * 60_000)
      .run()
    await enqueueMail(env, me.email, 'otp', { code, purpose: 'close' }, 'otp:' + id, now)
    if (env.PLATFORM_STAGE !== 'test' || mailConfigured(env)) {
      const d = mailConfigured(env)
        ? await drainOutbox(env, now, { fetchImpl: c.fetchImpl, dedupeKey: 'otp:' + id })
        : { sent: 0, deferred: 0 }
      if (!d.sent) {
        await env.DB.prepare('UPDATE email_otps SET used_at = ? WHERE id = ?').bind(now, id).run()
        await env.DB.prepare(
          `UPDATE mail_outbox SET status = 'dead', params = CASE WHEN template = 'otp' THEN '{"scrubbed":true}' ELSE params END, last_error = COALESCE(last_error, 'not_sent') WHERE dedupe_key = ? AND status <> 'sent'`,
        )
          .bind('otp:' + id)
          .run()
        return fail(
          503,
          d.deferred ? 'mail_quota' : 'mail_unavailable',
          d.deferred ? '今天的邮件发送额度已用完，请明天再试。' : '邮件服务暂未接通或发送失败，验证码无法发送。',
        )
      }
    }
    return json({ ok: true })
  }

  if (p === '/api/me/close/confirm' && req.method === 'POST') {
    if (body!.confirm !== '注销') return fail(400, 'confirm_required', '请输入“注销”确认')
    const code = typeof body!.code === 'string' ? body!.code.trim() : ''
    if (!/^\d{6}$/.test(code)) return fail(400, 'bad_code', '验证码不正确')
    const rows = await env.DB.prepare(
      `SELECT id, code_hash, attempts FROM email_otps WHERE email = ? AND purpose = 'close' AND used_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 3`,
    )
      .bind(me.email, now)
      .all<{ id: string; code_hash: string; attempts: number }>()
    let ok = false
    for (const r of rows.results) {
      if (r.attempts >= 5) continue
      if (timingSafeEq(await hmac(env, `otp:${r.id}:${me.email}:${code}`), r.code_hash)) {
        const u = await env.DB.prepare('UPDATE email_otps SET used_at = ? WHERE id = ? AND used_at IS NULL')
          .bind(now, r.id)
          .run()
        ok = !!u.meta?.changes
        break
      }
    }
    if (!ok) {
      for (const r of rows.results)
        await env.DB.prepare('UPDATE email_otps SET attempts = attempts + 1 WHERE id = ?').bind(r.id).run()
      return fail(400, 'bad_code', '验证码不正确或已过期')
    }
    const changed = await setStatus(env, now, me.email, 'closing', 'self_close')
    if (!changed) return fail(409, 'protected', '这个账号不能注销（最高管理员或状态已变化）')
    const m = await getMember(env, me.email)
    await enqueueMail(
      env,
      me.email,
      'closing_started',
      { deleteAfter: m?.delete_after },
      `closing:${me.email}:${now}`,
      now,
    )
    await audit(env, now, me.email, 'user', 'member.close_start', maskEmail(me.email))
    c.bg(syncAccess(env, now, { fetchImpl: c.fetchImpl }))
    c.bg(drainOutbox(env, now, { fetchImpl: c.fetchImpl, limit: 5 }))
    return json({ ok: true, deleteAfter: m?.delete_after, restoreUrl: `${env.WELCOME_URL || ''}/account` })
  }

  return null
}
