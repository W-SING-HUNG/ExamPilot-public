/**
 * Session draft persistence.
 *
 * A practice session is a short-lived, uncommitted piece of work: a page reload
 * or an accidental tab switch must not silently destroy it. The draft holds only
 * the in-flight UI state (which questions, which selection, which outcome so far),
 * never learning records — those are written exactly once, at submit time, by the
 * ordinary transaction path. Restoring a draft therefore can never double-count
 * an attempt.
 *
 * Storage is `sessionStorage`: it survives a reload of the same tab, which is the
 * case we are protecting against, and disappears with the tab, which keeps a
 * finished session from resurfacing later. Every read is defensive — a stale or
 * malformed draft is discarded, never trusted.
 *
 * ## Legacy keys
 *
 * An earlier implementation wrote `exampilot_practice_session` (a whole array of
 * Question objects) plus `exampilot_practice_session_id`, and the runner wrote
 * `exampilot_runner_<sessionId>` ({idx, results}). Those keys are still read here
 * and migrated into the unified draft, so a user who left a session open across
 * the upgrade does not lose it. The legacy keys are removed once migrated.
 */
import type { Outcome } from './session-outcome'

/**
 * Optional storage backend. The web edition plugs in the account's cloud
 * document store (synced across devices); the desktop edition keeps the
 * default per-tab sessionStorage behaviour below, unchanged.
 */
export interface DraftBackend {
  load(mode: string): unknown
  save(mode: string, draft: SessionDraft): void
  clear(mode: string, sessionId?: string): void
}
let backend: DraftBackend | null = null
export function setDraftBackend(b: DraftBackend | null): void {
  backend = b
}

export const DRAFT_PREFIX = 'exampilot.session.'

/** Legacy keys kept only for one-time migration. */
const LEGACY_SESSION_KEYS: Record<string, { q: string; id: string }> = {
  practice: { q: 'exampilot_practice_session', id: 'exampilot_practice_session_id' },
  special: { q: 'exampilot_special_session', id: 'exampilot_special_session_id' },
}
const LEGACY_RUNNER_PREFIX = 'exampilot_runner_'

export type SessionPhase = 'configure' | 'running' | 'summary'

/** The part of a session that is worth restoring after a reload. */
export interface SessionDraft {
  /** Route/mode the session belongs to, e.g. 'plan' | 'practice'. */
  mode: string
  sessionId: string
  /** Question ids in presentation order; the bank is the source of the content. */
  qids: string[]
  /** Current index. */
  idx: number
  /** Selection per qid (letters / 'true' / 'false' / free text). */
  answers: Record<string, string | null>
  /** Outcome per qid, only for questions already submitted. */
  outcomes: Record<string, Outcome>
  /** qids deliberately skipped. */
  skipped: string[]
  startedAt: number
  /** Plan/practice size, kept so the configure screen can be restored consistently. */
  size?: number
  savedAt: number
}

const isStr = (v: unknown): v is string => typeof v === 'string'

function valid(v: unknown): v is SessionDraft {
  if (!v || typeof v !== 'object') return false
  const d = v as Partial<SessionDraft>
  if (!isStr(d.mode) || !isStr(d.sessionId)) return false
  if (!Array.isArray(d.qids) || d.qids.length === 0 || !d.qids.every(isStr)) return false
  if (typeof d.idx !== 'number' || !Number.isFinite(d.idx)) return false
  if (typeof d.startedAt !== 'number' || !Number.isFinite(d.startedAt)) return false
  if (!d.answers || typeof d.answers !== 'object') return false
  if (!d.outcomes || typeof d.outcomes !== 'object') return false
  if (!Array.isArray(d.skipped)) return false
  // A draft that outlived the session it describes is not recoverable.
  if (d.idx < 0 || d.idx >= d.qids.length) return false
  const age = Date.now() - (typeof d.savedAt === 'number' ? d.savedAt : 0)
  if (age > 24 * 3600 * 1000) return false
  return true
}

/**
 * Convert the legacy runner payload ({idx, results}) into our outcome model.
 *
 * The legacy `results` map held `true | false | null`, where `null` meant "no
 * auto grade" — exactly the ambiguity P0-5 fixed. The mapping preserves intent
 * rather than the old rendering: `null` becomes `unscored`.
 */
function outcomesFromLegacy(results: unknown): Record<string, Outcome> {
  const out: Record<string, Outcome> = {}
  if (!results || typeof results !== 'object') return out
  for (const [qid, v] of Object.entries(results as Record<string, unknown>)) {
    out[qid] = v === true ? 'correct' : v === false ? 'wrong' : v === null ? 'unscored' : 'unscored'
  }
  return out
}

/**
 * Read a draft written by the previous implementation and convert it.
 * Returns null when there is nothing usable; never throws.
 */
function migrateLegacy(mode: string): SessionDraft | null {
  try {
    // Only the two modes the legacy implementation covered can have data.
    const keys = LEGACY_SESSION_KEYS[mode]
    if (!keys) return null
    const rawQ = sessionStorage.getItem(keys.q)
    if (!rawQ) return null
    const questions: unknown = JSON.parse(rawQ)
    if (!Array.isArray(questions) || questions.length === 0) return null
    const qids = questions
      .map((q) => (q && typeof q === 'object' && isStr((q as { id?: unknown }).id) ? (q as { id: string }).id : null))
      .filter((id): id is string => !!id)
    if (qids.length === 0) return null

    const sessionId = sessionStorage.getItem(keys.id) || `legacy-${Date.now()}`
    let idx = 0
    let outcomes: Record<string, Outcome> = {}
    const rawRunner = sessionStorage.getItem(LEGACY_RUNNER_PREFIX + sessionId)
    if (rawRunner) {
      const parsed: unknown = JSON.parse(rawRunner)
      if (parsed && typeof parsed === 'object') {
        const r = parsed as { idx?: unknown; results?: unknown }
        if (typeof r.idx === 'number' && Number.isFinite(r.idx)) idx = r.idx
        outcomes = outcomesFromLegacy(r.results)
      }
    }
    if (idx < 0 || idx >= qids.length) idx = 0

    const draft: SessionDraft = {
      mode,
      sessionId,
      qids,
      idx,
      answers: {},
      outcomes,
      skipped: [],
      startedAt: Date.now(),
      savedAt: Date.now(),
    }
    // Adopt it so the two representations can never diverge again.
    saveDraft(draft)
    clearLegacy()
    return valid(draft) ? draft : null
  } catch {
    clearLegacy()
    return null
  }
}

function clearLegacy(): void {
  try {
    for (const k of Object.values(LEGACY_SESSION_KEYS)) {
      sessionStorage.removeItem(k.q)
      sessionStorage.removeItem(k.id)
    }
    // The per-runner key needs the id we just removed, so sweep by prefix.
    const stale: string[] = []
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i)
      if (k && k.startsWith(LEGACY_RUNNER_PREFIX)) stale.push(k)
    }
    for (const k of stale) sessionStorage.removeItem(k)
  } catch {
    /* nothing else to do */
  }
}

export function saveDraft(draft: Omit<SessionDraft, 'savedAt'>): void {
  if (backend) {
    backend.save(draft.mode, { ...draft, savedAt: Date.now() })
    return
  }
  try {
    const payload: SessionDraft = { ...draft, savedAt: Date.now() }
    sessionStorage.setItem(DRAFT_PREFIX + draft.mode, JSON.stringify(payload))
  } catch {
    // Storage full / disabled: a missing draft degrades to "no recovery", which
    // is exactly the pre-existing behaviour. Never let this break the session.
  }
}

export function loadDraft(mode: string): SessionDraft | null {
  if (backend) {
    const v = backend.load(mode)
    return valid(v) ? v : null
  }
  try {
    const raw = sessionStorage.getItem(DRAFT_PREFIX + mode)
    if (!raw) return migrateLegacy(mode)
    const parsed: unknown = JSON.parse(raw)
    if (!valid(parsed)) {
      clearDraft(mode)
      return migrateLegacy(mode)
    }
    return parsed
  } catch {
    clearDraft(mode)
    return null
  }
}

export function clearDraft(mode: string, sessionId?: string): void {
  if (backend) {
    backend.clear(mode, sessionId)
    return
  }
  try {
    sessionStorage.removeItem(DRAFT_PREFIX + mode)
  } catch {
    /* nothing else to do */
  }
}
