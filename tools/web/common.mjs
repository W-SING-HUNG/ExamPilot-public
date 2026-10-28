// Shared paths/constants for the class-website (web edition) tooling.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
export const OUT_DIR = path.join(ROOT, 'dist-web')
export const STATE_DIR = path.join(ROOT, '.web-build') // git-ignored, local only
export const MANIFEST = path.join(STATE_DIR, 'manifest.json')
export const FULL_BANK = path.join(ROOT, 'data', 'bank.json')
export const SAMPLE_BANK = path.join(ROOT, 'data', 'sample-bank.json')
export const LOCAL_BANK = path.join(ROOT, 'data', 'local-bank.json')
export const GENERATED = path.join(ROOT, 'src', 'lib', 'local-bank.generated.ts')
export const WRANGLER_CONFIG = path.join(ROOT, 'wrangler.web.jsonc')
export const WRANGLER_VERSION = '4.152.0'

export const DEPLOY_LOCAL = path.join(ROOT, '.web-deploy.local.json') // git-ignored

/** Parse wrangler's JSONC (comments + trailing commas) without extra dependencies. */
function readJsonc(file) {
  const src = readFileSync(file, 'utf-8')
  let out = ''
  for (let i = 0, str = false; i < src.length; i++) {
    const c = src[i]
    if (str) {
      out += c
      if (c === '\\') out += src[++i]
      else if (c === '"') str = false
    } else if (c === '"') {
      str = true
      out += c
    } else if (c === '/' && src[i + 1] === '/') while (i < src.length && src[i] !== '\n') i++
    else if (c === '/' && src[i + 1] === '*') {
      i = src.indexOf('*/', i + 2) + 1
    } else out += c
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'))
}

/**
 * The ONE place the deploy target is derived from.
 *
 * The upload target (wrangler.web.jsonc `name` + your account's workers.dev
 * subdomain) and the address that is probed for Cloudflare Access are computed
 * from the same values, so the lock check can never test a different host than
 * the one that receives the upload. The config must also expose no other entry
 * point: workers.dev only, version-preview URLs off, no routes / custom domains.
 *
 * Account ID and subdomain are personal, so they live in the git-ignored
 * .web-deploy.local.json ({ "accountId": "...", "workersSubdomain": "..." }) or in
 * CLOUDFLARE_ACCOUNT_ID / EXAMPILOT_WORKERS_SUBDOMAIN, never in the repository.
 */
export function deployTarget() {
  const cfg = readJsonc(WRANGLER_CONFIG)
  const problems = []
  if (typeof cfg.name !== 'string' || !/^[a-z0-9-]+$/.test(cfg.name))
    problems.push('wrangler.web.jsonc 缺少合法的 name')
  if (cfg.workers_dev !== true) problems.push('wrangler.web.jsonc 必须 workers_dev: true（唯一入口）')
  if (cfg.preview_urls !== false) problems.push('wrangler.web.jsonc 必须 preview_urls: false（不允许版本预览地址）')
  if (cfg.route || cfg.routes || cfg.custom_domain)
    problems.push('wrangler.web.jsonc 不允许 route/routes/自定义域名（会多出未验证的入口）')
  if (cfg.account_id) problems.push('wrangler.web.jsonc 不应写 account_id，请放到 .web-deploy.local.json')
  const local = existsSync(DEPLOY_LOCAL) ? JSON.parse(readFileSync(DEPLOY_LOCAL, 'utf-8')) : {}
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || local.accountId
  const sub = process.env.EXAMPILOT_WORKERS_SUBDOMAIN || local.workersSubdomain
  if (!/^[0-9a-f]{32}$/.test(accountId || ''))
    problems.push('缺少 Cloudflare 账号 ID（.web-deploy.local.json 的 accountId）')
  if (!/^[a-z0-9-]+$/.test(sub || ''))
    problems.push('缺少 workers.dev 子域名（.web-deploy.local.json 的 workersSubdomain）')
  const host = `${cfg.name}.${sub}.workers.dev`
  return { name: cfg.name, accountId, host, url: `https://${host}`, problems }
}

export function listFiles(dir) {
  const out = []
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else out.push(p)
    }
  }
  walk(dir)
  return out.sort()
}

/** SHA-256 over every output file (path + bytes), to detect changes between verify and deploy. */
export function hashDir(dir) {
  const h = createHash('sha256')
  for (const f of listFiles(dir)) {
    h.update(path.relative(dir, f).replaceAll('\\', '/') + '\0')
    h.update(readFileSync(f))
    h.update('\0')
  }
  return h.digest('hex')
}
