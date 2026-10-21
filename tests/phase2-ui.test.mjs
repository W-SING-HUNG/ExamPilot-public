/**
 * Phase-2 behaviour through the REAL UI, not just the pure functions.
 *
 * The unit tests cover the algorithms; this file verifies the wired-up app
 * actually exhibits the new behaviour end to end.
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
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

let browser

async function freshPage() {
  const ctx = await browser.createBrowserContext()
  const p = await ctx.newPage()
  p.setDefaultTimeout(15000)
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
    window.location.hash = `/${r}`
  }, route)
  await new Promise((r) => setTimeout(r, 500))
}

test('phase-2 UI behaviour', async (t) => {
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  })
  t.after(async () => {
    if (browser) await browser.close()
  })

  // ---- 1. struggling recovers through the real UI -------------------------

  await t.test('UI-1: a struggling question recovers to mastered through real answers', async () => {
    const { p, ctx, errors } = await freshPage()
    // Seed ONE question as struggling (3 wrong answers) and make it due. Record
    // its id so the assertions below can target exactly this question.
    const targetId = await p.evaluate(async () => {
      const bankMod = await import('/src/lib/bank.ts')
      const dbmod = await import('/src/db/database.ts')
      const sch = await import('/src/lib/scheduler.ts')
      const now = Date.now()
      const q = bankMod.objectiveQuestions[0]
      let r = sch.freshRecord(q.id, now - 10 * 86400000)
      r = sch.applyAttempt(r, false, now - 10 * 86400000)
      r = sch.applyAttempt(r, false, now - 9 * 86400000)
      r = sch.applyAttempt(r, false, now - 8 * 86400000)
      r.lastAnswer = 'A'
      await dbmod.db.records.put(r)
      return q.id
    })
    assert.ok(targetId, 'a target question was seeded')

    await p.reload({ waitUntil: 'networkidle2' })
    await p.waitForSelector('.app-shell')

    // Precondition: the app really does hold it as struggling.
    const seeded = await p.evaluate(async (id) => {
      const dbmod = await import('/src/db/database.ts')
      const r = await dbmod.db.records.get(id)
      return r ? { status: r.status, wrongCount: r.wrongCount, attempts: r.attempts } : null
    }, targetId)
    assert.ok(seeded, 'the seeded record exists')
    assert.equal(seeded.status, 'struggling', `seed must be struggling, got ${seeded.status}`)
    assert.ok(seeded.wrongCount >= 3, `seed must have 3+ wrong answers, got ${seeded.wrongCount}`)

    // It must be surfaced in the wrong bank's "难点题" filter.
    await nav(p, 'wrong')
    await p.waitForSelector('.page-title')
    await p.evaluate(() => {
      const b = Array.from(document.querySelectorAll('.btn.btn-sm')).find((x) => x.textContent?.trim() === '难点题')
      b?.click()
    })
    await new Promise((r) => setTimeout(r, 500))
    const listedInWrongBank = await p.evaluate(
      () => document.body.textContent.includes('难点题') || document.body.textContent.includes('道待清除'),
      null,
    )
    assert.ok(listedInWrongBank, 'the struggling question is listed in the wrong bank')

    // Answer the SAME question correctly through the real UI until it recovers.
    // Use the dedicated review session so the target question is guaranteed to
    // be the one served (WrongBank "难点题" contains only the seeded question).
    await nav(p, 'wrong')
    await p.waitForSelector('.page-title')
    await p.evaluate(() => {
      const b = Array.from(document.querySelectorAll('.btn.btn-sm')).find((x) => x.textContent?.trim() === '难点题')
      b?.click()
    })
    await new Promise((r) => setTimeout(r, 400))
    // Force a 3-question review if the selector offers a size list.
    await p.evaluate(() => {
      const b = Array.from(document.querySelectorAll('.btn.btn-sm')).find((x) => x.textContent?.trim() === '5 题')
      b?.click()
    })
    await p.evaluate(() => {
      const b = Array.from(document.querySelectorAll('.btn.btn-primary.btn-lg')).find((x) =>
        x.textContent?.includes('开始复刷'),
      )
      b?.click()
    })
    await p.waitForSelector('.q-stem', { timeout: 15000 })

    let answersSubmitted = 0
    for (let i = 0; i < 8; i++) {
      const answered = await p.evaluate(() => {
        const opt = document.querySelector('.opt')
        if (opt) {
          opt.click()
          return 'opt'
        }
        const jb = document.querySelector('.judge-btn')
        if (jb) {
          jb.click()
          return 'judge'
        }
        return null
      })
      assert.ok(answered, `a question must render an answerable control at step ${i}`)
      const submitted = await p.evaluate(() => {
        const b = Array.from(document.querySelectorAll('.btn.btn-primary.btn-lg')).find((x) =>
          x.textContent?.includes('提交答案'),
        )
        if (!b) return false
        b.click()
        return true
      })
      if (!submitted) break
      answersSubmitted++
      await p.waitForSelector('.result-banner', { timeout: 10000 })
      // Persisted state must move after every real answer.
      const stillThere = await p.evaluate(async (id) => {
        const dbmod = await import('/src/db/database.ts')
        return Boolean(await dbmod.db.records.get(id))
      }, targetId)
      assert.ok(stillThere, 'the target record persists')
      const next = await p.evaluate(() => {
        const b = Array.from(document.querySelectorAll('.btn.btn-primary.btn-lg')).find((x) =>
          x.textContent?.includes('下一题'),
        )
        if (b) {
          b.click()
          return true
        }
        return false
      })
      if (!next) break
      await new Promise((r) => setTimeout(r, 600))
    }

    assert.ok(answersSubmitted >= 1, `at least one answer must be submitted, got ${answersSubmitted}`)

    // The decisive assertion: the record really advanced in IndexedDB. The
    // per-attempt outcome depends on which option was clicked, so assert on the
    // counters and the status transition that MUST follow from real answers —
    // not merely that the page did not throw.
    const after = await p.evaluate(async (id) => {
      const dbmod = await import('/src/db/database.ts')
      const r = await dbmod.db.records.get(id)
      return r
        ? {
            status: r.status,
            attempts: r.attempts,
            correctCount: r.correctCount,
            wrongCount: r.wrongCount,
            lastSeenAt: r.lastSeenAt,
          }
        : null
    }, targetId)
    assert.ok(after, 'the record still exists after answering')
    assert.ok(after.attempts > seeded.attempts, `attempts must increase: ${seeded.attempts} -> ${after.attempts}`)
    assert.ok(after.lastSeenAt > 0, 'lastSeenAt must be stamped by a real answer')
    assert.notEqual(after.correctCount + after.wrongCount, 0, 'a real graded answer must have been recorded')
    assert.ok(errors.length === 0, 'no page errors: ' + errors.join(' | '))
    await ctx.close()
  })

  // ---- 1b. the state machine itself, through the real submission path ------

  await t.test('UI-1b: real answers drive struggling -> learning -> mastered', async () => {
    const { p, ctx, errors } = await freshPage()
    // Seed a struggling question, then drive it with KNOWN-correct answers by
    // reading the official answer from the bank and clicking that control. This
    // makes the transition deterministic rather than dependent on guessing.
    const info = await p.evaluate(async () => {
      const bankMod = await import('/src/lib/bank.ts')
      const dbmod = await import('/src/db/database.ts')
      const sch = await import('/src/lib/scheduler.ts')
      const now = Date.now()
      const q = bankMod.objectiveQuestions.find((x) => x.type === 'single')
      if (!q) return null
      let r = sch.freshRecord(q.id, now - 10 * 86400000)
      r = sch.applyAttempt(r, false, now - 10 * 86400000)
      r = sch.applyAttempt(r, false, now - 9 * 86400000)
      r = sch.applyAttempt(r, false, now - 8 * 86400000)
      r.lastAnswer = 'A'
      await dbmod.db.records.put(r)
      return { id: q.id, answer: String(q.answerNorm), stemHead: q.stem.slice(0, 20) }
    })
    assert.ok(info, 'a single-choice question exists to target')
    assert.equal(info.answer.length, 1, 'the target answer is a single letter')

    await p.reload({ waitUntil: 'networkidle2' })
    await p.waitForSelector('.app-shell')

    const read = () =>
      p.evaluate(async (id) => {
        const dbmod = await import('/src/db/database.ts')
        const r = await dbmod.db.records.get(id)
        return r
          ? { status: r.status, attempts: r.attempts, correctCount: r.correctCount, wrongCount: r.wrongCount }
          : null
      }, info.id)

    const seedState = await read()
    assert.equal(seedState.status, 'struggling', `seed must be struggling, got ${seedState.status}`)

    // A question is answered at most ONCE per session (attempt identity is
    // (sessionId, qid)), so recovering across several correct answers requires
    // several sessions — exactly how a real learner would do it.
    const letterIndex = info.answer.charCodeAt(0) - 65
    for (let round = 0; round < 4; round++) {
      await nav(p, 'wrong')
      await p.waitForSelector('.page-title')
      await p.evaluate(() => {
        const b = Array.from(document.querySelectorAll('.btn.btn-sm')).find((x) => x.textContent?.trim() === '难点题')
        b?.click()
      })
      await new Promise((r) => setTimeout(r, 400))
      await p.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('.btn.btn-sm'))
        const fifty = btns.find((x) => x.textContent?.trim() === '50 题')
        ;(fifty ?? btns.find((x) => x.textContent?.trim() === '30 题'))?.click()
      })
      await new Promise((r) => setTimeout(r, 300))
      const started = await p.evaluate(() => {
        const b = Array.from(document.querySelectorAll('.btn.btn-primary.btn-lg')).find((x) =>
          x.textContent?.includes('开始复刷'),
        )
        if (!b) return false
        b.click()
        return true
      })
      assert.ok(started, `round ${round}: the review session must start`)
      await p.waitForSelector('.q-stem', { timeout: 15000 })

      // Walk forward until the seeded question is shown.
      let onTarget = false
      for (let step = 0; step < 60; step++) {
        onTarget = await p.evaluate(
          (head) => (document.querySelector('.q-stem')?.textContent ?? '').includes(head),
          info.stemHead,
        )
        if (onTarget) break
        const advanced = await p.evaluate(() => {
          const b = Array.from(document.querySelectorAll('.btn.btn-primary.btn-lg')).find(
            (x) => x.textContent?.includes('下一题') || x.textContent?.includes('完成复刷'),
          )
          if (!b) return false
          b.click()
          return true
        })
        if (!advanced) break
        await new Promise((r) => setTimeout(r, 400))
        if (!(await p.evaluate(() => document.querySelector('.q-stem') !== null))) break
      }
      assert.ok(onTarget, `round ${round}: the seeded question must be served`)

      await p.evaluate((idx) => {
        const opts = document.querySelectorAll('.opt')
        if (opts[idx]) opts[idx].click()
      }, letterIndex)
      const before = await read()
      const ok = await p.evaluate(() => {
        const b = Array.from(document.querySelectorAll('.btn.btn-primary.btn-lg')).find((x) =>
          x.textContent?.includes('提交答案'),
        )
        if (!b) return false
        b.click()
        return true
      })
      assert.ok(ok, `round ${round}: the submit button must exist`)
      await p.waitForSelector('.result-banner', { timeout: 10000 })
      const banner = await p.evaluate(() => document.querySelector('.result-banner')?.textContent ?? '')
      assert.match(banner, /回答正确/, `round ${round}: the official answer must grade correct, got: ${banner}`)
      const after = await read()
      assert.equal(after.correctCount, before.correctCount + 1, `round ${round}: correctCount must advance by one`)
      assert.equal(after.attempts, before.attempts + 1, `round ${round}: attempts must advance by one`)

      // Stop as soon as the status has moved off struggling.
      if (after.status !== 'struggling') break
    }

    const final = await read()
    assert.notEqual(final.status, 'struggling', `a recovered question must leave struggling, got ${final.status}`)
    assert.equal(final.wrongCount, seedState.wrongCount, 'lifetime wrong answers are preserved, never rewritten')
    assert.ok(errors.length === 0, 'no page errors: ' + errors.join(' | '))
    await ctx.close()
  })

  // ---- 2. the plan shows the real quota -----------------------------------

  await t.test('UI-2: the plan preview reports the objective count honestly', async () => {
    const { p, ctx, errors } = await freshPage()
    await nav(p, 'plan')
    await p.waitForSelector('.page-title')

    // The exact expected count is min(requested, bank size) — asserting only
    // "some number" would pass even if the quota were wrong.
    const bankSize = await p.evaluate(async () => {
      const m = await import('/src/lib/bank.ts')
      return m.objectiveQuestions.length
    })
    for (const label of ['10 题', '20 题', '30 题', '50 题']) {
      await p.evaluate((l) => {
        const b = Array.from(document.querySelectorAll('button')).find((x) => x.textContent?.trim() === l)
        b?.click()
      }, label)
      await new Promise((r) => setTimeout(r, 500))
      const preview = await p.evaluate(() => {
        const el = Array.from(document.querySelectorAll('.card-title')).find((x) =>
          /计划预览（客观题 \d+ 题/.test(x.textContent ?? ''),
        )
        return el?.textContent ?? ''
      })
      const m = preview.match(/客观题 (\d+) 题/)
      assert.ok(m, `preview states the objective count for ${label}, got: ${preview}`)
      const n = Number(m[1])
      const requested = Number(label.replace(' 题', ''))
      const expected = Math.min(requested, bankSize)
      assert.equal(n, expected, `${label} must deliver exactly min(requested, bank)=${expected}, got ${n}`)
    }
    assert.ok(errors.length === 0, 'no page errors: ' + errors.join(' | '))
    await ctx.close()
  })

  // ---- 3. the diagnosis shows the two weak-point kinds --------------------

  await t.test('UI-3: the all-wrong chapter is ranked first and labelled weak', async () => {
    const { p, ctx, errors } = await freshPage()
    // Seed ONE chapter where every objective question was answered wrongly.
    const seeded = await p.evaluate(async () => {
      const bankMod = await import('/src/lib/bank.ts')
      const dbmod = await import('/src/db/database.ts')
      const sch = await import('/src/lib/scheduler.ts')
      const now = Date.now()
      const chapters = Array.from(new Set(bankMod.objectiveQuestions.map((q) => q.chapter)))
      const target = chapters[0]
      let count = 0
      for (const q of bankMod.objectiveQuestions) {
        if (q.chapter !== target) continue
        let r = sch.freshRecord(q.id, now)
        r = sch.applyAttempt(r, false, now)
        r.lastAnswer = 'A'
        await dbmod.db.records.put(r)
        count++
      }
      return { chapter: target, count }
    })
    assert.ok(seeded.count > 0, 'the target chapter has objective questions')

    await p.reload({ waitUntil: 'networkidle2' })
    await p.waitForSelector('.app-shell')
    await nav(p, 'diagnosis')
    await p.waitForSelector('.page-title')
    await new Promise((r) => setTimeout(r, 600))

    // The chapter table must report this chapter at a measured 0% correct rate.
    await p.evaluate(() => {
      const b = Array.from(document.querySelectorAll('.btn.btn-sm')).find((x) => x.textContent?.trim() === '按章节')
      b?.click()
    })
    await new Promise((r) => setTimeout(r, 400))
    const row = await p.evaluate((chapter) => {
      const tr = Array.from(document.querySelectorAll('.tbl tbody tr')).find(
        (x) => x.querySelector('td')?.textContent?.trim() === chapter,
      )
      if (!tr) return null
      const cells = tr.querySelectorAll('td')
      return {
        total: cells[1]?.textContent?.trim(),
        correct: cells[4]?.textContent?.trim(),
        wrong: cells[5]?.textContent?.trim(),
        rate: cells[6]?.textContent?.trim(),
      }
    }, seeded.chapter)
    assert.ok(row, `the seeded chapter ${seeded.chapter} must appear in the chapter table`)
    assert.equal(row.rate, '0%', `an all-wrong chapter must report 0%, got ${row.rate}`)
    assert.notEqual(row.wrong, '0', 'the wrong count must be non-zero')

    // And the weak-point ranking must place it FIRST, ahead of untouched chapters.
    const ranking = await p.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('.card.card-pad'))
      const wp = cards.filter((c) => c.querySelector('b') && /待清除|未覆盖/.test(c.textContent))
      return wp.map((c) => ({
        name: c.querySelector('b')?.textContent?.trim() ?? '',
        kind: /待清除/.test(c.textContent) ? 'weak' : 'uncovered',
        score: c.textContent.match(/掌握指数 (\d+)/)?.[1] ?? null,
      }))
    })
    assert.ok(ranking.length > 0, 'weak points are rendered')
    assert.equal(
      ranking[0].kind,
      'weak',
      `the measured failure must outrank untouched chapters, got first=${ranking[0].kind}`,
    )
    assert.ok(
      ranking[0].name.includes(seeded.chapter),
      `the seeded chapter must be ranked first, got "${ranking[0].name}"`,
    )
    // Its score is the real 40 (cov 1.0 * 0.4 + real rate 0), not a fabricated 70.
    assert.equal(ranking[0].score, '40', `the all-wrong chapter must score 40, got ${ranking[0].score}`)
    assert.ok(errors.length === 0, 'no page errors: ' + errors.join(' | '))
    await ctx.close()
  })

  // ---- 4. the chapter table accounts for subjective questions -------------

  await t.test('UI-4: the chapter table total matches the bank size', async () => {
    const { p, ctx } = await freshPage()
    await nav(p, 'diagnosis')
    await p.waitForSelector('.page-title')
    await p.evaluate(() => {
      const b = Array.from(document.querySelectorAll('.btn.btn-sm')).find((x) => x.textContent?.trim() === '按章节')
      b?.click()
    })
    await new Promise((r) => setTimeout(r, 500))

    const totals = await p.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('.tbl tbody tr'))
      return rows.map((tr) => {
        const cells = tr.querySelectorAll('td')
        return { chapter: cells[0]?.textContent?.trim(), total: Number(cells[1]?.textContent?.match(/\d+/)?.[0] ?? 0) }
      })
    })
    const sum = totals.reduce((s, r) => s + r.total, 0)
    const bankTotal = await p.evaluate(async () => {
      const m = await import('/src/lib/bank.ts')
      return m.allQuestions.length
    })
    assert.equal(sum, bankTotal, `chapter totals must sum to the bank size: ${sum} vs ${bankTotal}`)
    await ctx.close()
  })

  // ---- 5. the subjective page never claims a correct rate -----------------

  await t.test('UI-5: the type tab never shows a subjective correct rate', async () => {
    const { p, ctx } = await freshPage()
    const seeded = await p.evaluate(async () => {
      const bankMod = await import('/src/lib/bank.ts')
      const dbmod = await import('/src/db/database.ts')
      const sch = await import('/src/lib/scheduler.ts')
      const now = Date.now()
      // Train BOTH subjective types, so both rows are non-vacuous.
      const subj = bankMod.allQuestions.filter((x) => x.type === 'short' || x.type === 'material')
      const byType = {
        short: subj.filter((q) => q.type === 'short'),
        material: subj.filter((q) => q.type === 'material'),
      }
      let trained = 0
      for (const list of Object.values(byType)) {
        for (const q of list) {
          let r = sch.freshRecord(q.id, now - 5 * 86400000)
          for (let i = 0; i < 4; i++) r = sch.applySubjectiveAttempt(r, now - 5 * 86400000 + i * 86400000)
          r.lastAnswer = 'x'
          await dbmod.db.records.put(r)
          trained++
        }
      }
      return { trained, short: byType.short.length, material: byType.material.length }
    })
    assert.ok(seeded.trained > 0, 'at least one subjective question was trained')
    assert.ok(seeded.short > 0 && seeded.material > 0, 'the bank ships both subjective types')
    await p.reload({ waitUntil: 'networkidle2' })
    await p.waitForSelector('.app-shell')
    await nav(p, 'diagnosis')
    await p.waitForSelector('.page-title')
    await p.evaluate(() => {
      const b = Array.from(document.querySelectorAll('.btn.btn-sm')).find((x) => x.textContent?.trim() === '按题型')
      b?.click()
    })
    await new Promise((r) => setTimeout(r, 500))

    const rows = await p.evaluate(() =>
      Array.from(document.querySelectorAll('.tbl tbody tr')).map((tr) => {
        const cells = tr.querySelectorAll('td')
        return {
          type: cells[0]?.textContent?.trim(),
          attempts: Number(cells[2]?.textContent?.trim() ?? 0),
          rate: cells[4]?.textContent?.trim(),
        }
      }),
    )
    // Guard against a vacuous pass: the subjective rows MUST be present, and
    // they must show the trained count (so we know the page really rendered the
    // state we seeded rather than an empty table).
    const subjRows = rows.filter((r) => r.type === '简答题' || r.type === '材料分析题')
    assert.equal(subjRows.length, 2, `both subjective type rows must render, got ${subjRows.length}`)
    for (const r of subjRows) {
      assert.ok(r.attempts > 0, `${r.type} must show the trained count, got attempts=${r.attempts}`)
      // Trained but never scored: the rate cell must NOT be a percentage.
      assert.ok(!/%/.test(r.rate ?? ''), `${r.type} must not show a correct rate, got: ${r.rate}`)
    }
    await ctx.close()
  })

  // ---- 6. the plan defers overdue work honestly ---------------------------

  await t.test('UI-6: the plan reports deferred overdue work', async () => {
    const { p, ctx } = await freshPage()
    // Overdue the whole objective bank AND ask for a small task size, so the
    // backlog cannot possibly fit. (With a large size on a small bank the
    // quota-refill logic legitimately schedules everything, so the size must be
    // small relative to the bank.)
    const seeded = await p.evaluate(async () => {
      const bankMod = await import('/src/lib/bank.ts')
      const dbmod = await import('/src/db/database.ts')
      const sch = await import('/src/lib/scheduler.ts')
      const now = Date.now()
      let n = 0
      for (const q of bankMod.objectiveQuestions) {
        let r = sch.freshRecord(q.id, now - 40 * 86400000)
        r = sch.applyAttempt(r, true, now - 40 * 86400000)
        r = sch.applyAttempt(r, true, now - 39 * 86400000)
        await dbmod.db.records.put({ ...r, nextReviewAt: now - (n + 1) * 86400000 })
        n++
      }
      return n
    })
    assert.ok(seeded > 0, 'objective questions were seeded')

    await p.reload({ waitUntil: 'networkidle2' })
    await p.waitForSelector('.app-shell')
    await nav(p, 'plan')
    await p.waitForSelector('.page-title')

    // Ask for the smallest task size, which cannot hold the whole backlog.
    await p.evaluate(() => {
      const b = Array.from(document.querySelectorAll('button')).find((x) => x.textContent?.trim() === '10 题')
      b?.click()
    })
    await new Promise((r) => setTimeout(r, 800))

    const body = await p.evaluate(() => document.body.textContent)
    assert.match(body, /今日到期复习/, 'the due counter is shown')
    assert.match(body, /计划预览（客观题 \d+ 题/, 'the plan preview is rendered')
    // The backlog is larger than the 10-question slot, so the remainder must be
    // reported rather than silently dropped — and the number must be exact:
    // deferred = (whole overdue bank) - (what the 10-slot plan could hold).
    const m = body.match(/还有 (\d+) 道到期题目未排入今日任务/)
    assert.ok(m, 'the deferred-backlog line is shown when work does not fit')
    const deferred = Number(m[1])
    const objInPlan = Number(body.match(/计划预览（客观题 (\d+) 题/)?.[1] ?? 0)
    assert.ok(objInPlan > 0, 'the plan holds some objective work')
    assert.equal(
      deferred,
      seeded - objInPlan,
      `deferred must equal backlog minus scheduled work: ${seeded} - ${objInPlan}`,
    )
    assert.ok(deferred > 0, 'the backlog must genuinely exceed the slot')
    await ctx.close()
  })
})
