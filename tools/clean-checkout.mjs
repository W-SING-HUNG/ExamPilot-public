/**
 * Clean-checkout acceptance run: install, typecheck, lint, format, unit tests,
 * AI contract tests, production build, browser E2E — all in the public
 * (sample-bank-only) configuration, with the AI proxy deliberately NOT running
 * and then running-unconfigured.
 *
 * Usage: node tools/clean-checkout.mjs
 */
import { execSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

const steps = []
function run(name, cmd, opts = {}) {
  const t0 = Date.now()
  try {
    const out = execSync(cmd, { encoding: 'utf8', stdio: 'pipe', ...opts })
    steps.push({ name, ok: true, ms: Date.now() - t0, out })
    console.log(`PASS  ${name}  (${Date.now() - t0}ms)`)
    return out
  } catch (e) {
    const out = ((e.stdout || '') + (e.stderr || '')).toString()
    steps.push({ name, ok: false, ms: Date.now() - t0, out })
    console.log(`FAIL  ${name}  (${Date.now() - t0}ms)`)
    console.log(out.split('\n').slice(-25).join('\n'))
    return null
  }
}

console.log('=== clean checkout (public sample bank) ===')
console.log('private bank present:', existsSync('data/bank.json'))
console.log('generated loader present:', existsSync('src/lib/local-bank.generated.ts'))
console.log('')

// 1. install with the committed lockfile, exactly like a fresh clone
run('npm ci', 'npm ci --no-audit --no-fund')

// 2. generate the bank loader (writes the null loader in public mode)
run('bank:local', 'npm run bank:local')

// 3. quality gates
run('typecheck', 'npm run typecheck')
run('lint', 'npm run lint')
run('format:check', 'npm run format:check')
run('unit tests', 'npm test')
run('AI proxy contract tests', 'npm run test:ai')

// 4. production build with the sample bank only
const buildOut = run('production build', 'npm run build')
if (buildOut) {
  const js = buildOut.match(/dist\/assets\/index-\w+\.js\s+([\d.]+) kB/)
  if (js) console.log(`      bundle: ${js[1]} kB`)
}

// 5. browser E2E with the AI proxy NOT running (degraded path).
// The script needs a dev server, so start one if none is reachable.
let devServer = null
async function ensureDevServer() {
  for (let i = 0; i < 10; i++) {
    try {
      const r = await fetch('http://localhost:5173/')
      if (r.ok) {
        console.log('      (reusing running dev server)')
        return
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  console.log('      (starting dev server)')
  devServer = spawn('node', ['node_modules/vite/bin/vite.js'], {
    stdio: 'ignore',
    detached: false,
  })
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch('http://localhost:5173/')
      if (r.ok) return
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('dev server did not start')
}

await ensureDevServer()
run('browser E2E (AI proxy down)', 'node tests/browser.test.mjs', {
  env: { ...process.env, E2E_BASE: 'http://localhost:5173' },
})
if (devServer) devServer.kill('SIGTERM')

console.log('\n=== summary ===')
const failed = steps.filter((s) => !s.ok)
for (const s of steps) console.log(`${s.ok ? 'PASS' : 'FAIL'}  ${s.name}`)
console.log(`\n${steps.length - failed.length}/${steps.length} passed`)
process.exit(failed.length === 0 ? 0 : 1)
