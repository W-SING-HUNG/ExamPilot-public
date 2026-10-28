/**
 * ExamPilot cloud-sync protocol (v1) — shared by the browser and the Worker.
 *
 * Model (see docs/cloud-sync-design.md):
 *  - Every learning change is an immutable OPERATION with a client-generated,
 *    globally unique id. The server appends accepted operations to a per-account
 *    log and gives each one a monotonically increasing `seq` (server order).
 *  - Derived state (records, history, mocks, settings) is a pure fold of the log
 *    (`fold.ts`); the server never interprets learning data beyond validation.
 *  - Mutable, single-valued things (practice drafts, the running exam) are
 *    DOCUMENTS with a version number, updated by compare-and-swap.
 *  - `epoch` is bumped by a reset; operations created against an older epoch are
 *    rejected and kept aside on the client instead of resurrecting data.
 */

export const PROTOCOL_VERSION = 1

/** Max operations accepted in one push (keeps a push inside D1's per-invocation query budget). */
export const MAX_OPS_PER_PUSH = 25
/** Max documents in one push. */
export const MAX_DOCS_PER_PUSH = 8
/** Max request body accepted by the API. */
export const MAX_BODY_BYTES = 900_000
/** Max size of one operation body / document body (JSON chars). */
export const MAX_OP_BYTES = 400_000
export const MAX_DOC_BYTES = 200_000
/** Page size of /api/sync/pull. */
export const PULL_PAGE = 400
/** Grace after an exam's deadline during which saves/submits are still accepted. */
export const EXAM_GRACE_MS = 120_000

export type OpKind =
  | 'attempt'
  | 'mock'
  | 'import'
  | 'ai_review'
  | 'hide_history'
  | 'clear_qids'
  | 'delete_mock'
  | 'settings'
  | 'reset'
  | 'ai_msg'
  | 'ai_conv_del'

export const OP_KINDS: readonly OpKind[] = [
  'attempt',
  'mock',
  'import',
  'ai_review',
  'hide_history',
  'clear_qids',
  'delete_mock',
  'settings',
  'reset',
  'ai_msg',
  'ai_conv_del',
]

/** Kinds that survive a reset and are therefore not epoch-checked. */
// AI conversations are not learning progress: a reset of learning data keeps them
// (they are deleted explicitly, conversation by conversation).
export const EPOCH_FREE_KINDS: readonly OpKind[] = ['settings', 'ai_msg', 'ai_conv_del']

/* ------------------------------ AI chat ---------------------------------- */
export type AiMsgStatus = 'generating' | 'done' | 'cancelled' | 'error'
export const AI_MSG_STATUSES: readonly AiMsgStatus[] = ['generating', 'done', 'cancelled', 'error']
/** Max characters of one stored chat message. */
export const MAX_AI_MSG_CHARS = 60_000
export interface AiChatMsg {
  id: string
  role: 'user' | 'assistant'
  content: string
  status: AiMsgStatus
  /** client time the message was created (display order inside a conversation) */
  at: number
  error?: string
  model?: string
  /** compressed copies saved in the image store (web edition, 2026-10-27) */
  images?: AiMsgImage[]
}
export interface AiMsgImage {
  id: string
  w: number
  h: number
}
export interface AiMsgOpBody {
  conv: string
  /** conversation title, sent with the first user message */
  title?: string
  /** only for the first message of a conversation started from a question */
  kind?: 'question' | 'free'
  msg: AiChatMsg
}

export interface WireOp {
  /** globally unique, stable across retries */
  id: string
  kind: OpKind
  /** epoch the client believed current when it created the op */
  epoch: number
  /** client wall clock at creation (informational only, never trusted for ordering) */
  createdAt: number
  body: unknown
}

/** An op as stored on the server / returned by pull. */
export interface ServerOp extends WireOp {
  seq: number
  clientId: string
}

export type DocOpType = 'put' | 'delete' | 'exam_start' | 'exam_save' | 'exam_takeover' | 'exam_abandon'

export interface WireDocOp {
  /** unique per attempt to write this doc; repeated on retry */
  opId: string
  key: string
  type: DocOpType
  /** version the client based this write on (0 = expected absent) */
  baseVersion: number
  body?: unknown
  /** exam fencing token the client holds */
  leaseGen?: number
  /** for 'delete' of drafts: only delete when the stored draft is this session */
  ifSessionId?: string
}

export interface ServerDoc {
  key: string
  version: number
  seq: number
  deleted: boolean
  body: unknown
  holder: string | null
  updatedAt: number
}

export interface PushRequest {
  protocol: number
  clientId: string
  /** account id the client believes it is writing to; must match the verified identity */
  accountId: string
  bankFp: string
  ops: WireOp[]
  docs: WireDocOp[]
}

export type OpResultStatus = 'ok' | 'dup' | 'stale_epoch' | 'rejected' | 'lease_lost' | 'late'
export interface OpResult {
  id: string
  status: OpResultStatus
  seq?: number
  reason?: string
  /** for 'late': the server's copy of the exam document */
  doc?: ServerDoc
}

export type DocResultStatus = 'ok' | 'dup' | 'conflict' | 'rejected' | 'lease_lost' | 'expired'
export interface DocResult {
  opId: string
  key: string
  status: DocResultStatus
  doc: ServerDoc | null
  reason?: string
}

export interface PushResponse {
  ok: true
  epoch: number
  head: number
  now: number
  ops: OpResult[]
  docs: DocResult[]
}

export interface PullResponse {
  ok: true
  epoch: number
  /** seq of the last reset operation (0 if none) */
  resetSeq: number
  head: number
  now: number
  ops: ServerOp[]
  docs: ServerDoc[]
  /** true when more ops are available after the last returned one */
  more: boolean
}

export interface MeResponse {
  ok: true
  accountId: string
  email: string
  epoch: number
  head: number
  now: number
  bankFp: string
}

export interface ApiError {
  ok: false
  error:
    | 'unauthenticated'
    | 'forbidden_origin'
    | 'identity_mismatch'
    | 'bad_request'
    | 'too_large'
    | 'rate_limited'
    | 'quota_exceeded'
    | 'bank_mismatch'
    | 'protocol_unsupported'
    | 'conflict_retry'
    | 'server_error'
  message?: string
}

/* ------------------------------------------------------------------ */
/* Validation (used by the Worker; also exercised by client tests)     */
/* ------------------------------------------------------------------ */

// Question ids carry a chapter suffix in CJK (e.g. S001-a1b2c3d4-导论), so ids may be any
// printable characters except whitespace, quotes and backslashes.
// eslint-disable-next-line no-control-regex -- rejecting control characters is the point of this class
const ID_RE = /^[^\s\u0000-\u001f\u007f"'\\<>]{3,200}$/u
const KEY_RE = /^(draft\.[a-z]{2,20}|exam\.current)$/

export function isId(v: unknown): v is string {
  return typeof v === 'string' && ID_RE.test(v)
}
export function isDocKey(v: unknown): v is string {
  return typeof v === 'string' && KEY_RE.test(v)
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isStrOrNull = (v: unknown) => v === null || typeof v === 'string'
const isBoolOrNull = (v: unknown) => v === null || typeof v === 'boolean'

/** Validate a HistoryEntry-like object carried inside an op body. */
export function validHistory(h: unknown): boolean {
  if (!isObj(h)) return false
  return (
    isId(h.id) &&
    typeof h.qid === 'string' &&
    h.qid.length > 0 &&
    h.qid.length < 120 &&
    typeof h.mode === 'string' &&
    h.mode.length < 40 &&
    typeof h.sessionId === 'string' &&
    h.sessionId.length < 160 &&
    isStrOrNull(h.answer) &&
    (h.answer === null || (h.answer as string).length < 20_000) &&
    isBoolOrNull(h.isCorrect) &&
    isNum(h.submittedAt) &&
    typeof h.usedAI === 'boolean'
  )
}

export function validRecord(r: unknown): boolean {
  if (!isObj(r)) return false
  return (
    typeof r.qid === 'string' &&
    ['new', 'learning', 'mastered', 'struggling'].includes(r.status as string) &&
    isNum(r.attempts) &&
    isNum(r.correctCount) &&
    isNum(r.wrongCount) &&
    isNum(r.lastSeenAt) &&
    isBoolOrNull(r.lastCorrect) &&
    isStrOrNull(r.lastAnswer) &&
    isNum(r.intervalDays) &&
    isNum(r.ease) &&
    isNum(r.nextReviewAt)
  )
}

export function validMockRun(m: unknown): boolean {
  if (!isObj(m)) return false
  return (
    isId(m.id) &&
    isNum(m.startedAt) &&
    (m.endedAt === null || isNum(m.endedAt)) &&
    isObj(m.config) &&
    isObj(m.submissions) &&
    typeof m.graded === 'boolean' &&
    (m.score === null || isNum(m.score)) &&
    isNum(m.maxScore) &&
    isObj(m.perQuestion)
  )
}

const SETTINGS_KEYS = [
  'theme',
  'reviewIntervalBase',
  'studyTarget',
  'dailyGoalQuestions',
  'mockConfig',
  'proWelcomed',
] as const

/** Validate an op's body for its kind. Returns null when valid, else a reason. */
export function validateOp(op: unknown): string | null {
  if (!isObj(op)) return 'op not an object'
  if (!isId(op.id)) return 'bad op id'
  if (!OP_KINDS.includes(op.kind as OpKind)) return 'unknown kind'
  if (!isNum(op.epoch) || op.epoch < 1) return 'bad epoch'
  if (!isNum(op.createdAt)) return 'bad createdAt'
  const b = op.body
  if (!isObj(b)) return 'bad body'
  switch (op.kind as OpKind) {
    case 'attempt':
      if (!validHistory(b.h)) return 'bad attempt'
      if (!(b.ef === null || b.ef === undefined || isNum(b.ef))) return 'bad ef'
      return null
    case 'mock': {
      if (!validMockRun(b.run)) return 'bad mock run'
      if (!Array.isArray(b.attempts) || b.attempts.length > 400) return 'bad mock attempts'
      for (const a of b.attempts as unknown[]) {
        if (!isObj(a) || !validHistory(a.h)) return 'bad mock attempt'
      }
      if (!(b.leaseGen === undefined || isNum(b.leaseGen))) return 'bad leaseGen'
      return null
    }
    case 'import': {
      if (typeof b.src !== 'string' || b.src.length > 200) return 'bad src'
      if (!Array.isArray(b.baselines) || b.baselines.length > 2000) return 'bad baselines'
      for (const x of b.baselines as unknown[]) {
        if (!isObj(x) || !validRecord(x.rec) || !Array.isArray(x.hids) || typeof x.ck !== 'string')
          return 'bad baseline'
      }
      if (!Array.isArray(b.history) || b.history.length > 4000) return 'bad history'
      for (const h of b.history as unknown[]) if (!validHistory(h)) return 'bad import history'
      if (!Array.isArray(b.mocks) || b.mocks.length > 200) return 'bad mocks'
      for (const m of b.mocks as unknown[]) if (!validMockRun(m)) return 'bad import mock'
      if (!Array.isArray(b.aiReviews) || b.aiReviews.length > 2000) return 'bad aiReviews'
      return null
    }
    case 'ai_review':
      if (!isObj(b.review) || !isId((b.review as Record<string, unknown>).id)) return 'bad review'
      if (!(b.attempt === null || b.attempt === undefined || validHistory(b.attempt))) return 'bad review attempt'
      return null
    case 'hide_history':
      if (!isNum(b.upto)) return 'bad upto'
      return null
    case 'clear_qids':
      if (!isNum(b.upto)) return 'bad upto'
      if (!Array.isArray(b.qids) || b.qids.length === 0 || b.qids.length > 2000) return 'bad qids'
      if (!(b.qids as unknown[]).every((q) => typeof q === 'string' && q.length < 120)) return 'bad qid'
      return null
    case 'delete_mock':
      if (!isId(b.runId)) return 'bad runId'
      return null
    case 'settings': {
      if (!isObj(b.patch)) return 'bad patch'
      for (const k of Object.keys(b.patch))
        if (!(SETTINGS_KEYS as readonly string[]).includes(k)) return 'bad setting key'
      if ('proWelcomed' in b.patch && typeof b.patch.proWelcomed !== 'boolean') return 'bad proWelcomed'
      return null
    }
    case 'reset':
      return null
    case 'ai_msg': {
      if (!isId(b.conv)) return 'bad conv'
      if (!(b.title === undefined || (typeof b.title === 'string' && b.title.length <= 200))) return 'bad title'
      if (!(b.kind === undefined || b.kind === 'question' || b.kind === 'free')) return 'bad conv kind'
      const m = b.msg
      if (!isObj(m) || !isId(m.id)) return 'bad msg'
      if (m.role !== 'user' && m.role !== 'assistant') return 'bad role'
      if (typeof m.content !== 'string' || m.content.length > MAX_AI_MSG_CHARS) return 'bad content'
      if (!AI_MSG_STATUSES.includes(m.status as AiMsgStatus)) return 'bad status'
      if (m.role === 'user' && m.status !== 'done') return 'bad user status'
      if (!isNum(m.at)) return 'bad at'
      if (!(m.error === undefined || (typeof m.error === 'string' && m.error.length <= 1000))) return 'bad error'
      if (!(m.model === undefined || (typeof m.model === 'string' && m.model.length <= 200))) return 'bad model'
      if (m.images !== undefined) {
        if (!Array.isArray(m.images) || m.images.length > 3 || m.role !== 'user') return 'bad images'
        for (const im of m.images as unknown[]) {
          if (
            !isObj(im) ||
            typeof im.id !== 'string' ||
            !/^img_[0-9a-f]{32}$/.test(im.id) ||
            !isNum(im.w) ||
            !isNum(im.h)
          )
            return 'bad image ref'
        }
      }
      return null
    }
    case 'ai_conv_del':
      if (!isId(b.conv)) return 'bad conv'
      return null
  }
  return 'unhandled'
}

export function validateDocOp(d: unknown): string | null {
  if (!isObj(d)) return 'doc op not an object'
  if (!isId(d.opId)) return 'bad doc opId'
  if (!isDocKey(d.key)) return 'bad doc key'
  if (!['put', 'delete', 'exam_start', 'exam_save', 'exam_takeover', 'exam_abandon'].includes(d.type as string))
    return 'bad doc op type'
  if (!isNum(d.baseVersion) || d.baseVersion < 0) return 'bad baseVersion'
  const isExam = d.key === 'exam.current'
  const examType = (d.type as string).startsWith('exam_')
  if (isExam !== examType) return 'doc op type does not match key'
  if ((d.type === 'put' || d.type === 'exam_start' || d.type === 'exam_save') && !isObj(d.body)) return 'missing body'
  if (examType && d.type !== 'exam_start' && !isNum(d.leaseGen)) return 'missing leaseGen'
  return null
}

/** Shape of the running-exam document body. */
export interface ExamDocBody {
  runId: string
  qids: string[]
  config: unknown
  startedAt: number
  endsAt: number
  durationMs: number
  answers: Record<string, string | null>
  idx: number
  status: 'active' | 'submitted' | 'abandoned'
  leaseGen: number
  holder: string
}
