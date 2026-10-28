#!/usr/bin/env node
/**
 * Build the class website (web edition) into ./dist-web.
 *
 *   npm run build:web          full course bank from data/bank.json (LOCAL ONLY — never in CI)
 *   npm run build:web:demo     the 17-question public sample bank
 *
 * - Reuses the already-parsed data/bank.json through tools/bank-local.mjs. It never
 *   parses a PDF and never edits a question.
 * - Sets VITE_EXAMPILOT_EDITION=web, which hides and disables every AI entry.
 * - Writes to dist-web/, so the desktop build in dist/ is untouched.
 * - Restores src/lib/local-bank.generated.ts and data/local-bank.json afterwards,
 *   so the desktop app keeps exactly the bank it had before.
 * - Runs tools/web/verify-web.mjs at the end; a failed check deletes nothing but
 *   leaves no manifest, and deploy refuses to upload.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { ROOT, OUT_DIR, STATE_DIR, MANIFEST, FULL_BANK, LOCAL_BANK, GENERATED } from './common.mjs'

const demo = process.argv.includes('--demo')
const mode = demo ? 'demo' : 'full'

function excludeDemoBank() {
  const VIRTUAL = '\0exampilot-no-demo-bank'
  return {
    name: 'exampilot-exclude-demo-bank',
    enforce: 'pre',
    resolveId(id) {
      return /(^|[\\/])data[\\/]sample-bank\.json$/.test(id) ? VIRTUAL : null
    },
    load(id) {
      if (id !== VIRTUAL) return null
      return 'export default ' + JSON.stringify({ schema: 'examPilot.bank.v1', chapterOrder: [], questions: [] })
    },
  }
}

// Web edition only: unified ExamPilot brand in the HTML shell (title, icon,
// description, share preview). The desktop index.html on disk is not edited.
const WEB_BRAND_ICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0' y1='0' x2='1' y2='1'%3E%3Cstop offset='0' stop-color='%232b8cff'/%3E%3Cstop offset='1' stop-color='%230059b3'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='64' height='64' rx='15' fill='url(%23g)'/%3E%3Cpath d='M19 17h24a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H26v5h14a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2H26v5h9' fill='none' stroke='%23fff' stroke-width='5' stroke-linecap='round' stroke-linejoin='round'/%3E%3Cpath d='M19 17v30' stroke='%23fff' stroke-width='5' stroke-linecap='round'/%3E%3Cpath d='M37 44l4.5 4.5L50 39' fill='none' stroke='%239fd0ff' stroke-width='4.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E"
const PUBLIC_ORIGIN_RAW = process.env.EXAMPILOT_PUBLIC_ORIGIN || ''
// A build that never declares its public origin still has to produce valid absolute
// links, so it falls back to a reserved-TLD placeholder — and says so, loudly, so
// nobody ships a page whose social preview points at exampilot.example.
const PUBLIC_ORIGIN = (PUBLIC_ORIGIN_RAW || 'https://exampilot.example').replace(/\/$/, '')
if (!PUBLIC_ORIGIN_RAW)
  console.warn(
    '[build:web] 未设置 EXAMPILOT_PUBLIC_ORIGIN，og:image 使用占位地址 https://exampilot.example/logo.png；正式部署请显式设置该变量。',
  )
const WEB_TITLE = 'ExamPilot 习概复习系统 · 独立学习辅助平台'
const WEB_DESC = 'ExamPilot 习概复习系统——独立学习辅助平台。系统化复习 · 精准诊断 · 高效备考。开发与维护：翁成航。'
// Pro typography: a 600-weight subset of Noto Serif SC (SIL OFL 1.1; ~820 UI glyphs,
// 139 KB woff2) wrapped in a hashed stylesheet. It is NOT linked from the page: the
// app appends it only after the server confirmed a Pro account, so Standard users
// never download it. Served with an immutable cache header (hashed name).
const SERIF_CSS = (() => {
  const woff2 = readFileSync(path.join(ROOT, 'tools', 'web', 'ep-serif-600.woff2'))
  const css = `@font-face{font-family:'EP Serif';src:url(data:font/woff2;base64,${woff2.toString('base64')}) format('woff2');font-weight:500 700;font-style:normal;font-display:swap}\n`
  const hash = createHash('sha256').update(css).digest('hex').slice(0, 10)
  return { css, file: `assets/ep-serif-${hash}.css` }
})()

function webBrandHtml() {
  return {
    name: 'exampilot-web-brand-html',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: SERIF_CSS.file, source: SERIF_CSS.css })
    },
    transformIndexHtml(html) {
      const head = [
        `<link rel="icon" type="image/svg+xml" href="${WEB_BRAND_ICON}" />`,
        `<title>${WEB_TITLE}</title>`,
        `<meta name="description" content="${WEB_DESC}" />`,
        '<meta name="author" content="翁成航 (Chenghang Weng)" />',
        '<meta name="application-name" content="ExamPilot 习概复习系统" />',
        '<meta name="apple-mobile-web-app-title" content="ExamPilot" />',
        '<meta name="theme-color" content="#0b5cc4" />',
        '<meta property="og:type" content="website" />',
        '<meta property="og:site_name" content="ExamPilot 习概复习系统" />',
        `<meta property="og:title" content="${WEB_TITLE}" />`,
        '<meta property="og:description" content="系统化复习 · 精准诊断 · 高效备考" />',
        `<meta property="og:image" content="${PUBLIC_ORIGIN}/logo.png" />`,
        '<meta name="twitter:card" content="summary" />',
        // First paint: the critical page background and the last chosen light/dark
        // preference, applied before the bundle runs (no white flash for dark users).
        // Only the theme is hinted; the Standard/Pro identity is never cached.
        "<style>html[data-theme='dark']{background:#0b0b0d;color-scheme:dark}</style>",
        `<script>window.__EP_SERIF__='/${SERIF_CSS.file}'</script>`,
        "<script>try{var t=localStorage.getItem('ep-theme');if(t==='light'||t==='dark'||t==='auto'){var d=t==='dark'||(t==='auto'&&matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.dataset.theme=d?'dark':'light'}}catch(e){}</script>",
      ].join('\n    ')
      const out = html.replace(/<link\s+rel="icon"\s+href="[^"]*"\s*\/>/, '').replace(/<title>[\s\S]*?<\/title>/, head)
      if (/<text[^>]*>习<\/text>/.test(out) || (out.match(/rel="icon"/g) || []).length !== 1)
        throw new Error('web brand: old favicon still present')
      if (!out.includes(WEB_TITLE)) throw new Error('web brand: <title> not found in index.html')
      return out
    },
  }
}

function run(cmd, args, env = {}) {
  const r = spawnSync(cmd, args, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, ...env },
  })
  if (r.status !== 0) throw new Error(`命令失败：${cmd} ${args.join(' ')}`)
}

if (!demo && !existsSync(FULL_BANK)) {
  console.error('[build:web] 找不到 data/bank.json。完整版只能在保存题库的本机构建。')
  process.exit(1)
}

// Snapshot the desktop loader state so it can be restored exactly.
const snap = {}
for (const f of [GENERATED, LOCAL_BANK]) snap[f] = existsSync(f) ? readFileSync(f) : null

rmSync(MANIFEST, { force: true })
let ok = false
try {
  run('node', ['tools/bank-local.mjs', ...(demo ? ['--public'] : [])])
  run('npx', ['tsc', '-b'])
  // Start from nothing: no output or dependency-optimiser cache of an earlier
  // (e.g. demo) build can leak into this one.
  rmSync(OUT_DIR, { recursive: true, force: true })
  rmSync(path.join(ROOT, 'node_modules', '.vite'), { recursive: true, force: true })
  process.env.VITE_EXAMPILOT_EDITION = 'web'
  const { build } = await import('vite')
  await build({
    root: ROOT,
    configFile: path.join(ROOT, 'vite.config.ts'),
    logLevel: 'warn',
    build: { outDir: 'dist-web', emptyOutDir: true, sourcemap: false },
    // Full edition: the demo bank is only bank.ts's fallback when no local bank
    // exists. It is replaced by an empty bank here so not one demo question can
    // end up in the class website, even as unused data.
    plugins: demo ? [webBrandHtml()] : [excludeDemoBank(), webBrandHtml()],
  })

  // Response headers for Workers Static Assets. Access already blocks anonymous
  // visitors; these only stop search indexing and shared caching of the pages.
  writeFileSync(
    path.join(OUT_DIR, '_headers'),
    [
      '/*',
      '  X-Robots-Tag: noindex, nofollow, noarchive',
      '  Referrer-Policy: no-referrer',
      '  X-Content-Type-Options: nosniff',
      '  X-Frame-Options: DENY',
      '  Cache-Control: private, no-store',
      '',
    ].join('\n'),
  )
  mkdirSync(STATE_DIR, { recursive: true })
  run('node', ['tools/web/verify-web.mjs', `--mode=${mode}`])
  ok = true
} catch (e) {
  console.error(`[build:web] ${e.message}`)
} finally {
  for (const [f, buf] of Object.entries(snap)) {
    if (buf === null) rmSync(f, { force: true })
    else writeFileSync(f, buf)
  }
  console.log('[build:web] 已恢复电脑版题库加载器（电脑版不受影响）')
}
if (!ok) process.exit(1)
console.log(`\n[build:web] 完成：dist-web/ (${mode === 'full' ? '完整题库' : '17 题演示'})，校验通过。`)
