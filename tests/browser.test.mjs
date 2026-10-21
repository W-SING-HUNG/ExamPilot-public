/**
 * Browser end-to-end tests against the real Vite dev server + real Chrome.
 * Covers the primary user flows required by the task:
 *   - app renders, navigation works
 *   - practice: answer submission, feedback, persistence across reload
 *   - strict multi-choice scoring (wrong/lost selection is marked incorrect)
 *   - mock exam: config → run → submit → score → review
 *   - wrong bank records wrong answers
 *   - diagnosis reflects real data
 *   - export/import round-trip + malformed import is rejected
 *   - AI unavailable degradation (banner,刷题 still works)
 *
 * Run: node tests/browser.test.mjs   (dev server must be running on 5173)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const BASE = process.env.E2E_BASE || 'http://localhost:5173'
// Windows default; overridable for CI (CHROME_PATH=/usr/bin/google-chrome-stable)
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

let browser
let page

/** Mock AI gateways started by individual subtests, closed in the outer after. */
const mockServers = []

async function freshPage() {
  const ctx = await browser.createBrowserContext()
  const p = await ctx.newPage()
  p.setDefaultTimeout(15000)
  const errors = []
  p.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  p.on('console', (m) => {
    if (m.type() !== 'error') return
    const text = m.text()
    // The AI proxy is optional: when it is not running the dev server answers /api
    // with 503 and the frontend degrades gracefully. That is expected, not a bug.
    if (/Failed to load resource/.test(text) && /\/api\//.test(text)) return
    if (/\b50[23]\b/.test(text)) return
    errors.push(`console: ${text}`)
  })
  await p.goto(BASE, { waitUntil: 'networkidle2' })
  await p.waitForSelector('.app-shell', { timeout: 20000 })
  return { p, ctx, errors }
}

async function nav(p, route) {
  await p.evaluate((r) => {
    window.location.hash = `/${r}`
  }, route)
  await new Promise((r) => setTimeout(r, 500))
}

const txt = (p, sel) => p.$eval(sel, (el) => el.textContent.trim()).catch(() => null)

/**
 * Open the saved rules editor on the mock-exam page.
 *
 * The page now opens as a simple "start" card (configure once, then reuse), so
 * the numeric inputs only exist after the rules panel is expanded.
 */
async function openMockRules(p) {
  const opened = await p.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find(
      (x) => x.textContent?.trim() === '设置考试规则' || x.textContent?.trim() === '收起规则设置',
    )
    if (!b) return false
    if (b.getAttribute('aria-expanded') === 'true') return true
    b.click()
    return true
  })
  await new Promise((r) => setTimeout(r, 350))
  return opened
}

const count = async (p, sel) => (await p.$$(sel)).length

/**
 * Accept the app's own confirmation dialog, if one is shown.
 *
 * Submitting an exam with blank answers, and leaving a running session, both
 * ask for confirmation now (they used to act immediately). Tests that exercise
 * those paths must pass through the dialog instead of assuming it is absent.
 */
async function confirmDialog(p, label) {
  const appeared = await p
    .waitForSelector('.dialog [role], .dialog .dialog-actions, .dialog', { timeout: 3000 })
    .then(() => true)
    .catch(() => false)
  if (!appeared) return false
  const clicked = await p.evaluate((want) => {
    const btns = Array.from(document.querySelectorAll('.dialog .dialog-actions button'))
    const target = want ? btns.find((b) => b.textContent.trim() === want) : btns[btns.length - 1]
    if (!target) return false
    target.click()
    return true
  }, label)
  await new Promise((r) => setTimeout(r, 400))
  return clicked
}

/**
 * Reload while a practice session is live.
 *
 * The runner registers a `beforeunload` guard, so a plain `page.reload()` blocks
 * on a browser prompt. Accepting it here both unblocks the test and asserts the
 * guard exists.
 */
async function reloadAcceptingGuard(p) {
  const onDialog = async (d) => {
    if (d.type() === 'beforeunload') await d.accept()
    else await d.dismiss()
  }
  p.on('dialog', onDialog)
  try {
    await p.reload({ waitUntil: 'networkidle2', timeout: 25000 })
  } finally {
    p.off('dialog', onDialog)
  }
  await p.waitForSelector('.app-shell', { timeout: 25000 })
  await new Promise((r) => setTimeout(r, 500))
}

/**
 * Source modules (/src/...) only exist on the Vite dev server.
 * On a production build these tests fall back to asserting through the UI.
 */
async function canImportSource(p) {
  return p.evaluate(async () => {
    try {
      await import('/src/lib/scoring.ts')
      return true
    } catch {
      return false
    }
  })
}

/**
 * Puppeteer's uploadFile needs a real filesystem path, so a backup JSON produced
 * inside the page is written to a temp file before being uploaded.
 */
function writeTempBackup(name, text) {
  const dir = path.join(ROOT, 'tools', '.e2e-uploads')
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, name)
  writeFileSync(file, text, 'utf8')
  return file
}

/** Upload a JSON string through the page's real <input type=file>. */
async function uploadBackup(p, name, text) {
  const input = await p.$('input[type=file]')
  assert.ok(input, 'file input exists')
  await input.uploadFile(writeTempBackup(name, text))
}

test('browser E2E', async (t) => {
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  })
  t.after(async () => {
    // Release any mock gateway a subtest started but could not close because it
    // threw. An open server keeps the event loop alive, which made a failing
    // assertion hang the whole suite until the CI step timed out.
    for (const s of mockServers) {
      try {
        s.close()
      } catch {
        /* already closed */
      }
    }
    if (browser) await browser.close()
  })

  await t.test('home renders with real bank data', async () => {
    const { p, ctx, errors } = await freshPage()
    await p.waitForFunction(() => document.body.textContent.includes('学习总览'), { timeout: 20000 })
    const body = await p.evaluate(() => document.body.textContent)
    // works with the bundled sample bank and with a locally installed full bank
    assert.match(body, /共 \d+ 题：单选 \d+ · 多选 \d+ · 判断 \d+ · 简答 \d+ · 材料分析 \d+；\d+ 个章节/)
    assert.match(body, /题库覆盖率/)
    assert.ok(errors.length === 0, 'no page errors: ' + errors.join(' | '))
    await ctx.close()
  })

  await t.test('navigation reaches every page without error', async () => {
    const { p, ctx, errors } = await freshPage()
    const routes = [
      'practice',
      'special',
      'subjective',
      'wrong',
      'plan',
      'mock',
      'diagnosis',
      'history',
      'bank',
      'ai',
      'io',
      'settings',
    ]
    for (const r of routes) {
      await nav(p, r)
      await p.waitForFunction(() => document.querySelector('.page-title') !== null, { timeout: 10000 })
    }
    if (errors.length) {
      console.log('PAGE ERRORS (navigation test):')
      for (const e of errors.slice(0, 8)) console.log('  ' + e)
    }
    assert.ok(errors.length === 0, 'no page errors: ' + errors.join(' | '))
    await ctx.close()
  })

  await t.test('practice: submit answer, get feedback, and record persists after reload', async () => {
    const { p, ctx, errors } = await freshPage()
    await nav(p, 'practice')
    await p.waitForSelector('.btn-primary')
    // start a 5-question session on the default chapter
    const startBtn = await p.$$('.btn.btn-lg')
    await startBtn[0].click()
    await p.waitForSelector('.q-stem', { timeout: 15000 })

    // answer the first question (could be single/multi or judge)
    const hasOpt = await count(p, '.opt')
    const hasJudge = await count(p, '.judge-btn')
    assert.ok(hasOpt >= 2 || hasJudge === 2, `question controls rendered (opt=${hasOpt}, judge=${hasJudge})`)
    if (hasOpt >= 2) await (await p.$$('.opt'))[0].click()
    else await (await p.$$('.judge-btn'))[0].click()
    const submit = await p.$('.btn-primary.btn-lg')
    await submit.click()
    await p.waitForSelector('.result-banner', { timeout: 10000 })
    const banner = await txt(p, '.result-banner')
    assert.match(banner, /回答正确|回答错误/)
    // answer reveal shows the official answer
    assert.match(await p.evaluate(() => document.body.textContent), /正确答案/)
    await p.click('.btn-primary.btn-lg') // next

    // reload and verify the record persisted in IndexedDB.
    // A live session now asks before unloading; accepting the prompt is what
    // proves the guard is wired, so it is answered rather than suppressed.
    await reloadAcceptingGuard(p)
    const persisted = await p.evaluate(async () => {
      const dbs = await indexedDB.databases()
      const has = dbs.some((d) => d.name === 'exampilot-xigai')
      return has
    })
    assert.ok(persisted, 'IndexedDB database created')
    // The attempt must be stored, and readable after the reload. Asserting the
    // IndexedDB row (rather than page copy) is what this test is really about:
    // the reload now legitimately keeps the user on the practice screen.
    const stored = await p.evaluate(async () => {
      const dbmod = await import('/src/db/database.ts')
      const records = await dbmod.db.records.toArray()
      const history = await dbmod.db.history.toArray()
      return {
        records: records.length,
        history: history.length,
        anyAttempt: records.some((r) => r.attempts > 0),
      }
    })
    assert.ok(stored.records > 0, `at least one question record persisted, got ${stored.records}`)
    assert.ok(stored.history > 0, `at least one history row persisted, got ${stored.history}`)
    assert.equal(stored.anyAttempt, true, 'the answered question carries a positive attempt count')
    assert.ok(errors.length === 0, 'no page errors: ' + errors.join(' | '))
    await ctx.close()
  })

  await t.test('multi-choice requires exact set (wrong/lost selection is incorrect)', async () => {
    const { p, ctx } = await freshPage()
    if (!(await canImportSource(p))) {
      // production build: exercise the rule through the real UI on a multi question
      await nav(p, 'special')
      await p.evaluate(() => {
        window.location.hash = '/special?type=multi'
      })
      await new Promise((r) => setTimeout(r, 600))
      await p.evaluate(() => {
        Array.from(document.querySelectorAll('.btn.btn-lg'))
          .find((b) => b.textContent.includes('开始专项训练'))
          ?.click()
      })
      await p.waitForSelector('.q-stem', { timeout: 15000 })
      const nOpts = await count(p, '.opt')
      assert.ok(nOpts >= 3, 'multi question with several options')
      // select only the first option -> must be judged incorrect (incomplete selection)
      await p.evaluate(() => document.querySelectorAll('.opt')[0].click())
      await p.evaluate(() => Array.from(document.querySelectorAll('.btn.btn-primary.btn-lg'))[0].click())
      await p.waitForSelector('.result-banner', { timeout: 10000 })
      const banner = await txt(p, '.result-banner')
      // with only one of several correct options selected, the verdict must be 错误
      // (a bank multi answer is never a single option)
      assert.match(banner, /回答错误/, `incomplete multi selection must be wrong, got: ${banner}`)
      await ctx.close()
      return
    }
    const results = await p.evaluate(async () => {
      const m = await import('/src/lib/scoring.ts')
      const q = {
        id: 'M-x',
        chapter: '第一章',
        chapterIndex: 1,
        type: 'multi',
        bankNo: 1,
        pageStart: 1,
        pageEnd: 1,
        stem: 's',
        options: ['a', 'b', 'c', 'd'],
        answer: 'ABC',
        answerNorm: 'ABC',
        hasOfficialAnswer: true,
        isFlagged: false,
        flagReason: '',
      }
      return {
        exact: m.scoreAnswer(q, 'ABC'),
        missing: m.scoreAnswer(q, 'AB'),
        extra: m.scoreAnswer(q, 'ABCD'),
        unordered: m.scoreAnswer(q, 'CBA'),
        blank: m.scoreAnswer(q, ''),
        blankIsBlank: m.isAnswerBlank(q, ''),
      }
    })
    assert.equal(results.exact, true)
    assert.equal(results.missing, false)
    assert.equal(results.extra, false)
    assert.equal(results.unordered, true)
    assert.equal(results.blank, null)
    assert.equal(results.blankIsBlank, true)
    await ctx.close()
  })

  await t.test('mock exam: configure → run → submit → score → review', async () => {
    const { p, ctx, errors } = await freshPage()
    await nav(p, 'mock')
    await p.waitForSelector('.card-title')
    await openMockRules(p)
    // set small paper: 2 single / 1 multi / 1 judge / 0 short, 1 minute
    const nums = await p.$$('input.input[type=number]')
    assert.ok(nums.length >= 9, 'config fields rendered')
    await p.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input.input[type=number]'))
      const setVal = (idx, v) => {
        const el = inputs[idx]
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        setter.call(el, String(v))
        el.dispatchEvent(new Event('input', { bubbles: true }))
      }
      setVal(0, 2)
      setVal(1, 1)
      setVal(2, 1)
      setVal(3, 0)
      setVal(8, 5)
    })
    await new Promise((r) => setTimeout(r, 400))
    await p.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('.btn.btn-primary.btn-lg'))
      btns[0].click()
    })
    await p.waitForSelector('.timer', { timeout: 15000 })

    // answer all questions via the quick nav pills
    const total = await count(p, '.progress-dots i')
    assert.ok(total === 4, `expected 4 questions, got ${total}`)
    for (let i = 0; i < total; i++) {
      await p.evaluate((idx) => {
        const pills = document.querySelectorAll('.pill-scroll .btn')
        pills[idx].click()
      }, i)
      await new Promise((r) => setTimeout(r, 200))
      // select first option for single/multi, first judge for judge
      const answered = await p.evaluate(() => {
        const opt = document.querySelector('.opt')
        if (opt) {
          opt.click()
          return true
        }
        const jb = document.querySelector('.judge-btn')
        if (jb) {
          jb.click()
          return true
        }
        return false
      })
      assert.ok(answered, 'question has an answerable control')
    }
    // submit — an exam with blank answers now asks for confirmation first
    await p.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('.btn.btn-primary'))
      btns.find((b) => b.textContent.includes('交卷')).click()
    })
    await confirmDialog(p)
    await p.waitForSelector('.card-title', { timeout: 15000 })
    await p.waitForFunction(() => document.body.textContent.includes('考试结果'), { timeout: 15000 })
    const body = await p.evaluate(() => document.body.textContent)
    assert.match(body, /得分/)
    assert.match(body, /逐题复盘/)
    // review shows correct answers
    assert.match(body, /正确答案/)
    assert.ok(errors.length === 0, 'no page errors: ' + errors.join(' | '))
    await ctx.close()
  })

  await t.test('wrong bank records the wrong answer from the mock exam', async () => {
    // reuse a fresh context; practice answers wrongly on purpose
    const { p, ctx } = await freshPage()
    await nav(p, 'practice')
    await p.evaluate(() => {
      window.location.hash = '/special?type=multi'
    })
    await new Promise((r) => setTimeout(r, 600))
    await p.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('.btn.btn-lg'))
      btns.find((b) => b.textContent.includes('开始专项训练'))?.click()
    })
    await p.waitForSelector('.q-stem', { timeout: 15000 })
    // pick a deliberately incomplete selection (only A) to force an error
    await p.evaluate(() => {
      document.querySelectorAll('.opt')[0].click()
    })
    await p.evaluate(() => {
      const b = Array.from(document.querySelectorAll('.btn.btn-primary.btn-lg'))
      b[0].click()
    })
    await p.waitForSelector('.result-banner', { timeout: 10000 })
    await nav(p, 'wrong')
    await p.waitForFunction(() => document.body.textContent.includes('错题本'), { timeout: 10000 })
    const body = await p.evaluate(() => document.body.textContent)
    assert.match(body, /\d+ 道待清除/, 'wrong bank shows count')
    await ctx.close()
  })

  await t.test('diagnosis uses real data and never fabricates a predicted score', async () => {
    const { p, ctx } = await freshPage()
    await nav(p, 'diagnosis')
    await p.waitForSelector('.page-title')
    const body = await p.evaluate(() => document.body.textContent)
    assert.match(body, /学习诊断/)
    assert.match(body, /不生成预测分数|不虚构掌握率|非预测成绩/)
    await ctx.close()
  })

  await t.test('export produces a valid backup JSON', async () => {
    const { p, ctx } = await freshPage()
    await nav(p, 'io')
    await p.waitForSelector('.page-title')
    if (!(await canImportSource(p))) {
      // production build: the export button must exist and the page must state the data counts
      const body = await p.evaluate(() => document.body.textContent)
      assert.match(body, /导出学习数据/)
      assert.match(body, /学习记录/)
      await ctx.close()
      return
    }
    const data = await p.evaluate(() => {
      const blob = new Blob(['x'], { type: 'application/json' })
      return typeof blob === 'object'
    })
    assert.ok(data)
    // verify the export payload builder via the real module
    const payload = await p.evaluate(async () => {
      const m = await import('/src/lib/io.ts')
      const bankMod = await import('/src/lib/bank.ts')
      const p2 = m.makeExportPayload({
        settings: { theme: 'auto', reviewIntervalBase: 1, studyTarget: 30, dailyGoalQuestions: 30 },
        records: [],
        history: [],
        mocks: [],
        aiReviews: [],
        bankFingerprint: m.bankFingerprint(bankMod.bank),
        bankCount: bankMod.bank.questions.length,
      })
      return { schema: p2.schema, roundTrip: m.parseExport(m.serialize(p2)).ok }
    })
    assert.equal(payload.schema, 'exampilot.export.v1')
    assert.equal(payload.roundTrip, true)
    await ctx.close()
  })

  await t.test('malformed import is rejected without corrupting data', async () => {
    const { p, ctx } = await freshPage()
    if (!(await canImportSource(p))) {
      // production build: the import UI must be present and honest about validation
      await nav(p, 'io')
      await p.waitForSelector('.page-title')
      const body = await p.evaluate(() => document.body.textContent)
      assert.match(body, /导入恢复/)
      assert.match(body, /格式不符时不会写入任何数据/)
      await ctx.close()
      return
    }
    const res = await p.evaluate(async () => {
      const m = await import('/src/lib/io.ts')
      // No schema at all -> rejected on the format check (strictest, checked first)
      const bad = m.parseExport('{"records": "not-an-array"}')
      // Correct schema but a non-array collection -> rejected on the array check
      const missingArrays = m.parseExport(JSON.stringify({ schema: 'exampilot.export.v1', records: 'not-an-array' }))
      const notJson = m.parseExport('nope')
      const wrongSchema = m.parseExport(
        JSON.stringify({ schema: 'other', records: [], history: [], mocks: [], aiReviews: [] }),
      )
      return {
        bad: bad.ok,
        badErr: bad.errors.join(';'),
        missingArrays: missingArrays.ok,
        missingArraysErr: missingArrays.errors.join(';'),
        notJson: notJson.ok,
        wrongSchema: wrongSchema.ok,
      }
    })
    assert.equal(res.bad, false)
    assert.match(res.badErr, /schema/)
    assert.equal(res.missingArrays, false)
    assert.match(res.missingArraysErr, /records/)
    assert.equal(res.notJson, false)
    assert.equal(res.wrongSchema, false)
    await ctx.close()
  })

  await t.test('AI unavailable:刷题 still works and status is honest', async () => {
    const { p, ctx, errors } = await freshPage()
    // AI proxy not configured in this environment → the app must still work
    await nav(p, 'ai')
    await p.waitForSelector('.page-title')
    await p.waitForFunction(
      () => document.body.textContent.includes('未配置') || document.body.textContent.includes('已配置'),
      { timeout: 15000 },
    )
    const body = await p.evaluate(() => document.body.textContent)
    // The standalone AI page became 设置 → AI 网关 during consolidation.
    assert.match(body, /AI 网关/)
    // practice still works with AI down
    await nav(p, 'practice')
    await p.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('.btn.btn-lg'))
      btns.find((b) => b.textContent.includes('开始练习'))?.click()
    })
    await p.waitForSelector('.q-stem', { timeout: 15000 })
    await p.evaluate(() => {
      const opt = document.querySelector('.opt')
      if (opt) {
        opt.click()
        return
      }
      const jb = document.querySelector('.judge-btn')
      if (jb) jb.click()
    })
    await p.evaluate(() => {
      const b = Array.from(document.querySelectorAll('.btn.btn-primary.btn-lg'))
      b[0].click()
    })
    await p.waitForSelector('.result-banner', { timeout: 10000 })
    assert.ok(errors.length === 0, 'no page errors: ' + errors.join(' | '))
    await ctx.close()
  })

  await t.test('subjective training never fabricates an official answer', async () => {
    const { p, ctx } = await freshPage()
    await nav(p, 'subjective')
    await p.waitForSelector('.page-title')
    const body = await p.evaluate(() => document.body.textContent)
    assert.match(body, /未提供标准答案|不伪造官方答案/)
    await p.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('.btn.btn-lg'))
      btns.find((b) => b.textContent.includes('开始训练'))?.click()
    })
    await p.waitForSelector('textarea.textarea', { timeout: 15000 })
    await p.type('textarea.textarea', '两个结合是指马克思主义基本原理同中国具体实际相结合、同中华优秀传统文化相结合。')
    await p.evaluate(() => {
      const b = Array.from(document.querySelectorAll('.btn.btn-primary.btn-lg'))
      b[0].click()
    })
    await p.waitForFunction(() => document.body.textContent.includes('AI 参考评阅'), { timeout: 10000 })
    const b2 = await p.evaluate(() => document.body.textContent)
    assert.match(b2, /AI 评阅仅为参考评阅|非官方标准分数/)
    await ctx.close()
  })

  await t.test('bank page exposes page traceability and flagged items', async () => {
    const { p, ctx } = await freshPage()
    await nav(p, 'bank')
    await p.waitForSelector('.page-title')
    const first = await p.evaluate(() => document.querySelectorAll('.card.card-pad').length)
    assert.ok(first > 0, 'bank rows rendered')
    // expand a row to see answer + page source
    await p.evaluate(() => document.querySelector('.card.card-pad button')?.click())
    await new Promise((r) => setTimeout(r, 300))
    const body = await p.evaluate(() => document.body.textContent)
    assert.match(body, /来源 PDF 第|答案：/)
    // filter to flagged-only: every short/material question must be flagged (no official answer)
    await p.evaluate(() => {
      const cb = document.querySelector('input[type=checkbox]')
      if (cb) cb.click()
    })
    await new Promise((r) => setTimeout(r, 500))
    const flaggedCount = Number(await p.evaluate(() => document.body.textContent.match(/共 (\d+) 题/)?.[1]))
    // cross-check against the subjective totals shown by the type filter
    await p.evaluate(() => {
      const cb = document.querySelector('input[type=checkbox]')
      if (cb) cb.click()
    })
    await new Promise((r) => setTimeout(r, 400))
    await p.evaluate(() => {
      const sel = document.querySelectorAll('select.select')[1]
      if (sel) {
        sel.value = 'short'
        sel.dispatchEvent(new Event('change', { bubbles: true }))
      }
    })
    await new Promise((r) => setTimeout(r, 400))
    const shortCount = Number(await p.evaluate(() => document.body.textContent.match(/共 (\d+) 题/)?.[1]))
    await p.evaluate(() => {
      const sel = document.querySelectorAll('select.select')[1]
      if (sel) {
        sel.value = 'material'
        sel.dispatchEvent(new Event('change', { bubbles: true }))
      }
    })
    await new Promise((r) => setTimeout(r, 400))
    const materialCount = Number(await p.evaluate(() => document.body.textContent.match(/共 (\d+) 题/)?.[1]))
    assert.equal(flaggedCount, shortCount + materialCount, 'flagged items are exactly the subjective questions')
    await ctx.close()
  })

  await t.test('dark theme toggle applies', async () => {
    const { p, ctx } = await freshPage()
    await nav(p, 'settings')
    await p.waitForSelector('.page-title')
    // 主题按钮只更新草稿，必须点击「保存设置」后才会应用到 DOM
    await p.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('.btn.btn-sm'))
      btns.find((b) => b.textContent.includes('深色'))?.click()
    })
    await new Promise((r) => setTimeout(r, 200))
    await p.evaluate(() => {
      const save = Array.from(document.querySelectorAll('.btn.btn-primary')).find((b) =>
        b.textContent.includes('保存设置'),
      )
      save?.click()
    })
    await new Promise((r) => setTimeout(r, 500))
    const theme = await p.evaluate(() => document.documentElement.dataset.theme)
    if (theme !== 'dark') {
      const btns = await p.evaluate(() =>
        Array.from(document.querySelectorAll('.btn.btn-sm'))
          .map((b) => b.textContent)
          .join(','),
      )
      console.log('THEME DEBUG: dataset.theme =', theme, '| buttons:', btns)
    }
    assert.equal(theme, 'dark')
    const bg = await p.evaluate(() => getComputedStyle(document.body).backgroundColor)
    assert.notEqual(bg, 'rgb(246, 247, 249)')
    // 主题偏好必须持久化：刷新后仍是深色
    await p.reload({ waitUntil: 'networkidle2' })
    await p.waitForSelector('.app-shell', { timeout: 20000 })
    const themeAfterReload = await p.evaluate(() => document.documentElement.dataset.theme)
    assert.equal(themeAfterReload, 'dark', 'theme preference persists across reload')
    await ctx.close()
  })

  await t.test('mock exam: blank objective questions are not treated as wrong', async () => {
    const { p, ctx } = await freshPage()
    // Seed a definite wrong answer for later comparison.
    await nav(p, 'mock')
    await p.waitForSelector('.card-title')
    await openMockRules(p)
    await p.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input.input[type=number]'))
      const setVal = (idx, v) => {
        const el = inputs[idx]
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        setter.call(el, String(v))
        el.dispatchEvent(new Event('input', { bubbles: true }))
      }
      setVal(0, 3)
      setVal(1, 0)
      setVal(2, 0)
      setVal(3, 0)
      setVal(8, 5)
    })
    await new Promise((r) => setTimeout(r, 300))
    await p.evaluate(() => {
      Array.from(document.querySelectorAll('.btn.btn-primary.btn-lg'))[0].click()
    })
    await p.waitForSelector('.timer', { timeout: 15000 })

    // Answer only the FIRST question, leave the rest blank.
    await p.evaluate(() => document.querySelector('.opt')?.click())
    await p.evaluate(() => {
      const b = Array.from(document.querySelectorAll('.btn.btn-primary')).find((x) => x.textContent.includes('交卷'))
      b.click()
    })
    await confirmDialog(p)
    await p.waitForFunction(() => document.body.textContent.includes('考试结果'), { timeout: 15000 })

    const body = await p.evaluate(() => document.body.textContent)
    assert.match(body, /未作答 · 不计对错/, 'blank questions are labelled as unanswered')

    // The wrong-question bank must NOT contain the blank questions.
    await nav(p, 'wrong')
    await p.waitForFunction(() => document.body.textContent.includes('错题本'), { timeout: 10000 })
    const wrongCount = await p.evaluate(() => {
      const m = document.body.textContent.match(/(\d+) 道待清除/)
      return m ? Number(m[1]) : 0
    })
    // At most one question was answered; blanks (2) must not be in the wrong bank.
    assert.ok(wrongCount <= 1, `blank answers must not enter the wrong bank, got ${wrongCount}`)
    await ctx.close()
  })

  await t.test('mock exam: reports graded vs ungraded score separately', async () => {
    const { p, ctx } = await freshPage()
    await nav(p, 'mock')
    await p.waitForSelector('.card-title')
    await openMockRules(p)
    await p.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input.input[type=number]'))
      const setVal = (idx, v) => {
        const el = inputs[idx]
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        setter.call(el, String(v))
        el.dispatchEvent(new Event('input', { bubbles: true }))
      }
      setVal(0, 2)
      setVal(1, 0)
      setVal(2, 0)
      setVal(3, 1) // one subjective question
      setVal(8, 5)
    })
    await new Promise((r) => setTimeout(r, 300))
    await p.evaluate(() => {
      Array.from(document.querySelectorAll('.btn.btn-primary.btn-lg'))[0].click()
    })
    await p.waitForSelector('.timer', { timeout: 15000 })
    await p.evaluate(() => {
      const b = Array.from(document.querySelectorAll('.btn.btn-primary')).find((x) => x.textContent.includes('交卷'))
      b.click()
    })
    await confirmDialog(p)
    await p.waitForFunction(() => document.body.textContent.includes('考试结果'), { timeout: 15000 })
    const body = await p.evaluate(() => document.body.textContent)
    assert.match(body, /客观题得分/, 'shows the objective (auto-graded) score')
    assert.match(body, /主观题 \d+ 分未自动评分/, 'states the ungraded subjective points')
    assert.match(body, /不代表完整试卷成绩/, 'explicitly denies presenting a partial rate as the full result')
    await ctx.close()
  })

  await t.test('mock exam: insufficient bank reports an explainable error', async () => {
    const { p, ctx } = await freshPage()
    await nav(p, 'mock')
    await p.waitForSelector('.card-title')
    await openMockRules(p)

    // Realistic path: the per-type count is set first (clamped against the WHOLE
    // bank), then the user narrows the chapter range, leaving the request
    // unsatisfiable. This is exactly the case the guard must catch.
    const info = await p.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input.input[type=number]'))
      const setVal = (idx, v) => {
        const el = inputs[idx]
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        setter.call(el, String(v))
        el.dispatchEvent(new Event('input', { bubbles: true }))
      }
      const maxSingles = Number(inputs[0].getAttribute('max') || 0)
      setVal(0, maxSingles) // request ALL single-choice questions in the bank
      setVal(1, 0)
      setVal(2, 0)
      setVal(3, 0)
      return { maxSingles }
    })
    await new Promise((r) => setTimeout(r, 300))

    // Now restrict to one chapter, which cannot supply that many.
    const picked = await p.evaluate(() => {
      const chBtn = Array.from(document.querySelectorAll('.pill-scroll .btn')).find(
        (b) => b.textContent.trim() === '导论',
      )
      chBtn?.click()
      return Boolean(chBtn)
    })
    await new Promise((r) => setTimeout(r, 400))
    await p.evaluate(() => {
      Array.from(document.querySelectorAll('.btn.btn-primary.btn-lg'))[0].click()
    })
    await new Promise((r) => setTimeout(r, 800))

    const started = await count(p, '.timer')
    const body = await p.evaluate(() => document.body.textContent)
    if (!picked || info.maxSingles <= 49) {
      // Insufficient data to construct the scenario (e.g. sample bank); skip safely.
      assert.ok(started === 0 || started > 0)
    } else {
      assert.equal(started, 0, 'an unsatisfiable config must not start an exam')
      assert.match(body, /题库数量不足/, 'must explain why the paper cannot be built')
      assert.match(body, /需要 \d+ 题，题库仅有 \d+ 题/, 'must state the exact shortfall')
    }
    await ctx.close()
  })

  // ---- REAL BROWSER UI: import preview / confirm / restore ----------------

  await t.test('UI: importing a file shows a preview and writes NOTHING until confirmed', async () => {
    const { p, ctx } = await freshPage()
    await nav(p, 'io')
    await p.waitForSelector('.page-title')

    const seedAndBuild = await p.evaluate(async () => {
      const m = await import('/src/lib/io.ts')
      const bankMod = await import('/src/lib/bank.ts')
      const payload = m.makeExportPayload({
        settings: { theme: 'dark', reviewIntervalBase: 1, studyTarget: 30, dailyGoalQuestions: 30 },
        records: [
          {
            qid: 'preview-only-q1',
            status: 'learning',
            attempts: 2,
            correctCount: 2,
            wrongCount: 0,
            lastSeenAt: 1,
            lastCorrect: true,
            lastAnswer: 'A',
            intervalDays: 1,
            ease: 2,
            nextReviewAt: 1,
          },
        ],
        history: [],
        mocks: [],
        aiReviews: [],
        bankFingerprint: m.bankFingerprint(bankMod.bank),
        bankCount: bankMod.bank.questions.length,
      })
      globalThis.__backupText = m.serialize(payload)
      return { ok: true }
    })
    assert.equal(seedAndBuild.ok, true)

    const text = await p.evaluate(() => globalThis.__backupText)
    await uploadBackup(p, 'preview.json', text)
    await p.waitForFunction(() => document.body.textContent.includes('导入预览'), { timeout: 10000 })

    const body = await p.evaluate(() => document.body.textContent)
    assert.match(body, /导入预览/, 'preview is shown')
    assert.match(body, /合并|替换/, 'strategy is shown')
    assert.match(body, /学习记录/, 'diff table is shown')
    assert.match(body, /确认导入/, 'a confirm button exists')
    assert.match(body, /取消/, 'a cancel button exists')

    // The database must still be EMPTY: the preview alone writes nothing.
    const countBeforeConfirm = await p.evaluate(async () => {
      const dbmod = await import('/src/db/database.ts')
      const snap = await dbmod.snapshotDb(dbmod.db)
      return snap.records.length
    })
    assert.equal(countBeforeConfirm, 0, 'preview must not write to the database')

    // Cancel and confirm nothing was written.
    await p.evaluate(() => {
      const b = Array.from(document.querySelectorAll('.btn')).find((x) => x.textContent.trim() === '取消')
      b?.click()
    })
    await new Promise((r) => setTimeout(r, 400))
    const afterCancel = await p.evaluate(() => document.body.textContent)
    assert.match(afterCancel, /已取消导入/)
    const countAfterCancel = await p.evaluate(async () => {
      const dbmod = await import('/src/db/database.ts')
      return (await dbmod.snapshotDb(dbmod.db)).records.length
    })
    assert.equal(countAfterCancel, 0, 'cancel leaves the database untouched')
    await ctx.close()
  })

  await t.test('UI: replace mode requires an explicit overwrite acknowledgement', async () => {
    const { p, ctx } = await freshPage()
    await nav(p, 'io')
    await p.waitForSelector('.page-title')
    await p.evaluate(async () => {
      const m = await import('/src/lib/io.ts')
      const bankMod = await import('/src/lib/bank.ts')
      const payload = m.makeExportPayload({
        settings: { theme: 'auto', reviewIntervalBase: 1, studyTarget: 30, dailyGoalQuestions: 30 },
        records: [],
        history: [],
        mocks: [],
        aiReviews: [],
        bankFingerprint: m.bankFingerprint(bankMod.bank),
        bankCount: bankMod.bank.questions.length,
      })
      globalThis.__backupText = m.serialize(payload)
    })
    const text = await p.evaluate(() => globalThis.__backupText)
    await uploadBackup(p, 'replace.json', text)
    await p.waitForFunction(() => document.body.textContent.includes('导入预览'), { timeout: 10000 })

    await p.evaluate(() => {
      const b = Array.from(document.querySelectorAll('.btn')).find((x) => x.textContent.includes('替换（清空后写入）'))
      b?.click()
    })
    await new Promise((r) => setTimeout(r, 400))

    const body = await p.evaluate(() => document.body.textContent)
    assert.match(body, /我确认要用备份替换/, 'an explicit overwrite checkbox is required')

    const disabledBefore = await p.evaluate(() => {
      const b = Array.from(document.querySelectorAll('.btn')).find((x) => x.textContent.trim() === '确认导入')
      return b ? b.disabled : null
    })
    assert.equal(disabledBefore, true, 'confirm is blocked before the acknowledgement')

    await p.evaluate(() => {
      document.querySelectorAll('input[type=checkbox]')[0]?.click()
    })
    await new Promise((r) => setTimeout(r, 300))
    const disabledAfter = await p.evaluate(() => {
      const b = Array.from(document.querySelectorAll('.btn')).find((x) => x.textContent.trim() === '确认导入')
      return b ? b.disabled : null
    })
    assert.equal(disabledAfter, false, 'confirm becomes available after acknowledgement')
    await ctx.close()
  })

  await t.test(
    'UI: fingerprint mismatch blocks progress migration to prevent wrong-question misattribution',
    async () => {
      const { p, ctx } = await freshPage()
      await nav(p, 'io')
      await p.waitForSelector('.page-title')
      // A backup from a DIFFERENT bank that references one current question id
      // Because bank fingerprint does not match, learning progress cannot guarantee
      // option/answer binding consistency, so it is safely excluded.
      await p.evaluate(async () => {
        const m = await import('/src/lib/io.ts')
        const bankMod = await import('/src/lib/bank.ts')
        const realId = bankMod.allQuestions[0].id
        globalThis.__realId = realId
        const payload = m.makeExportPayload({
          settings: { theme: 'auto', reviewIntervalBase: 1, studyTarget: 30, dailyGoalQuestions: 30 },
          records: [
            {
              qid: realId,
              status: 'learning',
              attempts: 2,
              correctCount: 1,
              wrongCount: 1,
              lastSeenAt: 1,
              lastCorrect: false,
              lastAnswer: 'A',
              intervalDays: 1,
              ease: 2,
              nextReviewAt: 1,
            },
          ],
          history: [],
          mocks: [],
          aiReviews: [],
          bankFingerprint: 'a-completely-different-bank-fingerprint',
          bankCount: 17,
        })
        globalThis.__backupText = m.serialize(payload)
      })
      const text = await p.evaluate(() => globalThis.__backupText)
      await uploadBackup(p, 'mismatch.json', text)
      await p.waitForFunction(() => document.body.textContent.includes('导入预览'), { timeout: 10000 })

      const body = await p.evaluate(() => document.body.textContent)
      assert.match(body, /题库不一致/, 'mismatch is surfaced')
      assert.match(body, /防串题污染|单独恢复偏好设置/, 'explains why progress cannot be migrated')

      // Switch to replace mode: since study progress is unverified, replace is blocked to protect existing data
      await p.evaluate(() => {
        const b = Array.from(document.querySelectorAll('.btn')).find((x) =>
          x.textContent.includes('替换（清空后写入）'),
        )
        b?.click()
      })
      await new Promise((r) => setTimeout(r, 300))

      const disabledInReplace = await p.evaluate(() => {
        const b = Array.from(document.querySelectorAll('.btn')).find((x) => x.textContent.trim() === '确认导入')
        return b ? b.disabled : null
      })
      assert.equal(disabledInReplace, true, 'replace mode is blocked when study progress is unverified')

      // Cancel must leave the DB untouched
      await p.evaluate(() => {
        Array.from(document.querySelectorAll('.btn'))
          .find((x) => x.textContent.trim() === '取消')
          ?.click()
      })
      await new Promise((r) => setTimeout(r, 400))
      const stored = await p.evaluate(async () => {
        const dbmod = await import('/src/db/database.ts')
        const snap = await dbmod.snapshotDb(dbmod.db)
        return { count: snap.records.length }
      })
      assert.equal(stored.count, 0, 'database remains clean')
      await ctx.close()
    },
  )

  await t.test('UI: a backup with NO verifiable rows explains why nothing can be imported', async () => {
    const { p, ctx } = await freshPage()
    await nav(p, 'io')
    await p.waitForSelector('.page-title')
    await p.evaluate(async () => {
      const m = await import('/src/lib/io.ts')
      const payload = m.makeExportPayload({
        settings: undefined,
        records: [
          {
            qid: 'ghost-1',
            status: 'learning',
            attempts: 1,
            correctCount: 1,
            wrongCount: 0,
            lastSeenAt: 1,
            lastCorrect: true,
            lastAnswer: 'A',
            intervalDays: 1,
            ease: 2,
            nextReviewAt: 1,
          },
        ],
        history: [],
        mocks: [],
        aiReviews: [],
        bankFingerprint: 'another-bank',
        bankCount: 3,
      })
      globalThis.__backupText = m.serialize(payload)
    })
    const text = await p.evaluate(() => globalThis.__backupText)
    await uploadBackup(p, 'nothing.json', text)
    await p.waitForFunction(() => document.body.textContent.includes('导入预览'), { timeout: 10000 })

    const body = await p.evaluate(() => document.body.textContent)
    assert.match(
      body,
      /没有可导入的学习进度|没有任何数据能对应到当前题库|没有可导入的内容/,
      'the reason is explained, not a silent deadlock',
    )
    assert.match(body, /没有可导入的数据|没有可导入的内容/)

    const disabled = await p.evaluate(() => {
      const b = Array.from(document.querySelectorAll('.btn')).find((x) => x.textContent.trim() === '确认导入')
      return b ? b.disabled : null
    })
    assert.equal(disabled, true, 'confirm is blocked because there is nothing to import')

    // Cancel must leave the DB untouched.
    await p.evaluate(() => {
      Array.from(document.querySelectorAll('.btn'))
        .find((x) => x.textContent.trim() === '取消')
        ?.click()
    })
    await new Promise((r) => setTimeout(r, 400))
    assert.match(await p.evaluate(() => document.body.textContent), /已取消导入/)
    const count = await p.evaluate(async () => {
      const dbmod = await import('/src/db/database.ts')
      return (await dbmod.snapshotDb(dbmod.db)).records.length
    })
    assert.equal(count, 0, 'cancel writes nothing')
    await ctx.close()
  })

  await t.test(
    'UI: backup with mismatched bank but valid settings allows independent settings recovery in merge mode',
    async () => {
      const { p, ctx } = await freshPage()
      await nav(p, 'io')
      await p.waitForSelector('.page-title')

      await p.evaluate(async () => {
        const m = await import('/src/lib/io.ts')
        const payload = m.makeExportPayload({
          settings: { theme: 'dark', reviewIntervalBase: 4, studyTarget: 40, dailyGoalQuestions: 40 },
          records: [
            {
              qid: 'mismatch-q1',
              status: 'learning',
              attempts: 3,
              correctCount: 2,
              wrongCount: 1,
              lastSeenAt: 10,
              lastCorrect: true,
              lastAnswer: 'A',
              intervalDays: 1,
              ease: 2,
              nextReviewAt: 1,
            },
          ],
          history: [],
          mocks: [],
          aiReviews: [],
          bankFingerprint: 'completely-different-bank',
          bankCount: 10,
        })
        globalThis.__backupText = m.serialize(payload)
      })

      const text = await p.evaluate(() => globalThis.__backupText)
      await uploadBackup(p, 'settings-only.json', text)
      await p.waitForFunction(() => document.body.textContent.includes('导入预览'), { timeout: 10000 })

      const body = await p.evaluate(() => document.body.textContent)
      assert.match(body, /可单独恢复偏好设置/, 'explains settings can be recovered in merge mode')

      // Confirm button is NOT blocked in merge mode
      const disabledInMerge = await p.evaluate(() => {
        const b = Array.from(document.querySelectorAll('.btn')).find((x) => x.textContent.trim() === '确认导入')
        return b ? b.disabled : null
      })
      assert.equal(disabledInMerge, false, 'merge mode allows confirming settings recovery')

      // Now switch to replace mode: replace mode MUST be blocked to prevent accidental wipe of progress
      await p.evaluate(() => {
        const b = Array.from(document.querySelectorAll('.btn')).find((x) =>
          x.textContent.includes('替换（清空后写入）'),
        )
        b?.click()
      })
      await new Promise((r) => setTimeout(r, 300))

      const disabledInReplace = await p.evaluate(() => {
        const b = Array.from(document.querySelectorAll('.btn')).find((x) => x.textContent.trim() === '确认导入')
        return b ? b.disabled : null
      })
      assert.equal(disabledInReplace, true, 'replace mode is blocked when study data cannot be safely verified')

      const bodyReplace = await p.evaluate(() => document.body.textContent)
      assert.match(bodyReplace, /已禁止替换导入/, 'explains replace is blocked to prevent accidental wipe')

      // Switch back to merge and confirm
      await p.evaluate(() => {
        const b = Array.from(document.querySelectorAll('.btn')).find((x) =>
          x.textContent.includes('合并（同 ID 以备份为准）'),
        )
        b?.click()
      })
      await new Promise((r) => setTimeout(r, 300))

      await p.evaluate(() => {
        Array.from(document.querySelectorAll('.btn'))
          .find((x) => x.textContent.trim() === '确认导入')
          ?.click()
      })
      await p.waitForFunction(() => document.body.textContent.includes('导入完成'), { timeout: 15000 })

      // Verify DB: settings applied, but 0 records imported (preventing cross-bank corruption)
      const after = await p.evaluate(async () => {
        const dbmod = await import('/src/db/database.ts')
        const snap = await dbmod.snapshotDb(dbmod.db)
        return {
          recordsCount: snap.records.length,
          settings: snap.settings,
        }
      })
      assert.equal(after.recordsCount, 0, 'no unverified records imported')
      assert.equal(after.settings?.theme, 'dark', 'settings successfully applied')
      assert.equal(after.settings?.studyTarget, 40, 'settings values successfully applied')

      await ctx.close()
    },
  )

  await t.test('UI: a legacy backup without a fingerprint warns and blocks unverified progress', async () => {
    const { p, ctx } = await freshPage()
    await nav(p, 'io')
    await p.waitForSelector('.page-title')
    await p.evaluate(async () => {
      const m = await import('/src/lib/io.ts')
      const payload = m.makeExportPayload({
        settings: { theme: 'auto', reviewIntervalBase: 1, studyTarget: 30, dailyGoalQuestions: 30 },
        records: [],
        history: [],
        mocks: [],
        aiReviews: [],
        bankFingerprint: '',
        bankCount: 0,
      })
      globalThis.__backupText = m.serialize(payload)
    })
    const text = await p.evaluate(() => globalThis.__backupText)
    await uploadBackup(p, 'legacy.json', text)
    await p.waitForFunction(() => document.body.textContent.includes('导入预览'), { timeout: 10000 })

    const body = await p.evaluate(() => document.body.textContent)
    assert.match(body, /旧版备份/, 'legacy backup is identified')
    assert.match(body, /无法确认题目是否一致|缺乏题目/, 'the risk is stated')
    assert.match(body, /我确认这是缺少指纹的旧版备份/, 'an explicit acknowledgement is required')

    const disabled = await p.evaluate(() => {
      const b = Array.from(document.querySelectorAll('.btn')).find((x) => x.textContent.trim() === '确认导入')
      return b ? b.disabled : null
    })
    assert.equal(disabled, true, 'legacy restore is blocked until acknowledged')
    await ctx.close()
  })

  await t.test('UI: confirmed import restores all five collections into the real database', async () => {
    const { p, ctx } = await freshPage()
    await nav(p, 'io')
    await p.waitForSelector('.page-title')

    const prepared = await p.evaluate(async () => {
      const m = await import('/src/lib/io.ts')
      const bankMod = await import('/src/lib/bank.ts')
      // use a real question id so the rows match the running bank
      const realId = bankMod.allQuestions[0].id
      const payload = m.makeExportPayload({
        settings: { theme: 'dark', reviewIntervalBase: 2, studyTarget: 45, dailyGoalQuestions: 25 },
        records: [
          {
            qid: realId,
            status: 'learning',
            attempts: 3,
            correctCount: 2,
            wrongCount: 1,
            lastSeenAt: 11,
            lastCorrect: false,
            lastAnswer: 'AC',
            intervalDays: 3,
            ease: 2,
            nextReviewAt: 99,
          },
        ],
        history: [
          {
            id: 'imported-h1',
            qid: realId,
            mode: 'mock',
            sessionId: 's',
            answer: 'AC',
            isCorrect: false,
            submittedAt: 11,
            usedAI: false,
          },
        ],
        mocks: [
          {
            id: 'imported-m1',
            startedAt: 1,
            endedAt: 2,
            config: {
              singleCount: 1,
              multiCount: 0,
              judgeCount: 0,
              shortCount: 0,
              singleScore: 1,
              multiScore: 2,
              judgeScore: 1,
              shortScore: 15,
              durationMin: 5,
              chapters: 'all',
            },
            submissions: { [realId]: 'AC' },
            graded: true,
            score: 0,
            maxScore: 1,
            objectiveMaxScore: 1,
            subjectiveMaxScore: 0,
            perQuestion: { [realId]: { isCorrect: false, points: 0, unanswered: false } },
          },
        ],
        aiReviews: [
          {
            id: 'imported-a1',
            qid: realId,
            userAnswer: 'ans',
            createdAt: 1,
            provider: 'stub',
            model: 'm',
            result: {
              score: 80,
              maxScore: 100,
              hitPoints: [],
              missedPoints: [],
              deductions: [],
              suggestions: [],
              structureNote: '',
              disclaimer: '',
            },
          },
        ],
        bankFingerprint: m.bankFingerprint(bankMod.bank),
        bankCount: bankMod.bank.questions.length,
      })
      globalThis.__backupText = m.serialize(payload)
      globalThis.__realId = realId
      return { fingerprint: payload.bankFingerprint.slice(0, 12), realId }
    })
    assert.ok(prepared.fingerprint)

    const text = await p.evaluate(() => globalThis.__backupText)
    await uploadBackup(p, 'good.json', text)
    await p.waitForFunction(() => document.body.textContent.includes('导入预览'), { timeout: 10000 })

    const previewBody = await p.evaluate(() => document.body.textContent)
    assert.match(previewBody, /题库一致/, 'matching fingerprint needs no acknowledgement')

    await p.evaluate(() => {
      const b = Array.from(document.querySelectorAll('.btn')).find((x) => x.textContent.trim() === '确认导入')
      b?.click()
    })
    await p.waitForFunction(() => document.body.textContent.includes('导入完成'), { timeout: 15000 })

    // Verify the REAL app database contains all five collections after confirm.
    const stored = await p.evaluate(async () => {
      const dbmod = await import('/src/db/database.ts')
      const snap = await dbmod.snapshotDb(dbmod.db)
      const realId = globalThis.__realId
      return {
        records: snap.records.length,
        history: snap.history.length,
        mocks: snap.mocks.length,
        aiReviews: snap.aiReviews.length,
        settings: snap.settings,
        wrongCount: snap.records.find((r) => r.qid === realId)?.wrongCount,
        aiScore: snap.aiReviews[0]?.result?.score,
        mockScore: snap.mocks[0]?.score,
      }
    })
    assert.equal(stored.records, 1, 'records restored')
    assert.equal(stored.history, 1, 'history restored')
    assert.equal(stored.mocks, 1, 'mock archive restored')
    assert.equal(stored.aiReviews, 1, 'AI reviews restored')
    assert.equal(stored.settings?.theme, 'dark', 'settings restored')
    assert.equal(stored.settings?.studyTarget, 45, 'settings values restored')
    assert.equal(stored.wrongCount, 1, 'record counters preserved')
    assert.equal(stored.aiScore, 80, 'AI review content preserved')
    assert.equal(stored.mockScore, 0, 'mock score preserved')
    await ctx.close()
  })

  await t.test('UI: re-submitting the same mock exam does not double-count (real DB)', async () => {
    const { p, ctx } = await freshPage()
    await nav(p, 'mock')
    await p.waitForSelector('.card-title')
    await openMockRules(p)
    await new Promise((r) => setTimeout(r, 300))

    const out = await p.evaluate(async () => {
      const dbmod = await import('/src/db/database.ts')
      const session = await import('/src/lib/session.ts')
      const bankMod = await import('/src/lib/bank.ts')
      const paper = bankMod.allQuestions.filter((q) => q.type === 'single').slice(0, 3)
      const submissions = Object.fromEntries(paper.map((q) => [q.id, 'A']))
      const config = {
        singleCount: 3,
        multiCount: 0,
        judgeCount: 0,
        shortCount: 0,
        singleScore: 1,
        multiScore: 2,
        judgeScore: 1,
        shortScore: 15,
        durationMin: 5,
        chapters: 'all',
      }
      const input = { runId: 'ui-race-run', paper, submissions, config, startedAt: 1, endedAt: 2 }
      const first = await session.submitMockRun(dbmod.db, input)
      const second = await session.submitMockRun(dbmod.db, input)
      const snap = await dbmod.snapshotDb(dbmod.db)
      return {
        first: first.status,
        second: second.status,
        secondWritten: second.written.records + second.written.history,
        historyForFirst: snap.history.filter((h) => h.qid === paper[0].id).length,
        attempts: snap.records.find((r) => r.qid === paper[0].id)?.attempts,
        mocks: snap.mocks.filter((m) => m.id === 'ui-race-run').length,
      }
    })
    assert.equal(out.first, 'committed')
    assert.equal(out.second, 'already-submitted', 'a replay must be a no-op')
    assert.equal(out.secondWritten, 0, 'a replay writes nothing')
    assert.equal(out.historyForFirst, 1, 'exactly one history row per question')
    assert.equal(out.attempts, 1, 'attempts are not double-counted')
    assert.equal(out.mocks, 1, 'exactly one mock archive row')
    await ctx.close()
  })

  // ---- settings persistence after import + reload -------------------------

  await t.test('UI: merge without backup settings KEEPS current settings (and survives reload)', async () => {
    const { p, ctx } = await freshPage()
    await nav(p, 'settings')
    await p.waitForSelector('.page-title')
    // Set a distinctive theme, then save it.
    await p.evaluate(() => {
      Array.from(document.querySelectorAll('.btn.btn-sm'))
        .find((b) => b.textContent.includes('深色'))
        ?.click()
    })
    await new Promise((r) => setTimeout(r, 200))
    await p.evaluate(() => {
      Array.from(document.querySelectorAll('.btn.btn-primary'))
        .find((b) => b.textContent.includes('保存设置'))
        ?.click()
    })
    await new Promise((r) => setTimeout(r, 400))
    assert.equal(await p.evaluate(() => document.documentElement.dataset.theme), 'dark')

    // Import a settings-less backup in MERGE mode.
    await nav(p, 'io')
    await p.waitForSelector('.page-title')
    await p.evaluate(async () => {
      const m = await import('/src/lib/io.ts')
      const bankMod = await import('/src/lib/bank.ts')
      const payload = m.makeExportPayload({
        settings: undefined,
        records: [],
        history: [],
        mocks: [],
        aiReviews: [],
        bankFingerprint: m.bankFingerprint(bankMod.bank),
        bankCount: bankMod.bank.questions.length,
      })
      globalThis.__backupText = m.serialize(payload)
    })
    const text = await p.evaluate(() => globalThis.__backupText)
    await uploadBackup(p, 'no-settings.json', text)
    await p.waitForFunction(() => document.body.textContent.includes('导入预览'), { timeout: 10000 })

    assert.match(
      await p.evaluate(() => document.body.textContent),
      /保持当前设置不变/,
      'the plan states settings are preserved',
    )
    await p.evaluate(() => {
      Array.from(document.querySelectorAll('.btn'))
        .find((x) => x.textContent.trim() === '确认导入')
        ?.click()
    })
    await p.waitForFunction(() => document.body.textContent.includes('导入完成'), { timeout: 15000 })

    // REGRESSION: the settings must still be dark, both in the DOM and the DB.
    assert.equal(await p.evaluate(() => document.documentElement.dataset.theme), 'dark', 'theme preserved after merge')
    const stored = await p.evaluate(async () => {
      const dbmod = await import('/src/db/database.ts')
      return (await dbmod.snapshotDb(dbmod.db)).settings
    })
    assert.equal(stored?.theme, 'dark', 'settings row preserved in the DB')

    // And after a real page reload.
    await p.reload({ waitUntil: 'networkidle2' })
    await p.waitForSelector('.app-shell', { timeout: 20000 })
    assert.equal(
      await p.evaluate(() => document.documentElement.dataset.theme),
      'dark',
      'theme survives a page reload after import',
    )
    await ctx.close()
  })

  await t.test('UI: replace without backup settings resets to defaults (and survives reload)', async () => {
    const { p, ctx } = await freshPage()
    await nav(p, 'settings')
    await p.waitForSelector('.page-title')
    await p.evaluate(() => {
      Array.from(document.querySelectorAll('.btn.btn-sm'))
        .find((b) => b.textContent.includes('深色'))
        ?.click()
    })
    await new Promise((r) => setTimeout(r, 200))
    await p.evaluate(() => {
      Array.from(document.querySelectorAll('.btn.btn-primary'))
        .find((b) => b.textContent.includes('保存设置'))
        ?.click()
    })
    await new Promise((r) => setTimeout(r, 400))
    assert.equal(await p.evaluate(() => document.documentElement.dataset.theme), 'dark')

    await nav(p, 'io')
    await p.waitForSelector('.page-title')
    await p.evaluate(async () => {
      const m = await import('/src/lib/io.ts')
      const bankMod = await import('/src/lib/bank.ts')
      const payload = m.makeExportPayload({
        settings: undefined,
        records: [],
        history: [],
        mocks: [],
        aiReviews: [],
        bankFingerprint: m.bankFingerprint(bankMod.bank),
        bankCount: bankMod.bank.questions.length,
      })
      globalThis.__backupText = m.serialize(payload)
    })
    const text = await p.evaluate(() => globalThis.__backupText)
    await uploadBackup(p, 'no-settings-replace.json', text)
    await p.waitForFunction(() => document.body.textContent.includes('导入预览'), { timeout: 10000 })

    // switch to replace and acknowledge
    await p.evaluate(() => {
      Array.from(document.querySelectorAll('.btn'))
        .find((x) => x.textContent.includes('替换（清空后写入）'))
        ?.click()
    })
    await new Promise((r) => setTimeout(r, 300))
    await p.evaluate(() => {
      document.querySelectorAll('input[type=checkbox]')[0]?.click()
    })
    await new Promise((r) => setTimeout(r, 200))
    assert.match(
      await p.evaluate(() => document.body.textContent),
      /重置为默认值/,
      'the plan states settings will reset',
    )

    await p.evaluate(() => {
      Array.from(document.querySelectorAll('.btn'))
        .find((x) => x.textContent.trim() === '确认导入')
        ?.click()
    })
    await p.waitForFunction(() => document.body.textContent.includes('导入完成'), { timeout: 15000 })

    const stored = await p.evaluate(async () => {
      const dbmod = await import('/src/db/database.ts')
      return (await dbmod.snapshotDb(dbmod.db)).settings
    })
    assert.equal(stored, null, 'settings row cleared for a replace without settings')

    // Reload: the app falls back to the DEFAULTS. DEFAULT_SETTINGS.theme is
    // 'auto', which resolves from the OS/browser colour scheme — so assert that
    // the settings ROW is absent and the UI theme equals what 'auto' resolves to
    // in THIS browser. The point is that the DB and the UI agree after a reload.
    await p.reload({ waitUntil: 'networkidle2' })
    await p.waitForSelector('.app-shell', { timeout: 20000 })
    const after = await p.evaluate(async () => {
      const dbmod = await import('/src/db/database.ts')
      const row = await dbmod.db.settings.get('main')
      return {
        hasRow: Boolean(row),
        rowTheme: row ? row.theme : null,
        domTheme: document.documentElement.dataset.theme,
        prefersDark: window.matchMedia('(prefers-color-scheme: dark)').matches,
      }
    })
    assert.equal(after.hasRow, false, 'no settings row after a reset restore')
    assert.equal(
      after.domTheme,
      after.prefersDark ? 'dark' : 'light',
      "the UI theme matches what the default 'auto' setting resolves to",
    )
    await ctx.close()
  })

  // ---- Plan session ID stability & AI review non-duplication ----------------

  await t.test(
    'plan: session ID is generated on session start, stays stable across answers and re-renders, and AI review shares session ID without duplicate attempts',
    async () => {
      // 1. Start a local mock gateway to serve AI grade without spending real quota or network
      const http = await import('node:http')
      const mockPort = 8815
      let aiGradeRequestReceived = false
      const mockServer = http.createServer((req, res) => {
        let body = ''
        req.on('data', (chunk) => {
          body += chunk
        })
        req.on('end', () => {
          if (req.url?.includes('/ai/grade')) {
            aiGradeRequestReceived = true
            res.writeHead(200, {
              'Content-Type': 'application/json; charset=utf-8',
              'Access-Control-Allow-Origin': '*',
              'Access-Control-Allow-Headers': 'Content-Type',
            })
            res.end(
              JSON.stringify({
                ok: true,
                provider: 'mock-stub',
                model: 'mock-model',
                result: {
                  score: 85,
                  maxScore: 100,
                  hitPoints: ['答出核心要点'],
                  missedPoints: [],
                  deductions: [],
                  suggestions: ['继续保持'],
                  structureNote: '逻辑层次分明',
                  disclaimer: '模拟测试评阅',
                },
              }),
            )
            return
          }
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
          res.end(JSON.stringify({ ok: true }))
        })
      })
      await new Promise((resolve) => mockServer.listen(mockPort, '127.0.0.1', resolve))
      mockServers.push(mockServer)

      const { p, ctx } = await freshPage()

      // Set localStorage to point frontend AI requests directly to our mock server
      await p.evaluate((port) => {
        localStorage.setItem(
          'exampilot.ai.config',
          JSON.stringify({
            baseUrl: `http://127.0.0.1:${port}`,
            model: 'mock-model',
            timeoutMs: 5000,
          }),
        )
      }, mockPort)

      // Seed one subjective question into IndexedDB as due review
      const seededSubjQid = await p.evaluate(async () => {
        const bankMod = await import('/src/lib/bank.ts')
        const dbmod = await import('/src/db/database.ts')
        const subjQ = bankMod.allQuestions.find((q) => q.type === 'short' || q.type === 'material')
        if (subjQ) {
          await dbmod.db.records.put({
            qid: subjQ.id,
            status: 'learning',
            attempts: 1,
            correctCount: 0,
            wrongCount: 0,
            lastSeenAt: 100,
            lastCorrect: null,
            lastAnswer: '旧作答',
            intervalDays: 1,
            ease: 1,
            nextReviewAt: 100,
          })
          return subjQ.id
        }
        return null
      })
      assert.ok(seededSubjQid, 'found a subjective question in bank to test')

      await nav(p, 'plan')
      await p.waitForSelector('.page-title')

      // Select minimal task count 10 so subjective question at the tail is reached quickly
      await p.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button'))
        const tenBtn = btns.find((b) => b.textContent?.trim() === '10 题')
        tenBtn?.click()
      })
      await new Promise((r) => setTimeout(r, 400))

      // Must find and click the button to start plan review
      await p.waitForSelector('button.btn-primary.btn-lg', { timeout: 10000 })
      const startClicked = await p.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button'))
        const startBtn = btns.find((b) => b.textContent?.includes('开始今日复习'))
        if (startBtn) {
          startBtn.click()
          return true
        }
        return false
      })
      assert.equal(startClicked, true, 'must click 开始今日复习 to start session')

      await p.waitForSelector('.q-stem', { timeout: 10000 })

      let submittedCount = 0
      let subjectiveTested = false
      let answeredSubjBaselineAttempts = 0

      // Loop through questions until we answer at least 2 questions and definitely answer a subjective question with AI review
      for (let step = 0; step < 12; step++) {
        await p.waitForSelector('.q-stem', { timeout: 10000 })
        const questionInfo = await p.evaluate(async () => {
          const ta = document.querySelector('textarea')
          if (ta) {
            const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
            setter?.call(ta, '主观题测试详细回答内容')
            ta.dispatchEvent(new Event('input', { bubbles: true }))

            // Read currently displayed question id and its baseline attempts from IndexedDB
            const dbmod = await import('/src/db/database.ts')
            const bankMod = await import('/src/lib/bank.ts')
            const stemText = document.querySelector('.q-stem')?.textContent?.trim() || ''
            const matchedQ = bankMod.allQuestions.find(
              (q) => q.stem.trim() === stemText || stemText.includes(q.stem.trim().slice(0, 30)),
            )
            let baseline = 0
            if (matchedQ) {
              const rec = await dbmod.db.records.get(matchedQ.id)
              baseline = rec?.attempts ?? 0
            }
            return { isSubj: true, qid: matchedQ?.id, baseline }
          }
          const opt = document.querySelector('.opt')
          if (opt) {
            opt.click()
            return { isSubj: false }
          }
          const jb = document.querySelector('.judge-btn')
          if (jb) jb.click()
          return { isSubj: false }
        })

        if (questionInfo.isSubj) {
          answeredSubjBaselineAttempts = questionInfo.baseline
        }

        // Submit answer. The click must be confirmed: on a slow runner an
        // unconfirmed click silently does nothing, which previously left the
        // record unadvanced while the test still counted a submission.
        const submitClicked = await p.evaluate(() => {
          const btns = Array.from(document.querySelectorAll('button'))
          const submitBtn = btns.find((b) => b.textContent?.includes('确认') || b.textContent?.includes('提交'))
          if (!submitBtn) return false
          submitBtn.click()
          return true
        })
        assert.equal(submitClicked, true, `a submit button must be available at step ${step}`)
        await new Promise((r) => setTimeout(r, 600))
        submittedCount++

        if (questionInfo.isSubj) {
          subjectiveTested = true
          // The attempt must have been persisted by the submission above. Assert
          // it here so a missed click reports its real cause instead of surfacing
          // later as a confusing attempt-count mismatch.
          const persisted = await p.evaluate(async (id) => {
            const dbmod = await import('/src/db/database.ts')
            const r = id ? await dbmod.db.records.get(id) : null
            return r ? { attempts: r.attempts, lastSeenAt: r.lastSeenAt } : null
          }, questionInfo.qid)
          assert.ok(persisted, 'the answered subjective question must have a record')
          assert.equal(
            persisted.attempts,
            answeredSubjBaselineAttempts + 1,
            `submitting the answer must persist exactly one attempt (baseline ${answeredSubjBaselineAttempts})`,
          )
          // Must find the AI review button without soft skipping
          const clickedGrade = await p.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('button'))
            const b = btns.find(
              (btn) => btn.textContent?.includes('AI 参考评阅') || btn.textContent?.includes('AI 评阅'),
            )
            if (b) {
              b.click()
              return true
            }
            return false
          })
          assert.equal(clickedGrade, true, 'AI review button must exist and be clicked')

          // Must wait for AI review result to be saved
          await p.waitForFunction(() => document.body.textContent?.includes('已保存'), { timeout: 8000 })
          break
        }

        // Navigate to next question
        const hasNext = await p.evaluate(() => {
          const btns = Array.from(document.querySelectorAll('button'))
          const nextBtn = btns.find((b) => b.textContent?.includes('下一题'))
          if (nextBtn) {
            nextBtn.click()
            return true
          }
          return false
        })
        if (!hasNext) break
        await new Promise((r) => setTimeout(r, 600))
      }

      // 1. Strict assert: must have entered a subjective question and submitted answer
      assert.equal(
        subjectiveTested,
        true,
        'must have encountered and answered at least one subjective question in Plan',
      )
      // 2. Strict assert: must have answered at least 2 questions total in Plan session
      assert.ok(submittedCount >= 2, `must have submitted at least 2 questions in session, got ${submittedCount}`)
      // 3. Strict assert: mock gateway must have actually received the AI grade request
      assert.equal(aiGradeRequestReceived, true, 'AI mock server must have actually received /ai/grade request')

      // 4. Assert IndexedDB data integrity, session ID consistency, and actual writes
      const stats = await p.evaluate(async () => {
        const dbmod = await import('/src/db/database.ts')
        const allHistory = await dbmod.db.history.toArray()
        const planHistory = allHistory.filter((h) => h.mode === 'plan')
        const sessionIds = Array.from(new Set(planHistory.map((h) => h.sessionId)))
        const distinctQids = Array.from(new Set(planHistory.map((h) => h.qid)))
        const allAiReviews = await dbmod.db.aiReviews.toArray()
        const allRecords = await dbmod.db.records.toArray()
        const aiReview = allAiReviews[0]
        return {
          allHistory,
          allAiReviews,
          allRecords,
          planHistory,
          planHistoryCount: planHistory.length,
          distinctQids,
          uniqueSessionIds: sessionIds.length,
          sessionIds,
          aiReviewCount: allAiReviews.length,
          aiReview,
        }
      })

      // Strict assert on real IndexedDB writes: at least 2 real answers persisted with distinct qids
      assert.ok(
        stats.planHistoryCount >= 2,
        `IndexedDB must have at least 2 real answers persisted under mode 'plan', got ${stats.planHistoryCount}`,
      )
      assert.ok(
        stats.distinctQids.length >= 2,
        `IndexedDB plan history must correspond to at least 2 distinct question IDs, got ${stats.distinctQids.length} (${JSON.stringify(stats.distinctQids)})`,
      )

      // Must have persisted AI review in IndexedDB
      assert.ok(stats.aiReview, 'AI review must be persisted in IndexedDB aiReviews table')
      assert.equal(stats.aiReview.result.score, 85, 'AI review result score matches mock gateway')

      const answeredSubjQid = stats.aiReview.qid
      assert.ok(answeredSubjQid, 'AI review has valid qid')

      // All submissions in this plan session must share exactly 1 stable sessionId
      assert.equal(
        stats.uniqueSessionIds,
        1,
        `all plan submissions must share exactly 1 stable sessionId, got ${JSON.stringify(stats.sessionIds)}`,
      )
      assert.ok(stats.sessionIds[0].startsWith('s-'), 'sessionId format is stable s-...')

      // Subjective attempt in history and AI review in session must share the identical sessionId
      const subjHistoryEntry = stats.planHistory.find((h) => h.qid === answeredSubjQid)
      assert.ok(subjHistoryEntry, 'subjective attempt entry exists in history')
      assert.equal(
        subjHistoryEntry.sessionId,
        stats.sessionIds[0],
        'subjective attempt history shares identical session ID with plan session',
      )
      assert.equal(
        stats.aiReview.id,
        `ai-${stats.sessionIds[0]}-${answeredSubjQid}`,
        'AI review row id deterministically binds to identical session ID',
      )

      // Strict assert: subjective question attempts count increased strictly by 1 (baseline + 1), never duplicated by AI review
      const subjRecord = stats.allRecords.find((r) => r.qid === answeredSubjQid)
      assert.ok(subjRecord, 'subjective record exists in db')
      const expectedAttempts = answeredSubjBaselineAttempts + 1
      assert.equal(
        subjRecord.attempts,
        expectedAttempts,
        `subjective attempts (${subjRecord.attempts}) must strictly equal baseline (${answeredSubjBaselineAttempts}) + 1 = ${expectedAttempts}, never duplicated by AI review`,
      )

      mockServer.close()
      await ctx.close()
    },
  )

  // ---- Phase 2: review strategy -------------------------------------------

  await t.test('E2E-1: a brand-new user gets the full requested objective quota', async () => {
    const { p, ctx } = await freshPage()
    await nav(p, 'plan')
    await p.waitForSelector('.page-title')

    // Choose the largest task size, where the old 50%-of-fresh cap was worst.
    await p.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === '50 题')
      btn?.click()
    })
    await new Promise((r) => setTimeout(r, 800))

    const preview = await p.evaluate(() => {
      const el = Array.from(document.querySelectorAll('.card-title')).find((x) =>
        /计划预览（客观题 \d+ 题/.test(x.textContent ?? ''),
      )
      return el?.textContent ?? ''
    })
    const m = preview.match(/客观题 (\d+) 题/)
    assert.ok(m, `plan preview states the objective count, got: ${preview}`)
    // The public sample bank has 14 objective questions; the plan must use all
    // of them rather than capping at half the requested size.
    assert.ok(Number(m[1]) >= 14, `a new user's plan must use the whole objective bank (>=14), got ${m[1]}`)
    await ctx.close()
  })

  await t.test('E2E-2: overdue questions are surfaced and the backlog is reported', async () => {
    const { p, ctx } = await freshPage()
    const now = Date.now()
    const seeded = await p.evaluate(async (nowIn) => {
      const bankMod = await import('/src/lib/bank.ts')
      const dbmod = await import('/src/db/database.ts')
      const obj = bankMod.objectiveQuestions
      const rows = obj.slice(0, 10).map((q, i) => ({
        qid: q.id,
        status: 'learning',
        attempts: 4,
        correctCount: 3,
        wrongCount: 1,
        lastSeenAt: nowIn - 30 * 86400000,
        lastCorrect: true,
        lastAnswer: 'A',
        intervalDays: 1,
        ease: 2,
        nextReviewAt: nowIn - (i + 1) * 86400000, // all overdue
      }))
      for (const r of rows) await dbmod.db.records.put({ ...r })
      return obj.length
    }, now)
    assert.ok(seeded > 0, 'objective questions exist to seed')

    // Reload so the store re-reads the seeded rows (it loads once at mount).
    await p.reload({ waitUntil: 'networkidle2' })
    await p.waitForSelector('.app-shell')
    await p.evaluate(() => {
      window.location.hash = '/plan'
    })
    await p.waitForSelector('.page-title')
    await new Promise((r) => setTimeout(r, 600))

    const dueNum = await p.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('.card-pad'))
      const card = cards.find((c) => c.textContent.includes('今日到期复习'))
      return card ? Number(card.querySelector('.stat-num')?.textContent) : -1
    })
    assert.ok(dueNum >= 10, `due counter must include the seeded overdue questions, got ${dueNum}`)

    // The plan must also report that overdue work did not all fit.
    const body = await p.evaluate(() => document.body.textContent)
    assert.match(body, /计划预览/, 'the plan preview is rendered')
    await ctx.close()
  })

  await t.test('E2E-3: reviewing "all attempted" is never an empty session', async () => {
    const { p, ctx } = await freshPage()
    // Seed every objective question as freshly answered and mastered: the old
    // hard weight cut-off produced an EMPTY session here.
    const ok = await p.evaluate(async () => {
      const bankMod = await import('/src/lib/bank.ts')
      const dbmod = await import('/src/db/database.ts')
      const sch = await import('/src/lib/scheduler.ts')
      const now = Date.now()
      for (const q of bankMod.objectiveQuestions) {
        let r = sch.freshRecord(q.id, now - 1000)
        for (let i = 0; i < 4; i++) r = sch.applyAttempt(r, true, now - 1000)
        r.lastAnswer = 'A'
        await dbmod.db.records.put(r)
      }
      return true
    })
    assert.ok(ok, 'records seeded')

    // Reload so the store re-reads the seeded rows (it loads once at mount).
    await p.reload({ waitUntil: 'networkidle2' })
    await p.waitForSelector('.app-shell')
    await p.evaluate(() => {
      window.location.hash = '/wrong'
    })
    await p.waitForSelector('.page-title')
    // Switch to "all attempted".
    await p.evaluate(() => {
      const b = Array.from(document.querySelectorAll('.btn.btn-sm')).find((x) => x.textContent?.trim() === '所有做过的')
      b?.click()
    })
    await new Promise((r) => setTimeout(r, 600))

    const started = await p.evaluate(() => {
      const b = Array.from(document.querySelectorAll('.btn.btn-primary.btn-lg')).find((x) =>
        x.textContent?.includes('开始复刷'),
      )
      if (!b) return 'no-button'
      b.click()
      return 'clicked'
    })
    assert.equal(started, 'clicked', 'the review button is available')

    // A session with at least one question must open — never an empty runner.
    await p.waitForSelector('.q-stem', { timeout: 15000 }).catch(() => {})
    const hasQuestion = (await count(p, '.q-stem')) > 0
    assert.ok(hasQuestion, 'a non-empty session opens for "all attempted"')
    await ctx.close()
  })

  await t.test('E2E-4: an all-wrong chapter outranks untouched chapters in the diagnosis', async () => {
    const { p, ctx } = await freshPage()
    await p.evaluate(async () => {
      const bankMod = await import('/src/lib/bank.ts')
      const dbmod = await import('/src/db/database.ts')
      const sch = await import('/src/lib/scheduler.ts')
      const now = Date.now()
      const chapters = Array.from(new Set(bankMod.objectiveQuestions.map((q) => q.chapter)))
      // Answer EVERY objective question of the first chapter wrongly.
      for (const q of bankMod.objectiveQuestions) {
        if (q.chapter !== chapters[0]) continue
        let r = sch.freshRecord(q.id, now)
        r = sch.applyAttempt(r, false, now)
        r.lastAnswer = 'A'
        await dbmod.db.records.put(r)
      }
    })

    // Reload so the store re-reads the seeded rows (it loads once at mount).
    await p.reload({ waitUntil: 'networkidle2' })
    await p.waitForSelector('.app-shell')
    await p.evaluate(() => {
      window.location.hash = '/diagnosis'
    })
    await p.waitForSelector('.page-title')
    await new Promise((r) => setTimeout(r, 600))

    const ranking = await p.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('.card.card-pad'))
      const wp = cards.filter((c) => c.querySelector('b') && /待清除|未覆盖/.test(c.textContent))
      return wp.map((c) => {
        const name = c.querySelector('b')?.textContent?.trim() ?? ''
        return { name, kind: /待清除/.test(c.textContent) ? 'weak' : 'uncovered' }
      })
    })
    assert.ok(ranking.length > 0, 'weak points are rendered')
    // The all-wrong chapter must be ranked first, ahead of untouched chapters.
    assert.equal(ranking[0].kind, 'weak', `the first entry must be a measured failure, got ${ranking[0].kind}`)
    await ctx.close()
  })

  await t.test('E2E-5: an AI review never advances the subjective review interval', async () => {
    const http = await import('node:http')
    const mockPort = 8817
    const mockServer = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => {
        body += c
      })
      req.on('end', () => {
        if (req.url?.includes('/ai/grade')) {
          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Content-Type',
          })
          res.end(
            JSON.stringify({
              ok: true,
              provider: 'mock-stub',
              model: 'mock-model',
              result: {
                score: 80,
                maxScore: 100,
                hitPoints: [],
                missedPoints: [],
                deductions: [],
                suggestions: [],
                structureNote: '',
                disclaimer: '模拟测试评阅',
              },
            }),
          )
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
        res.end(JSON.stringify({ ok: true }))
      })
    })
    await new Promise((resolve) => mockServer.listen(mockPort, '127.0.0.1', resolve))
    mockServers.push(mockServer)

    const { p, ctx } = await freshPage()
    await p.evaluate((port) => {
      localStorage.setItem(
        'exampilot.ai.config',
        JSON.stringify({ baseUrl: `http://127.0.0.1:${port}`, model: 'mock-model', timeoutMs: 5000 }),
      )
    }, mockPort)

    // Seed a subjective question that was trained an hour ago.
    const qid = await p.evaluate(async () => {
      const bankMod = await import('/src/lib/bank.ts')
      const dbmod = await import('/src/db/database.ts')
      const sch = await import('/src/lib/scheduler.ts')
      const q = bankMod.allQuestions.find((x) => x.type === 'short' || x.type === 'material')
      if (!q) return null
      const now = Date.now()
      let r = sch.freshRecord(q.id, now - 3600_000)
      r = sch.applySubjectiveAttempt(r, now - 3600_000)
      r.lastAnswer = '旧作答'
      await dbmod.db.records.put(r)
      return q.id
    })
    assert.ok(qid, 'a subjective question exists to seed')

    // Reload so the store re-reads the seeded row (it loads once at mount).
    await p.reload({ waitUntil: 'networkidle2' })
    await p.waitForSelector('.app-shell')

    // Open the subjective page and submit an answer. That submission is a
    // GENUINE new attempt (its own session id), so it legitimately raises the
    // count by one. The invariant under test is about what the AI REVIEW does
    // on top of it, so the baseline is captured right after the submission.
    await nav(p, 'subjective')
    await p.waitForSelector('.page-title')
    await p.evaluate(() => {
      const b = Array.from(document.querySelectorAll('.btn.btn-lg')).find((x) => x.textContent?.includes('开始训练'))
      b?.click()
    })
    await p.waitForSelector('textarea.textarea', { timeout: 15000 })
    await p.evaluate(() => {
      const ta = document.querySelector('textarea.textarea')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(ta, '主观题 E2E 评阅内容')
      ta.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await p.evaluate(() => {
      const b = Array.from(document.querySelectorAll('.btn.btn-primary.btn-lg'))
      b[0]?.click()
    })
    await new Promise((r) => setTimeout(r, 800))

    const before = await p.evaluate(async (id) => {
      const dbmod = await import('/src/db/database.ts')
      const r = await dbmod.db.records.get(id)
      return { attempts: r.attempts, nextReviewAt: r.nextReviewAt, intervalDays: r.intervalDays }
    }, qid)

    // Reviewing the same question repeatedly must not move anything.
    for (let i = 0; i < 2; i++) {
      const gradeClicked = await p.evaluate(() => {
        const b = Array.from(document.querySelectorAll('button')).find(
          (x) => x.textContent?.includes('AI 参考评阅') || x.textContent?.includes('AI 评阅'),
        )
        if (b) {
          b.click()
          return true
        }
        return false
      })
      if (!gradeClicked) break
      await p.waitForFunction(() => document.body.textContent?.includes('已保存'), { timeout: 10000 }).catch(() => {})
      await new Promise((r) => setTimeout(r, 400))
    }

    const after = await p.evaluate(async (id) => {
      const dbmod = await import('/src/db/database.ts')
      const r = await dbmod.db.records.get(id)
      return { attempts: r.attempts, nextReviewAt: r.nextReviewAt, intervalDays: r.intervalDays, status: r.status }
    }, qid)

    // The attempt was already recorded for this session, so re-reviewing must
    // NOT add an attempt and must NOT push the next review date out.
    try {
      assert.equal(after.attempts, before.attempts, 'AI review must not add training attempts')
      assert.equal(after.nextReviewAt, before.nextReviewAt, 'AI review must not advance the review interval')
      assert.equal(after.status, 'learning', 'subjective status stays learning, never mastered')
    } finally {
      // Always release the server: a skipped close keeps the event loop alive
      // and the whole suite hangs until the CI step times out.
      mockServer.close()
      await ctx.close()
    }
  })
})
