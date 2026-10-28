#!/usr/bin/env node
/**
 * Upload dist-web/ to the locked class website.
 *
 *   npm run web:deploy              upload a FULL-bank build (asks you to type YES)
 *   npm run web:deploy -- --demo    upload the 17-question demo
 *   add --embed                     upload as one Worker script with the files inlined
 *                                   (same bytes; for environments where the Workers
 *                                   static-assets upload is not available)
 *
 * Safety gates — any failure aborts BEFORE anything is uploaded:
 *  1. The deploy target comes from deployTarget() in common.mjs: the host that is
 *     probed for Access is derived from the very same Worker name + subdomain that
 *     receives the upload, and the config must expose no other entry point
 *     (workers.dev only, preview_urls false, no routes / custom domains).
 *  2. .web-build/manifest.json exists, and dist-web/ still hashes to the value
 *     recorded when web:verify passed (nothing changed after verification).
 *  3. The manifest mode matches the flag (a demo can never be uploaded as full).
 *  4. Cloudflare Access is LIVE for exactly this host right now: anonymous requests
 *     to the root, every asset path of this build, the bank paths and a random path
 *     must all answer 302 to https://<team>.cloudflareaccess.com/cdn-cgi/access/login/<this host>.
 *     Anything else (200, 404, a redirect elsewhere, an Access login for another
 *     host) stops the upload.
 * After `wrangler deploy`, gate 4 is repeated; on failure it prints the rollback.
 *
 * There is no CI deployment of this site.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import readline from 'node:readline/promises'
import path from 'node:path'
import {
  ROOT,
  OUT_DIR,
  STATE_DIR,
  MANIFEST,
  WRANGLER_CONFIG,
  WRANGLER_VERSION,
  deployTarget,
  listFiles,
  hashDir,
} from './common.mjs'

const demo = process.argv.includes('--demo')
const embed = process.argv.includes('--embed')
const die = (m) => {
  console.error(`[web:deploy] 已中止，未上传：${m}`)
  process.exit(1)
}

const target = deployTarget()
if (target.problems.length) die(target.problems.join('；'))

if (!existsSync(MANIFEST) || !existsSync(OUT_DIR)) die('没有通过校验的 dist-web/，请先运行 npm run build:web')
const manifest = JSON.parse(readFileSync(MANIFEST, 'utf-8'))
if (hashDir(OUT_DIR) !== manifest.distHash) die('dist-web/ 在校验后被改动过，请重新 npm run build:web')
if (demo && manifest.mode !== 'demo') die('这是完整题库构建，不能用 --demo 上传')
if (!demo && manifest.mode !== 'full') die('这是演示版构建；上传演示版请显式加 --demo')

const files = listFiles(OUT_DIR).map((f) => '/' + path.relative(OUT_DIR, f).replaceAll('\\', '/'))
const assets = files.filter((p) => p.startsWith('/assets/'))

/** True only for an Access login redirect for THIS host. */
function isAccessRedirectFor(status, location, host) {
  if (status < 300 || status >= 400 || !location) return false
  let u
  try {
    u = new URL(location)
  } catch {
    return false
  }
  return (
    u.protocol === 'https:' &&
    u.host.endsWith('.cloudflareaccess.com') &&
    u.pathname === `/cdn-cgi/access/login/${host}`
  )
}

async function assertLocked(paths, after) {
  for (const p of paths) {
    const url = target.url + p
    let res
    try {
      res = await fetch(url, { redirect: 'manual', headers: { 'cache-control': 'no-cache' } })
    } catch (e) {
      die(`无法连接 ${url}：${e.message}`)
    }
    const loc = res.headers.get('location') || ''
    const locked = isAccessRedirectFor(res.status, loc, target.host)
    let shown = ''
    try {
      shown = loc ? ' → ' + new URL(loc).host + new URL(loc).pathname : ''
    } catch {
      shown = ' → (无效 Location)'
    }
    console.log(`  ${locked ? '✓ 已上锁' : '✗ 未上锁'}  ${p}  HTTP ${res.status}${shown}`)
    if (!locked) {
      if (after)
        console.error(
          `[web:deploy] 上传后复查失败！立即回滚：npx wrangler rollback --name ${target.name}，并检查 Access 应用`,
        )
      die(`匿名访问 ${p} 没有被 Cloudflare Access 拦截（HTTP ${res.status}）`)
    }
  }
}

const probes = ['/', '/index.html', ...assets, '/data/bank.json', '/bank.json', `/x-${Date.now()}`]
console.log(`[web:deploy] 目标：${target.url}（Worker ${target.name}）`)
console.log(
  `[web:deploy] 内容：${manifest.mode === 'full' ? '完整题库' : '17 题演示'}，${manifest.total} 题，指纹 ${manifest.hashes.full}`,
)
console.log('[web:deploy] 上传前确认这个地址已被 Access 上锁：')
await assertLocked(probes, false)

if (!demo) {
  if (process.env.EXAMPILOT_DEPLOY_CONFIRM === manifest.hashes.full) {
    console.log('[web:deploy] 已通过 EXAMPILOT_DEPLOY_CONFIRM 确认本次指纹')
  } else {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    const ans = await rl.question('将上传【完整题库】到上锁网站。确认请输入 YES：')
    rl.close()
    if (ans.trim() !== 'YES') die('未确认')
  }
}

let config = WRANGLER_CONFIG
if (embed) {
  // Same files, same headers, served by a script instead of Workers Static Assets.
  const dir = path.join(STATE_DIR, 'embed')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const map = {}
  for (const p of files) if (p !== '/_headers') map[p] = readFileSync(path.join(OUT_DIR, p.slice(1)), 'utf-8')
  writeFileSync(
    path.join(dir, 'index.js'),
    `const FILES = ${JSON.stringify(map)}
const TYPES = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', svg: 'image/svg+xml' }
const SEC = { 'X-Robots-Tag': 'noindex, nofollow, noarchive', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Cache-Control': 'private, no-store' }
export default {
  async fetch(req) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('Method Not Allowed', { status: 405, headers: SEC })
    let p = new URL(req.url).pathname
    if (p === '/') p = '/index.html'
    let body = FILES[p]
    if (body === undefined) {
      if (p.startsWith('/assets/') || p.includes('.')) return new Response('Not Found', { status: 404, headers: SEC })
      p = '/index.html'
      body = FILES[p]
    }
    return new Response(req.method === 'HEAD' ? null : body, { headers: { ...SEC, 'Content-Type': TYPES[p.split('.').pop()] || 'application/octet-stream' } })
  },
}
`,
  )
  config = path.join(dir, 'wrangler.json')
  writeFileSync(
    config,
    JSON.stringify({
      name: target.name,
      main: 'index.js',
      compatibility_date: '2026-10-01',
      workers_dev: true,
      preview_urls: false,
      observability: { enabled: false },
    }),
  )
}

const r = spawnSync('npx', ['--yes', `wrangler@${WRANGLER_VERSION}`, 'deploy', '--config', config], {
  cwd: ROOT,
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: target.accountId },
})
if (embed) rmSync(path.join(STATE_DIR, 'embed'), { recursive: true, force: true })
if (r.status !== 0) die('wrangler deploy 失败（如提示未登录，先运行 npx wrangler login）')

console.log('[web:deploy] 上传完成，复查新文件同样上锁：')
await new Promise((res) => setTimeout(res, 5000))
await assertLocked(['/', ...assets, '/data/bank.json'], true)
console.log('[web:deploy] 完成。用授权邮箱登录网站，在 设置 → 题库指纹 核对完整指纹：' + manifest.hashes.full)
