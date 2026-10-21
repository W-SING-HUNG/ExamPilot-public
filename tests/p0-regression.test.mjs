/**
 * P0 regression suite.
 *
 * Every test here maps to one of the five P0 findings from the UI/UX acceptance
 * audit, and asserts the *measured* property that was broken — not a proxy for
 * it. They exist so the interaction architecture cannot silently regress:
 *
 *   P0-1  the answering surface starts at the top (config unmounted)
 *   P0-2  navigation resets scroll; back/forward keeps position
 *   P0-3  a session has skip / end / pause-resume, and cannot be double-started
 *   P0-4  finishing a group produces a real summary
 *   P0-5  un-scored is neither correct nor wrong, anywhere
 *
 * Run: node tests/p0-regression.test.mjs   (dev server required, E2E_BASE)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BASE = process.env.E2E_BASE || 'http://localhost:5173'
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

let browser

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function freshPage(vp = { width: 1366, height: 768 }) {
  const ctx = await browser.createBrowserContext()
  const p = await ctx.newPage()
  p.setDefaultTimeout(20000)
  await p.setViewport({ ...vp, deviceScaleFactor: 1 })
  const errors = []
  p.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  p.on('console', (m) => {
    if (m.type() !== 'error') return
    const t = m.text()
    if (/Failed to load resource/.test(t) && /\/api\//.test(t)) return
    errors.push(`console: ${t}`)
  })
  await p.goto(BASE, { waitUntil: 'networkidle2' })
  await p.waitForSelector('.app-shell', { timeout: 25000 })
  await sleep(300)
  return { p, ctx, errors }
}

async function go(p, route) {
  await p.evaluate((r) => {
    window.location.hash = `/${r}`
  }, route)
  await sleep(600)
}

/** Click the first button whose text starts with `text`, by real mouse. */
async function clickText(p, text) {
  const box = await p.evaluate((t) => {
    const b = Array.from(document.querySelectorAll('button')).find((x) => x.textContent.trim().startsWith(t))
    if (!b) return null
    b.scrollIntoView({ block: 'center' })
    const r = b.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  }, text)
  if (!box) return false
  await sleep(150)
  await p.mouse.click(box.x, box.y)
  await sleep(500)
  return true
}

/** Seed synthetic learning data straight into IndexedDB (never real records). */
async function seed(p, n = 40) {
  await p.evaluate(async (count) => {
    const dbm = await import('/src/db/database.ts')
    const bank = await import('/src/lib/bank.ts')
    const sched = await import('/src/lib/scheduler.ts')
    const now = Date.now()
    const records = []
    const history = []
    for (const [i, q] of bank.objectiveQuestions.slice(0, count).entries()) {
      const ok = i % 3 !== 0
      let r = sched.freshRecord(q.id, now - 3 * 86400000)
      r = sched.applyAttempt(r, ok, now - 2 * 86400000, 1)
      r = sched.applyAttempt(r, ok, now - 86400000, 1)
      records.push(r)
      history.push({
        id: `p0h-${i}`,
        qid: q.id,
        mode: i % 2 ? 'practice' : 'special',
        sessionId: `p0s-${i % 5}`,
        answer: ok ? String(q.answerNorm) : 'A',
        isCorrect: ok,
        submittedAt: now - 86400000 + i * 1000,
        usedAI: false,
      })
    }
    await dbm.db.records.bulkPut(records)
    await dbm.db.history.bulkPut(history)
  }, n)
  await p.reload({ waitUntil: 'networkidle2' })
  await p.waitForSelector('.app-shell')
  await sleep(400)
}

test('P0 regression', async (t) => {
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  })
  t.after(async () => {
    if (browser) await browser.close()
  })

  // ---------------- P0-1: answering surface owns the screen ----------------
  for (const vp of [
    { name: '1920x1080', width: 1920, height: 1080 },
    { name: '1366x768', width: 1366, height: 768 },
    { name: '768x1024', width: 768, height: 1024 },
    { name: '390x844', width: 390, height: 844 },
  ]) {
    await t.test(`P0-1 ${vp.name}: the first question is fully visible right after starting`, async () => {
      const { p, ctx, errors } = await freshPage({ width: vp.width, height: vp.height })
      await seed(p, 60)
      await go(p, 'plan')

      await clickText(p, '开始今日复习')
      await p.waitForSelector('.q-stem', { timeout: 15000 })
      await sleep(600)

      const m = await p.evaluate(() => {
        const stem = document.querySelector('.q-stem')
        const r = stem.getBoundingClientRect()
        const submit = Array.from(document.querySelectorAll('button')).find((b) => b.textContent.includes('提交答案'))
        return {
          stemTop: r.top,
          stemBottom: r.bottom,
          viewportH: window.innerHeight,
          submitVisible: submit ? submit.getBoundingClientRect().bottom <= window.innerHeight : null,
          configStillMounted: document.body.innerText.includes('计划预览'),
          methodStillMounted: document.body.innerText.includes('主动回忆'),
        }
      })

      assert.ok(m.stemTop >= 0, `stem must start inside the viewport, got top=${Math.round(m.stemTop)}`)
      assert.ok(
        m.stemBottom <= m.viewportH,
        `stem must be fully visible, bottom=${Math.round(m.stemBottom)} viewport=${m.viewportH}`,
      )
      assert.equal(m.submitVisible, true, 'the submit control must be reachable without scrolling')
      assert.equal(m.configStillMounted, false, 'the configure tree must be unmounted while answering')
      assert.equal(m.methodStillMounted, false, 'the method explainer must not occupy space while answering')
      assert.deepEqual(errors, [], 'no page errors')
      await ctx.close()
    })
  }

  // ---------------- P0-2: scroll management -------------------------------
  await t.test('P0-2: navigation resets scroll, back/forward restores it', async () => {
    const { p, ctx, errors } = await freshPage()
    await seed(p, 120)
    await go(p, 'bank')
    await sleep(400)
    await p.evaluate(() => window.scrollTo(0, 900))
    await sleep(300)

    await go(p, 'diagnosis')
    await sleep(400)
    const landed = await p.evaluate(() => ({
      y: window.scrollY,
      titleTop: Math.round(document.querySelector('.page-title').getBoundingClientRect().top),
    }))
    assert.equal(landed.y, 0, `a forward navigation must start at the top, got ${landed.y}`)
    assert.ok(landed.titleTop >= 0, 'the page heading must be visible after navigating')

    // Move, then go back: the previous page's offset comes back.
    await p.evaluate(() => window.scrollTo(0, 600))
    await sleep(300)
    await p.goBack()
    await sleep(700)
    const back = await p.evaluate(() => ({ hash: window.location.hash, y: window.scrollY }))
    assert.match(back.hash, /bank/, 'back returns to the previous route')
    assert.ok(back.y > 100, `back must restore the previous offset, got ${back.y}`)
    assert.deepEqual(errors, [], 'no page errors')
    await ctx.close()
  })

  await t.test('P0-2: switching questions keeps the question in view', async () => {
    const { p, ctx } = await freshPage()
    await seed(p, 40)
    await go(p, 'plan')
    await clickText(p, '开始今日复习')
    await p.waitForSelector('.q-stem')
    await sleep(400)

    const first = await p.evaluate(() => document.querySelector('.q-stem').textContent.slice(0, 20))
    // Answer, advance, and check the new question is on screen.
    await p.evaluate(() => document.querySelector('.opt, .judge-btn')?.click())
    await sleep(150)
    await clickText(p, '提交答案')
    await sleep(500)
    await clickText(p, '下一题')
    await sleep(600)

    const after = await p.evaluate(() => {
      const stem = document.querySelector('.q-stem')
      const r = stem.getBoundingClientRect()
      return {
        text: stem.textContent.slice(0, 20),
        top: r.top,
        bottom: r.bottom,
        viewportH: window.innerHeight,
      }
    })
    assert.notEqual(after.text, first, 'a different question must be shown')
    assert.ok(after.top >= 0 && after.bottom <= after.viewportH, 'the next question must be fully visible')
    await ctx.close()
  })

  // ---------------- P0-3: session lifecycle -------------------------------
  await t.test('P0-3: skip does not count as answered, and a submitted question is read-only', async () => {
    const { p, ctx } = await freshPage()
    await go(p, 'practice')
    await clickText(p, '开始练习')
    await p.waitForSelector('.q-stem')
    await sleep(300)

    await clickText(p, '跳过本题')
    await sleep(500)
    const skipped = await p.evaluate(() => ({
      pos: document.querySelector('.runner-pos').textContent.replace(/\s+/g, ''),
      counts: document.querySelector('.runner-counts').textContent.replace(/\s+/g, ''),
      skipTag: document.body.innerText.includes('已跳过'),
    }))
    assert.match(skipped.pos, /第2\/\d+题/, 'skipping advances to the next question')
    assert.match(skipped.counts, /已答0/, 'a skipped question is not counted as answered')
    assert.equal(skipped.skipTag, true, 'the skip count is shown')

    // Answer the current question, then assert it became read-only on the spot.
    await p.evaluate(() => document.querySelector('.opt, .judge-btn')?.click())
    await sleep(150)
    await clickText(p, '提交答案')
    await sleep(600)
    const locked = await p.evaluate(() => ({
      optionDisabled: Array.from(document.querySelectorAll('.opt, .judge-btn')).every((o) => o.disabled),
      submitHidden: !Array.from(document.querySelectorAll('button')).some((b) => b.textContent.includes('提交答案')),
      counts: document.querySelector('.runner-counts').textContent.replace(/\s+/g, ''),
    }))
    assert.equal(locked.optionDisabled, true, 'an answered question must be read-only')
    assert.equal(locked.submitHidden, true, 'an answered question must not offer submit again')
    assert.match(locked.counts, /已答1/, 'the graded question is counted once')

    // Stepping back to the previously skipped question must leave it answerable.
    await clickText(p, '上一题')
    await sleep(500)
    const skippedStillOpen = await p.evaluate(() => ({
      optionDisabled: Array.from(document.querySelectorAll('.opt, .judge-btn')).every((o) => o.disabled),
      submitVisible: Array.from(document.querySelectorAll('button')).some((b) => b.textContent.includes('提交答案')),
    }))
    assert.equal(skippedStillOpen.optionDisabled, false, 'a skipped question stays answerable')
    assert.equal(skippedStillOpen.submitVisible, true, 'a skipped question can still be submitted later')
    await ctx.close()
  })

  await t.test('P0-3: a reload preserves the session and offers to resume it', async () => {
    const { p, ctx } = await freshPage()
    await go(p, 'practice')
    await clickText(p, '开始练习')
    await p.waitForSelector('.q-stem')
    await p.evaluate(() => document.querySelector('.opt, .judge-btn')?.click())
    await sleep(150)
    await clickText(p, '提交答案')
    await sleep(600)

    const onDialog = async (d) => {
      if (d.type() === 'beforeunload') await d.accept()
      else await d.dismiss()
    }
    p.on('dialog', onDialog)
    await p.reload({ waitUntil: 'networkidle2' })
    p.off('dialog', onDialog)
    await p.waitForSelector('.app-shell')
    await sleep(600)

    const banner = await p.evaluate(() => ({
      hasResume: !!document.querySelector('.resume-banner'),
      text: document.querySelector('.resume-banner')?.textContent ?? '',
    }))
    assert.equal(banner.hasResume, true, 'an interrupted session must surface a resume affordance')
    assert.match(banner.text, /已答/, 'the resume banner reports the saved progress')

    await clickText(p, '继续上次')
    await p.waitForSelector('.q-stem', { timeout: 10000 })
    await sleep(500)
    const resumed = await p.evaluate(() => ({
      running: !!document.querySelector('.q-stem'),
      answeredDots: document.querySelectorAll('.progress-dots i.ok, .progress-dots i.bad').length,
    }))
    assert.equal(resumed.running, true, 'resuming returns to the answering surface')
    assert.ok(resumed.answeredDots >= 1, 'the previously answered question keeps its outcome')
    await ctx.close()
  })

  await t.test('P0-3: leaving a live session asks first, and starting twice cannot swap the paper', async () => {
    const { p, ctx } = await freshPage()
    await seed(p, 40)
    await go(p, 'plan')
    await clickText(p, '开始今日复习')
    await p.waitForSelector('.q-stem')
    await sleep(300)

    // The start button is gone while running, so a second click is impossible.
    const startGone = await p.evaluate(
      () => !Array.from(document.querySelectorAll('button')).some((b) => b.textContent.includes('开始今日复习')),
    )
    assert.equal(startGone, true, 'the start control must not be available mid-session')

    // Leaving via the sidebar must be gated.
    await p.evaluate(() => {
      Array.from(document.querySelectorAll('.nav-item'))
        .find((b) => b.textContent.includes('学习总览'))
        ?.click()
    })
    await sleep(600)
    const guard = await p.evaluate(() => ({
      dialog: !!document.querySelector('.dialog, [role=alertdialog]'),
      hash: window.location.hash,
    }))
    assert.equal(guard.dialog, true, 'leaving a live session must ask for confirmation')
    assert.match(guard.hash, /plan/, 'navigation must not proceed until the user confirms')

    await clickText(p, '继续答题')
    await sleep(400)
    const stillRunning = await p.evaluate(() => ({ running: !!document.querySelector('.q-stem') }))
    assert.equal(stillRunning.running, true, 'cancelling keeps the session')
    await ctx.close()
  })

  // ---------------- P0-4: completion summary ------------------------------
  await t.test('P0-4: finishing a group shows a summary with real counts', async () => {
    const { p, ctx } = await freshPage()
    await go(p, 'special')
    await p.evaluate(() => {
      Array.from(document.querySelectorAll('.btn-sm'))
        .find((b) => b.textContent.trim() === '10 题')
        ?.click()
    })
    await sleep(250)
    await clickText(p, '开始专项训练')
    await p.waitForSelector('.q-stem')
    await sleep(300)

    for (let i = 0; i < 2; i++) {
      await p.evaluate(() => document.querySelector('.opt, .judge-btn')?.click())
      await sleep(120)
      await clickText(p, '提交答案')
      await sleep(450)
      await clickText(p, '下一题')
      await sleep(450)
    }
    await clickText(p, '结束本组')
    await sleep(700)

    const summary = await p.evaluate(() => ({
      shown: !!document.querySelector('.summary'),
      metrics: Array.from(document.querySelectorAll('.summary-metric')).map((m) =>
        m.textContent.replace(/\s+/g, ' ').trim(),
      ),
      hasAdvice: !!document.querySelector('.summary-advice-list li'),
      hasRestart: Array.from(document.querySelectorAll('.summary button')).some((b) =>
        b.textContent.includes('再来一组'),
      ),
      heading: document.querySelector('.summary-title')?.tagName,
    }))
    assert.equal(summary.shown, true, 'finishing must produce a summary, not a silent return')
    assert.equal(summary.metrics.length, 6, 'the summary reports six distinct figures')
    assert.ok(
      summary.metrics.some((m) => m.includes('已作答')),
      'the summary reports how many were answered',
    )
    assert.ok(
      summary.metrics.some((m) => m.includes('未自动评分')),
      'the summary separates un-scored questions',
    )
    assert.equal(summary.hasAdvice, true, 'the summary gives a next step')
    assert.equal(summary.hasRestart, true, 'the summary offers to practise again')
    assert.equal(summary.heading, 'H2', 'the summary title is a semantic heading')
    await ctx.close()
  })

  // ---------------- P0-5: three outcomes ----------------------------------
  await t.test('P0-5: a subjective answer is neither correct nor wrong, anywhere', async () => {
    const { p, ctx, errors } = await freshPage()
    await go(p, 'subjective')
    await p.evaluate(() => {
      Array.from(document.querySelectorAll('.btn'))
        .find((b) => b.textContent.trim() === '1 题')
        ?.click()
    })
    await sleep(250)
    await clickText(p, '开始训练')
    await p.waitForSelector('.q-stem')
    await p.type('.textarea', '测试作答：分点作答，覆盖核心概念。')
    await sleep(200)
    await clickText(p, '提交答案')
    await sleep(700)

    const state = await p.evaluate(() => {
      const dot = document.querySelector('.progress-dots i')
      return {
        counts: document.querySelector('.runner-counts').textContent.replace(/\s+/g, ' ').trim(),
        dotClass: dot?.className ?? '',
        dotLabel: dot?.getAttribute('aria-label') ?? '',
        banner: document.querySelector('.result-banner')?.textContent?.trim() ?? '',
        bannerRole: document.querySelector('.result-banner')?.getAttribute('role'),
        bannerLive: document.querySelector('.result-banner')?.getAttribute('aria-live'),
      }
    })

    assert.match(state.counts, /未评 1/, 'the un-scored question is counted as un-scored')
    assert.match(state.counts, /错 0/, 'an un-scored answer must never be counted as wrong')
    assert.match(state.dotClass, /\buns\b/, 'the progress dot uses the un-scored state')
    assert.doesNotMatch(state.dotClass, /\bok\b/, 'the progress dot must not claim correctness')
    assert.doesNotMatch(state.dotClass, /\bbad\b/, 'the progress dot must not claim an error')
    assert.match(state.dotLabel, /未自动评分/, 'the dot announces its state to assistive tech')
    assert.match(state.banner, /未自动评分/, 'the banner states that no auto grade exists')
    assert.equal(state.bannerRole, 'status', 'the outcome is announced')
    assert.equal(state.bannerLive, 'polite', 'the outcome uses a polite live region')
    assert.deepEqual(errors, [], 'no page errors')
    await ctx.close()
  })

  await t.test('P0-5: correct and wrong still render distinctly for objective questions', async () => {
    const { p, ctx } = await freshPage()
    await go(p, 'practice')
    await clickText(p, '开始练习')
    await p.waitForSelector('.q-stem')
    await sleep(300)
    // Pick a deliberately wrong answer where possible, else any.
    await p.evaluate(() => document.querySelector('.opt, .judge-btn')?.click())
    await sleep(150)
    await clickText(p, '提交答案')
    await sleep(600)
    const state = await p.evaluate(() => ({
      counts: document.querySelector('.runner-counts').textContent.replace(/\s+/g, ' ').trim(),
      ok: document.querySelectorAll('.progress-dots i.ok').length,
      bad: document.querySelectorAll('.progress-dots i.bad').length,
      uns: document.querySelectorAll('.progress-dots i.uns').length,
    }))
    assert.match(state.counts, /(对 1|错 1)/, 'an objective answer is graded into correct or wrong')
    assert.equal(state.ok + state.bad, 1, 'exactly one graded dot is set')
    assert.equal(state.uns, 0, 'an objective answer is never marked un-scored')
    await ctx.close()
  })
})
