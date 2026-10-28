/**
 * One-time adoption of this browser's pre-sync data into the signed-in account.
 *
 * - The legacy database `exampilot-xigai` is only READ, never written or deleted.
 *   It stays as the ultimate fallback copy.
 * - Rows are split by the installed bank: rows of the old 17-question demo are
 *   never migrated (they stay in the legacy DB).
 * - Nothing is uploaded until the user explicitly confirms, seeing the verified
 *   e-mail and a summary. Before migrating, a full JSON backup is written to a
 *   separate local database and read back to verify it.
 * - Migration ops have ids derived from (browser install id, content), and the
 *   fold de-duplicates by history id and record content, so running it again —
 *   on this or another browser — never double counts.
 */
import Dexie from 'dexie'
import { createDb, DB_NAME } from '../db/database'
import { questionById, bank } from '../lib/bank'
import { makeExportPayload, serialize } from '../lib/io'
import type { AiReview, AppSettings, HistoryEntry, MockRun, QRecord } from '../lib/types'
import type { SyncEngine } from './engine'
import { baselineKey } from './fold'
import type { OpKind } from './protocol'

export interface LegacySnapshot {
  exists: boolean
  records: QRecord[]
  history: HistoryEntry[]
  mocks: MockRun[]
  aiReviews: AiReview[]
  settings: AppSettings | null
  demo: { records: number; history: number; mocks: number }
  mockConfig: unknown | null
  drafts: { mode: string; body: unknown }[]
}

const CLAIM_KEY = 'exampilot.legacy.claim'
const DISMISS_PREFIX = 'exampilot.legacy.later.'
const INSTALL_KEY = 'exampilot.installId'

export interface LegacyClaim {
  accountId: string
  email: string
  at: number
}

export function installId(): string {
  let v = localStorage.getItem(INSTALL_KEY)
  if (!v) {
    v = 'inst' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
    localStorage.setItem(INSTALL_KEY, v)
  }
  return v
}
export function readClaim(): LegacyClaim | null {
  try {
    return JSON.parse(localStorage.getItem(CLAIM_KEY) || 'null')
  } catch {
    return null
  }
}
export function isPostponed(accountId: string): boolean {
  const t = Number(localStorage.getItem(DISMISS_PREFIX + accountId) || 0)
  return Date.now() - t < 24 * 3600_000
}
export function postpone(accountId: string) {
  localStorage.setItem(DISMISS_PREFIX + accountId, String(Date.now()))
}

const inBank = (qid: string) => questionById.has(qid)

export async function scanLegacy(): Promise<LegacySnapshot> {
  const empty: LegacySnapshot = {
    exists: false,
    records: [],
    history: [],
    mocks: [],
    aiReviews: [],
    settings: null,
    demo: { records: 0, history: 0, mocks: 0 },
    mockConfig: null,
    drafts: [],
  }
  // Never create the legacy database as a side effect of looking for it.
  if (!(await Dexie.exists(DB_NAME))) return { ...empty, ...localExtras() }
  const db = createDb(DB_NAME)
  try {
    const [records, history, mocks, aiReviews, s] = await Promise.all([
      db.records.toArray(),
      db.history.toArray(),
      db.mocks.toArray(),
      db.aiReviews.toArray(),
      db.settings.get('main'),
    ])
    const mockOk = (m: MockRun) => Object.keys(m.submissions ?? {}).every(inBank)
    let settings: AppSettings | null = null
    if (s) {
      const { id: _id, ...rest } = s
      settings = rest
    }
    return {
      exists: true,
      records: records.filter((r) => inBank(r.qid)),
      history: history.filter((h) => inBank(h.qid)),
      mocks: mocks.filter(mockOk),
      aiReviews: aiReviews.filter((r) => inBank(r.qid)),
      settings,
      demo: {
        records: records.filter((r) => !inBank(r.qid)).length,
        history: history.filter((h) => !inBank(h.qid)).length,
        mocks: mocks.filter((m) => !mockOk(m)).length,
      },
      ...localExtras(),
    }
  } finally {
    db.close()
  }
}

function localExtras() {
  let mockConfig: unknown
  try {
    mockConfig = JSON.parse(localStorage.getItem('exampilot.mock.config') || 'null')
  } catch {
    mockConfig = null
  }
  const drafts: { mode: string; body: unknown }[] = []
  try {
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i)
      if (k && k.startsWith('exampilot.session.')) {
        drafts.push({
          mode: k.slice('exampilot.session.'.length),
          body: JSON.parse(sessionStorage.getItem(k) || 'null'),
        })
      }
    }
  } catch {
    /* ignore */
  }
  return { mockConfig, drafts }
}

export function hasMigratableData(s: LegacySnapshot): boolean {
  return s.records.length + s.history.length + s.mocks.length + s.aiReviews.length > 0
}

/* -------------------------- verified local backup -------------------------- */

class BackupDB extends Dexie {
  backups!: Dexie.Table<
    { id: string; at: number; reason: string; json: string; counts: Record<string, number> },
    string
  >
  constructor() {
    super('exampilot-backups')
    this.version(1).stores({ backups: 'id, at' })
  }
}

export async function backupLegacy(s: LegacySnapshot, reason: string): Promise<{ id: string; json: string }> {
  const payload = makeExportPayload({
    settings: s.settings,
    records: s.records,
    history: s.history,
    mocks: s.mocks,
    aiReviews: s.aiReviews,
    bankFingerprint: '',
    bankCount: bank.questions.length,
  })
  const json = serialize(payload)
  const counts = {
    records: s.records.length,
    history: s.history.length,
    mocks: s.mocks.length,
    aiReviews: s.aiReviews.length,
  }
  const id = 'bk-' + Date.now().toString(36)
  const db = new BackupDB()
  try {
    await db.backups.put({ id, at: Date.now(), reason, json, counts })
    // verify: read back, parse, compare counts
    const back = await db.backups.get(id)
    const parsed = JSON.parse(back!.json)
    if (
      parsed.records.length !== counts.records ||
      parsed.history.length !== counts.history ||
      parsed.mocks.length !== counts.mocks ||
      parsed.aiReviews.length !== counts.aiReviews
    )
      throw new Error('备份校验失败')
  } finally {
    db.close()
  }
  return { id, json }
}

/* ------------------------------- migration -------------------------------- */

function fnv(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0
  return h.toString(36)
}

/** Build import ops (chunked) for a set of rows. Ids are content-derived. */
export function buildImportOps(
  src: string,
  rows: { records: QRecord[]; history: HistoryEntry[]; mocks: MockRun[]; aiReviews: AiReview[] },
  idPrefix: string,
): { kind: OpKind; body: unknown; id: string }[] {
  const histByQ = new Map<string, HistoryEntry[]>()
  for (const h of rows.history) {
    const a = histByQ.get(h.qid) ?? []
    a.push(h)
    histByQ.set(h.qid, a)
  }
  const recordQids = new Set(rows.records.map((r) => r.qid))
  const baselines = rows.records.map((rec) => {
    const hids = (histByQ.get(rec.qid) ?? []).map((h) => h.id)
    return { qid: rec.qid, rec, hids, ck: baselineKey(rec, hids) }
  })
  // History rows whose question has a record are display-only (already counted
  // inside that record); rows without a record are display-only as well, which
  // reproduces the source exactly (it had no progress for them).
  void recordQids
  const out: { kind: OpKind; body: unknown; id: string }[] = []
  const B = 250
  const Hn = 600
  const n = Math.max(
    Math.ceil(baselines.length / B),
    Math.ceil(rows.history.length / Hn),
    rows.mocks.length || rows.aiReviews.length ? 1 : 0,
  )
  for (let i = 0; i < n; i++) {
    const body = {
      src,
      baselines: baselines.slice(i * B, (i + 1) * B),
      history: rows.history.slice(i * Hn, (i + 1) * Hn),
      mocks: i === 0 ? rows.mocks : [],
      aiReviews: i === 0 ? rows.aiReviews : [],
    }
    out.push({ kind: 'import', body, id: `${idPrefix}-${i}-${fnv(JSON.stringify(body))}` })
  }
  return out
}

export async function migrateLegacy(engine: SyncEngine, s: LegacySnapshot): Promise<{ ops: number; backupId: string }> {
  const { id: backupId } = await backupLegacy(s, 'before-migration:' + engine.accountId)
  const inst = installId()
  const items = buildImportOps('legacy:' + inst, s, 'mig-' + inst)
  // Preferences: only fill in what the account has never set (never override another device).
  const st = engine.state.settings
  const neverSet = !engine.state.liveOps && st.theme === 'auto' && st.mockConfig === null
  if (neverSet) {
    const patch: Record<string, unknown> = {}
    if (s.settings) Object.assign(patch, s.settings)
    if (s.mockConfig) patch.mockConfig = s.mockConfig
    if (Object.keys(patch).length) items.push({ kind: 'settings', body: { patch }, id: 'mig-' + inst + '-settings' })
  }
  await engine.commitMany(items)
  for (const d of s.drafts) {
    if (!engine.getDoc('draft.' + d.mode) && d.body) await engine.putDoc('draft.' + d.mode, d.body)
  }
  localStorage.setItem(
    CLAIM_KEY,
    JSON.stringify({ accountId: engine.accountId, email: engine.email, at: Date.now() } satisfies LegacyClaim),
  )
  return { ops: items.length, backupId }
}

export function downloadText(name: string, text: string) {
  const blob = new Blob([text], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  document.body.appendChild(a)
  a.click()
  setTimeout(() => {
    URL.revokeObjectURL(a.href)
    a.remove()
  }, 1000)
}
