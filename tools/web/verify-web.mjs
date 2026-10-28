#!/usr/bin/env node
/**
 * Verify dist-web/ before it may be uploaded.  (run automatically by build:web)
 *
 *   node tools/web/verify-web.mjs --mode=full|demo
 *
 * Checks (prints counts and hashes only — never question text):
 *  1. Source bank  : data/bank.json (full) or data/sample-bank.json (demo) passes the
 *     same structural validation as bank:local; prints total, chapter order, per-type
 *     counts and the SHA-256 fingerprints (chapterOrder / ids / stems+options /
 *     answers / full).
 *  2. Build input  : data/local-bank.json (what Vite bundled) has the identical
 *     fingerprint (full mode).
 *  3. Bundle       : every question id, stem and option string of the source bank is
 *     present in the built JavaScript; the web-edition marker is present.
 *  4. Hygiene      : only index.html, _headers, assets/*.js|css|svg|png|ico|woff2;
 *     no source maps, .env, backups, learning-data exports, AI keys, or local paths.
 *  5. Writes .web-build/manifest.json (git-ignored) with mode, fingerprints and a
 *     hash of dist-web/ — deploy refuses to upload anything that does not match it.
 *
 * The runtime check (tools/web/runtime-check.mjs) then opens the built site in a
 * real browser and compares the fingerprint the RUNNING app computes.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { bankFingerprint } from './bank-fingerprint.mjs'
import { OUT_DIR, STATE_DIR, MANIFEST, FULL_BANK, SAMPLE_BANK, LOCAL_BANK, listFiles, hashDir } from './common.mjs'

const mode = (process.argv.find((a) => a.startsWith('--mode=')) || '--mode=full').slice(7)
const problems = []
const fail = (m) => problems.push(m)
const log = (m) => console.log('  ' + m)

if (!existsSync(OUT_DIR)) {
  console.error('[web:verify] 没有 dist-web/，请先运行 npm run build:web')
  process.exit(1)
}

const srcPath = mode === 'demo' ? SAMPLE_BANK : FULL_BANK
const src = JSON.parse(readFileSync(srcPath, 'utf-8'))
const fp = bankFingerprint(src)
console.log(`[web:verify] 模式：${mode === 'demo' ? '17 题演示版' : '完整题库版'}`)
log(`题目总量      ${fp.total}`)
log(`章节数/顺序   ${src.chapterOrder.length} 章：${src.chapterOrder.join(' → ')}`)
log(`各题型数量    ${JSON.stringify(fp.byType)}`)
for (const [k, v] of Object.entries(fp.hashes)) log(`指纹 ${k.padEnd(13)}${v}`)

// 1. structure
const seen = new Set()
for (const q of src.questions) {
  if (seen.has(q.id)) fail(`重复题目 ID（第 ${seen.size + 1} 题附近）`)
  seen.add(q.id)
}

// 2. build input
if (mode === 'full') {
  if (!existsSync(LOCAL_BANK)) fail('缺少 data/local-bank.json（构建输入）')
  else {
    const built = bankFingerprint(JSON.parse(readFileSync(LOCAL_BANK, 'utf-8')))
    for (const k of Object.keys(fp.hashes))
      if (built.hashes[k] !== fp.hashes[k]) fail(`构建输入与 data/bank.json 不一致：${k}`)
  }
}

// 3. bundle content
const files = listFiles(OUT_DIR)
const js = files
  .filter((f) => f.endsWith('.js'))
  .map((f) => readFileSync(f, 'utf-8'))
  .join('\n')
if (!js.includes('exampilot-web-edition:account-ai')) fail('产物里没有网页版标记：不是用 build:web 构建的')
const variants = (s) => {
  const j = JSON.stringify(s).slice(1, -1) // body of a "..." JS/JSON string
  return [
    j,
    j.replaceAll("'", "\\'"),
    JSON.stringify(j).slice(1, -1), // inside JSON.parse("...")
    j.replaceAll('\\', '\\\\').replaceAll("'", "\\'"), // inside JSON.parse('...')
    s.replaceAll('\\', '\\\\').replaceAll('`', '\\`').replaceAll('${', '\\${'), // template literal
  ]
}
let missing = 0
for (const q of src.questions) {
  for (const s of [q.id, q.stem, ...(q.options || [])]) {
    if (typeof s !== 'string' || !s) continue
    if (!variants(s).some((v) => js.includes(v))) missing++
  }
}
if (missing) fail(`产物中缺少 ${missing} 处题目 ID/题干/选项文本`)
else log('产物包含源题库全部题目 ID、题干与选项文本')
if (mode === 'full') {
  // Not one demo question may reach the class website, not even as unused data.
  const sample = JSON.parse(readFileSync(SAMPLE_BANK, 'utf-8'))
  const realIds = new Set(src.questions.map((q) => q.id))
  const realText = new Set(src.questions.flatMap((q) => [q.stem, ...(q.options || [])]))
  let demoHits = 0
  for (const q of sample.questions) {
    if (!realIds.has(q.id) && js.includes(q.id)) demoHits++
    if (!realText.has(q.stem) && variants(q.stem).some((v) => js.includes(v))) demoHits++
  }
  if (src.questions.some((q) => sample.questions.some((d) => d.id === q.id)))
    fail('data/bank.json 含有演示题 ID：真实题库被混入了演示题，停止')
  if (demoHits) fail(`产物中混入了 ${demoHits} 处演示题 ID/题干`)
  else log(`产物中没有任何演示题（已核对 ${sample.questions.length} 道演示题的 ID 与题干）`)
}
if (mode === 'demo' && existsSync(FULL_BANK)) {
  // A demo build on a machine with the full bank must not contain it.
  const full = JSON.parse(readFileSync(FULL_BANK, 'utf-8'))
  const sampleIds = new Set(src.questions.map((q) => q.id))
  const leaked = full.questions.filter((q) => !sampleIds.has(q.id) && js.includes(q.id)).length
  if (leaked) fail(`演示版产物里混入了 ${leaked} 道完整题库题目`)
}

// 4. hygiene
const allowed = /^(index\.html|_headers|favicon\.(ico|svg|png)|assets\/[\w.-]+\.(js|css|svg|png|ico|woff2?))$/
for (const f of files) {
  const rel = path.relative(OUT_DIR, f).replaceAll('\\', '/')
  if (!allowed.test(rel)) fail(`不应出现在产物里的文件：${rel}`)
}
const text = files
  .filter((f) => /\.(js|css|html)$/.test(f) || f.endsWith('_headers'))
  .map((f) => readFileSync(f, 'utf-8'))
  .join('\n')
const secretPatterns = [
  [/sk-[A-Za-z0-9_-]{20,}/, 'sk- 形式的 API Key'],
  [/AKIA[0-9A-Z]{16}/, 'AWS Key'],
  [/gh[pousr]_[A-Za-z0-9]{30,}/, 'GitHub Token'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, '私钥'],
  [/Bearer\s+[A-Za-z0-9._-]{20,}/, 'Bearer Token'],
  [/[A-Za-z]:\\\\(Users|Deepseek)/i, '本机绝对路径'],
  [/sourceMappingURL=/, 'source map 引用'],
  [/exampilot\.ai\.config"\s*:\s*\{/, 'AI 配置数据'],
]
for (const [re, label] of secretPatterns) if (re.test(text)) fail(`产物中疑似包含：${label}`)
if (existsSync(path.join(OUT_DIR, '.env'))) fail('产物里有 .env')

if (problems.length) {
  console.error('\n[web:verify] 不通过，禁止上传：')
  for (const p of problems) console.error('  - ' + p)
  process.exit(1)
}
mkdirSync(STATE_DIR, { recursive: true })
writeFileSync(
  MANIFEST,
  JSON.stringify(
    {
      mode,
      total: fp.total,
      byType: fp.byType,
      hashes: fp.hashes,
      distHash: hashDir(OUT_DIR),
      verifiedAt: new Date().toISOString(),
    },
    null,
    2,
  ),
)
console.log('\n[web:verify] 通过。下一步：npm run web:check（真实浏览器核对运行中题库指纹）')
