/**
 * User e-mail: templates + idempotent outbox + provider.
 *
 * - Every message is queued in mail_outbox with a dedupe_key (UNIQUE): enqueueing
 *   the same event twice is a no-op, so retries / double clicks never double-send.
 * - Delivery runs from the queue (immediately via waitUntil, and from cron), with
 *   exponential back-off; a failure never rolls back the account action it reports.
 * - Provider 'brevo' (free plan, REST API; key in the Worker Secret BREVO_API_KEY).
 *   Provider 'outbox' (default, staging tests): nothing leaves the system; rows stay
 *   'held' and are reported as "未接通真实发信".
 * - One-time codes are scrubbed from params once sent / expired.
 */
import { DAY, HOUR, escapeHtml, isUndeliverable, rid, type PlatformEnv } from './util'

export type MailTemplate =
  | 'otp'
  | 'apply_received'
  | 'apply_approved'
  | 'apply_rejected'
  | 'invite'
  | 'account_ready'
  | 'pro_remind3'
  | 'pro_remind1'
  | 'pro_expired'
  | 'inactive_warn'
  | 'closing_started'
  | 'access_revoked'
  | 'inactive_stopped'
  | 'delete_soon'
  | 'close_cancelled'

const PURPOSE_LABEL: Record<string, string> = {
  apply: '提交加入申请',
  status: '查询申请状态',
  invite: '接受邀请',
  restore: '撤销注销',
  close: '注销账号',
}

function fmtDate(ms: number) {
  return new Date(ms + 8 * HOUR).toISOString().slice(0, 16).replace('T', ' ') + '（北京时间）'
}

export function renderMail(
  env: PlatformEnv,
  template: MailTemplate,
  p: Record<string, unknown>,
): { subject: string; text: string } {
  const app = env.APP_URL || ''
  const welcome = env.WELCOME_URL || ''
  const s = (k: string) => String(p[k] ?? '')
  switch (template) {
    case 'otp':
      return {
        subject: `ExamPilot 验证码 ${s('code')}`,
        text: `你的验证码是：${s('code')}\n\n用途：${PURPOSE_LABEL[s('purpose')] || '验证邮箱'}。10 分钟内有效，只能使用一次。\n这是 ExamPilot 欢迎页（申请、查询、邀请、注销）用的验证码，不能用来登录学习站；登录学习站的验证码由 Cloudflare Access 单独发送。\n如果不是你本人操作，请忽略这封邮件。`,
      }
    case 'apply_received':
      return {
        subject: 'ExamPilot：已收到你的加入申请',
        text: `我们已收到你的加入申请（${fmtDate(Number(p.at))}）。\n审核结果会发到这个邮箱。也可以随时在这里查询：${welcome}/status`,
      }
    case 'apply_approved':
      return {
        subject: 'ExamPilot：你的申请已通过',
        text: `你的加入申请已通过，账号已开通（Standard）。\n登录地址：${app}\n用这个邮箱接收验证码即可登录。`,
      }
    case 'apply_rejected':
      return {
        subject: 'ExamPilot：申请结果通知',
        text: `很抱歉，你这次的加入申请未通过。${p.publicNote ? `\n说明：${s('publicNote')}` : ''}\n${s('reapplyAt') ? `你可以在 ${fmtDate(Number(p.reapplyAt))} 之后重新申请。` : ''}`,
      }
    case 'invite':
      return {
        subject: '你收到了 ExamPilot 的邀请',
        text: `你被邀请加入 ExamPilot 习概复习系统。\n接受邀请：${welcome}/invite#${s('token')}\n邀请 7 天内有效（到 ${fmtDate(Number(p.expiresAt))}）。接受时需要验证这个邮箱。`,
      }
    case 'account_ready':
      return {
        subject: 'ExamPilot：账号已开通',
        text: `你的 ExamPilot 账号已开通（Standard）。\n登录地址：${app}\n用这个邮箱接收验证码即可登录。`,
      }
    case 'pro_remind3':
    case 'pro_remind1':
      return {
        subject: `ExamPilot Pro 将在 ${template === 'pro_remind3' ? '3' : '1'} 天内到期`,
        text: `你的 Pro 权益将于 ${fmtDate(Number(p.until))} 到期，之后自动转为 Standard。\n学习数据不会受影响；AI 历史仍可只读查看。`,
      }
    case 'pro_expired':
      return {
        subject: 'ExamPilot Pro 已到期',
        text: `你的 Pro 权益已于 ${fmtDate(Number(p.until))} 到期，账号已转为 Standard。\n学习数据都在；历史 AI 对话可在个人中心只读查看。`,
      }
    case 'inactive_warn':
      return {
        subject: 'ExamPilot：账号长期未登录提醒',
        text: `你的 ExamPilot 账号已经很久没有登录。\n如果在 ${fmtDate(Number(p.deadline))} 前仍未登录，账号会被停用，停用 7 天后学习数据会被删除。\n登录一次即可保留：${app}`,
      }
    case 'closing_started':
      return {
        subject: 'ExamPilot：账号注销已开始',
        text: `你的账号已停用，进入 7 天冷静期。\n${fmtDate(Number(p.deleteAfter))} 之后，学习数据会被删除。\n如果想撤销注销，请在此之前访问：${welcome}/account`,
      }
    case 'inactive_stopped':
      return {
        subject: 'ExamPilot：账号因长期未登录已停用',
        text: `你的 ExamPilot 账号因连续 6 个月未登录，已经停用。\n学习数据会保留到 ${fmtDate(Number(p.deleteAfter))}，之后删除。如需继续使用，请在此之前联系管理员或重新申请：${welcome}/apply`,
      }
    case 'delete_soon':
      return {
        subject: 'ExamPilot：账号数据即将删除',
        text: `你的 ExamPilot 账号已停用，学习数据将在 ${fmtDate(Number(p.deleteAfter))} 删除。${p.reason === 'self_close' ? `\n如果想撤销注销，请在此之前访问：${welcome}/account` : ''}`,
      }
    case 'close_cancelled':
      return {
        subject: 'ExamPilot：已撤销注销',
        text: `你的账号注销已撤销，账号和学习数据已恢复。\n登录地址：${app}`,
      }
    case 'access_revoked':
      return {
        subject: 'ExamPilot：账号访问已停用',
        text: `你的 ExamPilot 访问资格已被管理员停用。账号数据会保留到 ${fmtDate(Number(p.deleteAfter))}，之后删除。`,
      }
  }
}

export async function enqueueMail(
  env: PlatformEnv,
  to: string,
  template: MailTemplate,
  params: Record<string, unknown>,
  dedupeKey: string,
  now: number,
) {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO mail_outbox (id, to_email, template, params, dedupe_key, status, next_at, created_at)
     VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)`,
  )
    .bind(rid('mail'), to, template, JSON.stringify(params), dedupeKey, now, now)
    .run()
}

export function mailConfigured(env: PlatformEnv): boolean {
  if (env.PLATFORM_STAGE === 'staging' && mailAllowlist(env).size === 0) return false // staging never mails without an explicit test-recipient list
  return env.MAIL_PROVIDER === 'brevo' && !!env.BREVO_API_KEY && !!env.MAIL_FROM && mailCutoff(env) > 0
}
/**
 * Optional recipient allow-list (comma-separated exact addresses, 2026-10-27).
 * Required on staging: only explicitly allow-listed test inboxes receive real mail;
 * anything else is retired as 'not_allowlisted' and can never be sent later.
 */
export function mailAllowlist(env: PlatformEnv): Set<string> {
  return new Set(
    String(env.MAIL_ALLOWLIST || '')
      .split(',')
      .map((x) => x.trim().toLowerCase())
      .filter((x) => x.includes('@')),
  )
}
/**
 * Messages created before this moment are NEVER handed to the provider (2026-10-27).
 * Set at the moment real sending is switched on, so nothing queued, held or failed during the
 * test period (invites, approvals, codes) can be sent out later by surprise. Unset = no sending.
 */
export function mailCutoff(env: PlatformEnv): number {
  const n = Number(env.MAIL_SEND_AFTER || 0)
  return Number.isFinite(n) && n > 1_700_000_000_000 ? n : 0
}
/** last_error values of mail retired on purpose (never retried, never sent later). */
export const RETIRED_REASONS = [
  'test_address',
  'not_allowlisted',
  'before_mail_cutoff',
  'stale',
  'expired_while_held',
  'cancelled_before_acceptance',
  'probe',
  'mail_not_configured',
]
/** Brevo free plan: 300/day. Keep a margin; the rest waits for the next Beijing day. */
export function mailDailyCap(env: PlatformEnv): number {
  const n = Number(env.MAIL_DAILY_CAP || 0)
  return n > 0 ? Math.min(n, 300) : 250
}
/** a message older than this is stale and dropped instead of sent (codes: 10 min) */
const MAX_AGE: Partial<Record<MailTemplate, number>> = { otp: 10 * 60_000 }
const DEFAULT_MAX_AGE = 3 * DAY
function beijingDayStart(now: number) {
  return Math.floor((now + 8 * HOUR) / DAY) * DAY - 8 * HOUR
}

async function sendBrevo(env: PlatformEnv, to: string, subject: string, text: string, fetchImpl: typeof fetch) {
  const html = `<div style="font:15px/1.7 -apple-system,'PingFang SC','Microsoft YaHei',sans-serif;color:#1d2433;max-width:560px">${escapeHtml(text).replace(/\n/g, '<br>')}<hr style="border:none;border-top:1px solid #e3e6ec;margin:20px 0"><div style="color:#7b8494;font-size:12px">ExamPilot 习概复习系统 · 系统邮件，请勿直接回复</div></div>`
  const r = await fetchImpl('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': env.BREVO_API_KEY!, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      sender: { email: env.MAIL_FROM, name: env.MAIL_FROM_NAME || 'ExamPilot' },
      to: [{ email: to }],
      subject,
      textContent: text,
      htmlContent: html,
      tags: ['exampilot'],
    }),
  })
  const body = await r.text()
  if (!r.ok) throw new Error(`brevo ${r.status}: ${body.slice(0, 200)}`)
  try {
    return String(JSON.parse(body).messageId || '')
  } catch {
    return ''
  }
}

const BACKOFF = [60_000, 5 * 60_000, 30 * 60_000, 2 * HOUR, 6 * HOUR]

/** Deliver due messages. Returns counts. Safe to run concurrently (claims rows atomically). */
export async function drainOutbox(
  env: PlatformEnv,
  now: number,
  opts: { limit?: number; fetchImpl?: typeof fetch; dedupeKey?: string } = {},
) {
  const limit = opts.limit ?? 20
  const doFetch = opts.fetchImpl ?? fetch
  const out = { sent: 0, failed: 0, held: 0, deferred: 0, dropped: 0 }
  // scrub codes of anything finished or older than a day
  await env.DB.prepare(
    `UPDATE mail_outbox SET params = '{"scrubbed":true}' WHERE template = 'otp' AND params NOT LIKE '%scrubbed%'
       AND (status IN ('sent','dead') OR created_at < ?)`,
  )
    .bind(now - DAY)
    .run()
  const due = await (
    opts.dedupeKey
      ? env.DB.prepare(
          `SELECT id, to_email, template, params, attempts, created_at FROM mail_outbox WHERE dedupe_key = ? AND status IN ('queued','failed')`,
        ).bind(opts.dedupeKey)
      : env.DB.prepare(
          `SELECT id, to_email, template, params, attempts, created_at FROM mail_outbox
          WHERE status IN ('queued','failed') AND next_at <= ? ORDER BY next_at LIMIT ?`,
        ).bind(now, limit)
  ).all<{ id: string; to_email: string; template: MailTemplate; params: string; attempts: number }>()
  let sentToday = -1
  for (const m of due.results) {
    if (isUndeliverable(m.to_email)) {
      // reserved namespaces and example.* addresses: recorded, never sent
      await env.DB.prepare(
        `UPDATE mail_outbox SET status = 'dead', params = CASE WHEN template = 'otp' THEN '{"scrubbed":true}' ELSE params END, last_error = 'test_address' WHERE id = ? AND status IN ('queued','failed')`,
      )
        .bind(m.id)
        .run()
      out.dropped++
      continue
    }
    const allow = mailAllowlist(env)
    if (allow.size && !allow.has(m.to_email.toLowerCase())) {
      await env.DB.prepare(
        `UPDATE mail_outbox SET status = 'dead', params = CASE WHEN template = 'otp' THEN '{"scrubbed":true}' ELSE params END, last_error = 'not_allowlisted' WHERE id = ? AND status IN ('queued','failed')`,
      )
        .bind(m.id)
        .run()
      out.dropped++
      continue
    }
    if (!mailConfigured(env)) {
      await env.DB.prepare(
        `UPDATE mail_outbox SET status = 'held', last_error = 'mail_not_configured' WHERE id = ? AND status IN ('queued','failed')`,
      )
        .bind(m.id)
        .run()
      out.held++
      continue
    }
    const created = (m as { created_at?: number }).created_at ?? 0
    if (created < mailCutoff(env)) {
      await env.DB.prepare(
        `UPDATE mail_outbox SET status = 'dead', params = CASE WHEN template = 'otp' THEN '{"scrubbed":true}' ELSE params END, last_error = 'before_mail_cutoff' WHERE id = ? AND status IN ('queued','failed')`,
      )
        .bind(m.id)
        .run()
      out.dropped++
      continue
    }
    if (now - created > (MAX_AGE[m.template] ?? DEFAULT_MAX_AGE)) {
      await env.DB.prepare(
        `UPDATE mail_outbox SET status = 'dead', params = CASE WHEN template = 'otp' THEN '{"scrubbed":true}' ELSE params END, last_error = 'stale' WHERE id = ? AND status IN ('queued','failed')`,
      )
        .bind(m.id)
        .run()
      out.dropped++
      continue
    }
    if (sentToday < 0) {
      const c = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM mail_outbox WHERE status IN ('sent','sending') AND sent_at >= ?`,
      )
        .bind(beijingDayStart(now))
        .first<{ n: number }>()
      sentToday = c?.n ?? 0
    }
    if (sentToday >= mailDailyCap(env)) {
      // daily free quota reached: wait for the next Beijing day (never pay, never drop silently)
      await env.DB.prepare(
        `UPDATE mail_outbox SET next_at = ?, last_error = 'daily_cap' WHERE id = ? AND status IN ('queued','failed')`,
      )
        .bind(beijingDayStart(now) + DAY + 5 * 60_000, m.id)
        .run()
      out.deferred++
      continue
    }
    const claim = await env.DB.prepare(
      `UPDATE mail_outbox SET status = 'sending', attempts = attempts + 1, next_at = ? WHERE id = ? AND status IN ('queued','failed')`,
    )
      .bind(now, m.id)
      .run()
    if (!claim.meta?.changes) continue
    try {
      const { subject, text } = renderMail(env, m.template, JSON.parse(m.params))
      const pid = await sendBrevo(env, m.to_email, subject, text, doFetch)
      await env.DB.prepare(
        `UPDATE mail_outbox SET status = 'sent', params = CASE WHEN template = 'otp' THEN '{"scrubbed":true}' ELSE params END, sent_at = ?, provider_id = ?, last_error = NULL WHERE id = ?`,
      )
        .bind(now, pid, m.id)
        .run()
      out.sent++
      sentToday++
    } catch (e) {
      const attempts = m.attempts + 1
      const dead = attempts >= BACKOFF.length + 1
      await env.DB.prepare(`UPDATE mail_outbox SET status = ?, next_at = ?, last_error = ? WHERE id = ?`)
        .bind(
          dead ? 'dead' : 'failed',
          now + (BACKOFF[attempts - 1] ?? 6 * HOUR),
          String((e as Error).message).slice(0, 300),
          m.id,
        )
        .run()
      out.failed++
    }
  }
  // stuck 'sending' rows (isolate died mid-send) go back to the queue after 10 min
  await env.DB.prepare(`UPDATE mail_outbox SET status = 'failed', next_at = ? WHERE status = 'sending' AND next_at < ?`)
    .bind(now, now - 10 * 60_000)
    .run()
  return out
}

/** Move 'held' mail back into the queue (after the provider is configured). */
export async function releaseHeld(env: PlatformEnv, now: number) {
  // only mail created after the cutoff can ever be released; older held mail is retired
  const cut = mailCutoff(env)
  await env.DB.prepare(
    `UPDATE mail_outbox SET status = 'dead', params = CASE WHEN template = 'otp' THEN '{"scrubbed":true}' ELSE params END, last_error = 'before_mail_cutoff' WHERE status = 'held' AND created_at < ?`,
  )
    .bind(cut || now)
    .run()
  await env.DB.prepare(
    `UPDATE mail_outbox SET status = 'queued', next_at = ? WHERE status = 'held' AND template <> 'otp' AND created_at >= ?`,
  )
    .bind(now, cut || now)
    .run()
  // codes held while mail was off are useless by now
  await env.DB.prepare(
    `UPDATE mail_outbox SET status = 'dead', params = CASE WHEN template = 'otp' THEN '{"scrubbed":true}' ELSE params END, last_error = 'expired_while_held' WHERE status = 'held' AND template = 'otp' AND created_at < ?`,
  )
    .bind(now - 10 * 60_000)
    .run()
}
