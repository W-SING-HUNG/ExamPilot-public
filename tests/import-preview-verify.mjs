/**
 * Focused browser check for the import preview numbers.
 *
 * Defect reported: 11 existing records + a backup containing 1 new record was
 * previewed as backup 12 / overwrite 11 instead of backup 1 / new 1 / overwrite 0
 * / after-restore 12.
 *
 * Approach: seed 11 records, capture a REAL export payload from the app (so the
 * schema and bank fingerprint are authentic), trim it to exactly one NEW record,
 * upload it, and read the preview table the user sees.
 *
 * Run: node tests/import-preview-verify.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import puppeteer from 'puppeteer-core'

const BASE = process.env.E2E_BASE || 'http://localhost:5173'
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const DB = 'exampilot-xigai'

const ELEVEN = [
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

test('import preview: 1-row backup against 11 existing', async (t) => {
  // This test seeds PUBLIC SAMPLE question ids, so it is only meaningful when the
  // sample bank is installed. Detect that from the app rather than assuming: on a
  // private bank those ids are absent, the backup is correctly rejected as
  // unverifiable, and the cross-bank guard is what should be observed — that path
  // is covered by io.test.ts. Skipping keeps the signal honest instead of turning
  // a correct rejection into a red failure.
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1400, height: 1000 })
    await page.goto(`${BASE}/#/`, { waitUntil: 'networkidle2' })
    await page.evaluate(() => localStorage.clear())
    await page.goto(`${BASE}/#/`, { waitUntil: 'networkidle2' })
    await new Promise((r) => setTimeout(r, 1500))

    const seed = await page.evaluate(
      async ({ ids, dbName }) => {
        const req = indexedDB.open(dbName)
        const db = await new Promise((res, rej) => {
          req.onsuccess = () => res(req.result)
          req.onerror = () => rej(req.error)
        })
        const names = Array.from(db.objectStoreNames)
        if (!names.includes('records')) return { ok: false, names }
        const now = Date.now()
        const tx = db.transaction('records', 'readwrite')
        const store = tx.objectStore('records')
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
      },
      { ids: ELEVEN, dbName: DB },
    )
    assert.ok(seed.ok, 'records store exists')

    await page.goto(`${BASE}/#/io`, { waitUntil: 'networkidle2' })
    await page.reload({ waitUntil: 'networkidle2' })
    await new Promise((r) => setTimeout(r, 1300))

    const realPayload = await page.evaluate(async () => {
      return await new Promise((resolve) => {
        const origCreate = URL.createObjectURL
        let settled = false
        URL.createObjectURL = function (blob) {
          blob.text().then((t) => {
            if (!settled) {
              settled = true
              URL.createObjectURL = origCreate
              resolve(t)
            }
          })
          return origCreate.call(URL, blob)
        }
        const btn = Array.from(document.querySelectorAll('button')).find((b) =>
          /导出学习数据|导出备份/.test(b.textContent || ''),
        )
        if (!btn) {
          URL.createObjectURL = origCreate
          resolve(null)
          return
        }
        btn.click()
        setTimeout(() => {
          if (!settled) {
            settled = true
            URL.createObjectURL = origCreate
            resolve(null)
          }
        }, 4000)
      })
    })

    assert.ok(realPayload, 'the app produced an export payload')
    const exported = JSON.parse(realPayload)
    assert.equal(exported.records.length, 11, 'the exported backup holds the 11 records')

    // The export carries the installed bank size, which is the reliable signal.
    // This test seeds PUBLIC SAMPLE ids, so it only applies to the sample bank;
    // on a private bank those ids are (correctly) rejected as unverifiable and the
    // cross-bank guard is what should be observed — covered by io.test.ts.
    if (exported.bankCount !== 17) {
      return t.skip(`requires the 17-question public sample bank (installed bank has ${exported.bankCount})`)
    }
    assert.ok(exported.bankFingerprint, 'the export carries a real bank fingerprint')

    const now = Date.now()
    const trimmed = {
      ...exported,
      records: [
        {
          qid: 'J002-f2a3b4c5-导论',
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
        },
      ],
      history: [],
      mocks: [],
      aiReviews: [],
    }

    const dir = mkdtempSync(path.join(tmpdir(), 'exampilot-preview-'))
    const file = path.join(dir, 'backup-1row.json')
    writeFileSync(file, JSON.stringify(trimmed), 'utf8')

    const input = await page.$('input[type=file]')
    assert.ok(input, 'the page has a file input')
    await input.uploadFile(file)
    await new Promise((r) => setTimeout(r, 2200))

    const state = await page.evaluate(() => {
      const tables = Array.from(document.querySelectorAll('table'))
      for (const t of tables) {
        const head = (t.querySelector('thead')?.innerText || '').replace(/\s+/g, ' ')
        if (/备份中/.test(head)) {
          const rows = Array.from(t.querySelectorAll('tbody tr')).map((tr) =>
            Array.from(tr.querySelectorAll('td')).map((td) => (td.innerText || '').trim()),
          )
          return { found: true, head, rows }
        }
      }
      return { found: false, body: document.body.innerText.slice(0, 1800) }
    })

    if (!state.found) {
      console.log('--- page text when the preview did not render ---')
      console.log(state.body)
    }
    assert.ok(state.found, 'the preview table is rendered')

    console.log('preview header:', state.head)
    for (const r of state.rows) console.log('  row:', JSON.stringify(r))

    const recRow = state.rows.find((r) => r[0] === '学习记录')
    assert.ok(recRow, 'a records row exists')

    const [, backupCount, verifiable, existing, added, updated, total] = recRow
    assert.equal(backupCount, '1', 'backup count must be 1')
    assert.equal(verifiable, '1', 'verifiable count must be 1')
    assert.equal(existing, '11', 'existing count must be 11')
    assert.equal(added, '1', 'added must be 1')
    assert.equal(updated, '0', 'overwritten must be 0')
    assert.equal(total, '12', 'after restore must be 12')
  } finally {
    await browser.close()
  }
})
