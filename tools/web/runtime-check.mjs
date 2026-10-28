#!/usr/bin/env node
/**
 * Open dist-web/ in a real local browser and compare the bank fingerprint that the
 * RUNNING web app computes (设置 → 题库指纹) with .web-build/manifest.json.
 * Also confirms no AI entry is rendered. Serves on 127.0.0.1 only.
 *
 *   npm run web:check                 (Chrome; set CHROME_PATH for Edge etc.)
 */
import { existsSync, readFileSync } from 'node:fs'
import puppeteer from 'puppeteer-core'
import { preview } from 'vite'
import { ROOT, MANIFEST } from './common.mjs'

const candidates = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
].filter(Boolean)
const exe = candidates.find((p) => existsSync(p))
if (!exe) {
  console.error('[web:check] 找不到 Chrome/Edge，请设置 CHROME_PATH')
  process.exit(1)
}
if (!existsSync(MANIFEST)) {
  console.error('[web:check] 没有校验清单，请先 npm run build:web')
  process.exit(1)
}
const manifest = JSON.parse(readFileSync(MANIFEST, 'utf-8'))
// Programmatic preview on a random free port: never talks to some other server
// that happens to be running on a fixed port.
const server = await preview({
  root: ROOT,
  logLevel: 'silent',
  build: { outDir: 'dist-web' },
  preview: { port: 0, host: '127.0.0.1', strictPort: false, open: false },
})
const BASE = server.resolvedUrls.local[0].replace(/\/$/, '')
let code = 1
const browser = await puppeteer.launch({
  executablePath: exe,
  headless: true,
  args: ['--no-first-run', ...(process.platform === 'linux' ? ['--no-sandbox'] : [])],
})
try {
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  const requests = []
  page.on('request', (r) => requests.push(r.url()))
  await page.goto(`${BASE}/#/settings`, { waitUntil: 'networkidle0', timeout: 30000 })
  await page.waitForFunction(() => document.querySelector('[data-testid="bank-fp-full"]'), { timeout: 20000 })
  const fpText = await page.$eval('[data-testid="bank-fp-full"]', (e) => e.textContent || '')
  const totalText = await page.$eval('[data-testid="bank-total"]', (e) => e.textContent || '')
  const running = fpText.split('：').pop().trim()
  const aiVisible = await page.evaluate(() => /AI 题目答疑|AI 网关|AI 参考评阅|AI 助手/.test(document.body.innerText))
  const aiCalls = requests.filter((u) => u.includes('/api/ai'))
  console.log(`  运行中题目总数：${totalText.split('：').pop()}（清单 ${manifest.total}）`)
  console.log(`  运行中完整指纹：${running}`)
  console.log(`  本地题库指纹  ：${manifest.hashes.full}`)
  const ok = running === manifest.hashes.full && !aiVisible && aiCalls.length === 0 && errors.length === 0
  if (!ok) {
    if (running !== manifest.hashes.full) console.error('  ✗ 指纹不一致')
    if (aiVisible) console.error('  ✗ 页面上出现了 AI 入口')
    if (aiCalls.length) console.error('  ✗ 出现了 AI 请求')
    if (errors.length) console.error('  ✗ 页面脚本错误：' + errors.join(' | '))
  } else console.log('[web:check] 通过：网页运行的题库与本地 data 完全一致，无 AI 入口')
  code = ok ? 0 : 1
} finally {
  await browser.close()
  await server.close()
}
process.exit(code)
