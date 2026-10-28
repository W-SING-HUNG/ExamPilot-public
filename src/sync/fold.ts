/**
 * Deterministic derivation of an account's learning state from its operation log.
 *
 * Input: the confirmed operations in server order (by `seq`), followed by this
 * device's still-pending operations in the order they were created. Output: the
 * exact values the existing pages consume (records, history, mocks, aiReviews,
 * settings). Two devices that hold the same confirmed log compute byte-identical
 * state — statistics never drift, because nothing is stored that is not derived.
 *
 * Rules
 *  - Attempts are deduplicated by id (first occurrence in log order wins), so a
 *    replayed or duplicated upload can never count twice.
 *  - A question's record is rebuilt from scratch: merged baselines (imported /
 *    migrated records) first, then every live attempt sorted by
 *    (submittedAt, id) through the original scheduler functions. Arrival order
 *    therefore does not matter.
 *  - `reset` discards every learning row before it (settings survive, as in the
 *    original app).
 *  - `hide_history` / `clear_qids` act only on rows the issuing device could see:
 *    rows with seq <= `upto`, plus that device's own earlier operations. A
 *    concurrent answer from another device is never deleted behind the user's back.
 */
import type { AiReview, AppSettings, HistoryEntry, MockConfig, MockRun, QRecord } from '../lib/types'
import { applyAttempt, applySubjectiveAttempt, freshRecord } from '../lib/scheduler'
import type { AiChatMsg, AiMsgOpBody, OpKind } from './protocol'

export interface LogOp {
  id: string
  kind: OpKind
  /** null while pending on this device */
  seq: number | null
  clientId: string
  body: unknown
}

export interface Baseline {
  qid: string
  rec: QRecord
  /** ids of the history rows that this record already includes */
  hids: string[]
  /** content key: identical baselines imported twice are counted once */
  ck: string
}

interface AttemptRow {
  h: HistoryEntry
  /** ease floor used when the attempt was made (undefined = record's own ease) */
  ef: number | undefined
  /** true: already included in a baseline, shown in history only */
  base: boolean
  seq: number | null
  clientId: string
  historyHidden: boolean
}

interface BaselineRow extends Baseline {
  opId: string
  seq: number | null
  clientId: string
}

export interface SyncedSettings extends AppSettings {
  mockConfig: MockConfig | null
  /** the one-time "欢迎使用 ExamPilot Pro" was seen on some device (account-wide, so it never repeats) */
  proWelcomed: boolean
}

export const DEFAULT_SYNCED_SETTINGS: SyncedSettings = {
  theme: 'auto',
  reviewIntervalBase: 1,
  studyTarget: 30,
  dailyGoalQuestions: 30,
  mockConfig: null,
  proWelcomed: false,
}

export interface FoldResult {
  records: Map<string, QRecord>
  /** newest first, excludes rows hidden by "清空历史" */
  history: HistoryEntry[]
  /** every live attempt id (including hidden-from-history ones), for idempotency checks */
  attemptKeys: Set<string>
  /** (sessionId|qid) pairs that already have an attempt */
  sessionAttempts: Set<string>
  mocks: MockRun[]
  aiReviews: AiReview[]
  /** AI conversations, newest activity first (not affected by a learning-data reset) */
  aiChats: AiConversation[]
  settings: SyncedSettings
  /** number of ops folded after the last reset */
  liveOps: number
  /** kinds this build did not understand (a newer client wrote them) */
  unknownKinds: string[]
}

type Body = Record<string, unknown>

export interface AiConversation {
  id: string
  title: string
  kind: 'question' | 'free'
  createdAt: number
  updatedAt: number
  messages: AiChatMsg[]
}

const FINAL_AI_STATUS = new Set(['done', 'cancelled', 'error'])

/**
 * Fold AI chat operations. Rules:
 *  - a message is identified by its id; a later operation replaces it, except
 *    that a final state (done / cancelled / error) is never downgraded back to
 *    "generating" by a late or replayed placeholder;
 *  - a deleted conversation stays deleted: messages written for it later (an
 *    offline device catching up) do not bring it back.
 */
export function foldAiChats(ops: LogOp[]): AiConversation[] {
  const deleted = new Set<string>()
  for (const op of ops) if (op.kind === 'ai_conv_del') deleted.add(String((op.body as Body).conv))
  const convs = new Map<string, { title: string; kind: 'question' | 'free'; msgs: Map<string, AiChatMsg> }>()
  for (const op of ops) {
    if (op.kind !== 'ai_msg') continue
    const b = op.body as unknown as AiMsgOpBody
    if (!b || deleted.has(b.conv) || !b.msg) continue
    let c = convs.get(b.conv)
    if (!c) convs.set(b.conv, (c = { title: '', kind: 'free', msgs: new Map() }))
    if (!c.title && b.title) c.title = b.title
    if (b.kind === 'question') c.kind = 'question'
    const prev = c.msgs.get(b.msg.id)
    if (prev && FINAL_AI_STATUS.has(prev.status) && b.msg.status === 'generating') continue
    c.msgs.set(b.msg.id, b.msg)
  }
  const out: AiConversation[] = []
  for (const [id, c] of convs) {
    const messages = [...c.msgs.values()].sort(
      (x, y) => x.at - y.at || (x.role === y.role ? 0 : x.role === 'user' ? -1 : 1),
    )
    if (!messages.length) continue
    const firstUser = messages.find((m) => m.role === 'user')
    out.push({
      id,
      title: c.title || (firstUser ? firstUser.content.replace(/\s+/g, ' ').slice(0, 40) : 'AI 对话'),
      kind: c.kind,
      createdAt: messages[0].at,
      updatedAt: messages[messages.length - 1].at,
      messages,
    })
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

function canSee(row: { seq: number | null; clientId: string }, op: LogOp, upto: number): boolean {
  if (row.clientId === op.clientId) return true
  return row.seq !== null && row.seq <= upto
}

export function foldLog(ops: LogOp[]): FoldResult {
  // Settings survive resets; learning rows do not. Find the last reset first.
  let start = 0
  for (let i = ops.length - 1; i >= 0; i--) {
    if (ops[i].kind === 'reset') {
      start = i + 1
      break
    }
  }

  const settings: SyncedSettings = { ...DEFAULT_SYNCED_SETTINGS }
  for (const op of ops) {
    if (op.kind !== 'settings') continue
    const patch = (op.body as Body).patch as Partial<SyncedSettings>
    for (const [k, v] of Object.entries(patch ?? {})) {
      if (k in DEFAULT_SYNCED_SETTINGS) (settings as unknown as Record<string, unknown>)[k] = v
    }
  }

  const attempts = new Map<string, AttemptRow>()
  const baselines: BaselineRow[] = []
  const mocks = new Map<string, MockRun>()
  const reviews = new Map<string, AiReview>()
  const unknown = new Set<string>()

  const addAttempt = (h: HistoryEntry, ef: number | undefined, base: boolean, op: LogOp) => {
    if (attempts.has(h.id)) return
    attempts.set(h.id, { h, ef, base, seq: op.seq, clientId: op.clientId, historyHidden: false })
  }

  for (let i = start; i < ops.length; i++) {
    const op = ops[i]
    const b = (op.body ?? {}) as Body
    switch (op.kind) {
      case 'attempt':
        addAttempt(b.h as HistoryEntry, typeof b.ef === 'number' ? b.ef : undefined, false, op)
        break
      case 'mock': {
        const run = b.run as MockRun
        if (mocks.has(run.id)) break // a second submission of the same exam is a no-op
        mocks.set(run.id, run)
        for (const a of (b.attempts as { h: HistoryEntry; ef?: number | null }[]) ?? []) {
          addAttempt(a.h, typeof a.ef === 'number' ? a.ef : undefined, false, op)
        }
        break
      }
      case 'import': {
        for (const x of (b.baselines as Baseline[]) ?? []) {
          baselines.push({ ...x, opId: op.id, seq: op.seq, clientId: op.clientId })
        }
        for (const h of (b.history as HistoryEntry[]) ?? []) addAttempt(h, undefined, true, op)
        for (const m of (b.mocks as MockRun[]) ?? []) if (!mocks.has(m.id)) mocks.set(m.id, m)
        for (const r of (b.aiReviews as AiReview[]) ?? []) if (!reviews.has(r.id)) reviews.set(r.id, r)
        break
      }
      case 'ai_review': {
        const r = b.review as AiReview
        reviews.set(r.id, r) // same id = same (session, question): latest review wins, as before
        if (b.attempt) addAttempt(b.attempt as HistoryEntry, undefined, false, op)
        break
      }
      case 'hide_history': {
        const upto = Number(b.upto)
        for (const a of attempts.values()) if (canSee(a, op, upto)) a.historyHidden = true
        break
      }
      case 'clear_qids': {
        const upto = Number(b.upto)
        const qs = new Set(b.qids as string[])
        for (const [id, a] of attempts) if (qs.has(a.h.qid) && canSee(a, op, upto)) attempts.delete(id)
        for (let j = baselines.length - 1; j >= 0; j--) {
          const x = baselines[j]
          if (qs.has(x.qid) && canSee(x, op, upto)) baselines.splice(j, 1)
        }
        break
      }
      case 'delete_mock':
        mocks.delete(String(b.runId))
        break
      case 'settings':
      case 'reset':
      case 'ai_msg':
      case 'ai_conv_del':
        break
      default:
        unknown.add(String(op.kind))
    }
  }

  // ---- records ---------------------------------------------------------
  const byQ = new Map<string, { bases: BaselineRow[]; live: AttemptRow[] }>()
  const slot = (qid: string) => {
    let s = byQ.get(qid)
    if (!s) byQ.set(qid, (s = { bases: [], live: [] }))
    return s
  }
  // Attempts already contained in an imported record must not be applied again
  // (e.g. a backup of this same account merged back in).
  const explained = new Set<string>()
  for (const x of baselines) {
    slot(x.qid).bases.push(x)
    for (const id of x.hids) explained.add(id)
  }
  for (const a of attempts.values()) if (!a.base && !explained.has(a.h.id)) slot(a.h.qid).live.push(a)

  const records = new Map<string, QRecord>()
  for (const [qid, s] of byQ) {
    let rec: QRecord | null = s.bases.length ? mergeBaselines(qid, s.bases, attempts) : null
    s.live.sort((x, y) => x.h.submittedAt - y.h.submittedAt || (x.h.id < y.h.id ? -1 : x.h.id > y.h.id ? 1 : 0))
    for (const a of s.live) {
      const cur = rec ?? freshRecord(qid, a.h.submittedAt)
      const next =
        a.h.isCorrect === null
          ? applySubjectiveAttempt(cur, a.h.submittedAt)
          : applyAttempt(cur, a.h.isCorrect === true, a.h.submittedAt, a.ef)
      next.lastAnswer = a.h.answer
      if (a.h.isCorrect !== null) next.lastCorrect = a.h.isCorrect
      rec = next
    }
    if (rec) records.set(qid, rec)
  }

  const history: HistoryEntry[] = []
  const attemptKeys = new Set<string>()
  const sessionAttempts = new Set<string>()
  for (const a of attempts.values()) {
    attemptKeys.add(a.h.id)
    sessionAttempts.add(a.h.sessionId + '|' + a.h.qid)
    if (!a.historyHidden) history.push(a.h)
  }
  history.sort((x, y) => y.submittedAt - x.submittedAt || (x.id < y.id ? 1 : -1))

  return {
    records,
    history,
    attemptKeys,
    sessionAttempts,
    mocks: [...mocks.values()].sort((a, b) => b.startedAt - a.startedAt),
    aiReviews: [...reviews.values()].sort((a, b) => b.createdAt - a.createdAt),
    aiChats: foldAiChats(ops),
    settings,
    liveOps: ops.length - start,
    unknownKinds: [...unknown],
  }
}

/**
 * Merge one or more imported records of the same question.
 *
 * A record's counts = (part explained by its history rows) + (residual not
 * explained, e.g. history the user cleared earlier). Across baselines, the
 * history-explained part is counted once per distinct history id (union), and
 * residuals are summed. Identical baselines (same content key) count once.
 * State fields (interval, due date, status) come from the most recent baseline.
 */
function mergeBaselines(qid: string, bases: BaselineRow[], attempts: Map<string, AttemptRow>): QRecord {
  const uniq = new Map<string, BaselineRow>()
  for (const b of bases) if (!uniq.has(b.ck)) uniq.set(b.ck, b)
  const list = [...uniq.values()]
  if (list.length === 1) return { ...list[0].rec, qid }

  const stats = (ids: Iterable<string>) => {
    let n = 0,
      c = 0,
      w = 0
    for (const id of ids) {
      const a = attempts.get(id)
      if (!a) continue
      n++
      if (a.h.isCorrect === true) c++
      else if (a.h.isCorrect === false) w++
    }
    return { n, c, w }
  }
  let attemptsN = 0,
    correct = 0,
    wrong = 0
  const union = new Set<string>()
  for (const b of list) {
    const s = stats(b.hids)
    attemptsN += Math.max(0, b.rec.attempts - s.n)
    correct += Math.max(0, b.rec.correctCount - s.c)
    wrong += Math.max(0, b.rec.wrongCount - s.w)
    for (const id of b.hids) union.add(id)
  }
  const u = stats(union)
  attemptsN += u.n
  correct += u.c
  wrong += u.w

  const latest = [...list].sort((a, b) => b.rec.lastSeenAt - a.rec.lastSeenAt || (a.opId < b.opId ? -1 : 1))[0].rec
  return { ...latest, qid, attempts: attemptsN, correctCount: correct, wrongCount: wrong }
}

/** Stable content key for a baseline (FNV-1a over canonical JSON). */
export function baselineKey(rec: QRecord, hids: string[]): string {
  const canon = JSON.stringify([
    rec.qid,
    rec.status,
    rec.attempts,
    rec.correctCount,
    rec.wrongCount,
    rec.lastSeenAt,
    rec.lastCorrect,
    rec.lastAnswer,
    rec.intervalDays,
    rec.ease,
    rec.nextReviewAt,
    [...hids].sort(),
  ])
  let h1 = 0x811c9dc5,
    h2 = 0x01000193
  for (let i = 0; i < canon.length; i++) {
    const c = canon.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0
    h2 = Math.imul(h2 ^ c, 2246822519) >>> 0
  }
  return h1.toString(36) + h2.toString(36) + canon.length.toString(36)
}
