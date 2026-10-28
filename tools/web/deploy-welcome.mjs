#!/usr/bin/env node
/**
 * Build + deploy the public welcome Worker with the application portal.
 *   node tools/web/deploy-welcome.mjs staging      → exampilot-welcome-staging (D1 exampilot-sync-test)
 *   node tools/web/deploy-welcome.mjs production   → refused unless EXAMPILOT_WELCOME_PROD_OK=1 (needs the owner's approval)
 *   add --dry-run to only build.
 * Landing HTML is taken from ../welcome/index.html (the live landing page source);
 * the login buttons are pointed at the target learning site and an "申请加入" entry is added.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { ROOT, STATE_DIR, WRANGLER_VERSION } from './common.mjs'

const which = process.argv[2]
const dry = process.argv.includes('--dry-run')
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID || ''
const SUBDOMAIN = process.env.EXAMPILOT_WORKERS_SUBDOMAIN || ''
const T = {
  staging: {
    name: 'exampilot-welcome-staging',
    app: `https://exampilot-sync-staging.${SUBDOMAIN}.workers.dev`,
    db: { name: 'exampilot-sync-test', id: process.env.EXAMPILOT_STAGING_SYNC_DB_ID || '' },
  },
  production: {
    name: 'exampilot-welcome',
    app: `https://exampilot-class.${SUBDOMAIN}.workers.dev`,
    db: { name: 'exampilot-sync-prod', id: process.env.EXAMPILOT_PROD_SYNC_DB_ID || '' },
  },
}[which]
if (!T) {
  console.error('用法：deploy-welcome.mjs staging|production [--dry-run]')
  process.exit(1)
}
if (which === 'production' && process.env.EXAMPILOT_WELCOME_PROD_OK !== '1') {
  console.error('[deploy-welcome] 正式欢迎站需要用户单独批准（EXAMPILOT_WELCOME_PROD_OK=1）')
  process.exit(1)
}
const WELCOME_SRC = path.resolve(ROOT, '../welcome')
const workersHost = `${T.name}.${process.env.EXAMPILOT_WORKERS_SUBDOMAIN || ''}.workers.dev`
// Custom domain: allow-listed per target; only the CEO-approved staging host (2026-10-26), production none.
// Enabled with EXAMPILOT_STAGING_DOMAIN=1; otherwise workers.dev only, as before.
const CUSTOM = {
  staging: { welcome: 'staging.getexampilot.site', app: 'https://app-staging.getexampilot.site' },
  production: { welcome: 'getexampilot.site', www: 'www.getexampilot.site', app: 'https://app.getexampilot.site' },
}
if (which !== 'staging' && process.env.EXAMPILOT_STAGING_DOMAIN) {
  console.error('[deploy-welcome] EXAMPILOT_STAGING_DOMAIN 只用于 staging')
  process.exit(1)
}
if (which !== 'production' && process.env.EXAMPILOT_PROD_DOMAIN) {
  console.error('[deploy-welcome] EXAMPILOT_PROD_DOMAIN 只用于 production')
  process.exit(1)
}
if (which === 'production' && process.env.EXAMPILOT_MAIL_ALLOWLIST) {
  console.error('[deploy-welcome] 生产不得带 staging 收件白名单')
  process.exit(1)
}
// production domains only with EXAMPILOT_PROD_DOMAIN=1 (CEO launch approval)
const dom =
  which === 'staging' && process.env.EXAMPILOT_STAGING_DOMAIN === '1'
    ? CUSTOM.staging
    : which === 'production' && process.env.EXAMPILOT_PROD_DOMAIN === '1'
      ? CUSTOM.production
      : null
if (dom) T.app = dom.app
const welcomeUrl = `https://${dom ? dom.welcome : workersHost}`
// Turnstile: strict allow-list of this target's own welcome hosts; an override may only narrow it.
const tsAllowed = [workersHost, ...(dom ? [dom.welcome] : [])]
const tsHosts = (process.env.EXAMPILOT_TURNSTILE_HOSTNAME || tsAllowed.join(','))
  .split(',')
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean)
for (const h of tsHosts)
  if (!tsAllowed.includes(h)) {
    console.error(`[deploy-welcome] Turnstile 主机名 ${h} 不在允许列表：${tsAllowed.join(', ')}`)
    process.exit(1)
  }
if (!dry && !process.env.EXAMPILOT_TURNSTILE_SITEKEY) {
  console.error('[deploy-welcome] 缺少 EXAMPILOT_TURNSTILE_SITEKEY（真实 Turnstile site key），拒绝部署')
  process.exit(1)
}

let landing = readFileSync(path.join(WELCOME_SRC, 'index.html'), 'utf8')
landing = landing.replaceAll(`https://exampilot-class.${SUBDOMAIN}.workers.dev/`, T.app + '/')
const applyCss = `<style>.apply-entry{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;min-height:48px;margin-top:12px;border-radius:12px;border:1.5px solid var(--blue);color:var(--blue-d);text-decoration:none;font-weight:600;font-size:16px;background:#fff}.apply-entry:hover{background:var(--soft)}.apply-note{margin:8px 0 0;text-align:center;font-size:13px;color:var(--ink-3)}.apply-inline{display:inline-flex;margin-top:12px;color:var(--blue-d);font-weight:600}</style>`
landing = landing.replace('</head>', applyCss + '</head>')
const firstBtn = landing.indexOf('<a class="btn"')
const firstEnd = landing.indexOf('</a>', firstBtn) + 4
if (firstBtn < 0) throw new Error('landing: login button not found')
landing =
  landing.slice(0, firstEnd) +
  `\n      <a class="apply-entry" href="/apply">还没有受邀？申请加入</a>\n      <p class="apply-note">已申请过？<a href="/status">查询申请状态</a></p>` +
  landing.slice(firstEnd)
const lastBtn = landing.lastIndexOf('<a class="btn"')
const lastEnd = landing.indexOf('</a>', lastBtn) + 4
landing =
  landing.slice(0, lastEnd) +
  `<br><a class="apply-inline" href="/apply">没有邀请？申请加入 →</a>` +
  landing.slice(lastEnd)

const pages = {
  '/': { type: 'text/html; charset=utf-8', body: landing },
  '/portal.html': {
    type: 'text/html; charset=utf-8',
    body: readFileSync(path.join(ROOT, 'worker/welcome/portal.html'), 'utf8'),
  },
  '/portal.js': {
    type: 'text/javascript; charset=utf-8',
    body: readFileSync(path.join(ROOT, 'worker/welcome/portal.js'), 'utf8'),
  },
  '/logo.svg': {
    type: 'image/svg+xml',
    body: readFileSync(path.join(WELCOME_SRC, 'logo.svg'), 'utf8'),
    cache: 'public, max-age=3600',
  },
  '/logo.png': {
    type: 'image/png',
    body: readFileSync(path.join(WELCOME_SRC, 'logo.png')).toString('base64'),
    b64: true,
    cache: 'public, max-age=3600',
  },
}
const imgDir = path.join(WELCOME_SRC, 'img')
if (existsSync(imgDir))
  for (const f of readdirSync(imgDir))
    pages['/img/' + f] = {
      type: f.endsWith('.png') ? 'image/png' : f.endsWith('.jpg') ? 'image/jpeg' : 'image/webp',
      body: readFileSync(path.join(imgDir, f)).toString('base64'),
      b64: true,
      cache: 'public, max-age=3600',
    }
writeFileSync(path.join(ROOT, 'worker/welcome/pages.generated.js'), `export const PAGES = ${JSON.stringify(pages)}\n`)

const dir = path.join(STATE_DIR, 'welcome-' + which)
mkdirSync(dir, { recursive: true })
const config = path.join(dir, 'wrangler.json')
writeFileSync(
  config,
  JSON.stringify(
    {
      name: T.name,
      main: path.join(ROOT, 'worker/welcome/entry.ts'),
      account_id: ACCOUNT,
      compatibility_date: '2026-10-01',
      workers_dev: true,
      preview_urls: false,
      ...(dom
        ? {
            routes: [
              { pattern: dom.welcome, custom_domain: true },
              ...(dom.www ? [{ pattern: dom.www, custom_domain: true }] : []),
            ],
          }
        : {}),
      observability: { enabled: false },
      d1_databases: [{ binding: 'DB', database_name: T.db.name, database_id: T.db.id }],
      vars: {
        WELCOME_URL: welcomeUrl,
        APP_URL: T.app,
        MAIL_PROVIDER: process.env.EXAMPILOT_MAIL_PROVIDER || 'outbox',
        MAIL_FROM: process.env.EXAMPILOT_MAIL_FROM || '',
        MAIL_FROM_NAME: 'ExamPilot',
        // real sending only for mail created after this moment (set when Brevo is switched on); empty = never send
        MAIL_SEND_AFTER: process.env.EXAMPILOT_MAIL_SEND_AFTER || '',
        MAIL_DAILY_CAP: process.env.EXAMPILOT_MAIL_DAILY_CAP || '250',
        // staging: only these exact test inboxes ever get real mail (empty on staging = no sending)
        MAIL_ALLOWLIST: process.env.EXAMPILOT_MAIL_ALLOWLIST || '',
        TURNSTILE_SITEKEY: process.env.EXAMPILOT_TURNSTILE_SITEKEY || '',
        TURNSTILE_HOSTNAME: tsHosts.join(','),
        PLATFORM_STAGE: which,
      },
    },
    null,
    2,
  ),
)
console.log('[deploy-welcome] 构建完成', Object.keys(pages).length, '个页面 →', config)
if (dry) process.exit(0)
const r = spawnSync('npx', ['--yes', `wrangler@${WRANGLER_VERSION}`, 'deploy', '--config', config], {
  cwd: ROOT,
  stdio: 'inherit',
  env: {
    ...process.env,
    CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
    CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN || 'placeholder',
  },
})
process.exit(r.status ?? 1)
