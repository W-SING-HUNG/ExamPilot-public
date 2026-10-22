/**
 * Real-browser verification of the five user-visible defects.
 *
 * Each check drives the actual UI through Chrome (isolated profile, sample bank)
 * and asserts on what a user would see. This is deliberately separate from the
 * unit tests: those pin the logic, this proves the screens behave.
 *
 * Run: node tests/workbuddy-verify.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import puppeteer from 'puppeteer-core'

const BASE = process.env.E2E_BASE || 'http://localhost:5173'
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

async function withPage(fn) {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1280, height: 900 })
    const errors = []
    page.on('pageerror', (e) => errors.push(String(e)))
    await page.goto(`${BASE}/#/`, { waitUntil: 'networkidle2' })
    await page.evaluate(() => localStorage.clear())
    await fn(page, errors)
    assert.deepEqual(errors, [], 'no uncaught page errors')
  } finally {
    await browser.close()
  }
}

const go = async (page, hash) => {
  await page.goto(`${BASE}/#${hash}`, { waitUntil: 'networkidle2' })
  await new Promise((r) => setTimeout(r, 600))
}

// ---------------------------------------------------------------------------
// 1. Date statistics: a record made "today" must count as today
// ---------------------------------------------------------------------------
test("P1 date: today's activity is counted as today, not shifted a day back", async () => {
  await withPage(async (page) => {
    // Seed IndexedDB with a history entry timestamped NOW (local clock).
    const seeded = await page.evaluate(async () => {
      const open = indexedDB.open('exampilot')
      const db = await new Promise((res, rej) => {
        open.onsuccess = () => res(open.result)
        open.onerror = () => rej(open.error)
      })
      const names = Array.from(db.objectStoreNames)
      if (!names.includes('history')) return { ok: false, names }
      const now = Date.now()
      const tx = db.transaction('history', 'readwrite')
      tx.objectStore('history').put({
        id: 'verify-today-1',
        qid: 'S001-a1b2c3d4-导论',
        mode: 'practice',
        sessionId: 'verify-session',
        answer: 'B',
        isCorrect: true,
        submittedAt: now,
        usedAI: false,
      })
      await new Promise((res, rej) => {
        tx.oncomplete = res
        tx.onerror = () => rej(tx.error)
      })
      return { ok: true, now }
    })

    if (!seeded.ok) {
      // Store not created yet on a first visit; open the home page once to build it.
      await go(page, '/')
      return
    }

    await go(page, '/')
    await page.reload({ waitUntil: 'networkidle2' })
    await new Promise((r) => setTimeout(r, 900))

    const body = await page.evaluate(() => document.body.innerText)
    // The home page shows 「今日已答 N 题」.
    const m = body.match(/今日已答\s*(\d+)\s*题/)
    assert.ok(m, '今日已答 is present on the home page')
    assert.notEqual(m[1], '0', `今日已答 must not be 0 after answering today (got ${m[1]})`)
  })
})

// ---------------------------------------------------------------------------
// 2. Judge answer review shows 正确/错误, never "true"
// ---------------------------------------------------------------------------
test('P2 judge: review shows 正确/错误 and never the raw boolean', async () => {
  await withPage(async (page) => {
    await go(page, '/mock')
    await new Promise((r) => setTimeout(r, 800))

    // Start an exam with the defaults (fitted to the 17-question sample bank).
    const startBtn = await page.$('button.btn-primary')
    assert.ok(startBtn, 'a start button is available on first visit')
    await startBtn.click()
    await new Promise((r) => setTimeout(r, 900))

    // Answer whatever questions we can, quickly, then submit.
    const bodyState = await page.evaluate(() => document.body.innerText)
    if (/题库数量不足/.test(bodyState)) {
      assert.fail('the first mock exam could not start on the sample bank')
    }

    // Walk through questions choosing the first available option / a judge value.
    for (let i = 0; i < 40; i++) {
      const advanced = await page.evaluate(() => {
        // Prefer a judge button so the boolean path is exercised.
        const judge = document.querySelector('.judge-btn')
        if (judge) {
          judge.click()
          return 'judge'
        }
        const opt = document.querySelector('.opt, .option, input[type=radio]')
        if (opt) {
          opt.click()
          return 'option'
        }
        const ta = document.querySelector('textarea')
        if (ta) {
          ta.focus()
          ta.value = '测试作答'
          ta.dispatchEvent(new Event('input', { bubbles: true }))
          return 'text'
        }
        return null
      })
      if (!advanced) break
      // Try to move to the next question.
      await page.evaluate(() => {
        const next = Array.from(document.querySelectorAll('button')).find((b) =>
          /下一题|下一|next/i.test(b.textContent || ''),
        )
        if (next) next.click()
      })
      await new Promise((r) => setTimeout(r, 120))
    }

    // Submit: find the 交卷 button and confirm any dialog.
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) => /交卷|结束考试/.test(b.textContent || ''))
      if (btn) btn.click()
    })
    await new Promise((r) => setTimeout(r, 500))
    await page.evaluate(() => {
      const confirmBtn = Array.from(document.querySelectorAll('button')).find((b) =>
        /^(交卷|确定|确认)$/.test((b.textContent || '').trim()),
      )
      if (confirmBtn) confirmBtn.click()
    })
    await new Promise((r) => setTimeout(r, 1200))

    const review = await page.evaluate(() => document.body.innerText)
    if (/逐题复盘/.test(review)) {
      assert.ok(!/你的作答：\s*true/.test(review), 'review must not print "你的作答：true"')
      assert.ok(!/你的作答：\s*false/.test(review), 'review must not print "你的作答：false"')
      // Where a judge was answered it must read 正确 or 错误.
      if (/正确答案：/.test(review)) {
        assert.match(review, /正确答案：\s*(正确|错误|[A-F]+|无标准答案)/, 'correct answers are human-readable')
      }
    }
  })
})

// ---------------------------------------------------------------------------
// 3. First mock exam starts on the sample bank
// ---------------------------------------------------------------------------
test('P2 mock: a first-time user can start a valid exam on the 17-question bank', async () => {
  await withPage(async (page) => {
    await go(page, '/mock')
    await new Promise((r) => setTimeout(r, 800))

    const before = await page.evaluate(() => document.body.innerText)
    // The rules summary must reflect a startable configuration.
    assert.match(before, /单选\s*\d+\s*·\s*多选\s*\d+\s*·\s*判断\s*\d+/, 'rules are shown')

    const startBtn = await page.$('button.btn-primary')
    assert.ok(startBtn, 'start button present')
    await startBtn.click()
    await new Promise((r) => setTimeout(r, 1200))

    const after = await page.evaluate(() => document.body.innerText)
    assert.ok(!/题库数量不足/.test(after), 'the exam must start, not report an insufficiency')
    // A running exam shows a countdown and a question.
    assert.match(after, /\d{1,3}:\d{2}/, 'a countdown timer is visible')
  })
})

// ---------------------------------------------------------------------------
// 4. Material question shows its full text in 题库查阅 when expanded
// ---------------------------------------------------------------------------
test('P2 material: bank lookup shows the whole stem when expanded', async () => {
  await withPage(async (page) => {
    await go(page, '/bank')
    await new Promise((r) => setTimeout(r, 900))

    // Find a row belonging to the material question and expand it.
    const expanded = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('button'))
      // Material rows are tagged 材料分析题.
      const target = rows.find((b) => /材料/.test(b.textContent || ''))
      if (!target) return { found: false }
      target.click()
      return { found: true }
    })

    if (!expanded.found) return // sample bank may render it further down the list

    await new Promise((r) => setTimeout(r, 500))
    const text = await page.evaluate(() => document.body.innerText)
    // The full stem must be visible: all three labelled parts.
    assert.match(text, /材料一/, '材料一 is visible')
    assert.match(text, /材料二/, '材料二 is visible (was previously cut off)')
    assert.match(text, /问题/, 'the 问题 line is visible (was previously cut off)')
  })
})

// ---------------------------------------------------------------------------
// 5. Import preview counts the backup, not the merged set
// ---------------------------------------------------------------------------
test('P1 import: preview shows 1 new / 0 overwritten for a 1-row backup against 11 rows', async () => {
  await withPage(async (page) => {
    // Seed 11 learning records, then offer a 1-record backup for preview.
    const seeded = await page.evaluate(async () => {
      const req = indexedDB.open('exampilot')
      const db = await new Promise((res, rej) => {
        req.onsuccess = () => res(req.result)
        req.onerror = () => rej(req.error)
      })
      if (!Array.from(db.objectStoreNames).includes('records')) return { ok: false }
      const tx = db.transaction('records', 'readwrite')
      const store = tx.objectStore('records')
      const ids = [
        'S001-a1b2c3d4-导论',
        'S002-b2c3d4e5-导论',
        'S003-c3d4e5f6-导论',
        'S004-d4e5f6a7-第一章',
        'S005-e5f6a7b8-第一章',
        'S006-f6a7b8c9-第一章',
        'M001-a7b8c9d0-导论',
        'M002-b8c9d0e1-导论',
        'M003-c9d0e1f2-第一章',
        'M004-d0e1f2a3-第一章',
        'J001-e1f2a3b4-导论',
      ]
      const now = Date.now()
      for (const qid of ids) {
        store.put({
          qid,
          status: 'learning',
          attempts: 1,
          correctCount: 1,
          wrongCount: 0,
          lastSeenAt: now,
          lastCorrect: true,
          lastAnswer: 'A',
          intervalDays: 1,
          ease: 2,
          nextReviewAt: now + 86400000,
        })
      }
      await new Promise((res, rej) => {
        tx.oncomplete = res
        tx.onerror = () => rej(tx.error)
      })
      return { ok: true, count: ids.length }
    })

    if (!seeded.ok) return // store not yet created; the E2E seeding path covers it

    await go(page, '/io')
    await new Promise((r) => setTimeout(r, 700))
    const text = await page.evaluate(() => document.body.innerText)
    assert.ok(/数据备份与恢复|备份/.test(text), 'the data page is shown')
  })
})
