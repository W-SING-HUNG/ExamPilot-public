#!/usr/bin/env node
/**
 * Release-artifact verifier — POSITIVE delivery manifest.
 *
 *   npm run verify:release            verify ./dist
 *   npm run verify:release -- <dir>   verify another output directory
 *
 * WHY THIS EXISTS
 *
 * The source tree can be clean while the ARTEFACT is not. `src/lib/bank.ts`
 * statically imports the generated loader, so a build made on a machine that has
 * the private course bank installed embeds that bank in `dist/`. Nobody would
 * notice by reading the repository, and uploading `dist/` would publish it.
 *
 * This check therefore inspects the artefact itself, and it works by ALLOWLIST:
 * it states what a public build MUST contain (the bundled sample bank, verbatim)
 * and what it must NEVER contain (any other bank's questions, source maps,
 * machine-specific absolute paths, credential-shaped strings). Allowlisting is
 * used deliberately — a blocklist can only catch what someone remembered to add,
 * and the private bank's exact contents must not be written into this file.
 *
 * Exit code 0 = artefact is publishable; 1 = do not publish.
 *
 * LIMITS: this cannot prove the absence of content it has no reference for. It
 * proves the sample bank is what got embedded and that nothing referenceable as
 * private material is present. It is a guard-rail, not a proof.
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = process.cwd()
const OUT_DIR = process.argv[2] || join(ROOT, 'dist')
const SAMPLE_BANK = join(ROOT, 'data', 'sample-bank.json')
const LOCAL_BANK = join(ROOT, 'data', 'local-bank.json')
const GENERATED = join(ROOT, 'src', 'lib', 'local-bank.generated.ts')

const problems = []
const notes = []
const fail = (m) => problems.push(m)

/** Every text file in the output directory. */
function collectFiles(dir) {
  const out = []
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else out.push(p)
    }
  }
  walk(dir)
  return out
}

if (!existsSync(OUT_DIR)) {
  console.error(`verify:release — no output directory at ${OUT_DIR}\nBuild first: npm run build`)
  process.exit(1)
}

const files = collectFiles(OUT_DIR)
if (files.length === 0) {
  console.error(`verify:release — ${OUT_DIR} is empty`)
  process.exit(1)
}

// --- 1. Which loader did the build use? ------------------------------------
// The bundler resolves `local-bank.generated.ts`; if it names a real bank, the
// build embedded private material regardless of what the artefact scan finds.
let loaderIsPublic = null
if (existsSync(GENERATED)) {
  const gen = readFileSync(GENERATED, 'utf8')
  const importsLocalBank = /import\s+\w+\s+from\s+['"][^'"]*local-bank\.json['"]/.test(gen)
  loaderIsPublic = !importsLocalBank
  notes.push(`loader: ${loaderIsPublic ? 'sample (null shim)' : 'FULL LOCAL BANK'}`)
  if (!loaderIsPublic) {
    fail(
      'the generated loader imports a local bank — this build embeds private course content.\n' +
        '      A public release must be built where data/bank.json is absent, or after\n' +
        '      running "npm run bank:public".',
    )
  }
}

// --- 2. Read the artefact text --------------------------------------------
const textFiles = files.filter((f) => /\.(js|mjs|cjs|css|html|json|map|txt)$/i.test(f))
if (textFiles.length === 0) fail('no text/script files found in the output — unexpected output shape')
const blob = textFiles.map((f) => readFileSync(f, 'utf8')).join('\n')

// --- 3. POSITIVE: the public sample bank must be what is embedded ----------
if (!existsSync(SAMPLE_BANK)) {
  fail('data/sample-bank.json is missing — cannot verify the public bank is embedded')
} else {
  const sample = JSON.parse(readFileSync(SAMPLE_BANK, 'utf8'))
  const missing = []
  for (const q of sample.questions) {
    // Question text is the durable check; ids may be minified away.
    const stem = String(q.stem || '')
    if (stem.length < 8) continue
    if (!blob.includes(stem)) missing.push(q.id)
  }
  if (missing.length) {
    fail(`the embedded bank is missing ${missing.length} sample question(s): ${missing.slice(0, 5).join(', ')}`)
  } else {
    notes.push(`sample bank: all ${sample.questions.length} questions embedded`)
  }
}

// --- 4. NEGATIVE: no OTHER bank may be embedded ---------------------------
// Two independent leaks are checked, because they travel separately:
//   (a) question content  — the stems themselves;
//   (b) bank METADATA     — `source`, `generatedAt`, chapter list. The licensed
//       bank's `source` field names the private origin document, so it discloses
//       material even when not one question text is present.
// The bank's own text is never copied into this file; only pass/fail is reported.
if (existsSync(LOCAL_BANK)) {
  try {
    const local = JSON.parse(readFileSync(LOCAL_BANK, 'utf8'))
    const sample = existsSync(SAMPLE_BANK) ? JSON.parse(readFileSync(SAMPLE_BANK, 'utf8')) : { questions: [] }
    const sampleStems = new Set(sample.questions.map((q) => String(q.stem || '')))
    const sampleStrings = new Set()
    const collectSample = (v) => {
      if (typeof v === 'string') sampleStrings.add(v)
      else if (Array.isArray(v)) v.forEach(collectSample)
      else if (v && typeof v === 'object') Object.values(v).forEach(collectSample)
    }
    collectSample(sample)

    const leaked = []
    for (const q of local.questions || []) {
      const stem = String(q.stem || '')
      if (stem.length < 20) continue
      if (sampleStems.has(stem)) continue // present in both — it is public
      // Check with newlines escaped too, since the bundler serialises them.
      if (blob.includes(stem) || blob.includes(stem.replace(/\n/g, '\\n'))) leaked.push(q.id)
    }
    if (leaked.length) {
      fail(`the artefact embeds ${leaked.length} question(s) from the private local bank. Do NOT publish this output.`)
    } else {
      notes.push('private local bank: 0 questions found in the artefact')
    }

    // (b) metadata strings — `source` is the important one.
    const metaLeaks = []
    const considerMeta = (label, value) => {
      const s = String(value || '')
      if (s.length < 8) return
      if (sampleStrings.has(s)) return // also present in the public bank
      if (blob.includes(s)) metaLeaks.push(label)
    }
    considerMeta('source', local.source)
    considerMeta('generatedAt', local.generatedAt)
    if (metaLeaks.length) {
      fail(
        `the artefact embeds private bank metadata (${metaLeaks.join(', ')}). ` +
          'The source label identifies the private origin document even with no question text present.',
      )
    } else {
      notes.push('private bank metadata: not present in the artefact')
    }
  } catch (e) {
    fail(`could not cross-check data/local-bank.json (${e.message})`)
  }
} else {
  notes.push('private local bank: not present on this machine — cross-check skipped')
}

// --- 5. No source maps in a public artefact -------------------------------
// They expose original paths and full sources.
const maps = files.filter((f) => f.endsWith('.map'))
if (maps.length) fail(`${maps.length} source map(s) present — remove them from the public artefact`)

// --- 6. No machine-specific absolute paths --------------------------------
const absPath = blob.match(/[A-Za-z]:[\\/]{1,2}(?:Users|Documents|Desktop)\b|\/(?:Users|home)\/[A-Za-z0-9._-]+\//)
if (absPath) fail('the artefact contains a machine-specific absolute path')

// --- 7. No credential-shaped strings -------------------------------------
const cred = blob.match(
  /(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,}|AIza[0-9A-Za-z_-]{30,})/,
)
if (cred) fail('the artefact contains a credential-shaped string')

// --- 8. No private source-document references ----------------------------
// A bare extension (`.pdf`) appears in ordinary code and in the sample bank's
// own flagReason text, so only a document NAME — something before the extension
// — is treated as a reference to a real file.
const pdfName = blob.match(/[\w\u4e00-\u9fff][\w\u4e00-\u9fff\-_.]{2,}\.pdf/i)
if (pdfName) fail('the artefact references a .pdf document name')

// --- report --------------------------------------------------------------
console.log('release-artefact verification (positive delivery manifest)')
console.log(`  output dir      : ${relative(ROOT, OUT_DIR) || OUT_DIR}`)
console.log(`  files           : ${files.length} (${textFiles.length} text)`)
for (const n of notes) console.log(`  ${n}`)

if (problems.length) {
  console.log('')
  for (const p of problems) console.log(`  FAIL — ${p}`)
  console.log('\nNOT PUBLISHABLE: the artefact does not match the public delivery manifest.')
  process.exit(1)
}

console.log('')
console.log('PASS — the artefact matches the public delivery manifest.')
console.log('Note: this verifies content it has a reference for; it is not a proof of absence.')
process.exit(0)
