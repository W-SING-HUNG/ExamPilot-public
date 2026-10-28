#!/usr/bin/env node
/**
 * Bind an AI administrator (server side, via wrangler → D1). There is no web
 * endpoint that can create an admin.
 *
 *   node tools/web/ai-admin.mjs staging|production add <email>
 *   node tools/web/ai-admin.mjs staging|production list
 *
 * The email must already belong to an account (the person signed in through
 * Access at least once), so the admin is bound to a verified account id, never
 * to a bare email string.
 */
import { spawnSync } from 'node:child_process'
import { WRANGLER_VERSION } from './common.mjs'

const DB = { staging: 'exampilot-sync-test', production: 'exampilot-sync-prod' }
const [target, cmd, emailRaw] = process.argv.slice(2)
const die = (m) => {
  console.error('[ai-admin] ' + m)
  process.exit(1)
}
if (!DB[target] || !['add', 'list'].includes(cmd)) die('用法：ai-admin.mjs staging|production add <email> | list')

function sql(command) {
  const r = spawnSync(
    'npx',
    ['--yes', `wrangler@${WRANGLER_VERSION}`, 'd1', 'execute', DB[target], '--remote', '--json', '--command', command],
    {
      encoding: 'utf-8',
      env: {
        ...process.env,
        CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID || '',
        CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN || 'placeholder',
      },
    },
  )
  if (r.status !== 0) die('wrangler 失败：' + (r.stderr || r.stdout).slice(-500))
  return JSON.parse(r.stdout).flatMap((x) => x.results)
}

if (cmd === 'list') {
  for (const row of sql(
    `SELECT a.account_id, GROUP_CONCAT(i.email) AS emails, a.created_at FROM ai_admins a LEFT JOIN identities i ON i.account_id = a.account_id GROUP BY a.account_id`,
  ))
    console.log(row)
  process.exit(0)
}

const email = String(emailRaw || '')
  .trim()
  .toLowerCase()
if (!/^[^\s@'"]+@[^\s@'"]+\.[a-z]{2,}$/.test(email)) die('邮箱格式不对')
const rows = sql(`SELECT account_id FROM identities WHERE email = '${email}'`)
if (rows.length !== 1) die(`${email} 还没有账号（需要先用这个邮箱登录网站一次）`)
const id = rows[0].account_id
if (!/^acc_[0-9a-f]{24}$/.test(id)) die('账号 ID 异常')
sql(`INSERT OR IGNORE INTO ai_admins (account_id, created_at) VALUES ('${id}', ${Date.now()})`)
console.log(
  `[ai-admin] 已把 ${email}（${id}）设为 AI 管理员（${target}）。管理员身份不等于 AI 使用权，需要在「AI 权限管理」里单独开启。`,
)
