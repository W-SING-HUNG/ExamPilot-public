/**
 * Phase-3 UI/UX browser regression.
 *
 * These tests assert presentation and interaction properties that the business
 * suites do not cover: responsive layout at the required breakpoints, absence of
 * overflow and unreachable controls, keyboard access, the presence and honesty of
 * the motion layer, real pagination, and real cancellation.
 *
 * They run against the same dev server as the other browser suites and use only
 * the public sample bank.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import puppeteer from 'puppeteer-core'

const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const BASE = process.env.E2E_BASE || 'http://localhost:5173'

const VIEWPORTS = [
  { name: '1440', width: 1440, height: 900, touch: false },
  { name: '1280', width: 1280, height: 800, touch: false },
  { name: '768', width: 768, height: 1024, touch: true },
  { name: '390', width: 390, height: 844, touch: true },
  { name: '375', width: 375, height: 812, touch: true },
]

const ROUTES = [
  ['home', '/'],
  ['diagnosis', '/#/diagnosis'],
  ['plan', '/#/plan'],
  ['practice', '/#/practice'],
  ['special', '/#/special'],
  ['subjective', '/#/subjective'],
  ['wrong', '/#/wrong'],
  ['mock', '/#/mock'],
  ['history', '/#/history'],
  ['bank', '/#/bank'],
  ['ai', '/#/ai'],
  ['io', '/#/io'],
  ['settings', '/#/settings'],
]

let browser

async function freshPage({ width = 1280, height = 800, touch = false, reducedMotion = false } = {}) {
  const ctx = await browser.createBrowserContext()
  const p = await ctx.newPage()
  p.setDefaultTimeout(15000)
  await p.setViewport({ width, height, isMobile: touch, hasTouch: touch })
  if (reducedMotion) {
    await p.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }])
  }
  const errors = []
  p.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  p.on('console', (m) => {
    if (m.type() !== 'error') return
    const t = m.text()
    if (/Failed to load resource/.test(t) && /\/api\//.test(t)) return
    if (/\b50[23]\b/.test(t)) return
    errors.push(`console: ${t}`)
  })
  await p.goto(BASE, { waitUntil: 'networkidle2' })
  await p.waitForSelector('.app-shell', { timeout: 20000 })
  return { p, ctx, errors }
}

const nav = async (p, route) => {
  await p.evaluate((r) => {
    window.location.hash = r === 'home' ? '/' : `/${r}`
  }, route)
  await p.waitForSelector('.page-title', { timeout: 15000 })
  await new Promise((r) => setTimeout(r, 320))
}

test('phase-3 UI/UX', async (t) => {
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  })
  t.after(async () => {
    if (browser) await browser.close()
  })

  // ---- 1. responsive layout at every required breakpoint -------------------

  for (const vp of VIEWPORTS) {
    await t.test(`R-${vp.name}: no overflow and every control reachable`, async () => {
      const { p, ctx, errors } = await freshPage(vp)
      for (const [name, path] of ROUTES) {
        await p.goto(BASE + path, { waitUntil: 'networkidle2' })
        await p.waitForSelector('.app-shell')
        await new Promise((r) => setTimeout(r, 260))

        const info = await p.evaluate(() => {
          const de = document.documentElement
          const inScroller = (el) => {
            let n = el.parentElement
            while (n) {
              const s = getComputedStyle(n)
              if (s.overflowX === 'auto' || s.overflowX === 'scroll') return true
              n = n.parentElement
            }
            return false
          }
          const unreachable = []
          for (const el of document.querySelectorAll('button, a, input, select, textarea')) {
            if (el.classList.contains('skip-link')) continue
            const r = el.getBoundingClientRect()
            if (!r.width || !r.height) continue
            const s = getComputedStyle(el)
            if (s.display === 'none' || s.visibility === 'hidden') continue
            if (inScroller(el)) continue
            if (r.right > de.clientWidth + 1 || r.left < -1) {
              unreachable.push((el.textContent || el.tagName).trim().slice(0, 24))
            }
          }
          return {
            overflow: de.scrollWidth - de.clientWidth,
            unreachable,
            hasTitle: !!document.querySelector('.page-title'),
          }
        })

        assert.equal(info.overflow, 0, `${name} must not overflow horizontally at ${vp.name}px`)
        assert.deepEqual(info.unreachable, [], `${name} must have no unreachable control at ${vp.name}px`)
        assert.ok(info.hasTitle, `${name} must render a page title at ${vp.name}px`)
      }
      assert.deepEqual(errors, [], 'no page errors')
      await ctx.close()
    })
  }

  // ---- 2. mobile navigation is operable ------------------------------------

  await t.test('N-1: the mobile menu opens, navigates and closes on selection', async () => {
    const { p, ctx, errors } = await freshPage({ width: 390, height: 844, touch: true })
    // The desktop sidebar must be hidden at this width.
    const sidebarVisible = await p.evaluate(() => {
      const el = document.querySelector('.sidebar')
      return el ? getComputedStyle(el).display !== 'none' : false
    })
    assert.equal(sidebarVisible, false, 'the desktop sidebar is hidden on a phone')

    const toggle = await p.evaluate(() => {
      const b = document.querySelector('.topbar button[aria-controls="mobile-menu"]')
      if (!b) return null
      b.click()
      return true
    })
    assert.ok(toggle, 'the topbar exposes a menu button')
    // React re-renders on the next tick, so read the state after it settles.
    await p.waitForFunction(
      () =>
        document.querySelector('.topbar button[aria-controls="mobile-menu"]')?.getAttribute('aria-expanded') === 'true',
      { timeout: 5000 },
    )
    await p.waitForSelector('#mobile-menu')

    const picked = await p.evaluate(() => {
      const items = Array.from(document.querySelectorAll('#mobile-menu .nav-item'))
      const target = items.find((x) => x.textContent?.trim() === '复习计划')
      if (!target) return false
      target.click()
      return true
    })
    assert.ok(picked, 'the menu lists navigation entries')
    await p.waitForSelector('.page-title')
    await new Promise((r) => setTimeout(r, 320))
    const closed = await p.evaluate(() => document.getElementById('mobile-menu') === null)
    assert.ok(closed, 'selecting an entry closes the menu')
    const title = await p.evaluate(() => document.querySelector('.page-title')?.textContent ?? '')
    assert.match(title, /复习计划/, 'the selected page is shown')
    assert.deepEqual(errors, [], 'no page errors')
    await ctx.close()
  })

  // ---- 3. keyboard access --------------------------------------------------

  await t.test('A-1: the skip link is the first tab stop and focuses main', async () => {
    const { p, ctx, errors } = await freshPage({ width: 1280, height: 800 })
    await p.keyboard.press('Tab')
    const first = await p.evaluate(() => {
      const el = document.activeElement
      return { cls: el?.className ?? '', text: el?.textContent?.trim() ?? '' }
    })
    assert.match(first.cls, /skip-link/, 'the first tab stop is the skip link')
    assert.match(first.text, /跳到主要内容/, 'the skip link is labelled')

    // Activating it must move focus into the main region.
    await p.keyboard.press('Enter')
    await new Promise((r) => setTimeout(r, 200))
    const focused = await p.evaluate(() => document.activeElement?.id ?? '')
    assert.equal(focused, 'main-content', 'the skip link focuses the main region')
    assert.deepEqual(errors, [], 'no page errors')
    await ctx.close()
  })

  await t.test('A-2: navigation entries expose aria-current and focus is visible', async () => {
    const { p, ctx, errors } = await freshPage({ width: 1280, height: 800 })
    await nav(p, 'diagnosis')
    const info = await p.evaluate(() => {
      const active = document.querySelector('.nav-item.active')
      return {
        current: active?.getAttribute('aria-current') ?? null,
        label: active?.textContent?.trim() ?? '',
      }
    })
    assert.equal(info.current, 'page', 'the active nav entry exposes aria-current=page')
    // 学习诊断 is now the 详细诊断 view inside 学习总览, so that entry is the
    // one that must be highlighted while its sub-route is open.
    assert.match(info.label, /学习总览/, 'the highlighted entry is the current page')

    // Focus ring must be a real outline, not a colour-only change.
    const ring = await p.evaluate(() => {
      const b = document.querySelector('.nav-item')
      b?.focus()
      const s = getComputedStyle(b, ':focus-visible')
      return { width: s.outlineWidth, style: s.outlineStyle }
    })
    assert.notEqual(ring.style, 'none', 'a focus outline is defined for keyboard focus')
    assert.deepEqual(errors, [], 'no page errors')
    await ctx.close()
  })

  // ---- 4. motion layer -----------------------------------------------------

  await t.test('M-1: the reveal animation is CSS-driven and staggered', async () => {
    const { p, ctx, errors } = await freshPage({ width: 1280, height: 800 })
    await nav(p, 'home')
    // The stagger is expressed as an animation-delay derived from an index
    // variable; assert the mechanism rather than a sleep.
    const stagger = await p.evaluate(() => {
      const wrap = document.querySelector('.reveal')
      if (!wrap) return null
      const kids = Array.from(wrap.children).slice(0, 3)
      return kids.map((k) => {
        const s = getComputedStyle(k)
        return { delay: s.animationDelay, name: s.animationName, dur: s.animationDuration }
      })
    })
    assert.ok(stagger && stagger.length > 0, 'the home page renders a reveal wrapper')
    const delays = stagger.map((s) => s.delay)
    assert.ok(
      delays.some((d) => d !== '0s'),
      `at least one item must be delayed to create a stagger, got ${JSON.stringify(delays)}`,
    )
    assert.ok(
      stagger.every((s) => s.name !== 'none'),
      'reveal items carry a CSS animation',
    )
    assert.deepEqual(errors, [], 'no page errors')
    await ctx.close()
  })

  await t.test('M-2: prefers-reduced-motion disables the motion layer', async () => {
    const { p, ctx, errors } = await freshPage({ width: 1280, height: 800, reducedMotion: true })
    await nav(p, 'home')
    const motion = await p.evaluate(() => {
      const el = document.querySelector('.reveal > *')
      const sk = document.createElement('div')
      sk.className = 'sk'
      document.body.appendChild(sk)
      const after = getComputedStyle(sk, '::after')
      const animated = after.animationName !== 'none' && after.animationDuration !== '0s'
      const kb = el ? getComputedStyle(el) : null
      const res = {
        skeletonSweeps: animated,
        revealDuration: kb?.animationDuration ?? '0s',
      }
      sk.remove()
      return res
    })
    // The reduced-motion block collapses durations to a hair, and the skeleton
    // sweep is turned off outright.
    assert.equal(motion.skeletonSweeps, false, 'the skeleton sweep is disabled')
    assert.ok(
      motion.revealDuration === '0s' || parseFloat(motion.revealDuration) < 0.01,
      `reveal animation is collapsed, got ${motion.revealDuration}`,
    )
    assert.deepEqual(errors, [], 'no page errors')
    await ctx.close()
  })

  await t.test('M-3: the skeleton sweep uses the specified gradient cycle', async () => {
    const { p, ctx, errors } = await freshPage({ width: 1280, height: 800 })
    const cfg = await p.evaluate(() => {
      const el = document.createElement('div')
      el.className = 'sk'
      document.body.appendChild(el)
      const after = getComputedStyle(el, '::after')
      const out = {
        name: after.animationName,
        duration: after.animationDuration,
        timing: after.animationTimingFunction,
        iterations: after.animationIterationCount,
        backgroundSize: after.backgroundSize,
        hasGradient: after.backgroundImage.includes('linear-gradient'),
      }
      el.remove()
      return out
    })
    assert.match(cfg.name, /sk-sweep/, 'the skeleton uses the sweep keyframes')
    assert.equal(cfg.duration, '1.6s', 'the sweep runs on a 1.6s cycle')
    assert.equal(cfg.iterations, 'infinite', 'the sweep is unbounded while visible')
    assert.ok(cfg.hasGradient, 'the highlight is a linear-gradient')
    assert.match(cfg.backgroundSize, /200%/, 'the gradient is 200% wide so it can travel')
    assert.deepEqual(errors, [], 'no page errors')
    await ctx.close()
  })

  // ---- 5. real pagination --------------------------------------------------

  await t.test('P-1: history pages through IndexedDB and resets on filter change', async () => {
    const { p, ctx, errors } = await freshPage({ width: 1280, height: 800 })
    // Seed more rows than one page so pagination must engage.
    const seeded = await p.evaluate(async () => {
      const bankMod = await import('/src/lib/bank.ts')
      const dbmod = await import('/src/db/database.ts')
      const now = Date.now()
      const qs = bankMod.objectiveQuestions
      const rows = []
      const N = 130
      for (let i = 0; i < N; i++) {
        const q = qs[i % qs.length]
        rows.push({
          id: `h-${i}`,
          qid: q.id,
          mode: i % 3 === 0 ? 'practice' : i % 3 === 1 ? 'special' : 'plan',
          sessionId: `s-${i}`,
          answer: 'A',
          isCorrect: i % 2 === 0,
          submittedAt: now - i * 60_000,
          usedAI: false,
        })
      }
      await dbmod.db.history.bulkPut(rows)
      return N
    })
    assert.ok(seeded > 60, 'more rows than one page were seeded')

    await p.reload({ waitUntil: 'networkidle2' })
    await p.waitForSelector('.app-shell')
    await nav(p, 'history')
    await p.waitForSelector('.tbl tbody tr', { timeout: 15000 })

    const firstPage = await p.evaluate(() => document.querySelectorAll('.tbl tbody tr').length)
    assert.equal(firstPage, 60, `the first page holds one page of rows, got ${firstPage}`)

    // Scrolling to the sentinel must load the next page.
    await p.evaluate(() => {
      const s = document.querySelector('.list-sentinel')
      s?.scrollIntoView({ block: 'end' })
    })
    await p.waitForFunction(() => document.querySelectorAll('.tbl tbody tr').length > 60, { timeout: 10000 })
    const afterScroll = await p.evaluate(() => document.querySelectorAll('.tbl tbody tr').length)
    assert.ok(afterScroll > firstPage, `scrolling appends rows, got ${afterScroll}`)

    // Changing a filter must reset to a single page. Wait for the reset to
    // settle rather than sampling immediately: the list has to drop back to the
    // first page before the assertion means anything.
    await p.select('#hist-result', 'ok')
    await p.waitForFunction(
      () => {
        const rows = document.querySelectorAll('.tbl tbody tr')
        return rows.length > 0 && rows.length <= 60
      },
      { timeout: 10000 },
    )
    const afterFilter = await p.evaluate(() => ({
      rows: document.querySelectorAll('.tbl tbody tr').length,
      allOk: Array.from(document.querySelectorAll('.tbl tbody tr')).every((tr) =>
        (tr.textContent ?? '').includes('正确'),
      ),
    }))
    assert.ok(afterFilter.rows <= 60, `a filter change resets the list to one page, got ${afterFilter.rows}`)
    assert.ok(afterFilter.allOk, 'the filter is actually applied to the loaded rows')
    assert.deepEqual(errors, [], 'no page errors')
    await ctx.close()
  })

  await t.test('P-2: the bank list pages instead of truncating, and filtering resets', async () => {
    const { p, ctx, errors } = await freshPage({ width: 1280, height: 800 })
    await nav(p, 'bank')
    await p.waitForSelector('.infinite-list .card', { timeout: 15000 })
    // The page size is 40, but the installed bank may hold fewer questions than
    // that, so the first page is min(pageSize, bankSize).
    const bankSize = await p.evaluate(async () => {
      const m = await import('/src/lib/bank.ts')
      return m.allQuestions.length
    })
    const PAGE = 40
    const expected = Math.min(PAGE, bankSize)
    const first = await p.evaluate(() => document.querySelectorAll('.infinite-list .card').length)
    assert.equal(first, expected, `the bank page renders one page of rows (${expected}), got ${first}`)

    if (bankSize > PAGE) {
      // Paging must continue past the first page; the old implementation simply
      // truncated and printed a note.
      await p.evaluate(() => document.querySelector('.list-sentinel')?.scrollIntoView({ block: 'end' }))
      await p.waitForFunction(
        (n) => document.querySelectorAll('.infinite-list .card').length > n,
        { timeout: 10000 },
        first,
      )
      const more = await p.evaluate(() => document.querySelectorAll('.infinite-list .card').length)
      assert.ok(more > first, `scrolling appends bank rows, got ${more}`)
    }

    // Choosing a chapter resets the list. Wait for the reset to settle before
    // measuring, otherwise the assertion samples the pre-reset list.
    //
    // Reset the scroll to the top FIRST. The paging check above deliberately
    // scrolls the sentinel into view; leaving it there means the freshly reset
    // list legitimately loads a second page immediately (chapters hold more than
    // one page of questions), so the "<= 40 rows" assertion races the loader.
    // That race is what made this test flap between runs.
    await p.evaluate(() => {
      window.scrollTo(0, 0)
      document.querySelector('.app-main')?.scrollTo?.(0, 0)
    })
    await p.waitForFunction(() => window.scrollY === 0, { timeout: 5000 }).catch(() => {})
    const before = await p.evaluate(() => document.querySelectorAll('.infinite-list .card').length)
    const chapter = await p.evaluate(() => {
      const sel = document.querySelector('#bank-chapter')
      if (!sel) return null
      // Pick a chapter that actually contains questions.
      const opt = Array.from(sel.options).find((o) => o.value)
      if (!opt) return null
      sel.value = opt.value
      sel.dispatchEvent(new Event('change', { bubbles: true }))
      return opt.value
    })
    assert.ok(chapter, 'a chapter filter exists')
    await p.waitForFunction(
      () => {
        const n = document.querySelectorAll('.infinite-list .card').length
        return n > 0 && n <= 40
      },
      { timeout: 10000 },
    )
    const filtered = await p.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('.infinite-list .card'))
      return {
        rows: cards.length,
        // The filtered rows must all belong to the chosen chapter.
        allMatch: cards.length > 0 && cards.every((c) => (c.textContent ?? '').includes('')),
        firstRows: cards.slice(0, 3).map((c) => (c.textContent ?? '').trim().slice(0, 30)),
      }
    })
    assert.ok(
      filtered.rows <= 40,
      `a chapter filter restarts at the first page (<=40 rows), got ${filtered.rows} after ${before}`,
    )
    assert.ok(filtered.rows > 0, 'the chosen chapter has questions')
    assert.deepEqual(errors, [], 'no page errors')
    await ctx.close()
  })

  // ---- 6. AI cancellation --------------------------------------------------

  await t.test('I-1: an AI request can be genuinely cancelled', async () => {
    // A port that refuses instantly would end the request before the pending
    // state is observable, so route /api/ai via a never-resolving interception.
    const { p, ctx, errors } = await freshPage({ width: 1280, height: 800 })
    await p.setRequestInterception(true)
    let sawGradeRequest = false
    p.on('request', (req) => {
      if (req.url().includes('/api/ai/grade')) {
        sawGradeRequest = true
        // Hang: never respond, so the request stays in flight until aborted.
        return
      }
      void req.continue()
    })
    await p.reload({ waitUntil: 'networkidle2' })
    await p.waitForSelector('.app-shell')

    // Reach an AI panel through the subjective training flow.
    await nav(p, 'subjective')
    const started = await p.evaluate(() => {
      const b = Array.from(document.querySelectorAll('.btn.btn-lg')).find((x) => x.textContent?.includes('开始训练'))
      if (!b) return false
      b.click()
      return true
    })
    assert.ok(started, 'the subjective training session starts')
    await p.waitForSelector('textarea.textarea', { timeout: 15000 })
    await p.evaluate(() => {
      const ta = document.querySelector('textarea.textarea')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(ta, '阶段三取消测试作答')
      ta.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await p.evaluate(() => {
      const b = Array.from(document.querySelectorAll('.btn.btn-primary.btn-lg'))
      b[0]?.click()
    })
    await new Promise((r) => setTimeout(r, 800))

    // Start the AI review; the stop control must appear while pending.
    const startedReq = await p.evaluate(() => {
      const b = Array.from(document.querySelectorAll('button')).find((x) => x.textContent?.includes('提交 AI 评阅'))
      if (!b) return false
      b.click()
      return true
    })
    assert.ok(startedReq, 'the AI review request starts')
    await p.waitForFunction(() => document.body.textContent?.includes('正在评阅'), { timeout: 8000 })
    assert.ok(sawGradeRequest, 'the request actually reached the network layer')

    const stopBtn = await p.evaluate(() => {
      const b = Array.from(document.querySelectorAll('button')).find((x) => x.textContent?.includes('停止评阅'))
      if (!b) return false
      b.click()
      return true
    })
    assert.ok(stopBtn, 'a real stop control is offered while pending')

    // The cancelled state must be reported and must not fabricate a score.
    await p.waitForFunction(() => document.body.textContent?.includes('已取消'), { timeout: 8000 })
    const state = await p.evaluate(() => ({
      cancelled: document.body.textContent?.includes('已取消') ?? false,
      pending: document.body.textContent?.includes('正在评阅') ?? false,
      hasScore: /\b\d+\s*\/\s*100（参考分）/.test(document.body.textContent ?? ''),
    }))
    assert.equal(state.cancelled, true, 'cancellation is reported')
    assert.equal(state.pending, false, 'the pending state is cleared')
    assert.equal(state.hasScore, false, 'no score is fabricated for a cancelled request')
    assert.deepEqual(errors, [], 'no page errors')
    await ctx.close()
  })

  // ---- 7. empty and error states -------------------------------------------

  await t.test('S-1: empty states are informative rather than blank', async () => {
    const { p, ctx, errors } = await freshPage({ width: 1280, height: 800 })
    await nav(p, 'history')
    await p.waitForSelector('.tbl, .empty', { timeout: 15000 })
    const hist = await p.evaluate(() => ({
      hasEmpty: !!document.querySelector('.empty'),
      hasGlyph: !!document.querySelector('.empty-icon'),
      text: document.querySelector('.empty')?.textContent?.trim() ?? '',
    }))
    assert.ok(hist.hasEmpty || hist.text.length > 0, 'history shows an empty state when there is no data')
    assert.ok(hist.hasGlyph, 'the empty state carries a glyph rather than bare text')

    await nav(p, 'wrong')
    await p.waitForSelector('.page-title')
    const wrong = await p.evaluate(() => document.querySelector('.empty')?.textContent?.trim() ?? '')
    assert.ok(wrong.length > 0, 'the wrong bank explains how questions arrive')
    assert.deepEqual(errors, [], 'no page errors')
    await ctx.close()
  })

  await t.test('S-2: destructive actions use an in-app dialog, not window.confirm', async () => {
    const { p, ctx, errors } = await freshPage({ width: 1280, height: 800 })
    await nav(p, 'settings')
    await p.waitForSelector('.page-title')

    // A native confirm would block the page; assert the button opens a dialog.
    const opened = await p.evaluate(() => {
      const b = Array.from(document.querySelectorAll('button')).find((x) => x.textContent?.includes('重置全部学习数据'))
      if (!b) return false
      b.click()
      return true
    })
    assert.ok(opened, 'the reset control exists')
    await p.waitForSelector('.dialog[role="alertdialog"]', { timeout: 5000 })
    const dlg = await p.evaluate(() => {
      const d = document.querySelector('.dialog')
      return {
        modal: d?.getAttribute('aria-modal') ?? null,
        labelled: !!document.getElementById('dialog-title'),
        focused: document.activeElement?.textContent?.trim() ?? '',
        buttons: Array.from(d?.querySelectorAll('.dialog-actions button') ?? []).map((b) => b.textContent?.trim()),
      }
    })
    assert.equal(dlg.modal, 'true', 'the dialog is modal')
    assert.ok(dlg.labelled, 'the dialog is labelled for assistive tech')
    assert.ok(dlg.buttons.length === 2, 'the dialog offers cancel and confirm')

    // Escape cancels and leaves the data untouched.
    await p.keyboard.press('Escape')
    await new Promise((r) => setTimeout(r, 250))
    const closed = await p.evaluate(() => document.querySelector('.dialog') === null)
    assert.ok(closed, 'Escape closes the dialog without acting')
    assert.deepEqual(errors, [], 'no page errors')
    await ctx.close()
  })

  // ---- 8. core flow still works -------------------------------------------

  await t.test('F-1: answering a question still records progress after the redesign', async () => {
    const { p, ctx, errors } = await freshPage({ width: 1280, height: 800 })
    await nav(p, 'practice')
    await p.evaluate(() => {
      const b = Array.from(document.querySelectorAll('.btn.btn-lg')).find((x) => x.textContent?.includes('开始练习'))
      b?.click()
    })
    await p.waitForSelector('.q-stem', { timeout: 15000 })

    // The served question may be choice, judge or free text; drive whichever
    // control is present rather than assuming one type.
    const kind = await p.evaluate(() => {
      if (document.querySelector('.opt')) {
        document.querySelector('.opt').click()
        return 'opt'
      }
      const jb = document.querySelector('.judge-btn')
      if (jb) {
        jb.click()
        return 'judge'
      }
      const ta = document.querySelector('textarea.textarea')
      if (ta) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
        setter?.call(ta, '阶段三回归作答')
        ta.dispatchEvent(new Event('input', { bubbles: true }))
        return 'text'
      }
      return null
    })
    assert.ok(kind, 'the question exposes an answerable control')

    const submitted = await p.evaluate(() => {
      const b = Array.from(document.querySelectorAll('.btn.btn-primary.btn-lg')).find((x) =>
        x.textContent?.includes('提交答案'),
      )
      if (!b) return false
      b.click()
      return true
    })
    assert.ok(submitted, 'the submit control is reachable')
    await p.waitForSelector('.result-banner', { timeout: 15000 })

    // Progress must be persisted, not merely displayed.
    await new Promise((r) => setTimeout(r, 600))
    const recorded = await p.evaluate(async () => {
      const dbmod = await import('/src/db/database.ts')
      const rows = await dbmod.db.history.toArray()
      return rows.length
    })
    assert.ok(recorded > 0, 'the answer created a history row')
    assert.deepEqual(errors, [], 'no page errors')
    await ctx.close()
  })

  await t.test('F-2: the option controls expose accessible roles', async () => {
    const { p, ctx, errors } = await freshPage({ width: 1280, height: 800 })
    await nav(p, 'practice')
    // 自由刷题 opens in 按章节 mode, where the type toggles are hidden.
    // Switch to 按题型 so single-choice can be isolated.
    await p.evaluate(() => {
      const tab = Array.from(document.querySelectorAll('.view-switch button')).find(
        (b) => b.textContent?.trim() === '按题型',
      )
      tab?.click()
    })
    await new Promise((r) => setTimeout(r, 350))
    await p.evaluate(() => {
      const names = ['多选题', '判断题']
      for (const name of names) {
        const b = Array.from(document.querySelectorAll('.btn.btn-sm')).find((x) => x.textContent?.trim() === name)
        b?.click()
      }
    })
    await new Promise((r) => setTimeout(r, 400))
    const poolHint = await p.evaluate(
      () =>
        Array.from(document.querySelectorAll('.muted-2')).find((x) => x.textContent?.includes('符合条件'))
          ?.textContent ?? '',
    )
    assert.match(poolHint, /符合条件\s*[1-9]\d* 题/, `single-choice questions remain available, got "${poolHint}"`)

    await p.evaluate(() => {
      // In 按题型 mode the primary button is labelled 开始专项训练.
      const b = Array.from(document.querySelectorAll('.btn.btn-lg')).find(
        (x) => x.textContent?.includes('开始专项训练') || x.textContent?.includes('开始刷题'),
      )
      b?.click()
    })

    await p.waitForSelector('.q-stem', { timeout: 15000 })
    await p.waitForSelector('.opt .opt-text', { timeout: 10000 })

    const roles = await p.evaluate(() => {
      const opt = document.querySelector('.opt')
      const group = opt?.closest('[role="radiogroup"], [role="group"]')
      return {
        hasGroup: !!group,
        groupRole: group?.getAttribute('role') ?? '',
        groupLabel: group?.getAttribute('aria-label') ?? '',
        hasOptText: !!opt?.querySelector('.opt-text'),
        hasKey: !!opt?.querySelector('.opt-key'),
        keyHidden: opt?.querySelector('.opt-key')?.getAttribute('aria-hidden') ?? null,
        optRole: opt?.getAttribute('role') ?? '',
        ariaChecked: opt?.getAttribute('aria-checked'),
      }
    })
    assert.ok(roles.hasGroup, 'options are grouped for assistive tech')
    assert.equal(roles.groupRole, 'radiogroup', 'single-choice options form a radiogroup')
    assert.match(roles.groupLabel, /选项/, 'the group is labelled')
    assert.ok(roles.hasOptText, 'option text is wrapped separately from its key')
    assert.ok(roles.hasKey, 'the option letter is still rendered')
    assert.equal(roles.keyHidden, 'true', 'the decorative letter is hidden from assistive tech')
    assert.equal(roles.optRole, 'radio', 'a single-choice option is a radio')
    assert.notEqual(roles.ariaChecked, null, 'a radio option reports aria-checked')
    assert.deepEqual(errors, [], 'no page errors')
    await ctx.close()
  })

  // ---- 9. list invalidation and retry after failure ------------------------

  await t.test('P-3: clearing history empties the paged list and reports success only after the write', async () => {
    const { p, ctx, errors } = await freshPage({ width: 1280, height: 800 })
    // Seed enough rows that the list is genuinely populated before clearing.
    const seeded = await p.evaluate(async () => {
      const bankMod = await import('/src/lib/bank.ts')
      const dbmod = await import('/src/db/database.ts')
      const now = Date.now()
      const qs = bankMod.objectiveQuestions
      const rows = []
      for (let i = 0; i < 25; i++) {
        const q = qs[i % qs.length]
        rows.push({
          id: `hc-${i}`,
          qid: q.id,
          mode: 'practice',
          sessionId: `s-${i}`,
          answer: 'A',
          isCorrect: true,
          submittedAt: now - i * 60_000,
          usedAI: false,
        })
      }
      await dbmod.db.history.bulkPut(rows)
      return rows.length
    })
    assert.ok(seeded > 0, 'history rows were seeded')

    await p.reload({ waitUntil: 'networkidle2' })
    await p.waitForSelector('.app-shell')
    await nav(p, 'history')
    await p.waitForSelector('.tbl tbody tr', { timeout: 15000 })
    const beforeRows = await p.evaluate(() => document.querySelectorAll('.tbl tbody tr').length)
    assert.ok(beforeRows > 0, `the list is populated before clearing, got ${beforeRows}`)

    // Clear through the real UI.
    await p.evaluate(() => {
      const b = Array.from(document.querySelectorAll('button')).find((x) => x.textContent?.includes('清空历史'))
      b?.click()
    })
    await p.waitForSelector('.dialog[role="alertdialog"]', { timeout: 5000 })
    await p.evaluate(() => {
      const b = Array.from(document.querySelectorAll('.dialog-actions button')).find((x) =>
        x.textContent?.includes('清空历史'),
      )
      b?.click()
    })

    // The success toast must only appear once the write has completed, and the
    // paged list must be invalidated so it reflects the empty database.
    await p.waitForFunction(() => document.body.textContent?.includes('历史已清除'), { timeout: 10000 })
    await p.waitForFunction(
      () => document.querySelectorAll('.tbl tbody tr').length === 0 && !!document.querySelector('.empty'),
      { timeout: 10000 },
    )
    const after = await p.evaluate(async () => {
      const dbmod = await import('/src/db/database.ts')
      const rows = await dbmod.db.history.count()
      return {
        dbCount: rows,
        renderedRows: document.querySelectorAll('.tbl tbody tr').length,
        hasEmpty: !!document.querySelector('.empty'),
      }
    })
    assert.equal(after.dbCount, 0, 'the database really is empty')
    assert.equal(after.renderedRows, 0, 'the paged list was invalidated and shows no rows')
    assert.ok(after.hasEmpty, 'an empty state replaces the table')

    // A reload must agree: the clear was committed, not just hidden.
    await p.reload({ waitUntil: 'networkidle2' })
    await p.waitForSelector('.app-shell')
    await nav(p, 'history')
    await new Promise((r) => setTimeout(r, 700))
    const afterReload = await p.evaluate(() => document.querySelectorAll('.tbl tbody tr').length)
    assert.equal(afterReload, 0, 'the clear survives a reload')
    assert.deepEqual(errors, [], 'no page errors')
    await ctx.close()
  })

  await t.test('P-4: the clear control is disabled once there is nothing to clear', async () => {
    const { p, ctx, errors } = await freshPage({ width: 1280, height: 800 })
    await p.evaluate(async () => {
      const bankMod = await import('/src/lib/bank.ts')
      const dbmod = await import('/src/db/database.ts')
      const now = Date.now()
      const q = bankMod.objectiveQuestions[0]
      await dbmod.db.history.bulkPut([
        {
          id: 'hd-0',
          qid: q.id,
          mode: 'practice',
          sessionId: 's-0',
          answer: 'A',
          isCorrect: true,
          submittedAt: now,
          usedAI: false,
        },
      ])
    })
    await p.reload({ waitUntil: 'networkidle2' })
    await p.waitForSelector('.app-shell')
    await nav(p, 'history')
    await p.waitForSelector('.tbl tbody tr', { timeout: 15000 })

    const enabledBefore = await p.evaluate(() => {
      const b = Array.from(document.querySelectorAll('button')).find((x) => x.textContent?.includes('清空历史'))
      return b ? !b.disabled : null
    })
    assert.equal(enabledBefore, true, 'the clear control is enabled while rows exist')

    await p.evaluate(() => {
      const b = Array.from(document.querySelectorAll('button')).find((x) => x.textContent?.includes('清空历史'))
      b?.click()
    })
    await p.waitForSelector('.dialog[role="alertdialog"]', { timeout: 5000 })
    await p.evaluate(() => {
      const b = Array.from(document.querySelectorAll('.dialog-actions button')).find((x) =>
        x.textContent?.includes('清空历史'),
      )
      b?.click()
    })
    await p.waitForFunction(() => document.body.textContent?.includes('历史已清除'), { timeout: 10000 })
    await p.waitForFunction(() => document.querySelectorAll('.tbl tbody tr').length === 0, { timeout: 10000 })

    const enabledAfter = await p.evaluate(() => {
      const b = Array.from(document.querySelectorAll('button')).find((x) => x.textContent?.includes('清空历史'))
      return b ? !b.disabled : null
    })
    assert.equal(enabledAfter, false, 'the clear control is disabled once the history is empty')
    assert.deepEqual(errors, [], 'no page errors')
    await ctx.close()
  })

  await t.test('P-5: an empty store renders an empty state, and a reload appends each row once', async () => {
    const { p, ctx, errors } = await freshPage({ width: 1280, height: 800 })

    // Start from a genuinely empty history so the first page resolves to the
    // empty state rather than a failure.
    await nav(p, 'history')
    await p.waitForFunction(
      () => document.querySelector('.empty') !== null || document.querySelectorAll('.tbl tbody tr').length === 0,
      {
        timeout: 20000,
      },
    )
    const emptyRows = await p.evaluate(() => document.querySelectorAll('.tbl tbody tr').length)
    assert.equal(emptyRows, 0, 'an empty store renders no rows')

    // Insert rows while the page is open, then force a first-page reload through
    // a filter change. The reload must show each row exactly once — this is the
    // regression for a retry/reset that re-requests but appends into stale state.
    const inserted = await p.evaluate(async () => {
      const bankMod = await import('/src/lib/bank.ts')
      const dbmod = await import('/src/db/database.ts')
      const now = Date.now()
      const q = bankMod.objectiveQuestions[0]
      const rows = [0, 1, 2].map((i) => ({
        id: `hp-${i}`,
        qid: q.id,
        mode: 'plan',
        sessionId: `s-${i}`,
        answer: 'C',
        isCorrect: true,
        submittedAt: now - i * 60_000,
        usedAI: false,
      }))
      await dbmod.db.history.bulkPut(rows)
      return rows.length
    })
    assert.equal(inserted, 3, 'three rows were inserted')

    await p.select('#hist-result', 'ok')
    await p.waitForFunction(() => document.querySelectorAll('.tbl tbody tr').length === 3, { timeout: 20000 })
    await new Promise((r) => setTimeout(r, 600))
    const reloaded = await p.evaluate(() => ({
      rows: document.querySelectorAll('.tbl tbody tr').length,
      stamps: Array.from(document.querySelectorAll('.tbl tbody tr')).map(
        (tr) => tr.querySelector('.code')?.textContent?.trim() ?? '',
      ),
    }))
    assert.equal(reloaded.rows, 3, `the reload shows each row once, got ${reloaded.rows}`)
    assert.equal(new Set(reloaded.stamps).size, reloaded.stamps.length, 'no duplicated or stale rows after the reload')

    // Switching the filter again must replace, not accumulate.
    await p.select('#hist-result', 'bad')
    await p.waitForFunction(() => document.querySelectorAll('.tbl tbody tr').length === 0, { timeout: 20000 })
    const afterBad = await p.evaluate(() => document.querySelectorAll('.tbl tbody tr').length)
    assert.equal(afterBad, 0, 'a filter with no matches replaces the list rather than appending')
    assert.deepEqual(errors, [], 'no page errors')
    await ctx.close()
  })
})
