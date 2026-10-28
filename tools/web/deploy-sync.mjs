#!/usr/bin/env node
/**
 * Deploy the web app + sync API Worker.
 *
 *   node tools/web/deploy-sync.mjs staging      → exampilot-sync-staging + D1 exampilot-sync-test
 *   node tools/web/deploy-sync.mjs production   → exampilot-class        + D1 exampilot-sync-prod
 *   add --migrate   apply worker/migrations/*.sql to the target D1 first
 *   add --dry-run   build the bundle and config only
 *
 * Gates (any failure aborts before upload):
 *  - dist-web/ must still hash to the manifest written by web:verify (full bank)
 *  - the target host must ALREADY answer anonymous requests with an Access
 *    302 to /cdn-cgi/access/login/<host> (never deploy the bank unprotected)
 *  - production additionally requires EXAMPILOT_DEPLOY_CONFIRM=<full fingerprint>
 * After upload the Access gate is re-checked; on failure the rollback command is printed.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { ROOT, OUT_DIR, STATE_DIR, MANIFEST, WRANGLER_VERSION, listFiles, hashDir } from './common.mjs'
// Commit the deployed code was built from (+ "-dirty" when the tree had local edits).
const gitOut = (a) => spawnSync('git', a, { cwd: ROOT, encoding: 'utf8' }).stdout?.trim() || ''
const BUILD_COMMIT =
  (gitOut(['rev-parse', '--short=7', 'HEAD']) || 'unknown') +
  (gitOut(['status', '--porcelain', '--untracked-files=no']) ? '-dirty' : '')

const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID || ''
const SUBDOMAIN = process.env.EXAMPILOT_WORKERS_SUBDOMAIN || ''

const PLATFORM = {
  staging: {
    deletions: { name: 'exampilot-deletions-staging', id: process.env.EXAMPILOT_STAGING_DELETIONS_DB_ID || '' },
    media: { name: 'exampilot-media-staging', id: process.env.EXAMPILOT_STAGING_MEDIA_DB_ID || '' },
    policy: process.env.EXAMPILOT_STAGING_ACCESS_POLICY_ID || '',
    app: process.env.EXAMPILOT_STAGING_ACCESS_APP_ID || '',
    welcome: `https://exampilot-welcome-staging.${SUBDOMAIN}.workers.dev`,
  },
  // production deletions/media D1s are created only at launch (CEO approval); their ids are passed in, never guessed
  production: {
    ...(process.env.EXAMPILOT_PROD_DELETIONS_DB_ID
      ? { deletions: { name: 'exampilot-deletions-prod', id: process.env.EXAMPILOT_PROD_DELETIONS_DB_ID } }
      : {}),
    ...(process.env.EXAMPILOT_PROD_MEDIA_DB_ID
      ? { media: { name: 'exampilot-media-prod', id: process.env.EXAMPILOT_PROD_MEDIA_DB_ID } }
      : {}),
    policy: process.env.EXAMPILOT_PROD_ACCESS_POLICY_ID || '',
    app: process.env.EXAMPILOT_PROD_ACCESS_APP_ID || '',
    welcome: `https://exampilot-welcome.${SUBDOMAIN}.workers.dev`,
  },
}
const TARGETS = {
  staging: {
    name: 'exampilot-sync-staging',
    db: { name: 'exampilot-sync-test', id: process.env.EXAMPILOT_STAGING_SYNC_DB_ID || '' },
    aud: process.env.EXAMPILOT_STAGING_ACCESS_AUD || '',
    // Staging talks to the mock gateway Worker through a service binding (no
    // public URL). EXAMPILOT_STAGING_REAL_AI=1 points it at the real gateway.
    ai:
      process.env.EXAMPILOT_STAGING_REAL_AI === '1'
        ? { base: process.env.EXAMPILOT_AI_BASE_URL || '', model: process.env.EXAMPILOT_AI_MODEL || 'gemini-3.8-flash' }
        : { base: 'https://mock-gateway.invalid/v1', model: 'mock-grok', upstream: 'exampilot-ai-mock' },
  },
  production: {
    name: 'exampilot-class',
    db: { name: 'exampilot-sync-prod', id: process.env.EXAMPILOT_PROD_SYNC_DB_ID || '' },
    aud: process.env.EXAMPILOT_PROD_ACCESS_AUD || '',
    ai: { base: process.env.EXAMPILOT_AI_BASE_URL || '', model: process.env.EXAMPILOT_AI_MODEL || 'gemini-3.8-flash' },
  },
}
const TEAM = process.env.EXAMPILOT_ACCESS_TEAM_URL || ''

const which = process.argv[2]
const t = TARGETS[which]
const die = (m) => {
  console.error(`[deploy-sync] 已中止：${m}`)
  process.exit(1)
}
if (!t) die('用法：deploy-sync.mjs staging|production [--migrate] [--dry-run]')
const host = `${t.name}.${SUBDOMAIN}.workers.dev`
const dry = process.argv.includes('--dry-run')
// Custom domains: an explicit allow-list per target. Only the CEO-approved staging host exists (2026-10-26);
// production has none. Enabled with EXAMPILOT_STAGING_DOMAIN=1 (otherwise workers.dev only, as before).
// Production hosts only with EXAMPILOT_PROD_DOMAIN=1 (CEO launch approval).
const CUSTOM_HOSTS = { staging: ['app-staging.getexampilot.site'], production: ['app.getexampilot.site'] }
const WELCOME_HOST = { staging: 'staging.getexampilot.site', production: 'getexampilot.site' }
if (which !== 'staging' && process.env.EXAMPILOT_STAGING_DOMAIN) die('EXAMPILOT_STAGING_DOMAIN 只用于 staging')
if (which !== 'production' && process.env.EXAMPILOT_PROD_DOMAIN) die('EXAMPILOT_PROD_DOMAIN 只用于 production')
const useDomain =
  (which === 'staging' && process.env.EXAMPILOT_STAGING_DOMAIN === '1') ||
  (which === 'production' && process.env.EXAMPILOT_PROD_DOMAIN === '1')
if (which === 'production' && !dry && !(PLATFORM.production.deletions && PLATFORM.production.media))
  die('生产需要 EXAMPILOT_PROD_DELETIONS_DB_ID 和 EXAMPILOT_PROD_MEDIA_DB_ID')
if (which === 'production' && process.env.EXAMPILOT_MAIL_ALLOWLIST) die('生产不得带 staging 收件白名单')
const customHosts = useDomain ? CUSTOM_HOSTS[which] : []
const appUrl = useDomain ? `https://${customHosts[0]}` : `https://${host}`
const welcomeUrl = useDomain ? `https://${WELCOME_HOST[which]}` : PLATFORM[which].welcome

if (!existsSync(MANIFEST)) die('没有通过校验的 dist-web/')
const manifest = JSON.parse(readFileSync(MANIFEST, 'utf-8'))
if (manifest.mode !== 'full') die('不是完整题库构建')
if (hashDir(OUT_DIR) !== manifest.distHash) die('dist-web/ 在校验后被改动过')
const fp = manifest.hashes.full
if (which === 'production' && process.env.EXAMPILOT_DEPLOY_CONFIRM !== fp)
  die('生产部署需要 EXAMPILOT_DEPLOY_CONFIRM=<完整指纹>')

async function locked(p, h = host) {
  const r = await fetch(`https://${h}${p}`, { redirect: 'manual' })
  const loc = r.headers.get('location') || ''
  let ok = false
  try {
    const u = new URL(loc)
    ok = r.status === 302 && u.host.endsWith('.cloudflareaccess.com') && u.pathname === `/cdn-cgi/access/login/${h}`
  } catch {}
  console.log(`  ${ok ? '✓ 已上锁' : '✗ 未上锁'} ${h}${p} HTTP ${r.status}`)
  return ok
}
const probes = [
  '/',
  '/index.html',
  '/api/sync/me',
  '/api/sync/pull?since=0',
  '/api/ai/status',
  '/api/ai/qa',
  '/api/admin/ai-users',
  `/x-${Date.now()}`,
]
console.log(`[deploy-sync] 目标 ${which}: https://${host}  D1 ${t.db.name}`)
for (const p of probes) if (!(await locked(p))) die(`匿名访问 ${p} 未被 Access 拦截`)
// every custom host must already be a destination of this target's own Access application before it is bound
if (customHosts.length) {
  // curl (honours the environment's proxy settings, like wrangler does)
  const out = spawnSync(
    'curl',
    [
      '-s',
      '-H',
      `Authorization: Bearer ${process.env.CLOUDFLARE_API_TOKEN || 'placeholder'}`,
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/access/apps/${PLATFORM[which].app}`,
    ],
    { encoding: 'utf8' },
  ).stdout
  let j = {}
  try {
    j = JSON.parse(out)
  } catch {}
  const dests = (j?.result?.destinations || []).map((d) => String(d.uri || '').toLowerCase())
  for (const h of customHosts)
    if (!dests.includes(h)) die(`${h} 还不是 Access 应用 ${PLATFORM[which].app} 的受保护地址，拒绝绑定`)
  console.log('  ✓ Access 应用已覆盖', customHosts.join(', '))
}

// 1. bundle inputs
const files = listFiles(OUT_DIR).map((f) => '/' + path.relative(OUT_DIR, f).replaceAll('\\', '/'))
const map = {}
for (const p of files) if (p !== '/_headers') map[p] = readFileSync(path.join(OUT_DIR, p.slice(1)), 'utf-8')
writeFileSync(path.join(ROOT, 'worker', 'assets.generated.js'), `export const FILES = ${JSON.stringify(map)}\n`)

const dir = path.join(STATE_DIR, 'sync-' + which)
mkdirSync(dir, { recursive: true })
const config = path.join(dir, 'wrangler.json')
writeFileSync(
  config,
  JSON.stringify(
    {
      name: t.name,
      main: path.join(ROOT, 'worker', 'entry.ts'),
      account_id: ACCOUNT,
      compatibility_date: '2026-10-01',
      workers_dev: true,
      preview_urls: false,
      observability: { enabled: false },
      d1_databases: [
        { binding: 'DB', database_name: t.db.name, database_id: t.db.id },
        ...(PLATFORM[which].deletions
          ? [
              {
                binding: 'DELETIONS_DB',
                database_name: PLATFORM[which].deletions.name,
                database_id: PLATFORM[which].deletions.id,
              },
            ]
          : []),
        // AI chat images (compressed copies) in their own free D1; production has none until approved
        ...(PLATFORM[which].media
          ? [{ binding: 'MEDIA_DB', database_name: PLATFORM[which].media.name, database_id: PLATFORM[which].media.id }]
          : []),
      ],
      // AI_API_KEY is a Worker Secret (set in the dashboard / `wrangler secret put`),
      // never a var: deploys keep it untouched.
      vars: {
        ACCESS_TEAM_DOMAIN: TEAM,
        ACCESS_AUD: t.aud,
        BANK_FP: fp,
        DAILY_OP_QUOTA: '20000',
        AI_BASE_URL: t.ai.base,
        AI_MODEL: t.ai.model,
        AI_TIMEOUT_MS: '60000',
        // read-only build identity for GET /api/version (no secrets)
        BUILD_COMMIT: BUILD_COMMIT,
        BUILD_TIME: String(Date.now()), // epoch ms; /api/version renders it as ISO
        // platform (invitations, Pro ledger, lifecycle). Secrets: PLATFORM_SECRET, CF_ACCESS_TOKEN, BREVO_API_KEY
        SUPER_OWNERS: process.env.SUPER_OWNERS || '',
        PLATFORM_STAGE: which,
        WELCOME_URL: welcomeUrl,
        APP_URL: appUrl,
        ACCESS_ACCOUNT_ID: ACCOUNT,
        ACCESS_POLICY_ID: PLATFORM[which].policy,
        ACCESS_APP_ID: PLATFORM[which].app,
        MAIL_PROVIDER: process.env.EXAMPILOT_MAIL_PROVIDER || 'outbox',
        MAIL_FROM: process.env.EXAMPILOT_MAIL_FROM || '',
        MAIL_FROM_NAME: 'ExamPilot',
        // real sending only for mail created after this moment (set when Brevo is switched on); empty = never send
        MAIL_SEND_AFTER: process.env.EXAMPILOT_MAIL_SEND_AFTER || '',
        MAIL_DAILY_CAP: process.env.EXAMPILOT_MAIL_DAILY_CAP || '250',
        // staging: only these exact test inboxes ever get real mail (empty on staging = no sending)
        MAIL_ALLOWLIST: process.env.EXAMPILOT_MAIL_ALLOWLIST || '',
      },
      ...(customHosts.length ? { routes: customHosts.map((pattern) => ({ pattern, custom_domain: true })) } : {}),
      triggers: { crons: ['*/15 * * * *'] },
      version_metadata: { binding: 'CF_VERSION' },
      ...(t.ai.upstream ? { services: [{ binding: 'AI_UPSTREAM', service: t.ai.upstream }] } : {}),
    },
    null,
    2,
  ),
)
const wr = (args) =>
  spawnSync('npx', ['--yes', `wrangler@${WRANGLER_VERSION}`, ...args], {
    cwd: ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
      CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN || 'placeholder',
    },
  })

if (process.argv.includes('--migrate')) {
  const migs = readdirSync(path.join(ROOT, 'worker', 'migrations'))
    .filter((f) => /^\d+_.+\.sql$/.test(f) && !f.includes('down'))
    .sort()
  for (const m of migs) {
    console.log(`[deploy-sync] 迁移 ${m} → ${t.db.name}`)
    if (
      !dry &&
      wr([
        'd1',
        'execute',
        t.db.name,
        '--remote',
        '--yes',
        '--config',
        config,
        '--file',
        path.join(ROOT, 'worker', 'migrations', m),
      ]).status !== 0
    )
      die('数据库迁移失败')
  }
}
if (dry) {
  console.log('[deploy-sync] dry-run：配置已生成', config)
  process.exit(0)
}
if (wr(['deploy', '--config', config]).status !== 0) die('wrangler deploy 失败')
await new Promise((r) => setTimeout(r, 6000))
for (const p of probes)
  if (!(await locked(p))) {
    console.error(`[deploy-sync] 上传后复查失败！回滚：npx wrangler rollback --name ${t.name}`)
    process.exit(2)
  }
console.log('[deploy-sync] 完成')
