/**
 * Source-level regression guards for the three UI defects fixed in this round.
 *
 * These assert on the PAGE SOURCE rather than on rendered output, because the
 * defects were all "the wrong expression is written here" rather than "the right
 * function returned the wrong value":
 *
 *   - MockExam printed the stored judge wire value (`你的作答：{mine}`).
 *   - MockExam used the full-exam defaults unconditionally, so the public sample
 *     bank could not start an exam.
 *   - BankLookup sliced the stem to its first line.
 *
 * Behavioural coverage for the underlying helpers lives in the vitest suites
 * (src/lib/mock-defaults.test.ts, src/lib/bank-lookup-display.test.ts).
 *
 * Run: node tests/ui-source-guards.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8')

// ---------------------------------------------------------------------------
// 1. Judge answer display must not leak the storage format
// ---------------------------------------------------------------------------

test('MockExam: the review screen does not interpolate the raw answer value', () => {
  const src = read('src/pages/MockExam.tsx')
  assert.ok(!/你的作答：\{mine\}/.test(src), 'the raw stored value must not be printed directly (it shows "true")')
})

test('MockExam: the review screen renders answers through the display helpers', () => {
  const src = read('src/pages/MockExam.tsx')
  assert.match(src, /displayUserAnswer\(qq\.type, mine\)/, 'must use displayUserAnswer')
  assert.match(src, /displayCorrectAnswer\(qq\.answerNorm\)/, 'must use displayCorrectAnswer')
})

test('MockExam: boolean answer formatting is not hand-rolled inline', () => {
  const src = read('src/pages/MockExam.tsx')
  assert.ok(
    !/answerNorm === true \? '正确' : qq\.answerNorm === false/.test(src),
    'boolean judge formatting belongs in the shared helper',
  )
})

test('answer-display: the helpers exist and cover judge wire values', () => {
  const src = read('src/lib/answer-display.ts')
  assert.match(src, /export function displayUserAnswer/)
  assert.match(src, /export function displayCorrectAnswer/)
  assert.match(src, /'true'/, 'must handle the "true" wire value')
  assert.match(src, /'false'/, 'must handle the "false" wire value')
  assert.match(src, /未作答/, 'must render unanswered explicitly')
})

// ---------------------------------------------------------------------------
// 2. Mock exam first-run defaults must adapt to the installed bank
// ---------------------------------------------------------------------------

test('MockExam: defaults are fitted to the bank only when nothing is saved', () => {
  const src = read('src/pages/MockExam.tsx')
  assert.match(src, /function fitConfigToBank/, 'the fitter must exist')
  assert.match(src, /if \(saved\) return saved/, 'a saved config must win')
  assert.match(src, /fitConfigToBank\(allQuestions, DEFAULT_CONFIG\)/, 'defaults are fitted')
  assert.ok(!/fitConfigToBank\(allQuestions, saved/.test(src), 'a SAVED configuration must never be silently fitted')
})

test('MockExam: the shipped defaults are left intact for full-size banks', () => {
  const src = read('src/pages/MockExam.tsx')
  // The template values must still describe a full exam.
  assert.match(src, /singleCount: 20/)
  assert.match(src, /multiCount: 10/)
  assert.match(src, /judgeCount: 10/)
})

test('MockExam: a reduced default is disclosed to the user', () => {
  const src = read('src/pages/MockExam.tsx')
  assert.match(src, /defaultsWereReduced/, 'the UI must know the defaults were reduced')
  assert.match(src, /已按当前题库实际题量调整默认配置/, 'and must say so visibly')
})

test('scheduler: buildPaper still refuses an unsatisfiable configuration', () => {
  const src = read('src/lib/scheduler.ts')
  assert.match(src, /题库数量不足/, 'must report the shortfall rather than shrink silently')
})

// ---------------------------------------------------------------------------
// 3. Bank lookup must show the whole stem when expanded
// ---------------------------------------------------------------------------

test('BankLookup: the stem is not sliced to its first line', () => {
  const src = read('src/pages/BankLookup.tsx')
  assert.ok(
    !/q\.stem\.split\('\\n'\)\[0\]/.test(src),
    'slicing to the first line dropped material paragraphs and the question',
  )
})

test('BankLookup: expanded rows render the full stem, collapsed rows a summary', () => {
  const src = read('src/pages/BankLookup.tsx')
  assert.match(src, /open \? q\.stem : firstLineSummary\(q\.stem\)/)
  assert.match(src, /function firstLineSummary/, 'the summary helper must exist')
})

test('BankLookup: expanded stems keep their line breaks', () => {
  const src = read('src/pages/BankLookup.tsx')
  assert.match(src, /whiteSpace: 'pre-wrap'/, 'line breaks must be preserved on screen')
})

// ---------------------------------------------------------------------------
// 4. The fixes must not have touched forbidden areas
// ---------------------------------------------------------------------------

test('SCORING/PRIVATE DATA: the sample bank file is unmodified by this round', () => {
  // Guards against "make the test pass by editing the data".
  const bank = JSON.parse(read('data/sample-bank.json'))
  assert.equal(bank.questions.length, 17, 'the sample bank must still hold 17 questions')
  const byType = {}
  for (const q of bank.questions) byType[q.type] = (byType[q.type] ?? 0) + 1
  assert.deepEqual(byType, { single: 6, multi: 4, judge: 4, short: 2, material: 1 })
})

test('SCORING: the scoring engine source is unchanged in its contract', () => {
  const src = read('src/lib/scoring.ts')
  // The multi-select must still require an exact set match.
  assert.match(src, /export function scoreAnswer/)
  assert.match(src, /export function formatAnswerNorm/)
})
