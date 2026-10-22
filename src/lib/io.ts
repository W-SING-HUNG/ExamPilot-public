import type { QRecord, HistoryEntry, MockRun, AiReview, BankData, AppSettings, Question } from './types'
import { APP_VERSION } from './meta'

export interface ExportPayload {
  schema: string
  exportedAt: number
  appVersion: string
  /** SHA-256 over the full bank identity and every question's answer binding. */
  bankFingerprint: string
  bankCount: number
  settings: unknown
  records: QRecord[]
  history: HistoryEntry[]
  mocks: MockRun[]
  aiReviews: AiReview[]
}

/**
 * Restore strategy.
 *
 * `replace` — the backup becomes the whole dataset.
 *   - records / history / mocks / aiReviews: cleared, then written from the backup.
 *   - settings: cleared, then written ONLY if the backup carries a valid settings
 *     object. A backup without settings leaves settings empty (factory defaults).
 *
 * `merge` — the backup is unioned into the existing dataset.
 *   - records: keyed by qid, backup wins on conflict.
 *   - history / mocks / aiReviews: keyed by id, backup wins on conflict.
 *   - settings: backup wins only if present and valid; otherwise existing kept.
 */
export type RestoreMode = 'replace' | 'merge'

// ---------------------------------------------------------------------------
// SHA-256 (pure JS, synchronous, no dependency)
// ---------------------------------------------------------------------------

const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
  0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
  0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
]

function rotr(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0
}

function utf8Bytes(s: string): number[] {
  const out: number[] = []
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i)
    if (c < 0x80) out.push(c)
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63))
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const c2 = s.charCodeAt(i + 1)
      if (c2 >= 0xdc00 && c2 <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00)
        i++
        out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
      } else {
        out.push(0xef, 0xbf, 0xbd)
      }
    } else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
  }
  return out
}

/** Synchronous SHA-256, returns lowercase hex. */
export function sha256(input: string): string {
  const bytes = utf8Bytes(input)
  const bitLen = bytes.length * 8
  bytes.push(0x80)
  while (bytes.length % 64 !== 56) bytes.push(0)
  const hi = Math.floor(bitLen / 0x100000000)
  const lo = bitLen >>> 0
  bytes.push((hi >>> 24) & 255, (hi >>> 16) & 255, (hi >>> 8) & 255, hi & 255)
  bytes.push((lo >>> 24) & 255, (lo >>> 16) & 255, (lo >>> 8) & 255, lo & 255)

  let h0 = 0x6a09e667
  let h1 = 0xbb67ae85
  let h2 = 0x3c6ef372
  let h3 = 0xa54ff53a
  let h4 = 0x510e527f
  let h5 = 0x9b05688c
  let h6 = 0x1f83d9ab
  let h7 = 0x5be0cd19

  const w = new Array<number>(64)
  for (let off = 0; off < bytes.length; off += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] =
        ((bytes[off + i * 4] << 24) |
          (bytes[off + i * 4 + 1] << 16) |
          (bytes[off + i * 4 + 2] << 8) |
          bytes[off + i * 4 + 3]) >>>
        0
    }
    for (let i = 16; i < 64; i++) {
      const s0 = (rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)) >>> 0
      const s1 = (rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)) >>> 0
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0
    }
    let a = h0
    let b = h1
    let c = h2
    let d = h3
    let e = h4
    let f = h5
    let g = h6
    let h = h7
    for (let i = 0; i < 64; i++) {
      const S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0
      const ch = ((e & f) ^ (~e & g)) >>> 0
      const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0
      const S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0
      const t2 = (S0 + maj) >>> 0
      h = g
      g = f
      f = e
      e = (d + t1) >>> 0
      d = c
      c = b
      b = a
      a = (t1 + t2) >>> 0
    }
    h0 = (h0 + a) >>> 0
    h1 = (h1 + b) >>> 0
    h2 = (h2 + c) >>> 0
    h3 = (h3 + d) >>> 0
    h4 = (h4 + e) >>> 0
    h5 = (h5 + f) >>> 0
    h6 = (h6 + g) >>> 0
    h7 = (h7 + h) >>> 0
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7].map((x) => x.toString(16).padStart(8, '0')).join('')
}

// ---------------------------------------------------------------------------
// Bank fingerprint
// ---------------------------------------------------------------------------

/**
 * Canonical per-question descriptor used for the fingerprint. Includes the id,
 * type, chapter, stem, every option and the normalized answer — so changing an
 * answer for the same id, adding options, or editing the tail of the bank all
 * change the fingerprint.
 */
function questionDescriptor(q: Question): string {
  return [
    q.id,
    q.type,
    q.chapter,
    q.stem,
    q.options.join('\u001f'),
    String(q.answerNorm),
    q.hasOfficialAnswer ? '1' : '0',
  ].join('\u001e')
}

/**
 * Stable SHA-256 fingerprint of a bank covering the full bank identity and every
 * question–option–answer binding. A change anywhere — including the last
 * question, or an answer swap that keeps the same id — changes the fingerprint.
 */
export function bankFingerprint(bank: BankData): string {
  const parts = [bank.schema, String(bank.questions.length), ...bank.questions.map(questionDescriptor)]
  return sha256(parts.join('\u001d'))
}

export function makeExportPayload(input: {
  settings: unknown
  records: QRecord[]
  history: HistoryEntry[]
  mocks: MockRun[]
  aiReviews: AiReview[]
  bankFingerprint: string
  bankCount: number
}): ExportPayload {
  return {
    schema: 'exampilot.export.v1',
    exportedAt: Date.now(),
    appVersion: APP_VERSION,
    settings: input.settings,
    records: input.records,
    history: input.history,
    mocks: input.mocks,
    aiReviews: input.aiReviews,
    bankFingerprint: input.bankFingerprint,
    bankCount: input.bankCount,
  }
}

export function serialize(payload: ExportPayload): string {
  return JSON.stringify(payload, null, 2)
}

// ---------------------------------------------------------------------------
// Strict field validation
// ---------------------------------------------------------------------------

export type ValidationIssue = { path: string; message: string }

const isStr = (v: unknown): v is string => typeof v === 'string'
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isBool = (v: unknown): v is boolean => typeof v === 'boolean'
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

const RECORD_STATUS = new Set(['new', 'learning', 'mastered', 'struggling'])
const THEMES = new Set(['light', 'dark', 'auto'])

function validateRecord(r: unknown, path: string, issues: ValidationIssue[]): boolean {
  if (!isObj(r)) {
    issues.push({ path, message: '不是对象' })
    return false
  }
  let ok = true
  const req = (cond: boolean, msg: string) => {
    if (!cond) {
      issues.push({ path, message: msg })
      ok = false
    }
  }
  req(isStr(r.qid) && (r.qid as string).length > 0, 'qid 必须是非空字符串')
  req(isStr(r.status) && RECORD_STATUS.has(r.status as string), `status 非法：${String(r.status)}`)
  req(isNum(r.attempts) && (r.attempts as number) >= 0, 'attempts 必须是非负数字')
  req(isNum(r.correctCount) && (r.correctCount as number) >= 0, 'correctCount 必须是非负数字')
  req(isNum(r.wrongCount) && (r.wrongCount as number) >= 0, 'wrongCount 必须是非负数字')
  req(isNum(r.lastSeenAt), 'lastSeenAt 必须是数字')
  req(isNum(r.intervalDays) && (r.intervalDays as number) >= 0, 'intervalDays 必须是非负数字')
  req(isNum(r.ease) && (r.ease as number) > 0, 'ease 必须是正数')
  req(isNum(r.nextReviewAt), 'nextReviewAt 必须是数字')
  if (r.lastCorrect !== null) req(isBool(r.lastCorrect), 'lastCorrect 必须是布尔值或 null')
  if (r.lastAnswer !== null) req(isStr(r.lastAnswer), 'lastAnswer 必须是字符串或 null')
  if (isNum(r.correctCount) && isNum(r.wrongCount) && isNum(r.attempts)) {
    req(
      (r.correctCount as number) + (r.wrongCount as number) <= (r.attempts as number),
      'correctCount + wrongCount 不得超过 attempts',
    )
  }
  return ok
}

function validateHistory(h: unknown, path: string, issues: ValidationIssue[]): boolean {
  if (!isObj(h)) {
    issues.push({ path, message: '不是对象' })
    return false
  }
  let ok = true
  const req = (cond: boolean, msg: string) => {
    if (!cond) {
      issues.push({ path, message: msg })
      ok = false
    }
  }
  req(isStr(h.id) && (h.id as string).length > 0, 'id 必须是非空字符串')
  req(isStr(h.qid) && (h.qid as string).length > 0, 'qid 必须是非空字符串')
  req(isStr(h.mode) && (h.mode as string).length > 0, 'mode 必须是非空字符串')
  req(isStr(h.sessionId), 'sessionId 必须是字符串')
  req(isNum(h.submittedAt), 'submittedAt 必须是数字')
  req(isBool(h.usedAI), 'usedAI 必须是布尔值')
  if (h.isCorrect !== null) req(isBool(h.isCorrect), 'isCorrect 必须是布尔值或 null')
  if (h.answer !== null) req(isStr(h.answer), 'answer 必须是字符串或 null')
  return ok
}

function validatePerQuestion(v: unknown, path: string, issues: ValidationIssue[]): boolean {
  if (!isObj(v)) {
    issues.push({ path, message: 'perQuestion 值不是对象' })
    return false
  }
  let ok = true
  const req = (cond: boolean, msg: string) => {
    if (!cond) {
      issues.push({ path, message: msg })
      ok = false
    }
  }
  if (v.isCorrect !== null) req(isBool(v.isCorrect), 'perQuestion.isCorrect 必须是布尔值或 null')
  req(isNum(v.points) && (v.points as number) >= 0, 'perQuestion.points 必须是非负数字')
  req(isBool(v.unanswered), 'perQuestion.unanswered 必须是布尔值')
  return ok
}

function validateMock(m: unknown, path: string, issues: ValidationIssue[]): boolean {
  if (!isObj(m)) {
    issues.push({ path, message: '不是对象' })
    return false
  }
  let ok = true
  const req = (cond: boolean, msg: string) => {
    if (!cond) {
      issues.push({ path, message: msg })
      ok = false
    }
  }
  req(isStr(m.id) && (m.id as string).length > 0, 'id 必须是非空字符串')
  req(isNum(m.startedAt), 'startedAt 必须是数字')
  if (m.endedAt !== null) req(isNum(m.endedAt), 'endedAt 必须是数字或 null')
  req(isBool(m.graded), 'graded 必须是布尔值')
  if (m.score !== null) req(isNum(m.score), 'score 必须是数字或 null')
  req(isNum(m.maxScore) && (m.maxScore as number) >= 0, 'maxScore 必须是非负数字')

  if (!isObj(m.config)) {
    issues.push({ path, message: 'config 缺失或不是对象' })
    ok = false
  } else {
    const c = m.config
    for (const k of ['singleCount', 'multiCount', 'judgeCount', 'shortCount']) {
      req(isNum(c[k]) && (c[k] as number) >= 0, `config.${k} 必须是非负数字`)
    }
    for (const k of ['singleScore', 'multiScore', 'judgeScore', 'shortScore']) {
      req(isNum(c[k]) && (c[k] as number) >= 0, `config.${k} 必须是非负数字`)
    }
    req(isNum(c.durationMin) && (c.durationMin as number) > 0, 'config.durationMin 必须是正数')
    const ch = c.chapters
    req(ch === 'all' || (Array.isArray(ch) && ch.every(isStr)), 'config.chapters 必须是 "all" 或字符串数组')
  }

  if (!isObj(m.submissions)) {
    issues.push({ path, message: 'submissions 缺失或不是对象' })
    ok = false
  } else {
    for (const [k, v] of Object.entries(m.submissions)) {
      req(v === null || isStr(v), `submissions["${k}"] 必须是字符串或 null`)
    }
  }

  if (!isObj(m.perQuestion)) {
    issues.push({ path, message: 'perQuestion 缺失或不是对象' })
    ok = false
  } else {
    for (const [k, v] of Object.entries(m.perQuestion)) {
      req(validatePerQuestion(v, `${path}.perQuestion["${k}"]`, issues), 'perQuestion 条目非法')
    }
  }

  if (isNum(m.score) && isNum(m.maxScore)) {
    req((m.score as number) <= (m.maxScore as number), 'score 不得超过 maxScore')
  }
  if (isNum(m.objectiveMaxScore) && isNum(m.subjectiveMaxScore) && isNum(m.maxScore)) {
    req(
      (m.objectiveMaxScore as number) + (m.subjectiveMaxScore as number) === (m.maxScore as number),
      'objectiveMaxScore + subjectiveMaxScore 必须等于 maxScore',
    )
  }
  return ok
}

function validateAiReview(a: unknown, path: string, issues: ValidationIssue[]): boolean {
  if (!isObj(a)) {
    issues.push({ path, message: '不是对象' })
    return false
  }
  let ok = true
  const req = (cond: boolean, msg: string) => {
    if (!cond) {
      issues.push({ path, message: msg })
      ok = false
    }
  }
  req(isStr(a.id) && (a.id as string).length > 0, 'id 必须是非空字符串')
  req(isStr(a.qid) && (a.qid as string).length > 0, 'qid 必须是非空字符串')
  req(isStr(a.userAnswer), 'userAnswer 必须是字符串')
  req(isNum(a.createdAt), 'createdAt 必须是数字')
  req(isStr(a.provider), 'provider 必须是字符串')
  req(isStr(a.model), 'model 必须是字符串')
  if (!isObj(a.result)) {
    issues.push({ path, message: 'result 缺失或不是对象' })
    ok = false
  } else {
    const r = a.result
    req(isNum(r.score) && (r.score as number) >= 0 && (r.score as number) <= 100, 'result.score 必须是 0-100 的数字')
    req(isNum(r.maxScore) && (r.maxScore as number) === 100, 'result.maxScore 必须是 100')
    for (const k of ['hitPoints', 'missedPoints', 'deductions', 'suggestions']) {
      req(Array.isArray(r[k]) && (r[k] as unknown[]).every(isStr), `result.${k} 必须是字符串数组`)
    }
    req(isStr(r.structureNote), 'result.structureNote 必须是字符串')
    req(isStr(r.disclaimer), 'result.disclaimer 必须是字符串')
  }
  return ok
}

/** Validate settings; returns null when the value is absent (allowed). */
export function validateSettings(v: unknown, path = 'settings', issues: ValidationIssue[] = []): AppSettings | null {
  if (v === undefined || v === null) return null
  if (!isObj(v)) {
    issues.push({ path, message: 'settings 不是对象' })
    return null
  }
  let ok = true
  const req = (cond: boolean, msg: string) => {
    if (!cond) {
      issues.push({ path, message: msg })
      ok = false
    }
  }
  req(isStr(v.theme) && THEMES.has(v.theme as string), `theme 非法：${String(v.theme)}`)
  req(isNum(v.reviewIntervalBase) && (v.reviewIntervalBase as number) >= 1, 'reviewIntervalBase 必须 >= 1')
  req(isNum(v.studyTarget) && (v.studyTarget as number) > 0, 'studyTarget 必须是正数')
  req(isNum(v.dailyGoalQuestions) && (v.dailyGoalQuestions as number) > 0, 'dailyGoalQuestions 必须是正数')
  if (!ok) return null
  return {
    theme: v.theme as AppSettings['theme'],
    reviewIntervalBase: v.reviewIntervalBase as number,
    studyTarget: v.studyTarget as number,
    dailyGoalQuestions: v.dailyGoalQuestions as number,
  }
}

export interface ParseResult {
  ok: boolean
  payload?: ExportPayload
  errors: string[]
  warnings: string[]
  /** number of structurally invalid rows, reported (never silently dropped) */
  invalidCount: number
}

/**
 * Parse & validate an exported JSON string. Structurally invalid rows cause the
 * WHOLE import to fail rather than being silently discarded, so a corrupt backup
 * can never produce a partially-restored database.
 */
export function parseExport(text: string): ParseResult {
  const errors: string[] = []
  const warnings: string[] = []
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch (e) {
    return { ok: false, errors: [`JSON 解析失败: ${(e as Error).message}`], warnings, invalidCount: 0 }
  }
  if (!isObj(data)) return { ok: false, errors: ['数据不是对象'], warnings, invalidCount: 0 }
  const d = data as Record<string, unknown>
  if (d.schema !== 'exampilot.export.v1') {
    return {
      ok: false,
      errors: [`不支持的备份格式（schema=${String(d.schema)}，期望 exampilot.export.v1）`],
      warnings,
      invalidCount: 0,
    }
  }
  for (const key of ['records', 'history', 'mocks', 'aiReviews']) {
    if (!Array.isArray(d[key])) errors.push(`${key} 缺失或不是数组`)
  }
  if (errors.length) return { ok: false, errors, warnings, invalidCount: 0 }

  const issues: ValidationIssue[] = []
  const seen = {
    records: new Set<string>(),
    history: new Set<string>(),
    mocks: new Set<string>(),
    aiReviews: new Set<string>(),
  }

  ;(d.records as unknown[]).forEach((r, i) => {
    const p = `records[${i}]`
    if (!validateRecord(r, p, issues)) return
    const qid = (r as QRecord).qid
    if (seen.records.has(qid)) issues.push({ path: p, message: `重复 qid=${qid}` })
    seen.records.add(qid)
  })

  ;(d.history as unknown[]).forEach((h, i) => {
    const p = `history[${i}]`
    if (!validateHistory(h, p, issues)) return
    const id = (h as HistoryEntry).id
    if (seen.history.has(id)) issues.push({ path: p, message: `重复 id=${id}` })
    seen.history.add(id)
  })

  ;(d.mocks as unknown[]).forEach((m, i) => {
    const p = `mocks[${i}]`
    if (!validateMock(m, p, issues)) return
    const id = (m as MockRun).id
    if (seen.mocks.has(id)) issues.push({ path: p, message: `重复 id=${id}` })
    seen.mocks.add(id)
  })

  ;(d.aiReviews as unknown[]).forEach((a, i) => {
    const p = `aiReviews[${i}]`
    if (!validateAiReview(a, p, issues)) return
    const id = (a as AiReview).id
    if (seen.aiReviews.has(id)) issues.push({ path: p, message: `重复 id=${id}` })
    seen.aiReviews.add(id)
  })

  const settingsIssues: ValidationIssue[] = []
  validateSettings(d.settings, 'settings', settingsIssues)
  if (settingsIssues.length) issues.push(...settingsIssues)
  else if (d.settings === undefined || d.settings === null) {
    warnings.push('备份未包含偏好设置（导入后保持当前或默认设置）')
  }

  if (typeof d.bankFingerprint !== 'string' || !d.bankFingerprint) {
    warnings.push('备份缺少题库指纹（旧版备份），无法校验题库一致性')
  }

  if (issues.length) {
    const shown = issues.slice(0, 8).map((x) => `${x.path}: ${x.message}`)
    return {
      ok: false,
      errors: [`备份数据校验失败（${issues.length} 处问题），未写入任何数据：`, ...shown],
      warnings,
      invalidCount: issues.length,
    }
  }

  return { ok: true, payload: d as unknown as ExportPayload, errors: [], warnings, invalidCount: 0 }
}

// ---------------------------------------------------------------------------
// Import planning & preview
// ---------------------------------------------------------------------------

export interface ImportPlan {
  records: QRecord[]
  history: HistoryEntry[]
  mocks: MockRun[]
  aiReviews: AiReview[]
  settings: AppSettings | null
  /**
   * Explicit settings semantics handed to the database layer, so the actual
   * write always matches what the UI promised:
   *  - 'keep'  → merge mode with no usable backup settings; current settings stay
   *  - 'set'   → the backup carries valid settings; they replace the current ones
   *  - 'reset' → replace mode with no usable backup settings; falls back to defaults
   */
  settingsAction: 'keep' | 'set' | 'reset'
  /** Which rows were excluded because their question is absent from the bank. */
  filter: BankFilterReport
  /**
   * The backup rows that survived bank filtering — i.e. what the backup actually
   * contributes, BEFORE merging with existing data.
   *
   * This is separate from `records`/`history`/… on purpose. In merge mode those
   * fields hold the MERGED result (existing ∪ incoming), so using them to compute
   * "how much of this backup is new" compares the merge against the existing set
   * and reports every pre-existing row as overwritten. The preview must describe
   * the BACKUP's contribution, and only this field can answer that.
   */
  incoming: IncomingRows
}

/** The backup's own rows, after bank filtering and before any merging. */
export interface IncomingRows {
  records: QRecord[]
  history: HistoryEntry[]
  mocks: MockRun[]
  aiReviews: AiReview[]
}

/** Row-level difference between the backup and the current database. */
export interface ImportDiff {
  /**
   * `incoming` = rows this backup contributes (post-filter, pre-merge).
   * `existing` = rows currently in the database.
   * `added`    = incoming rows whose key is not present locally.
   * `updated`  = incoming rows whose key already exists (backup wins).
   * `total`    = rows after restore under the chosen mode.
   */
  records: RowDiff
  history: RowDiff
  mocks: RowDiff
  aiReviews: RowDiff
  settingsChanged: boolean
  /** existing rows that would be destroyed in replace mode */
  clearedInReplace: number
}

export interface RowDiff {
  incoming: number
  existing: number
  added: number
  updated: number
  total: number
}

export interface ExistingData {
  records: QRecord[]
  history: HistoryEntry[]
  mocks: MockRun[]
  aiReviews: AiReview[]
  settings?: AppSettings | null
}

export interface BankCheck {
  /** 'match' | 'mismatch' | 'unknown' (older backup without a fingerprint) */
  status: 'match' | 'mismatch' | 'unknown'
  unmatchedRecords: number
  unmatchedHistory: number
  mocksWithUnmatchedQuestions: number
  message: string
}

/**
 * Report produced by verifying a backup against the current bank.
 *
 * Rules:
 *  - When the bank fingerprint matches, the whole question–option–answer binding
 *    is guaranteed identical, so all rows can be safely restored.
 *  - When the fingerprint differs or is missing (legacy backup), cross-bank migration
 *    requires trustworthy full-content verification per question. Without full-content
 *    proof, learning records and history cannot be verified against the current bank
 *    and are EXCLUDED to prevent progress corruption / wrong-question misattribution.
 *  - Mocks referencing missing/unmatched questions are likewise excluded.
 */
export interface BankFilterReport {
  applied: boolean
  fingerprintMatch: boolean
  excludedRecords: number
  excludedHistory: number
  excludedMocks: number
  excludedAiReviews: number
  keptRecords: number
  keptHistory: number
  keptMocks: number
  keptAiReviews: number
  /** true when the backup had data but nothing could be verified against the current bank */
  nothingVerifiable: boolean
}

/**
 * Filter payload rows against the current bank.
 *
 * If `fingerprintMatch` is true, all rows matching valid bank question IDs are accepted.
 * If `fingerprintMatch` is false (mismatch or legacy backup without fingerprint),
 * cross-bank progress migration is blocked: question records and history cannot guarantee
 * option-order and answer binding consistency, so they are excluded. Mocks and AI reviews
 * referencing unknown questions are also excluded.
 */
export function filterPayloadToBank(
  payload: ExportPayload,
  bankQuestionIds: Set<string>,
  fingerprintMatch: boolean = false,
): { payload: ExportPayload; report: BankFilterReport } {
  // If fingerprint matches completely, we verify membership in the current bank question IDs.
  // If fingerprint differs or is unknown, question records, history, and AI reviews have no content proof,
  // so they cannot be migrated to the active database.
  const records = fingerprintMatch ? payload.records.filter((r) => bankQuestionIds.has(r.qid)) : []
  const history = fingerprintMatch ? payload.history.filter((h) => bankQuestionIds.has(h.qid)) : []
  const aiReviews = fingerprintMatch ? payload.aiReviews.filter((a) => bankQuestionIds.has(a.qid)) : []
  const mocks = payload.mocks.filter(
    (m) => fingerprintMatch && Object.keys(m.submissions ?? {}).every((qid) => bankQuestionIds.has(qid)),
  )

  const totalIn = payload.records.length + payload.history.length + payload.mocks.length + payload.aiReviews.length

  const report: BankFilterReport = {
    applied: true,
    fingerprintMatch,
    excludedRecords: payload.records.length - records.length,
    excludedHistory: payload.history.length - history.length,
    excludedMocks: payload.mocks.length - mocks.length,
    excludedAiReviews: payload.aiReviews.length - aiReviews.length,
    keptRecords: records.length,
    keptHistory: history.length,
    keptMocks: mocks.length,
    keptAiReviews: aiReviews.length,
    nothingVerifiable:
      totalIn > 0 && records.length === 0 && history.length === 0 && mocks.length === 0 && aiReviews.length === 0,
  }

  return { payload: { ...payload, records, history, mocks, aiReviews }, report }
}

/**
 * Compare the backup's bank fingerprint with the current bank and count rows that
 * cannot be matched to a question. Unmatched rows would corrupt coverage
 * statistics, so the caller must not silently import them.
 */
export function checkBank(
  payload: ExportPayload,
  currentFingerprint: string,
  currentBankCount: number,
  bankQuestionIds: Set<string>,
): BankCheck {
  const hasFp = typeof payload.bankFingerprint === 'string' && payload.bankFingerprint.length > 0
  const status: BankCheck['status'] = !hasFp
    ? 'unknown'
    : payload.bankFingerprint === currentFingerprint
      ? 'match'
      : 'mismatch'

  const unmatchedRecords = payload.records.filter((r) => !bankQuestionIds.has(r.qid)).length
  const unmatchedHistory = payload.history.filter((h) => !bankQuestionIds.has(h.qid)).length
  const mocksWithUnmatchedQuestions = payload.mocks.filter((m) =>
    Object.keys(m.submissions ?? {}).some((qid) => !bankQuestionIds.has(qid)),
  ).length

  let message: string
  if (status === 'match') {
    message = `题库一致（${currentBankCount} 题）`
    if (unmatchedRecords || unmatchedHistory || mocksWithUnmatchedQuestions) {
      message += `；但仍有无法匹配的题目引用：学习记录 ${unmatchedRecords}、历史 ${unmatchedHistory}、模拟考试 ${mocksWithUnmatchedQuestions}`
    }
  } else if (status === 'mismatch') {
    message = `题库指纹不一致（备份 ${payload.bankCount ?? '?'} 题，当前 ${currentBankCount} 题）`
  } else {
    message = `备份未包含题库指纹（旧版备份），无法确认题库是否一致；当前 ${currentBankCount} 题`
  }
  return { status, unmatchedRecords, unmatchedHistory, mocksWithUnmatchedQuestions, message }
}

/**
 * Build the concrete write plan for a restore.
 *
 * Every row is first filtered against the current bank: a question id that
 * exists in the current bank is per-question identity evidence (ids are derived
 * from question content), so those rows are verifiable. Rows whose id is absent
 * cannot be verified and are EXCLUDED — they never reach the learning statistics.
 * The exclusion is reported in `plan.filter` so the UI can explain it.
 *
 * Settings semantics (the plan's `settingsAction` is what the DB actually does):
 *  - backup has valid settings  -> 'set'   (both modes)
 *  - replace without settings   -> 'reset' (fall back to DEFAULT_SETTINGS)
 *  - merge without settings     -> 'keep'  (current settings are preserved)
 */
export function planImport(
  payload: ExportPayload,
  mode: RestoreMode,
  existing?: ExistingData,
  bankQuestionIds?: Set<string>,
  fingerprintMatch: boolean = false,
): ImportPlan {
  const { payload: verified, report } = bankQuestionIds
    ? filterPayloadToBank(payload, bankQuestionIds, fingerprintMatch)
    : { payload, report: emptyFilterReport(fingerprintMatch) }

  const incomingRecords = verified.records ?? []
  const incomingHistory = verified.history ?? []
  const incomingMocks = verified.mocks ?? []
  const incomingAi = verified.aiReviews ?? []

  // The backup's own contribution, captured before merging so the preview can
  // report "new / overwritten" against what the BACKUP contains.
  const incoming: IncomingRows = {
    records: incomingRecords,
    history: incomingHistory,
    mocks: incomingMocks,
    aiReviews: incomingAi,
  }

  const issues: ValidationIssue[] = []
  const settings = validateSettings(payload.settings, 'settings', issues)
  const settingsUsable = issues.length === 0 && settings !== null

  const action: ImportPlan['settingsAction'] = settingsUsable ? 'set' : mode === 'replace' ? 'reset' : 'keep'

  if (mode === 'replace' || !existing) {
    return {
      records: incomingRecords,
      history: incomingHistory,
      mocks: incomingMocks,
      aiReviews: incomingAi,
      settings: settingsUsable ? settings : null,
      settingsAction: action,
      filter: report,
      incoming,
    }
  }

  const byId = <T extends { id: string }>(a: T[], b: T[]): T[] => {
    const m = new Map<string, T>()
    for (const x of a) m.set(x.id, x)
    for (const x of b) m.set(x.id, x) // backup wins on conflict
    return Array.from(m.values())
  }
  const recById = (a: QRecord[], b: QRecord[]): QRecord[] => {
    const m = new Map<string, QRecord>()
    for (const x of a) m.set(x.qid, x)
    for (const x of b) m.set(x.qid, x)
    return Array.from(m.values())
  }
  return {
    records: recById(existing.records, incomingRecords),
    history: byId(existing.history, incomingHistory),
    mocks: byId(existing.mocks, incomingMocks),
    aiReviews: byId(existing.aiReviews, incomingAi),
    settings: settingsUsable ? settings : null,
    settingsAction: action,
    filter: report,
    incoming,
  }
}

function emptyFilterReport(fingerprintMatch: boolean = false): BankFilterReport {
  return {
    applied: false,
    fingerprintMatch,
    excludedRecords: 0,
    excludedHistory: 0,
    excludedMocks: 0,
    excludedAiReviews: 0,
    keptRecords: 0,
    keptHistory: 0,
    keptMocks: 0,
    keptAiReviews: 0,
    nothingVerifiable: false,
  }
}

/**
 * Row-level diff used by the confirmation UI.
 *
 * `incoming` counts come from `plan.incoming` (the filtered BACKUP rows), not
 * from `plan.records`. In merge mode `plan.records` is the merged result, so
 * diffing it against the current database would count every pre-existing row as
 * overwritten: a backup with 1 new row against 11 existing rows would be
 * reported as "12 backup rows, 11 overwritten" instead of "1 new, 0 overwritten".
 * The preview must describe what the backup contributes, so the comparison is
 * backup-vs-current.
 */
export function diffImport(plan: ImportPlan, mode: RestoreMode, existing: ExistingData): ImportDiff {
  const stat = <T>(incoming: T[], current: T[], key: (x: T) => string) => {
    const cur = new Set(current.map(key))
    const inc = new Set(incoming.map(key))
    let added = 0
    let updated = 0
    for (const k of inc) {
      if (cur.has(k)) updated++
      else added++
    }
    // Rows after restore: replace discards the current set, merge unions them.
    const total = mode === 'replace' ? inc.size : new Set([...cur, ...inc]).size
    return { incoming: inc.size, existing: cur.size, added, updated, total }
  }

  const incomingSettings = plan.settings
  const settingsChanged =
    plan.settingsAction === 'set' &&
    incomingSettings !== null &&
    JSON.stringify(incomingSettings) !== JSON.stringify(existing.settings ?? null)

  const clearedInReplace =
    mode === 'replace'
      ? existing.records.length + existing.history.length + existing.mocks.length + existing.aiReviews.length
      : 0

  return {
    records: stat(plan.incoming.records, existing.records, (r) => r.qid),
    history: stat(plan.incoming.history, existing.history, (h) => h.id),
    mocks: stat(plan.incoming.mocks, existing.mocks, (m) => m.id),
    aiReviews: stat(plan.incoming.aiReviews, existing.aiReviews, (a) => a.id),
    settingsChanged,
    clearedInReplace,
  }
}

/** Human-readable summary of what a restore will do. */
export function describePlan(plan: ImportPlan, mode: RestoreMode): string[] {
  const settingsLine =
    plan.settingsAction === 'set'
      ? '偏好设置：将使用备份中的设置'
      : plan.settingsAction === 'reset'
        ? '偏好设置：备份未包含有效设置，将重置为默认值'
        : '偏好设置：保持当前设置不变'
  return [
    `模式：${mode === 'replace' ? '替换（清空现有数据后写入备份）' : '合并（同一 ID 以备份为准）'}`,
    `将写入：学习记录 ${plan.records.length} 条 · 历史 ${plan.history.length} 条 · 模拟考试 ${plan.mocks.length} 场 · AI 评阅 ${plan.aiReviews.length} 条`,
    settingsLine,
  ]
}
