/**
 * Regression tests for the release-artefact verifier (tools/verify-release.mjs).
 *
 * The verifier is the last line of defence against publishing a build made on a
 * machine that has the licensed course bank installed: the SOURCE tree can be
 * spotless while `dist/` embeds the private bank, because `src/lib/bank.ts`
 * imports the generated loader statically.
 *
 * These tests build tiny synthetic output directories and the fixture bank files
 * the verifier compares against, so no real private content is written here.
 *
 * Run: node tests/verify-release.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const SCRIPT = path.join(ROOT, 'tools', 'verify-release.mjs')

const repos = []

/**
 * A throwaway project root holding:
 *   data/sample-bank.json   the public bank fixture
 *   data/local-bank.json    the "private" bank fixture (synthetic)
 *   src/lib/local-bank.generated.ts   whichever loader the build used
 *   dist/                   the built artefact
 */
function makeProject({ sample, local, loaderImportsLocalBank, dist }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'exampilot-rel-'))
  repos.push(dir)
  mkdirSync(path.join(dir, 'data'), { recursive: true })
  mkdirSync(path.join(dir, 'src', 'lib'), { recursive: true })
  mkdirSync(path.join(dir, 'tools'), { recursive: true })
  mkdirSync(path.join(dir, 'dist', 'assets'), { recursive: true })

  writeFileSync(path.join(dir, 'tools', 'verify-release.mjs'), readFileSync(SCRIPT))
  writeFileSync(path.join(dir, 'data', 'sample-bank.json'), JSON.stringify(sample, null, 2))
  if (local) writeFileSync(path.join(dir, 'data', 'local-bank.json'), JSON.stringify(local, null, 2))

  const loader = loaderImportsLocalBank
    ? "import local from '../../data/local-bank.json'\nexport const LOCAL_BANK = local\n"
    : 'export const LOCAL_BANK = null\n'
  writeFileSync(path.join(dir, 'src', 'lib', 'local-bank.generated.ts'), loader)

  for (const [name, content] of Object.entries(dist)) {
    writeFileSync(path.join(dir, 'dist', 'assets', name), content)
  }
  return dir
}

function runVerify(cwd) {
  try {
    const out = execFileSync(process.execPath, [path.join(cwd, 'tools', 'verify-release.mjs')], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { code: 0, out }
  } catch (e) {
    return { code: e.status ?? 1, out: String(e.stdout || '') + String(e.stderr || '') }
  }
}

process.on('exit', () => {
  for (const d of repos) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})

// Synthetic banks. Deliberately unlike the real course material.
const SAMPLE = {
  schema: 'examPilot.bank.v1',
  source: 'public sample bank',
  isSample: true,
  chapterOrder: ['c1'],
  questions: [
    { id: 'P1', stem: 'PUBLIC-SAMPLE-STEM-ONE-what is two plus two', type: 'single', answerNorm: 'A' },
    { id: 'P2', stem: 'PUBLIC-SAMPLE-STEM-TWO-name the primary colours', type: 'single', answerNorm: 'B' },
  ],
}
const PRIVATE = {
  schema: 'examPilot.bank.v1',
  // Stands in for the licensed bank's `source` label, which names the origin
  // document. It deliberately is NOT modelled as a filename: what matters to the
  // verifier is that this string is private, and inventing a `.pdf` here would
  // make the fixture itself look like a real document reference.
  source: 'PRIVATE-ORIGIN-LABEL-xyzzy-2020',
  generatedAt: '2020-01-01T00:00:00.000Z',
  chapterOrder: ['c1'],
  questions: [{ id: 'X1', stem: 'PRIVATE-BANK-STEM-ONE-not-for-public-release-at-all', type: 'single' }],
}

// ---------------------------------------------------------------------------
// A correctly published artefact passes.
// ---------------------------------------------------------------------------

test('verify: a public artefact (sample bank only) PASSES', () => {
  const d = makeProject({
    sample: SAMPLE,
    local: PRIVATE,
    loaderImportsLocalBank: false,
    dist: {
      'app.js':
        'var x=' + JSON.stringify(SAMPLE.questions[0].stem) + ';var y=' + JSON.stringify(SAMPLE.questions[1].stem),
    },
  })
  const { code, out } = runVerify(d)
  assert.equal(code, 0, out)
  assert.match(out, /PASS/)
  assert.match(out, /all 2 questions embedded/)
})

// ---------------------------------------------------------------------------
// The failure this verifier exists for: private bank embedded in dist.
// ---------------------------------------------------------------------------

test('verify: an artefact embedding PRIVATE question text FAILS', () => {
  const d = makeProject({
    sample: SAMPLE,
    local: PRIVATE,
    loaderImportsLocalBank: false,
    dist: {
      'app.js':
        JSON.stringify(SAMPLE.questions[0].stem) +
        JSON.stringify(SAMPLE.questions[1].stem) +
        JSON.stringify(PRIVATE.questions[0].stem),
    },
  })
  const { code, out } = runVerify(d)
  assert.equal(code, 1, 'private question text must block publication')
  assert.match(out, /embeds 1 question\(s\) from the private local bank/)
})

test('verify: a private-bank build is rejected even if no question text is present', () => {
  // The loader alone is enough evidence: it means the build resolved a real bank.
  const d = makeProject({
    sample: SAMPLE,
    local: PRIVATE,
    loaderImportsLocalBank: true,
    dist: { 'app.js': JSON.stringify(SAMPLE.questions[0].stem) + JSON.stringify(SAMPLE.questions[1].stem) },
  })
  const { code, out } = runVerify(d)
  assert.equal(code, 1)
  assert.match(out, /loader imports a local bank/)
})

test('verify: private bank METADATA (source label) blocks publication', () => {
  // The licensed bank's `source` names the origin document. It leaks even when
  // not a single question stem is present in the bundle.
  const d = makeProject({
    sample: SAMPLE,
    local: PRIVATE,
    loaderImportsLocalBank: false,
    dist: {
      'app.js':
        JSON.stringify(SAMPLE.questions[0].stem) +
        JSON.stringify(SAMPLE.questions[1].stem) +
        JSON.stringify(PRIVATE.source),
    },
  })
  const { code, out } = runVerify(d)
  assert.equal(code, 1, 'a private origin-document label must block publication')
  assert.match(out, /private bank metadata/)
})

// ---------------------------------------------------------------------------
// Generic hygiene checks on the artefact.
// ---------------------------------------------------------------------------

test('verify: a source map in the artefact FAILS', () => {
  const d = makeProject({
    sample: SAMPLE,
    loaderImportsLocalBank: false,
    dist: {
      'app.js': JSON.stringify(SAMPLE.questions[0].stem) + JSON.stringify(SAMPLE.questions[1].stem),
      'app.js.map': '{"version":3}',
    },
  })
  const { code, out } = runVerify(d)
  assert.equal(code, 1)
  assert.match(out, /source map/)
})

test('verify: a machine-specific absolute path FAILS', () => {
  const d = makeProject({
    sample: SAMPLE,
    loaderImportsLocalBank: false,
    dist: {
      'app.js':
        JSON.stringify(SAMPLE.questions[0].stem) +
        JSON.stringify(SAMPLE.questions[1].stem) +
        '"C:\\\\Users\\\\someone\\\\f"',
    },
  })
  const { code, out } = runVerify(d)
  assert.equal(code, 1)
  assert.match(out, /absolute path/)
})

test('verify: a credential-shaped string FAILS', () => {
  const d = makeProject({
    sample: SAMPLE,
    loaderImportsLocalBank: false,
    dist: {
      'app.js':
        JSON.stringify(SAMPLE.questions[0].stem) +
        JSON.stringify(SAMPLE.questions[1].stem) +
        '"sk-' +
        'A'.repeat(24) +
        '"',
    },
  })
  const { code, out } = runVerify(d)
  assert.equal(code, 1)
  assert.match(out, /credential-shaped/)
})

test('verify: a missing sample bank is reported, not silently ignored', () => {
  const d = makeProject({
    sample: SAMPLE,
    loaderImportsLocalBank: false,
    dist: { 'app.js': 'nothing useful' },
  })
  const { code, out } = runVerify(d)
  assert.equal(code, 1, 'an artefact with none of the public bank must not pass')
  assert.match(out, /missing 2 sample question/)
})

test('verify: a bare extension token is NOT treated as a document name', () => {
  // Ordinary code mentions the extension; only a NAME before it is a document.
  const d = makeProject({
    sample: SAMPLE,
    loaderImportsLocalBank: false,
    dist: {
      'app.js':
        JSON.stringify(SAMPLE.questions[0].stem) + JSON.stringify(SAMPLE.questions[1].stem) + '"*' + '.' + 'pdf' + '"',
    },
  })
  const { code, out } = runVerify(d)
  assert.equal(code, 0, out)
})
