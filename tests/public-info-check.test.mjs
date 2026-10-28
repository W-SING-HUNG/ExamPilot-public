/**
 * Regression tests for the public-information gate.
 *
 * These tests are written against the CURRENT behaviour and are designed to fail
 * against the previous implementation, which:
 *   - printed the matched source line (re-disclosing credentials into CI logs)
 *   - scanned only tracked worktree files + commit messages, and labelled that
 *     as the whole audit
 *   - had no path-level block (relied on .gitignore and text patterns)
 *
 * Run: node tests/public-info-check.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const SCRIPT = path.join(ROOT, 'tools', 'public-info-check.mjs')

// Synthetic values only. Never real credentials or real personal paths.
//
// Filenames and tool names are assembled at runtime so this test file does not
// itself contain a literal that the gate would (correctly) flag. Every value
// here is FICTIONAL: the fixtures exist to prove the gate redacts them, so
// substituting a real private string would make this file the leak it guards
// against.
const PDF_EXT = '.' + 'pdf'
const FAKE_KEY = 'sk-' + 'A'.repeat(24) + 'synthetic'
const FAKE_TOKEN = 'ghp_' + 'B'.repeat(24) + 'synthetic'
const FAKE_WIN_PATH = 'C:' + '\\' + 'Users' + '\\' + 'syntheticuser' + '\\' + 'Desktop' + '\\' + 'notes.txt'
const FAKE_NIX_PATH = '/Users/' + 'syntheticuser' + '/secret/project.txt'
const FAKE_EMAIL = 'synthetic.person' + '@' + 'gmail.com'
const FAKE_PDF = '"' + 'private-source-material' + PDF_EXT + '"'
const FAKE_AGENT = 'Clau' + 'de'

/** Run a git command inside a temp repo. */
function gitIn(cwd, args, opts = {}) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts })
}

/** Create an isolated git repo containing the gate script, and return its path. */
function makeRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'exampilot-gate-'))
  gitIn(dir, ['init', '-q', '-b', 'main'])
  gitIn(dir, ['config', 'user.email', 'test@example.invalid'])
  gitIn(dir, ['config', 'user.name', 'Test'])
  gitIn(dir, ['config', 'commit.gpgsign', 'false'])
  mkdirSync(path.join(dir, 'tools'), { recursive: true })
  writeFileSync(path.join(dir, 'tools', 'public-info-check.mjs'), readFileSync(SCRIPT))
  writeFileSync(path.join(dir, 'README.md'), '# clean fixture\n')
  return dir
}

function runGate(cwd, args = []) {
  const res = execFileSync(process.execPath, [path.join(cwd, 'tools', 'public-info-check.mjs'), ...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return { code: 0, out: res }
}

/** Run the gate capturing stderr/stdout even on failure. */
function runGateRaw(cwd, args = []) {
  try {
    const out = execFileSync(process.execPath, [path.join(cwd, 'tools', 'public-info-check.mjs'), ...args], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
    return { code: 0, out }
  } catch (e) {
    return { code: e.status ?? 1, out: String(e.stdout || '') + String(e.stderr || '') }
  }
}

const repos = []
function repo() {
  const d = makeRepo()
  repos.push(d)
  return d
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

// ---------------------------------------------------------------------------
// Issue 1 — findings must never print the matched text
// ---------------------------------------------------------------------------

test('gate: SECRET finding is reported WITHOUT printing the credential', () => {
  const d = repo()
  writeFileSync(path.join(d, 'leak.js'), `const apiKey = '${FAKE_KEY}'\n`)
  gitIn(d, ['add', '-A'])
  const { code, out } = runGateRaw(d, ['--index', '--no-metadata'])

  assert.equal(code, 1, 'a credential must fail the gate')
  assert.ok(out.includes('credential-literal'), 'the rule id must be reported')
  assert.ok(!out.includes(FAKE_KEY), 'the raw credential must NOT appear in output')
  assert.ok(!out.includes('AAAA'), 'no fragment of the credential may appear')
})

test('gate: INTERNAL findings do not print the private path, email or document name', () => {
  const d = repo()
  writeFileSync(
    path.join(d, 'notes.js'),
    [
      `const win = '${FAKE_WIN_PATH}'`,
      `const nix = '${FAKE_NIX_PATH}'`,
      `const mail = '${FAKE_EMAIL}'`,
      `const src = ${FAKE_PDF}`,
      // A private record, not a mere tool mention: this is what must be blocked.
      `// pasted from the ${FAKE_AGENT} chat log`,
      '',
    ].join('\n'),
  )
  gitIn(d, ['add', '-A'])
  const { code, out } = runGateRaw(d, ['--index', '--no-metadata'])

  assert.equal(code, 1, 'internal findings must fail the gate')
  for (const secret of [FAKE_WIN_PATH, FAKE_NIX_PATH, FAKE_EMAIL, 'private-source-material']) {
    assert.ok(!out.includes(secret), `must not print: ${secret}`)
  }
  // The rule ids and descriptions ARE reported, so the finding is actionable.
  assert.ok(/windows-user-path|posix-home-path|personal-email|source-doc-name|private-collaboration-record/.test(out))
})

test('gate: a commit message containing a credential is reported without the message text', () => {
  const d = repo()
  writeFileSync(path.join(d, 'a.txt'), 'clean\n')
  gitIn(d, ['add', '-A'])
  gitIn(d, ['commit', '-q', '-m', `oops token ${FAKE_TOKEN} committed`])

  const { code, out } = runGateRaw(d, ['--index'])
  assert.equal(code, 1)
  assert.ok(out.includes('credential-literal'))
  assert.ok(!out.includes(FAKE_TOKEN), 'the commit message text must not be printed')
  assert.ok(!out.includes('oops token'), 'no commit message fragment may be printed')
})

test('gate: a sensitive PATH in a finding is redacted in the report', () => {
  const d = repo()
  // The finding's location is itself sensitive: the file NAME contains personal
  // data and the content contains a credential. Neither may be printed.
  writeFileSync(path.join(d, `${FAKE_EMAIL}.txt`), `token = '${FAKE_KEY}'\n`)
  gitIn(d, ['add', '-A'])
  const { code, out } = runGateRaw(d, ['--index', '--no-metadata'])
  assert.equal(code, 1)
  assert.ok(!out.includes(FAKE_EMAIL), 'the sensitive file name must not be printed verbatim')
  assert.ok(!out.includes(FAKE_KEY), 'the credential must not be printed')
  assert.match(out, /redacted path/)
  assert.match(out, /credential-literal/)
})

test('gate: placeholders in fixtures still pass (no false positive)', () => {
  const d = repo()
  writeFileSync(
    path.join(d, 'fixture.mjs'),
    ["const AI_API_KEY = 'your-api-key-here'", "const t = 'shared-secret'", ''].join('\n'),
  )
  gitIn(d, ['add', '-A'])
  const { code, out } = runGateRaw(d, ['--index', '--no-metadata'])
  assert.equal(code, 0, `placeholders must not fail:\n${out}`)
})

// ---------------------------------------------------------------------------
// Issue 3 — mode separation and honest scope reporting
// ---------------------------------------------------------------------------

test('gate: staged content is scanned, not just the worktree', () => {
  const d = repo()
  // Stage the secret, then clean the WORKTREE. An index scan must still see the
  // secret; a worktree scan legitimately would not.
  writeFileSync(path.join(d, 'safe.txt'), `const k = '${FAKE_KEY}'\n`)
  gitIn(d, ['add', '-A'])
  writeFileSync(path.join(d, 'safe.txt'), 'clean now\n')

  const indexRun = runGateRaw(d, ['--index', '--no-metadata'])
  assert.equal(indexRun.code, 1, 'the STAGED secret must be detected')
  assert.ok(!indexRun.out.includes(FAKE_KEY))

  const worktreeRun = runGateRaw(d, ['--worktree', '--no-metadata'])
  assert.equal(worktreeRun.code, 0, 'the worktree really is clean, proving the modes differ')
})

test('gate: --commit scans the committed tree, independent of the worktree', () => {
  const d = repo()
  writeFileSync(path.join(d, 'cfg.txt'), `key = '${FAKE_KEY}'\n`)
  gitIn(d, ['add', '-A'])
  gitIn(d, ['commit', '-q', '-m', 'add config'])
  // Remove it from the worktree; the COMMIT still contains it.
  rmSync(path.join(d, 'cfg.txt'))
  writeFileSync(path.join(d, 'cfg.txt'), 'rotated\n')

  const { code, out } = runGateRaw(d, ['--commit', 'HEAD', '--no-metadata'])
  assert.equal(code, 1, 'the committed blob must be detected')
  assert.ok(!out.includes(FAKE_KEY))
})

test('gate: the report names the mode and does not overstate scope', () => {
  const d = repo()
  writeFileSync(path.join(d, 'ok.txt'), 'clean\n')
  gitIn(d, ['add', '-A'])
  const { out } = runGateRaw(d, ['--index', '--no-metadata'])

  assert.match(out, /mode\s+:\s+index/)
  assert.match(out, /staged content/)
  assert.match(out, /not proof/i, 'must state that a clean run is not a guarantee')
  assert.match(out, /known patterns/i)
})

test('gate: --all-refs reports blob coverage, not "full history audit"', () => {
  const d = repo()
  writeFileSync(path.join(d, 'ok.txt'), 'clean\n')
  gitIn(d, ['add', '-A'])
  gitIn(d, ['commit', '-q', '-m', 'first'])
  const { out } = runGateRaw(d, ['--all-refs', '--no-metadata'])
  assert.match(out, /all-refs content/)
  assert.match(out, /unique blob/)
  assert.doesNotMatch(out, /full history audit/i)
})

test('gate: metadata scanning can be disabled and is reported separately', () => {
  const d = repo()
  writeFileSync(path.join(d, 'a.txt'), 'clean\n')
  gitIn(d, ['add', '-A'])
  gitIn(d, ['commit', '-q', '-m', `bad ${FAKE_TOKEN}`])

  const withMeta = runGateRaw(d, ['--index'])
  assert.equal(withMeta.code, 1)

  const withoutMeta = runGateRaw(d, ['--index', '--no-metadata'])
  assert.equal(withoutMeta.code, 0, 'metadata scan disabled -> commit message not considered')
  assert.match(withoutMeta.out, /commit metadata : 0 commit message/)
})

// ---------------------------------------------------------------------------
// Issue 4 — path-level hard block
// ---------------------------------------------------------------------------

const HARD_BLOCKED = [
  'data/bank.json',
  'data/local-bank.json',
  'src/lib/local-bank.generated.ts',
  'tools/pdf_text.txt',
  'server/ai-config.json',
  '.env',
  '.env.local',
  'private-source' + PDF_EXT,
]

for (const p of HARD_BLOCKED) {
  test(`gate: hard-blocks ${p} even when the content is clean`, () => {
    const d = repo()
    const full = path.join(d, p)
    mkdirSync(path.dirname(full), { recursive: true })
    writeFileSync(full, 'this content is completely innocent\n')
    gitIn(d, ['add', '-A'])
    const { code, out } = runGateRaw(d, ['--index', '--no-metadata'])
    assert.equal(code, 1, `${p} must be blocked by path, not by content`)
    assert.match(out, /FORBIDDEN PATH/)
    assert.ok(!out.includes('innocent'), 'must not dump file content')
  })
}

test('gate: REJECTS git add -f (force-added gitignored sensitive file)', () => {
  const d = repo()
  mkdirSync(path.join(d, 'data'), { recursive: true })
  writeFileSync(path.join(d, '.gitignore'), 'data/bank.json\n')
  writeFileSync(path.join(d, 'data', 'bank.json'), '{"questions":[]}\n')
  // The bypass this rule exists to stop.
  gitIn(d, ['add', '-f', 'data/bank.json'])
  const { code, out } = runGateRaw(d, ['--index', '--no-metadata'])
  assert.equal(code, 1, 'git add -f must not bypass the gate')
  assert.match(out, /FORBIDDEN PATH/)
})

test('gate: allows the placeholder example while blocking real .env files', () => {
  const d = repo()
  writeFileSync(path.join(d, '.env.example'), 'AI_API_KEY=your-api-key-here\n')
  gitIn(d, ['add', '-A'])
  const ok = runGateRaw(d, ['--index', '--no-metadata'])
  assert.equal(ok.code, 0, '.env.example must remain allowed')

  // Assembled at runtime: a literal `KEY=<value>` line in THIS file would be a
  // real credential-shaped assignment on a tracked path, so the gate would (and
  // should) report it. The fixture value only has to look non-placeholder.
  writeFileSync(path.join(d, '.env'), ['AI_API_KEY=', 'something-real-looking', '-1234', '\n'].join(''))
  gitIn(d, ['add', '-A'])
  const bad = runGateRaw(d, ['--index', '--no-metadata'])
  assert.equal(bad.code, 1, '.env must be blocked')
})

test('gate: blocks a private PDF but allows the committed sample bank json', () => {
  const d = repo()
  mkdirSync(path.join(d, 'data'), { recursive: true })
  writeFileSync(path.join(d, 'data', 'sample-bank.json'), '{"questions":[]}\n')
  let r = runGateRaw(d, ['--index', '--no-metadata'])
  assert.equal(r.code, 0, 'data/sample-bank.json is a public file and must pass')

  writeFileSync(path.join(d, 'course-bank' + PDF_EXT), 'not a real document\n')
  gitIn(d, ['add', '-A'])
  r = runGateRaw(d, ['--index', '--no-metadata'])
  assert.equal(r.code, 1, 'a PDF must be hard-blocked')
})

// ---------------------------------------------------------------------------
// Allowlist integrity: allowlists must never silence credentials
// ---------------------------------------------------------------------------

test('gate: the file allowlist does NOT suppress SECRET rules', () => {
  const d = repo()
  // The scanner allows itself for vocabulary rules; a credential inside it must
  // still be caught.
  const selfPath = path.join(d, 'tools', 'public-info-check.mjs')
  const original = readFileSync(selfPath, 'utf8')
  writeFileSync(selfPath, original + `\n// ${FAKE_KEY}\n`)
  gitIn(d, ['add', '-A'])
  const { code, out } = runGateRaw(d, ['--index', '--no-metadata'])
  assert.equal(code, 1, 'allowlisting must not mask a credential')
  assert.ok(!out.includes(FAKE_KEY))
})

test('gate: does not rely on .gitignore to block sensitive paths', () => {
  const d = repo()
  // No .gitignore at all, yet the file must still be blocked.
  assert.equal(existsSync(path.join(d, '.gitignore')), false)
  mkdirSync(path.join(d, 'server'), { recursive: true })
  writeFileSync(path.join(d, 'server', 'ai-config.json'), '{"apiKey":"x"}\n')
  gitIn(d, ['add', '-A'])
  const { code } = runGateRaw(d, ['--index', '--no-metadata'])
  assert.equal(code, 1)
})

// ---------------------------------------------------------------------------
// Mode distinction: the committed tree vs historical blobs
// ---------------------------------------------------------------------------

test('gate: a secret removed by a later commit is gone from --commit but still in --all-refs', () => {
  const d = repo()
  writeFileSync(path.join(d, 'legacy.txt'), `key = '${FAKE_KEY}'\n`)
  gitIn(d, ['add', '-A'])
  gitIn(d, ['commit', '-q', '-m', 'first'])
  // Remove the secret in a second commit: HEAD is clean, history is not.
  writeFileSync(path.join(d, 'legacy.txt'), 'rotated\n')
  gitIn(d, ['add', '-A'])
  gitIn(d, ['commit', '-q', '-m', 'second'])

  const head = runGateRaw(d, ['--commit', 'HEAD', '--no-metadata'])
  assert.equal(head.code, 0, 'the current tree must be clean')
  assert.ok(!head.out.includes(FAKE_KEY))

  const first = runGateRaw(d, ['--commit', 'HEAD~1', '--no-metadata'])
  assert.equal(first.code, 1, 'the earlier tree still contains it')
  assert.ok(!first.out.includes(FAKE_KEY), 'even then, the value is never printed')

  const all = runGateRaw(d, ['--all-refs', '--no-metadata'])
  assert.equal(all.code, 1, '--all-refs must surface the historical blob')
  assert.ok(!all.out.includes(FAKE_KEY))
  assert.match(all.out, /unique blob/)
})

// ---------------------------------------------------------------------------
// Boundary fix 1 — a forbidden path's NAME must never be printed
//
// Regression: safePath() relied on the content rules, and the source-document
// rule requires quotes, so a real (unquoted) git path was printed verbatim.
// ---------------------------------------------------------------------------

test('gate: a blocked private PDF filename is REDACTED in the report', () => {
  const d = repo()
  // A FICTIONAL document name. It must look like a real title so the redaction
  // path is exercised, but it must not be any actual document's name — the whole
  // point of this test is that the gate never reprints private filenames, and a
  // real name written here would defeat that.
  const cnName = 'FICTIONAL-合成文档-示例' + PDF_EXT
  writeFileSync(path.join(d, cnName), 'innocent content\n')
  gitIn(d, ['add', '-A'])

  const { code, out } = runGateRaw(d, ['--index', '--no-metadata'])
  assert.equal(code, 1, 'a private PDF must be blocked')
  assert.ok(!out.includes(cnName), 'the raw private filename must NOT be printed')
  // No .pdf name at all may survive anywhere in the output.
  assert.ok(!/[\w\u4e00-\u9fff\uFF00-\uFFEF-]+\.pdf/i.test(out), 'no document name may appear in the log')
  assert.match(out, /redacted path/, 'a redaction marker must be present')
  assert.match(out, /private-source-pdf/, 'the rule id must still be reported')
})

test('gate: an ASCII private PDF filename is also redacted', () => {
  const d = repo()
  const name = 'internal-question-bank-2026' + PDF_EXT
  writeFileSync(path.join(d, name), 'innocent\n')
  gitIn(d, ['add', '-A'])
  const { code, out } = runGateRaw(d, ['--index', '--no-metadata'])
  assert.equal(code, 1)
  assert.ok(!out.includes(name), 'the filename must not be printed')
  assert.match(out, /redacted path/)
})

test('gate: non-sensitive forbidden paths are still named for actionability', () => {
  const d = repo()
  mkdirSync(path.join(d, 'data'), { recursive: true })
  writeFileSync(path.join(d, 'data', 'bank.json'), '{}\n')
  gitIn(d, ['add', '-A'])
  const { code, out } = runGateRaw(d, ['--index', '--no-metadata'])
  assert.equal(code, 1)
  // Ordinary repo paths are not secret; naming them is what makes the report useful.
  assert.match(out, /data\/bank\.json/)
})

// ---------------------------------------------------------------------------
// Boundary fix 2 — every common .env variant is blocked by PATH
// ---------------------------------------------------------------------------

const ENV_BLOCKED = [
  '.env',
  '.env.local',
  '.env.production',
  '.env.development',
  '.env.test',
  '.env.staging',
  '.env.production.local',
  '.env.development.local',
  '.env.test.local',
  '.env.staging.local',
  '.env.production.local.bak',
  'config/.env.production.local',
  'a/b/.env',
  '.ENV',
  '.ENV.LOCAL',
  '.env.LOCAL',
  '.Env.Production.Local',
]

for (const name of ENV_BLOCKED) {
  test(`gate: blocks .env variant "${name}" by path`, () => {
    const d = repo()
    const full = path.join(d, name)
    mkdirSync(path.dirname(full), { recursive: true })
    // Deliberately innocuous content: the PATH must be what blocks it.
    writeFileSync(full, 'PLACEHOLDER=hello\n')
    gitIn(d, ['add', '-A'])
    const { code, out } = runGateRaw(d, ['--index', '--no-metadata'])
    assert.equal(code, 1, `${name} must be blocked by path, not content`)
    assert.match(out, /FORBIDDEN PATH/)
    assert.match(out, /environment-secrets/)
  })
}

const ENV_ALLOWED = ['.env.example', '.env.sample', '.env.template', 'config/.env.example', 'docs/env.md']

for (const name of ENV_ALLOWED) {
  test(`gate: allows credential-free template "${name}"`, () => {
    const d = repo()
    const full = path.join(d, name)
    mkdirSync(path.dirname(full), { recursive: true })
    writeFileSync(full, '# placeholders only\nAI_API_KEY=your-api-key-here\n')
    gitIn(d, ['add', '-A'])
    const { code, out } = runGateRaw(d, ['--index', '--no-metadata'])
    assert.equal(code, 0, `${name} must remain allowed:\n${out}`)
  })
}

// ---------------------------------------------------------------------------
// Boundary fix 3 — lockfiles must not be a secret blind spot
// ---------------------------------------------------------------------------

test('gate: a credential injected into package-lock.json IS detected', () => {
  const d = repo()
  writeFileSync(path.join(d, 'package-lock.json'), JSON.stringify({ injected: FAKE_KEY }, null, 2))
  gitIn(d, ['add', '-A'])
  const { code, out } = runGateRaw(d, ['--index', '--no-metadata'])
  assert.equal(code, 1, 'a credential in a lockfile must fail the gate')
  assert.match(out, /credential-literal/)
  assert.ok(!out.includes(FAKE_KEY), 'the raw value must not be printed')
})

test('gate: a real npm lockfile still passes (no lockfile false positives)', () => {
  const d = repo()
  writeFileSync(path.join(d, 'package-lock.json'), readFileSync(path.join(ROOT, 'package-lock.json')))
  gitIn(d, ['add', '-A'])
  const { code, out } = runGateRaw(d, ['--index', '--no-metadata'])
  assert.equal(code, 0, `an ordinary lockfile must pass:\n${out.slice(0, 800)}`)
  assert.match(out, /lockfile/, 'the report must state that a lockfile was scanned')
})

test('gate: vocabulary rules are still skipped in lockfiles, SECRET rules are not', () => {
  const d = repo()
  // A tool name inside a lockfile must not fail the build...
  writeFileSync(path.join(d, 'package-lock.json'), JSON.stringify({ note: FAKE_AGENT }, null, 2))
  gitIn(d, ['add', '-A'])
  assert.equal(runGateRaw(d, ['--index', '--no-metadata']).code, 0, 'vocabulary is noise in a lockfile')

  // ...but a credential in the same file must.
  writeFileSync(path.join(d, 'package-lock.json'), JSON.stringify({ note: FAKE_AGENT, k: FAKE_KEY }, null, 2))
  gitIn(d, ['add', '-A'])
  const { code, out } = runGateRaw(d, ['--index', '--no-metadata'])
  assert.equal(code, 1, 'SECRET rules must still apply inside lockfiles')
  assert.ok(!out.includes(FAKE_KEY))
})

// ---------------------------------------------------------------------------
// Boundary fix 4 — metadata scope follows the SELECTED revision
//
// Regression: the metadata scan was hardcoded to HEAD, so `--commit <old>`
// reported HEAD's messages regardless of the revision under inspection.
// ---------------------------------------------------------------------------

test("gate: --commit <rev> scans THAT revision's metadata, not HEAD", () => {
  const d = repo()
  writeFileSync(path.join(d, 'a.txt'), 'a\n')
  gitIn(d, ['add', '-A'])
  gitIn(d, ['commit', '-q', '-m', 'commit A clean'])
  const shaA = gitIn(d, ['rev-parse', 'HEAD']).trim()

  writeFileSync(path.join(d, 'b.txt'), 'b\n')
  gitIn(d, ['add', '-A'])
  gitIn(d, ['commit', '-q', '-m', `commit B with ${FAKE_TOKEN}`])
  const shaB = gitIn(d, ['rev-parse', 'HEAD']).trim()

  writeFileSync(path.join(d, 'c.txt'), 'c\n')
  gitIn(d, ['add', '-A'])
  gitIn(d, ['commit', '-q', '-m', 'commit C clean'])
  const shaC = gitIn(d, ['rev-parse', 'HEAD']).trim()

  // Selecting the clean ANCESTOR must pass: its ancestry holds no secret.
  const atA = runGateRaw(d, ['--commit', shaA])
  assert.equal(atA.code, 0, 'the selected revision A and its ancestors are clean')
  assert.ok(!atA.out.includes(FAKE_TOKEN))
  assert.match(atA.out, /scope: ancestry of/)

  // Selecting the revision that contains the secret must fail.
  const atB = runGateRaw(d, ['--commit', shaB])
  assert.equal(atB.code, 1, 'revision B introduced the secret')
  assert.ok(!atB.out.includes(FAKE_TOKEN), 'the token must never be printed')

  // And HEAD (which has B in its ancestry) must also fail.
  const atC = runGateRaw(d, ['--commit', shaC])
  assert.equal(atC.code, 1, 'B is an ancestor of C')
  assert.ok(!atC.out.includes(FAKE_TOKEN))

  // The scope line must differ, proving it is not pinned to HEAD.
  const scopeA = (atA.out.match(/scope: [^\n]*/) || [''])[0]
  const scopeC = (atC.out.match(/scope: [^\n]*/) || [''])[0]
  assert.notEqual(scopeA, scopeC, 'the reported scope must reflect the selected revision')
})

// ---------------------------------------------------------------------------
// Boundary fix 5 — encoded and split literals
//
// Regression: a value could be committed in a shape the line matcher could not
// see. Escaping four CJK characters as `\uXXXX` and joining them with `+` was
// enough to hide a document name, and the same trick works for any string.
// ---------------------------------------------------------------------------

/** Build `\uXXXX` escapes for `text` without writing the escapes literally. */
function escapeUnicode(text) {
  return [...text].map((ch) => '\\u' + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')).join('')
}

const SYNTHETIC_TITLE = '合成测试文档名称'

test('gate: a document name hidden as unicode escapes is detected', () => {
  const d = repo()
  const escaped = escapeUnicode(SYNTHETIC_TITLE)
  // Split across literals, exactly the shape that hid a real name before.
  writeFileSync(path.join(d, 'probe.mjs'), `const parts = '${escaped.slice(0, 12)}' + '${escaped.slice(12)}'\n`)
  gitIn(d, ['add', '-A'])
  const { code, out } = runGateRaw(d, ['--index', '--no-metadata'])
  assert.equal(code, 1, 'escaped CJK must not be a blind spot')
  assert.match(out, /obfuscated-cjk-literal|source-doc-name/)
  assert.ok(!out.includes(escaped), 'the encoded text must not be echoed')
  assert.ok(!out.includes(SYNTHETIC_TITLE), 'neither may the decoded text be echoed')
})

test('gate: a filename split across concatenation is still matched', () => {
  const d = repo()
  // Adjacent literals joined by `+`: no single literal is a document name, which
  // is exactly the shape that hid a real title here once. The extension is built
  // at runtime so this fixture is not itself a quotable filename.
  const ext = '.' + 'pdf'
  writeFileSync(path.join(d, 'src.mjs'), `const f = '"' + 'synthetic' + '-' + 'report' + '${ext}' + '"'\n`)
  gitIn(d, ['add', '-A'])
  const { code, out } = runGateRaw(d, ['--index', '--no-metadata'])
  assert.equal(code, 1, 'a concatenated filename must not slip through')
  assert.match(out, /source-doc-name/)
})

test('gate: ordinary regex character classes are NOT flagged as obfuscation', () => {
  const d = repo()
  // A CJK range in a character class is normal source, not a hidden payload.
  writeFileSync(path.join(d, 'util.mjs'), 'const CJK = /[\\u4e00-\\u9fff]+/g\n')
  gitIn(d, ['add', '-A'])
  const { code, out } = runGateRaw(d, ['--index', '--no-metadata'])
  assert.equal(code, 0, `a character-class range must not be a false positive:\n${out}`)
})

// ---------------------------------------------------------------------------
// Boundary fix 6 — modern credential formats
//
// Regression: only five prefixes were recognised, so common real-world token
// shapes passed silently. The values are synthetic AND assembled from character
// codes, because writing a credential-shaped literal here would trip the very
// rule under test — the same trap that hid a document name in this file before.
// ---------------------------------------------------------------------------

/** Build a string from character codes, so no literal appears in this source. */
const ch = (...codes) => String.fromCharCode(...codes)
const BODY = 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'

const SYNTHETIC_CREDENTIALS = {
  'openai project key': ch(115, 107) + '-' + ch(112, 114, 111, 106) + '-' + BODY.slice(0, 20),
  'gitlab pat': ch(103, 108, 112, 97, 116) + '-' + BODY.slice(0, 20),
  'slack token': ch(120, 111, 120, 98) + '-123456789012-abcdefghijklmnop',
  'google api key': ch(65, 73, 122, 97) + BODY,
  'npm token': ch(110, 112, 109, 95) + BODY,
  jwt: ch(101, 121, 74) + 'hbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJlcGFydA',
}

for (const [label, value] of Object.entries(SYNTHETIC_CREDENTIALS)) {
  test(`gate: detects a synthetic ${label}`, () => {
    const d = repo()
    writeFileSync(path.join(d, 'creds.txt'), `value = '${value}'\n`)
    gitIn(d, ['add', '-A'])
    const { code, out } = runGateRaw(d, ['--index', '--no-metadata'])
    assert.equal(code, 1, `${label} must be detected`)
    assert.match(out, /credential-literal/)
    assert.ok(!out.includes(value), 'the credential must never be printed')
  })
}

test('gate: detects a credential embedded in a connection URI', () => {
  const d = repo()
  const pw = BODY.slice(0, 12)
  writeFileSync(path.join(d, 'db.txt'), "url = 'postgres://svcuser:" + pw + '@db.internal/app' + "'\n")
  gitIn(d, ['add', '-A'])
  const { code, out } = runGateRaw(d, ['--index', '--no-metadata'])
  assert.equal(code, 1, 'a URI-embedded password must be detected')
  assert.match(out, /credential-in-uri/)
  assert.ok(!out.includes(pw), 'the password must never be printed')
})

// ---------------------------------------------------------------------------
// Boundary fix 7 — the placeholder excuse must not cover real values
//
// Regression: `assigned-secret` excused the entire LINE when any of
// example/sample/xxx appeared anywhere on it, so a real key passed whenever a
// nearby comment said "sample".
// ---------------------------------------------------------------------------

test('gate: an "example" comment elsewhere on the line does not excuse a real value', () => {
  const d = repo()
  const real = BODY.slice(0, 16)
  writeFileSync(path.join(d, 'cfg.mjs'), `const apiKey = "${real}" // example deployment\n`)
  gitIn(d, ['add', '-A'])
  const { code, out } = runGateRaw(d, ['--index', '--no-metadata'])
  assert.equal(code, 1, 'the excuse must apply to the VALUE, not the line')
  assert.match(out, /assigned-secret/)
  assert.ok(!out.includes(real))
})

test('gate: a placeholder value is still allowed as an assigned secret', () => {
  const d = repo()
  writeFileSync(
    path.join(d, 'cfg.mjs'),
    ['const apiKey = "your-api-key-here"', 'const token = "placeholder-value-1234"', ''].join('\n'),
  )
  gitIn(d, ['add', '-A'])
  const { code, out } = runGateRaw(d, ['--index', '--no-metadata'])
  assert.equal(code, 0, `placeholders must stay allowed:\n${out}`)
})

// ---------------------------------------------------------------------------
// Boundary fix 8 — `assigned-secret` covers the value forms this project
// actually uses, including credentials with no known provider prefix
//
// Regression: the rule required QUOTED values. So `AI_API_KEY=<token>` (.env),
// `"apiKey": "<token>"` (JSON) and `apiKey: <token>` (YAML) were all missed —
// and because a self-hosted gateway token has no `sk-`/`ghp_` prefix, the
// `credential-literal` rule could not catch it either. Together that left a
// real credential able to pass the gate silently.
// ---------------------------------------------------------------------------

/**
 * An opaque token with NO known provider prefix (42 chars, URL-safe).
 *
 * Assembled at runtime on purpose: a literal `TOKEN = '<42 chars>'` assignment
 * in this tracked file is itself a credential-shaped assignment, so the gate
 * would (correctly) block the very test that verifies it blocks such values.
 * This is the same reason every other fixture in this file is assembled.
 */
const OPAQUE_TOKEN = ['aq9ZtR4mXvB2nLpY7kJs3dGf6Hc', 'W1eUo8iTq5rAz0xNbV'].join('')

const ASSIGNED_SECRET_BLOCKED = [
  ['env unquoted', `AI_API_KEY=${OPAQUE_TOKEN}\n`, 'the .env form users are told to create'],
  ['env, unrelated name', `EXAMPILOT_TOKEN=${OPAQUE_TOKEN}\n`, 'an env var without an "api" prefix'],
  ['json double-quoted key', `{\n  "apiKey": "${OPAQUE_TOKEN}"\n}\n`, 'the shape of a gateway config file'],
  ['yaml', `apiKey: ${OPAQUE_TOKEN}\n`, 'the YAML form'],
  ['ts single-quoted', `const apiKey = '${OPAQUE_TOKEN}'\n`, 'a JS/TS literal'],
  ['password in json', `{\n  "password": "${OPAQUE_TOKEN}"\n}\n`, 'a password field'],
  ['secret in json', `{\n  "secret": "${OPAQUE_TOKEN}"\n}\n`, 'a secret field'],
]

for (const [label, body, why] of ASSIGNED_SECRET_BLOCKED) {
  test(`gate: assigned-secret blocks an unquoted/quoted real value — ${label}`, () => {
    const d = repo()
    writeFileSync(path.join(d, 'cfg.txt'), body)
    gitIn(d, ['add', '-A'])
    const { code, out } = runGateRaw(d, ['--index', '--no-metadata'])
    assert.equal(code, 1, `${why} must be blocked`)
    assert.match(out, /assigned-secret/)
    // The gate must never echo the detected value back into the log.
    assert.ok(!out.includes(OPAQUE_TOKEN), 'the detected value must not be printed')
  })
}

test('gate: assigned-secret blocks an unquoted token with no provider prefix in .env', () => {
  const d = repo()
  writeFileSync(path.join(d, '.env.local'), `AI_API_KEY=${OPAQUE_TOKEN}\n`)
  gitIn(d, ['add', '-A'])
  const { code, out } = runGateRaw(d, ['--index', '--no-metadata'])
  assert.equal(code, 1, 'an opaque self-hosted token must be blocked')
  assert.match(out, /assigned-secret/)
  assert.ok(!out.includes(OPAQUE_TOKEN))
})

// The counter-direction is equally important: widening the rule must not turn
// ordinary source code into a blocker, or the gate becomes noise and gets
// switched off. These are REAL lines from this repository.
const ASSIGNED_SECRET_ALLOWED = [
  ['react key prop', '        <div key={g.group} role="group" aria-label={g.group}>\n'],
  ['react key over items', '          <li key={i}>{s}</li>\n'],
  ['env var read with fallback', "const CONFIG_TOKEN = process.env.AI_CONFIG_TOKEN || ''\n"],
  ['placeholder env value', 'AI_API_KEY=your-api-key-here\n'],
  ['numeric env value', 'AI_MAX_TOKENS=2048\n'],
  ['localStorage key constant', "const CONFIG_KEY = 'exampilot.mock.config'\n"],
  ['numeric config field', '    timeoutMs: Number(process.env.AI_TIMEOUT_MS || 60000),\n'],
  ['numeric request field', '        max_tokens: c.maxTokens,\n'],
  ['quoted placeholder', 'const apiKey = "your-api-key-here"\n'],
  ['quoted placeholder, 2nd form', 'const token = "placeholder-value-1234"\n'],
  ['placeholder for secrets', "const t = 'shared-secret'\n"],
  ['keyboard event check', "      if (e.key === 'Escape') {\n"],
  ['numeric type declaration', '  timeoutMs: number\n'],
  ['short non-secret value', 'TOKEN=abc123\n'],
  ['object property read', '        apiKey: c.apiKey,\n'],
  ['chained variable read', 'const k = apiKey || token || credential\n'],
]

for (const [label, body] of ASSIGNED_SECRET_ALLOWED) {
  test(`gate: assigned-secret does not flag legitimate code — ${label}`, () => {
    const d = repo()
    writeFileSync(path.join(d, 'src.ts'), body)
    gitIn(d, ['add', '-A'])
    const { code, out } = runGateRaw(d, ['--index', '--no-metadata'])
    assert.equal(code, 0, `must not be a finding:\n${body}\n${out}`)
  })
}

test('gate: the placeholder excuse still applies only to the VALUE, not the line', () => {
  const d = repo()
  // A real value with a "sample" comment beside it must still block.
  writeFileSync(path.join(d, 'cfg.mjs'), `const apiKey = "${OPAQUE_TOKEN}" // sample for docs\n`)
  gitIn(d, ['add', '-A'])
  const { code, out } = runGateRaw(d, ['--index', '--no-metadata'])
  assert.equal(code, 1, 'a nearby comment must not excuse a real unquoted/quoted value')
  assert.match(out, /assigned-secret/)
})

// ---------------------------------------------------------------------------
// Boundary fix 9 — commit metadata no longer skips document names
//
// Regression: `scanCommitMetadata` skipped `source-doc-name` on the theory that
// a commit message is prose. A message naming a source document disproves that.
// ---------------------------------------------------------------------------

test('gate: a commit message naming a document is flagged', () => {
  const d = repo()
  writeFileSync(path.join(d, 'a.txt'), 'clean\n')
  gitIn(d, ['add', '-A'])
  // Assemble the subject so this test file does not itself quote a filename.
  const docName = '"synthetic' + '-' + 'source' + PDF_EXT + '"'
  gitIn(d, ['commit', '-q', '-m', `feat: parse ${docName} into the bank`])
  const { code, out } = runGateRaw(d, ['--index'])
  assert.equal(code, 1, 'a document name in a commit message must be reported')
  assert.match(out, /source-doc-name/)
  assert.ok(!out.includes('synthetic-source'), 'the name must not be printed')
})

// ---------------------------------------------------------------------------
// Boundary fix 9 — local-only artifacts are blocked by path
// ---------------------------------------------------------------------------

const LOCAL_ONLY_BLOCKED = [
  'tools/.gh_token',
  'tools/staged.txt',
  'exampilot-bank.json',
  'exampilot-history-2026-01.csv',
  'scratch/probe.mjs',
]
for (const p of LOCAL_ONLY_BLOCKED) {
  test(`gate: hard-blocks local-only artifact ${p}`, () => {
    const d = repo()
    const full = path.join(d, p)
    mkdirSync(path.dirname(full), { recursive: true })
    writeFileSync(full, 'innocent\n')
    gitIn(d, ['add', '-f', p])
    const { code, out } = runGateRaw(d, ['--index', '--no-metadata'])
    assert.equal(code, 1, `${p} must be blocked by path`)
    assert.match(out, /FORBIDDEN PATH/)
  })
}

// ---------------------------------------------------------------------------
// Boundary fix 10 — validation-claim covers the compound wording actually used
// ---------------------------------------------------------------------------

test('gate: "independent source review" wording is flagged as an unsupported claim', () => {
  const d = repo()
  // Assembled from parts so this fixture is not itself a quotable claim.
  const claim = '独立' + '源码' + '审查'
  writeFileSync(path.join(d, 'NOTES.md'), `- 针对${claim}确认的缺陷进行整改\n`)
  gitIn(d, ['add', '-A'])
  const { code, out } = runGateRaw(d, ['--index', '--no-metadata'])
  // REVIEW severity is advisory: it must be reported without failing the build.
  assert.equal(code, 0, 'a review-level claim does not block')
  assert.match(out, /validation-claim/, 'but it must be surfaced')
})

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Boundary fix 11 — AI tool names are PUBLIC; private AI records are not
//
// An earlier version flagged ANY tool name as INTERNAL. That was wrong twice
// over: it treated a public product name as a secret, and it penalised the
// honest statement "assisted by <tool>" — punishing disclosure and rewarding
// silence, the opposite of what this gate is for.
//
// Classification now:
//   public / advisory : tool names, provider names, model ids, attributions
//   INTERNAL          : transcripts, personal prompts, internal instructions
// ---------------------------------------------------------------------------

test('gate: a provider model id is NOT flagged (AI provider names are public)', () => {
  const d = repo()
  writeFileSync(path.join(d, 'models.ts'), "export const MODELS = ['gpt-4o', 'claude-3-5-sonnet', 'gemini-pro']\n")
  gitIn(d, ['add', '-A'])
  const { code, out } = runGateRaw(d, ['--index', '--no-metadata'])
  assert.equal(code, 0, `model ids must not be treated as secrets:\n${out}`)
})

test('gate: an honest AI-attribution sentence does NOT block the build', () => {
  const d = repo()
  const tool = 'Clau' + 'de'
  writeFileSync(path.join(d, 'NOTES.md'), `- this module was assisted by ${tool} Code\n`)
  gitIn(d, ['add', '-A'])
  const { code, out } = runGateRaw(d, ['--index', '--no-metadata'])
  assert.equal(code, 0, `stating how the work was done must not be blocked:\n${out}`)
  // Still surfaced as advice, so a reviewer can confirm the claim is accurate.
  assert.match(out, /ai-attribution-note/, 'the attribution is surfaced, not hidden')
})

test('gate: a bare AI tool name in prose does NOT block', () => {
  const d = repo()
  const tools = ['Clau' + 'de', 'Chat' + 'GPT', 'Co' + 'pilot'].join(', ')
  writeFileSync(path.join(d, 'README.md'), `Compatible backends include ${tools}.\n`)
  gitIn(d, ['add', '-A'])
  const { code } = runGateRaw(d, ['--index', '--no-metadata'])
  assert.equal(code, 0, 'a product name is not a secret')
})

test('gate: a PRIVATE collaboration record IS still blocked', () => {
  const d = repo()
  const tool = 'Clau' + 'de'
  writeFileSync(path.join(d, 'notes.md'), `- pasted from the ${tool} chat log we kept\n`)
  gitIn(d, ['add', '-A'])
  const { code, out } = runGateRaw(d, ['--index', '--no-metadata'])
  assert.equal(code, 1, 'a transcript remains an INTERNAL disclosure')
  assert.match(out, /private-collaboration-record/)
})

test('gate: internal instructions addressed to a tool ARE still blocked', () => {
  const d = repo()
  const tool = 'Code' + 'x'
  writeFileSync(path.join(d, 'notes.md'), `internal instructions for ${tool}: always answer in JSON\n`)
  gitIn(d, ['add', '-A'])
  const { code, out } = runGateRaw(d, ['--index', '--no-metadata'])
  assert.equal(code, 1, 'internal instruction text is not publishable')
  assert.match(out, /private-collaboration-record/)
})

test('gate: personal prompts written for a tool ARE still blocked', () => {
  const d = repo()
  const tool = 'Gem' + 'ini'
  writeFileSync(path.join(d, 'notes.md'), `my prompts for ${tool} are in this folder\n`)
  gitIn(d, ['add', '-A'])
  const { code, out } = runGateRaw(d, ['--index', '--no-metadata'])
  assert.equal(code, 1, 'a personal prompt library is a private record')
  assert.match(out, /private-collaboration-record/)
})

// ---------------------------------------------------------------------------
// EXACT_LINE_EXEMPTIONS — reviewed false positives.
//
// The rule vocabulary contains ordinary product words. Two UI lines and one
// historical commit body in THIS project legitimately use them. The exemption
// mechanism must excuse exactly those, and nothing else.
//
// These tests exist to prove both halves. If a future change widens the
// mechanism (substring matching, keyword allowlist, rule-wide bypass), the
// "still blocked" cases below start failing.
// ---------------------------------------------------------------------------

const LOCAL_AI = 'src/components/FloatingAiAssistant.tsx'

// The reviewed lines are READ FROM the shipped exemption table rather than
// copied here. Two reasons:
//   1. writing them literally would make this fixture trip the very rule it
//      tests, and the gate would (correctly) refuse to publish this file;
//   2. the test then proves the table is coherent with itself, and a typo in an
//      exemption line is caught here instead of silently disabling it.
function shippedExemptionLines() {
  const src = readFileSync(SCRIPT, 'utf8')
  const start = src.indexOf('export const EXACT_LINE_EXEMPTIONS')
  assert.ok(start > 0, 'exemption table exists in the gate')
  const end = src.indexOf('\n]', start)
  assert.ok(end > start, 'exemption table is well formed')
  const block = src.slice(start, end)
  const lines = [...block.matchAll(/\bline:\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/g)].map((m) =>
    (m[1] ?? m[2]).replace(/\\'/g, "'").replace(/\\\\/g, '\\'),
  )
  assert.equal(lines.length, 4, 'exactly four reviewed lines are exempted')
  return lines
}
const EXEMPT_LINES = shippedExemptionLines()
const L_PROMPT = EXEMPT_LINES[0]
const L_CLEAR = EXEMPT_LINES[1]
// A NEAR MISS: same words, different tail. Must not be exempted.
const L_NEARMISS = L_PROMPT + ' — 这是另一个版本的写法'

test('exemption: the two reviewed product lines in FloatingAiAssistant pass', () => {
  const d = repo()
  mkdirSync(path.join(d, 'src', 'components'), { recursive: true })
  writeFileSync(path.join(d, LOCAL_AI), [L_PROMPT, L_CLEAR, ''].join('\n'))
  gitIn(d, ['add', '-A'])
  const { code, out } = runGateRaw(d, ['--index', '--no-metadata'])
  assert.equal(code, 0, 'reviewed UI copy is not a private record')
  assert.doesNotMatch(out, /process-disclosure/)
})

test('exemption: the same WORDS on a different line in the same file still block', () => {
  const d = repo()
  mkdirSync(path.join(d, 'src', 'components'), { recursive: true })
  // Same vocabulary, different surrounding text -> must NOT be exempt.
  writeFileSync(path.join(d, LOCAL_AI), [L_NEARMISS, 'const a = 1', ''].join('\n'))
  gitIn(d, ['add', '-A'])
  const { code, out } = runGateRaw(d, ['--index', '--no-metadata'])
  assert.equal(code, 1, 'a near-miss line is not covered by an exact-line exemption')
  assert.match(out, /process-disclosure/)
})

test('exemption: no leading-whitespace drift can smuggle content, and indentation is normalised', () => {
  const d = repo()
  mkdirSync(path.join(d, 'src', 'components'), { recursive: true })
  // Trimmed-equal to the reviewed line: indentation may differ, wording may not.
  writeFileSync(path.join(d, LOCAL_AI), ['\t\t' + L_PROMPT + '   ', 'const a = 1', ''].join('\n'))
  gitIn(d, ['add', '-A'])
  const { code } = runGateRaw(d, ['--index', '--no-metadata'])
  assert.equal(code, 0, 'whitespace-only drift still resolves to the reviewed line')
})

test('exemption: the same product line in a DIFFERENT file still blocks', () => {
  const d = repo()
  writeFileSync(path.join(d, 'notes.md'), L_PROMPT + '\n')
  gitIn(d, ['add', '-A'])
  const { code, out } = runGateRaw(d, ['--index', '--no-metadata'])
  assert.equal(code, 1, 'exemption is scoped to one file path')
  assert.match(out, /process-disclosure/)
})

test('exemption: a real private prompt record in the exempted FILE still blocks', () => {
  const d = repo()
  mkdirSync(path.join(d, 'src', 'components'), { recursive: true })
  const tool = 'Clau' + 'de'
  writeFileSync(path.join(d, LOCAL_AI), [L_PROMPT, `// my prompts for ${tool}: be extremely rude`, ''].join('\n'))
  gitIn(d, ['add', '-A'])
  const { code, out } = runGateRaw(d, ['--index', '--no-metadata'])
  assert.equal(code, 1, 'the exemption does not whitelist the whole file')
  assert.match(out, /private-collaboration-record/)
})

test('exemption: SECRET rules are never excused by the exact-line mechanism', () => {
  const d = repo()
  mkdirSync(path.join(d, 'src', 'components'), { recursive: true })
  // A credential on a line that is NOT in the exemption table.
  writeFileSync(path.join(d, LOCAL_AI), `const k = "${FAKE_KEY}"\n`)
  gitIn(d, ['add', '-A'])
  const { code, out } = runGateRaw(d, ['--index', '--no-metadata'])
  assert.equal(code, 1, 'credentials have no exemption path')
  assert.match(out, /SECRET|credential/)
})

test('exemption: an unicode-escaped copy of a reviewed line is NOT excused', () => {
  const d = repo()
  mkdirSync(path.join(d, 'src', 'components'), { recursive: true })
  // Same characters, written as escapes. The exemption compares the RAW line, so
  // the obfuscated form must still trip the rule that looks through encodings.
  const escaped = '\\u63d0\\u793a\\u8bcd'
  writeFileSync(path.join(d, LOCAL_AI), `// 全新题目解析：使用干净规范的系统${escaped}\n`)
  gitIn(d, ['add', '-A'])
  const { code, out } = runGateRaw(d, ['--index', '--no-metadata'])
  assert.equal(code, 1, 'encoding obfuscation is not covered by an exact-line exemption')
  assert.match(out, /process-disclosure/)
})

test('exemption: table entries are exact, rule-scoped and justified', () => {
  // Static invariants on the shipped table. Cheap to check, and they catch the
  // "just add a keyword to make CI green" failure mode.
  const gate = readFileSync(SCRIPT, 'utf8')
  const start = gate.indexOf('export const EXACT_LINE_EXEMPTIONS')
  assert.ok(start > 0, 'exemption table exists')
  const block = gate.slice(start, gate.indexOf(']\n', gate.indexOf('reason:', start)))
  for (const m of block.matchAll(/rule:\s*'([^']+)'/g)) {
    assert.equal(m[1], 'process-disclosure', 'only the reviewed vocabulary rule is exemptible')
  }
  assert.equal((block.match(/reason:/g) || []).length, 4, 'every entry documents why it is safe')
  assert.equal((block.match(/rule:\s*/g) || []).length, 4, 'exactly four reviewed entries')
  // The vocabulary itself must be untouched by this mechanism.
  assert.match(gate, /'提' \+ '示词'/, 'the flagged word is still in the vocabulary')
  assert.match(gate, /'对话' \+ '记录'/, 'the flagged phrase is still in the vocabulary')
})

test('review rule: a fabricated infrastructure id in deployment code is flagged', () => {
  const d = repo()
  mkdirSync(path.join(d, 'tools', 'web'), { recursive: true })
  // Entirely invented values. The rule must fire on the SHAPE, not on a list of
  // known resources, so an operator account id or D1 uuid cannot slip in unnoticed.
  writeFileSync(
    path.join(d, 'tools', 'web', 'deploy-demo.mjs'),
    [
      "const ACCOUNT = '0123456789abcdef0123456789abcdef'",
      "const DB = '11111111-2222-4333-8444-555555555555'",
      "const HOST = 'demo-tenant.workers.dev'",
      '',
    ].join('\n'),
  )
  gitIn(d, ['add', '-A'])
  const { code, out } = runGateRaw(d, ['--index', '--no-metadata'])
  assert.equal(code, 0, 'a REVIEW finding does not block the build')
  const hits = out.match(/cloud-resource-id/g) || []
  assert.ok(hits.length >= 3, 'every identifier shape on those lines is reported')
  assert.doesNotMatch(out, /0123456789abcdef/, 'the matched value is never echoed back')
})

test('the gate keeps no record of specific resources, hashed or otherwise', () => {
  const gate = readFileSync(SCRIPT, 'utf8')
  assert.doesNotMatch(gate, /OPERATOR_DIGESTS/, 'no digest table of real identifiers')
  assert.doesNotMatch(gate, /\b[0-9a-f]{64}\b/, 'no 64-hex constant of that shape')
  assert.doesNotMatch(gate, /hasOperatorId|infraTokens/, 'no digest-matching helpers')
})
