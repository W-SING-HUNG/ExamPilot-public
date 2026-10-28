#!/usr/bin/env node
/**
 * Generate the Worker's embedded asset modules.
 *
 * `worker/entry.ts` imports `./assets.generated.js` and `worker/welcome/entry.ts`
 * imports `./pages.generated.js`. Both are build artifacts and are git-ignored;
 * this script produces them so a clean checkout can run the test suite and a
 * local preview without a deploy step.
 *
 * Run a build first (`npm run build:web:demo` or `npm run build:web`): this script
 * only embeds what is already in dist-web/. Nothing here talks to the network.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { OUT_DIR, ROOT, listFiles } from './common.mjs'

const INDEX = path.join(OUT_DIR, 'index.html')
const built = existsSync(INDEX)
if (!built) {
  console.warn('[gen:worker] dist-web/ 尚未生成，先写入空资源集。构建请运行 npm run build:web:demo。')
}

/** Every file of the built site except the `_headers` control file. */
const files = {}
for (const abs of built ? listFiles(OUT_DIR) : []) {
  const rel = '/' + path.relative(OUT_DIR, abs).replaceAll('\\', '/')
  if (rel === '/_headers') continue
  files[rel] = readFileSync(abs, 'utf-8')
}
writeFileSync(path.join(ROOT, 'worker', 'assets.generated.js'), `export const FILES = ${JSON.stringify(files)}\n`)

/** The welcome portal, assembled from the sources tracked in this repository. */
const WELCOME_DIR = path.join(ROOT, 'worker', 'welcome')
const portal = readFileSync(path.join(WELCOME_DIR, 'portal.html'), 'utf8')
const pages = {
  '/': { type: 'text/html; charset=utf-8', body: portal },
  '/portal.html': { type: 'text/html; charset=utf-8', body: portal },
  '/portal.js': {
    type: 'text/javascript; charset=utf-8',
    body: readFileSync(path.join(WELCOME_DIR, 'portal.js'), 'utf8'),
  },
}
writeFileSync(path.join(WELCOME_DIR, 'pages.generated.js'), `export const PAGES = ${JSON.stringify(pages)}\n`)

console.log(`[gen:worker] worker/assets.generated.js — ${Object.keys(files).length} 个静态文件`)
console.log(`[gen:worker] worker/welcome/pages.generated.js — ${Object.keys(pages).length} 个页面`)
