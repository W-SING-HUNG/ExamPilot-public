/**
 * Client sync engine (one instance per VERIFIED account).
 *
 * Mechanisms (and where they come from):
 *  - Local outbox written in the same IndexedDB transaction as the change
 *    (Dexie Cloud's mutation-tracking middleware idea): here the change IS the
 *    outbox row — an operation is appended to `ops` with state 'pending' in one
 *    atomic write, so a change can never exist without its upload record.
 *  - Pull applies remote ops AND advances the cursor in one local transaction
 *    (WatermelonDB `synchronize()` / `setLastPulledAt` inside one `db.write`).
 *  - Stable op ids + server dedupe (Replicache mutation ids / push idempotency);
 *    pending ops are re-applied on top of confirmed ones on every fold
 *    (Replicache rebase), so the UI always shows confirmed + pending.
 *  - Ops are marked as uploaded only after the server acknowledged them
 *    (PowerSync CrudBatch.complete()); documents are only marked clean if they
 *    did not change while the request was in flight (WatermelonDB markAsSynced).
 *  - Exponential backoff with jitter, network/visibility triggers, Web Locks +
 *    BroadcastChannel to coordinate tabs.
 */
import Dexie, { type Table } from 'dexie'
import {
  MAX_DOCS_PER_PUSH,
  MAX_OPS_PER_PUSH,
  PROTOCOL_VERSION,
  type DocResult,
  type ExamDocBody,
  type OpKind,
  type OpResult,
  type PullResponse,
  type PushResponse,
  type ServerDoc,
  type WireDocOp,
  type DocOpType,
  EPOCH_FREE_KINDS,
} from './protocol'
import { foldLog, type FoldResult, type LogOp } from './fold'

/* ------------------------------ local schema ------------------------------ */

export interface LocalOp {
  order?: number // auto-increment local creation order
  id: string
  kind: OpKind
  epoch: number
  createdAt: number
  body: unknown
  clientId: string
  /** pending: not yet acknowledged; acked: server stored it, seq may still be unknown */
  state: 'pending' | 'acked' | 'confirmed'
  seq: number | null
}

export interface LocalDoc {
  key: string
  body: unknown
  deleted: boolean
  /** server version this content is based on (0 = never on server) */
  version: number
  /** has local changes not yet acknowledged */
  dirty: boolean
  /** the pending write intent */
  pendingType?: DocOpType
  pendingOpId?: string
  ifSessionId?: string
  leaseGen?: number
  /** last server copy that disagrees with local content */
  conflict?: ServerDoc | null
  /** marker set when the server says the exam lease/time is gone */
  serverNote?: 'lease_lost' | 'expired' | null
  /** who produced the current local content */
  origin?: 'local' | 'remote'
}

export interface QuarantineRow {
  id: string
  at: number
  reason: 'reset' | 'rejected' | 'lease_lost' | 'exam_other_device'
  op: LocalOp
  note?: string
}

export class CloudDB extends Dexie {
  ops!: Table<LocalOp, number>
  docs!: Table<LocalDoc, string>
  meta!: Table<{ k: string; v: unknown }, string>
  quarantine!: Table<QuarantineRow, string>
  constructor(name: string) {
    super(name)
    this.version(1).stores({
      ops: '++order, &id, state, seq',
      docs: 'key',
      meta: 'k',
      quarantine: 'id, at',
    })
  }
}

export function cloudDbName(accountId: string) {
  return 'exampilot-cloud-' + accountId
}

/* ------------------------------- transport -------------------------------- */

export type Fetcher = (path: string, init: RequestInit) => Promise<Response>

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code)
  }
}

/* --------------------------------- status --------------------------------- */

export const REQUEST_TIMEOUT_MS = 20_000

export type SyncPhase =
  'idle' | 'syncing' | 'offline' | 'retrying' | 'auth_expired' | 'account_switched' | 'update_required' | 'quota'

export interface SyncStatus {
  phase: SyncPhase
  pending: number
  dirtyDocs: number
  conflicts: number
  /** wall clock of the last fully successful push+pull */
  lastSyncedAt: number | null
  lastError: string | null
  /** true only when the server confirmed everything this device holds */
  synced: boolean
  /** server clock minus local clock, ms */
  clockOffset: number
}

export interface EngineOptions {
  accountId: string
  email: string
  clientId: string
  bankFp: string
  fetcher: Fetcher
  db?: CloudDB
  /** disable timers / locks (tests) */
  manual?: boolean
}

type Listener = () => void

const rid = () => {
  const b = new Uint8Array(9)
  crypto.getRandomValues(b)
  return [...b].map((x) => x.toString(36).padStart(2, '0')).join('')
}
export const newOpId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${rid()}`

export class SyncEngine {
  readonly db: CloudDB
  readonly accountId: string
  readonly email: string
  readonly clientId: string
  private bankFp: string
  private fetcher: Fetcher
  private manual: boolean

  private opsCache: LocalOp[] = []
  private docsCache = new Map<string, LocalDoc>()
  private quarantineCache: QuarantineRow[] = []
  private folded: FoldResult | null = null
  private listeners = new Set<Listener>()
  private cursor = 0
  private epoch = 1
  private resetSeq = 0
  private disposed = false
  private running: Promise<void> | null = null
  private rerun = false
  private backoffMs = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private pollTimer: ReturnType<typeof setTimeout> | null = null
  private lastActivity = Date.now()
  private bc: BroadcastChannel | null = null
  private examGrader: ((exam: ExamDocBody) => { run: unknown; attempts: unknown[] } | null) | null = null
  status: SyncStatus = {
    phase: 'idle',
    pending: 0,
    dirtyDocs: 0,
    conflicts: 0,
    lastSyncedAt: null,
    lastError: null,
    synced: false,
    clockOffset: 0,
  }

  constructor(o: EngineOptions) {
    this.accountId = o.accountId
    this.email = o.email
    this.clientId = o.clientId
    this.bankFp = o.bankFp
    this.fetcher = o.fetcher
    this.manual = !!o.manual
    this.db = o.db ?? new CloudDB(cloudDbName(o.accountId))
  }

  /* ------------------------------ lifecycle ------------------------------- */

  async init(): Promise<void> {
    await this.reload()
    if (!this.manual) {
      if (typeof BroadcastChannel !== 'undefined') {
        this.bc = new BroadcastChannel('exampilot-sync-' + this.accountId)
        this.bc.onmessage = () => void this.reload()
      }
      if (typeof window !== 'undefined') {
        window.addEventListener('online', this.onWake)
        window.addEventListener('focus', this.onWake)
        window.addEventListener('pageshow', this.onWake)
        document.addEventListener('visibilitychange', this.onVisibility)
      }
      this.schedule(0)
    }
  }

  dispose() {
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    if (this.pollTimer) clearTimeout(this.pollTimer)
    this.bc?.close()
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.onWake)
      window.removeEventListener('focus', this.onWake)
      window.removeEventListener('pageshow', this.onWake)
      document.removeEventListener('visibilitychange', this.onVisibility)
    }
    this.listeners.clear()
    this.db.close()
  }

  private onWake = () => {
    if (this.status.phase === 'auth_expired' || this.status.phase === 'account_switched') return
    this.backoffMs = 0
    this.schedule(0)
  }
  private onVisibility = () => {
    if (document.visibilityState === 'visible') this.onWake()
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
  private emit() {
    for (const l of this.listeners) l()
  }

  /** Re-read everything from IndexedDB (another tab may have written). */
  async reload(): Promise<void> {
    const [ops, docs, meta, q] = await Promise.all([
      this.db.ops.orderBy('order').toArray(),
      this.db.docs.toArray(),
      this.db.meta.toArray(),
      this.db.quarantine.toArray(),
    ])
    const m = new Map(meta.map((x) => [x.k, x.v]))
    this.cursor = Number(m.get('cursor') ?? 0)
    this.epoch = Number(m.get('epoch') ?? 1)
    this.resetSeq = Number(m.get('resetSeq') ?? 0)
    this.status.lastSyncedAt = (m.get('lastSyncedAt') as number) ?? this.status.lastSyncedAt
    this.opsCache = ops
    this.docsCache = new Map(docs.map((d) => [d.key, d]))
    this.quarantineCache = q.sort((a, b) => b.at - a.at)
    this.refold()
  }

  private refold() {
    const confirmed = this.opsCache.filter((o) => o.seq !== null).sort((a, b) => (a.seq as number) - (b.seq as number))
    const tail = this.opsCache.filter((o) => o.seq === null).sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    const log: LogOp[] = [...confirmed, ...tail].map((o) => ({
      id: o.id,
      kind: o.kind,
      seq: o.seq,
      clientId: o.clientId,
      body: o.body,
    }))
    this.folded = foldLog(log)
    this.updateStatus()
    this.emit()
  }

  private updateStatus() {
    const pending = this.opsCache.filter((o) => o.state === 'pending').length
    const unconfirmed = this.opsCache.filter((o) => o.state !== 'confirmed').length
    const dirtyDocs = [...this.docsCache.values()].filter((d) => d.dirty).length
    const conflicts =
      this.quarantineCache.length + [...this.docsCache.values()].filter((d) => d.conflict || d.serverNote).length
    this.status = {
      ...this.status,
      pending: pending + dirtyDocs,
      dirtyDocs,
      conflicts,
      synced:
        unconfirmed === 0 &&
        dirtyDocs === 0 &&
        conflicts === 0 &&
        this.status.lastSyncedAt !== null &&
        (this.status.phase === 'idle' || this.status.phase === 'syncing'),
    }
  }

  private setPhase(phase: SyncPhase, err: string | null = null) {
    this.status = { ...this.status, phase, lastError: err }
    this.updateStatus()
    this.emit()
  }

  /* ------------------------------ read model ------------------------------ */

  get state(): FoldResult {
    return this.folded!
  }
  get localEpoch(): number {
    const pendingResets = this.opsCache.filter((o) => o.kind === 'reset' && o.seq === null).length
    return this.epoch + pendingResets
  }
  get pullCursor() {
    return this.cursor
  }
  get quarantine(): QuarantineRow[] {
    return this.quarantineCache
  }
  getDoc(key: string): LocalDoc | undefined {
    return this.docsCache.get(key)
  }
  allDocs(): LocalDoc[] {
    return [...this.docsCache.values()]
  }
  serverNow(): number {
    return Date.now() + this.status.clockOffset
  }

  /* ------------------------------- writes --------------------------------- */

  /**
   * Record a change. The op row is the change: one atomic IndexedDB write, then
   * the UI updates immediately from the refold, then the upload is scheduled.
   */
  async commit(kind: OpKind, body: unknown, id?: string): Promise<LocalOp> {
    const op: LocalOp = {
      id: id ?? newOpId(kind.slice(0, 3)),
      kind,
      epoch: kind === 'settings' ? this.epoch : this.localEpoch,
      createdAt: Date.now(),
      body,
      clientId: this.clientId,
      state: 'pending',
      seq: null,
    }
    await this.db.transaction('rw', this.db.ops, async () => {
      const existing = await this.db.ops.where('id').equals(op.id).first()
      if (existing) return // idempotent local commit (e.g. double click)
      op.order = await this.db.ops.add(op)
    })
    await this.reload()
    this.touched()
    return op
  }

  /** Commit several ops in ONE local transaction (all or nothing). */
  async commitMany(items: { kind: OpKind; body: unknown; id?: string }[]): Promise<void> {
    await this.db.transaction('rw', this.db.ops, async () => {
      let epoch = this.localEpoch
      for (const it of items) {
        const op: LocalOp = {
          id: it.id ?? newOpId(it.kind.slice(0, 3)),
          kind: it.kind,
          epoch: it.kind === 'settings' ? this.epoch : epoch,
          createdAt: Date.now(),
          body: it.body,
          clientId: this.clientId,
          state: 'pending',
          seq: null,
        }
        if (it.kind === 'reset') epoch++
        if (await this.db.ops.where('id').equals(op.id).first()) continue
        await this.db.ops.add(op)
      }
    })
    await this.reload()
    this.touched()
  }

  /** Write a document locally (draft / exam) and schedule its upload. */
  async putDoc(
    key: string,
    body: unknown,
    intent: Partial<Pick<LocalDoc, 'pendingType' | 'leaseGen' | 'ifSessionId' | 'version'>> = {},
  ) {
    const cur = this.docsCache.get(key)
    const next: LocalDoc = {
      key,
      body,
      deleted: false,
      version: intent.version ?? cur?.version ?? 0,
      dirty: true,
      pendingType: intent.pendingType ?? 'put',
      pendingOpId: newOpId('doc'),
      leaseGen: intent.leaseGen ?? cur?.leaseGen,
      conflict: cur?.conflict ?? null,
      serverNote: null,
      origin: 'local',
    }
    this.docsCache.set(key, next)
    await this.db.docs.put(next)
    this.updateStatus()
    this.emit()
    this.touched(1500)
  }

  /** Replace a document's local content without uploading it. */
  async setDocLocal(key: string, body: unknown) {
    const cur = this.docsCache.get(key)
    if (!cur) return
    const next: LocalDoc = { ...cur, body, dirty: false, pendingType: undefined, pendingOpId: undefined }
    this.docsCache.set(key, next)
    await this.db.docs.put(next)
    this.updateStatus()
    this.emit()
  }

  async deleteDoc(key: string, ifSessionId?: string) {
    const cur = this.docsCache.get(key)
    if (!cur || (cur.deleted && !cur.dirty)) return
    const next: LocalDoc = {
      ...cur,
      body: null,
      deleted: true,
      dirty: cur.version > 0 || cur.dirty,
      pendingType: 'delete',
      pendingOpId: newOpId('doc'),
      ifSessionId,
      conflict: null,
      serverNote: null,
    }
    if (!next.dirty) {
      this.docsCache.delete(key)
      await this.db.docs.delete(key)
    } else {
      this.docsCache.set(key, next)
      await this.db.docs.put(next)
    }
    this.updateStatus()
    this.emit()
    this.touched()
  }

  /** Accept the server's copy of a conflicting document. */
  async resolveDocUseServer(key: string) {
    const cur = this.docsCache.get(key)
    if (!cur?.conflict) return
    const s = cur.conflict
    const next: LocalDoc = {
      key,
      body: s.body,
      deleted: s.deleted,
      version: s.version,
      dirty: false,
      conflict: null,
      serverNote: null,
      leaseGen: (s.body as ExamDocBody | null)?.leaseGen,
      origin: 'remote',
    }
    this.docsCache.set(key, next)
    await this.db.docs.put(next)
    this.updateStatus()
    this.emit()
  }

  /** Keep this device's copy: re-send it on top of the server's version. */
  async resolveDocKeepLocal(key: string) {
    const cur = this.docsCache.get(key)
    if (!cur?.conflict) return
    const next: LocalDoc = {
      ...cur,
      version: cur.conflict.version,
      dirty: true,
      pendingOpId: newOpId('doc'),
      conflict: null,
    }
    this.docsCache.set(key, next)
    await this.db.docs.put(next)
    this.updateStatus()
    this.emit()
    this.touched()
  }

  async clearDocNote(key: string) {
    const cur = this.docsCache.get(key)
    if (!cur) return
    const next = { ...cur, serverNote: null }
    this.docsCache.set(key, next)
    await this.db.docs.put(next)
    this.updateStatus()
    this.emit()
  }

  /** Re-issue quarantined learning ops as new ops in the current epoch. */
  async restoreQuarantined(ids: string[]) {
    const rows = this.quarantineCache.filter((q) => ids.includes(q.id))
    await this.db.transaction('rw', this.db.ops, this.db.quarantine, async () => {
      for (const r of rows) {
        if (r.op.kind === 'reset' || r.op.kind === 'clear_qids' || r.op.kind === 'hide_history') {
          await this.db.quarantine.delete(r.id)
          continue
        }
        await this.db.ops.add({
          ...r.op,
          order: undefined,
          id: r.op.id + '-r' + rid().slice(0, 4),
          epoch: this.localEpoch,
          state: 'pending',
          seq: null,
          clientId: this.clientId,
        })
        await this.db.quarantine.delete(r.id)
      }
    })
    await this.reload()
    this.touched()
  }
  async discardQuarantined(ids: string[]) {
    await this.db.quarantine.bulkDelete(ids)
    await this.reload()
  }

  setExamGrader(fn: (exam: ExamDocBody) => { run: unknown; attempts: unknown[] } | null) {
    this.examGrader = fn
  }

  /* ------------------------------ scheduling ------------------------------ */

  private touched(delay = 600) {
    this.lastActivity = Date.now()
    this.bc?.postMessage('changed')
    if (!this.manual) this.schedule(delay)
  }

  private schedule(delay: number) {
    if (this.disposed) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.syncNow(), delay)
  }

  private schedulePoll() {
    if (this.manual || this.disposed) return
    if (this.pollTimer) clearTimeout(this.pollTimer)
    const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden'
    if (hidden) return // resumes on visibilitychange
    const recent = Date.now() - this.lastActivity < 5 * 60_000
    const delay = this.backoffMs > 0 ? this.backoffMs : recent ? 20_000 : 60_000
    this.pollTimer = setTimeout(() => void this.syncNow(), delay)
  }

  /** Run one push+pull cycle (coalesced; one at a time across tabs via Web Locks). */
  syncNow(): Promise<void> {
    if (this.running) {
      this.rerun = true
      return this.running
    }
    const run = async () => {
      do {
        this.rerun = false
        await this.withLock(() => this.cycle())
      } while (this.rerun && !this.disposed)
    }
    this.running = run().finally(() => {
      this.running = null
      this.schedulePoll()
    })
    return this.running
  }

  private async withLock(fn: () => Promise<void>) {
    const locks = (
      typeof navigator !== 'undefined' ? (navigator as Navigator & { locks?: LockManager }).locks : undefined
    ) as LockManager | undefined
    if (!locks || this.manual) return fn()
    await locks.request('exampilot-sync-' + this.accountId, async () => {
      await this.reload() // another tab may have pushed/pulled while we waited
      await fn()
    })
  }

  private async cycle() {
    if (this.disposed) return
    if (['auth_expired', 'account_switched', 'update_required'].includes(this.status.phase)) return
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      this.setPhase('offline')
      return
    }
    this.setPhase('syncing')
    try {
      for (let i = 0; i < 50; i++) {
        const more = await this.pushOnce()
        if (!more) break
      }
      for (let i = 0; i < 100; i++) {
        const more = await this.pullOnce()
        if (!more) break
      }
      // a pull may have produced nothing to push, but a push during pull (other tab) is caught by rerun
      this.backoffMs = 0
      await this.db.meta.put({ k: 'lastSyncedAt', v: Date.now() })
      this.status.lastSyncedAt = Date.now()
      this.setPhase('idle')
      await this.maybeAutoFixLateExam()
    } catch (e) {
      this.handleError(e)
    }
  }

  private handleError(e: unknown) {
    if (e instanceof HttpError) {
      if (e.code === 'unauthenticated' || e.status === 401 || e.code === 'redirect')
        return this.setPhase('auth_expired', e.code)
      if (e.code === 'identity_mismatch') return this.setPhase('account_switched', e.code)
      if (e.code === 'bank_mismatch' || e.code === 'protocol_unsupported')
        return this.setPhase('update_required', e.code)
      if (e.code === 'quota_exceeded') {
        this.bump(15 * 60_000)
        return this.setPhase('quota', e.code)
      }
    }
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false
    this.bump()
    this.setPhase(offline ? 'offline' : 'retrying', String((e as Error)?.message || e))
  }

  private bump(min = 0) {
    const next = this.backoffMs ? Math.min(this.backoffMs * 2, 120_000) : 2_000
    this.backoffMs = Math.max(min, Math.round(next * (0.75 + Math.random() * 0.5)))
  }

  /* ------------------------------- network -------------------------------- */

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    let res: Response
    // A request can hang forever on flaky mobile networks (or across an
    // offline/online flip). A hung request would hold the sync lock and block
    // every later cycle, so each request gets a hard deadline.
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null
    const killer = ctl ? setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS) : null
    try {
      res = await this.fetcher(path, {
        ...init,
        ...(ctl ? { signal: ctl.signal } : {}),
        credentials: 'same-origin',
        redirect: 'manual',
        cache: 'no-store',
        headers: {
          'X-ExamPilot-Sync': '1',
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
          ...(init.headers ?? {}),
        },
      })
    } catch (e) {
      if (killer) clearTimeout(killer)
      const err = new Error('network: ' + String((e as Error)?.message || e))
      throw Object.assign(err, { cause: e })
    }
    // Access answers an expired session with a redirect to its login page.
    if (
      res.type === 'opaqueredirect' ||
      (res.status >= 300 && res.status < 400) ||
      !(res.headers.get('Content-Type') || '').includes('application/json')
    ) {
      if (killer) clearTimeout(killer)
    }
    if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) throw new HttpError(401, 'redirect')
    const ct = res.headers.get('Content-Type') || ''
    if (!ct.includes('application/json')) {
      if (res.status === 401 || res.status === 403) throw new HttpError(401, 'unauthenticated')
      throw new HttpError(res.status, 'http_' + res.status)
    }
    let data: T & { ok?: boolean; error?: string }
    try {
      data = (await res.json()) as T & { ok?: boolean; error?: string }
    } catch (e) {
      const err = new Error('network: ' + String((e as Error)?.message || e))
      throw Object.assign(err, { cause: e })
    } finally {
      if (killer) clearTimeout(killer)
    }
    if (!res.ok || data.ok === false) throw new HttpError(res.status, data.error || 'http_' + res.status)
    const now = (data as { now?: number }).now
    if (typeof now === 'number') this.status.clockOffset = now - Date.now()
    return data
  }

  private async pushOnce(): Promise<boolean> {
    const pending = await this.db.ops.where('state').equals('pending').sortBy('order')
    const batch = pending.slice(0, MAX_OPS_PER_PUSH)
    const dirty = (await this.db.docs.toArray()).filter((d) => d.dirty).slice(0, MAX_DOCS_PER_PUSH)
    if (batch.length === 0 && dirty.length === 0) return false
    const docOps: WireDocOp[] = dirty.map((d) => ({
      opId: d.pendingOpId ?? newOpId('doc'),
      key: d.key,
      type: d.pendingType ?? (d.deleted ? 'delete' : 'put'),
      baseVersion: d.version,
      ...(d.deleted ? {} : { body: d.body }),
      ...(d.leaseGen !== undefined ? { leaseGen: d.leaseGen } : {}),
      ...(d.ifSessionId ? { ifSessionId: d.ifSessionId } : {}),
    }))
    const sentDocs = new Map(dirty.map((d) => [d.key, JSON.stringify([d.body, d.deleted, d.pendingOpId])]))
    const res = await this.request<PushResponse>('/api/sync/push', {
      method: 'POST',
      body: JSON.stringify({
        protocol: PROTOCOL_VERSION,
        clientId: this.clientId,
        accountId: this.accountId,
        bankFp: this.bankFp,
        ops: batch.map((o) => ({ id: o.id, kind: o.kind, epoch: o.epoch, createdAt: o.createdAt, body: o.body })),
        docs: docOps,
      }),
    })
    await this.applyPushResult(res.ops, res.docs, sentDocs, batch)
    await this.reload()
    return pending.length > batch.length || dirty.length === MAX_DOCS_PER_PUSH
  }

  private async applyPushResult(ops: OpResult[], docs: DocResult[], sentDocs: Map<string, string>, batch: LocalOp[]) {
    const byId = new Map(batch.map((o) => [o.id, o]))
    await this.db.transaction('rw', this.db.ops, this.db.docs, this.db.quarantine, async () => {
      for (const r of ops) {
        const local = byId.get(r.id)
        if (!local) continue
        const row = await this.db.ops.where('id').equals(r.id).first()
        if (!row) continue
        if (r.status === 'ok' || r.status === 'dup') {
          await this.db.ops.update(row.order!, { state: 'acked', seq: r.seq ?? row.seq })
        } else if (r.status === 'late' && local.kind === 'mock' && r.doc && this.examGrader) {
          // Submitted after the deadline with answers changed after it: re-grade
          // with the answers the server held at the deadline (timer semantics kept).
          const fixed = this.examGrader(r.doc.body as ExamDocBody)
          if (fixed) {
            await this.db.ops.update(row.order!, { body: { ...(local.body as object), ...fixed } })
          } else {
            await this.quarantineOp(row, 'rejected', 'late exam submission')
          }
        } else {
          const reason = r.status === 'stale_epoch' ? 'reset' : r.status === 'lease_lost' ? 'lease_lost' : 'rejected'
          await this.quarantineOp(row, reason, r.reason)
        }
      }
      for (const r of docs) {
        const cur = await this.db.docs.get(r.key)
        if (!cur) continue
        const unchanged = sentDocs.get(r.key) === JSON.stringify([cur.body, cur.deleted, cur.pendingOpId])
        if (r.status === 'ok' || r.status === 'dup') {
          const sd = r.doc
          if (unchanged) {
            if (sd && (sd.deleted || cur.deleted)) {
              // keep a tombstone: the next write must be based on this version
              if (sd.deleted)
                await this.db.docs.put({
                  key: r.key,
                  body: null,
                  deleted: true,
                  version: sd.version,
                  dirty: false,
                  conflict: null,
                  serverNote: null,
                })
              else
                await this.db.docs.put({
                  key: r.key,
                  body: sd.body,
                  deleted: false,
                  version: sd.version,
                  dirty: false,
                  leaseGen: (sd.body as ExamDocBody | null)?.leaseGen,
                })
            } else if (sd) {
              await this.db.docs.put({
                key: r.key,
                body: r.key === 'exam.current' ? sd.body : cur.body,
                deleted: false,
                version: sd.version,
                dirty: false,
                leaseGen: (sd.body as ExamDocBody | null)?.leaseGen ?? cur.leaseGen,
              })
            }
          } else if (sd) {
            // changed while in flight: keep dirty, rebase on the new version
            const keepType: DocOpType | undefined =
              cur.pendingType === 'exam_start' || cur.pendingType === 'exam_takeover' ? 'exam_save' : cur.pendingType
            await this.db.docs.put({
              ...cur,
              version: sd.version,
              pendingType: keepType,
              leaseGen: (sd.body as ExamDocBody | null)?.leaseGen ?? cur.leaseGen,
            })
          }
        } else if (r.status === 'conflict') {
          if (r.key.startsWith('draft.') && r.doc?.deleted && !cur.deleted && unchanged) {
            // The server only holds a deleted placeholder: nothing to lose, so
            // re-send this device's draft on top of it instead of asking the user.
            await this.db.docs.put({
              ...cur,
              version: r.doc.version,
              dirty: true,
              pendingOpId: newOpId('doc'),
              conflict: null,
            })
            this.rerun = true
          } else if (r.key === 'exam.current') {
            // The running exam is server-authoritative: a start/takeover that
            // lost the race simply adopts what the server holds now.
            const sd = r.doc
            if (!sd || sd.deleted)
              await this.db.docs.put({
                key: r.key,
                body: null,
                deleted: true,
                version: sd?.version ?? cur.version,
                dirty: false,
                conflict: null,
                serverNote: null,
              })
            else
              await this.db.docs.put({
                key: r.key,
                body: sd.body,
                deleted: false,
                version: sd.version,
                dirty: false,
                conflict: null,
                serverNote: null,
                leaseGen: (sd.body as ExamDocBody | null)?.leaseGen,
                origin: sd.holder === this.clientId ? 'local' : 'remote',
              })
          } else {
            await this.db.docs.put({ ...cur, dirty: false, conflict: r.doc })
          }
        } else if (r.status === 'lease_lost' || r.status === 'expired') {
          const sd = r.doc
          await this.db.docs.put({
            key: r.key,
            body: sd?.body ?? cur.body,
            deleted: sd?.deleted ?? false,
            version: sd?.version ?? cur.version,
            dirty: false,
            leaseGen: (sd?.body as ExamDocBody | null)?.leaseGen ?? cur.leaseGen,
            serverNote: r.status,
            conflict: null,
          })
        } else {
          // rejected: keep the content locally, stop retrying
          await this.db.docs.put({ ...cur, dirty: false, serverNote: 'expired' })
        }
      }
    })
  }

  private async quarantineOp(row: LocalOp, reason: QuarantineRow['reason'], note?: string) {
    await this.db.quarantine.put({ id: row.id, at: Date.now(), reason, op: row, note })
    await this.db.ops.delete(row.order!)
  }

  private async pullOnce(): Promise<boolean> {
    const since = this.cursor
    const res = await this.request<PullResponse>(`/api/sync/pull?since=${since}`, { method: 'GET' })
    await this.db.transaction('rw', this.db.ops, this.db.docs, this.db.meta, async () => {
      // cursor guard (WatermelonDB): if another tab advanced the cursor meanwhile, drop this result
      const curCursor = Number((await this.db.meta.get('cursor'))?.v ?? 0)
      if (curCursor !== since) return
      for (const s of res.ops) {
        const row = await this.db.ops.where('id').equals(s.id).first()
        if (row) {
          await this.db.ops.update(row.order!, { seq: s.seq, state: 'confirmed', epoch: s.epoch })
        } else {
          await this.db.ops.add({
            id: s.id,
            kind: s.kind,
            epoch: s.epoch,
            createdAt: s.createdAt,
            body: s.body,
            clientId: s.clientId,
            state: 'confirmed',
            seq: s.seq,
          })
        }
      }
      for (const d of res.docs) {
        const cur = await this.db.docs.get(d.key)
        if (cur?.dirty) {
          if (d.version > cur.version && d.holder !== this.clientId) {
            // someone else wrote a newer version while we have unsent changes
            if (d.key === 'exam.current') {
              const sb = d.body as ExamDocBody | null
              if (!sb || d.deleted || sb.status !== 'active' || sb.leaseGen !== cur.leaseGen) {
                await this.db.docs.put({
                  key: d.key,
                  body: d.body,
                  deleted: d.deleted,
                  version: d.version,
                  dirty: false,
                  leaseGen: sb?.leaseGen,
                  serverNote: sb?.status === 'active' ? 'lease_lost' : 'expired',
                })
              } else {
                await this.db.docs.put({ ...cur, version: d.version })
              }
            } else {
              await this.db.docs.put({ ...cur, dirty: false, conflict: d })
            }
          }
          continue
        }
        if (cur?.conflict) {
          // unresolved conflict: keep the user's copy, refresh the server side of it
          if (d.version >= cur.conflict.version) await this.db.docs.put({ ...cur, conflict: d })
          continue
        }
        if (cur && cur.version >= d.version) continue
        if (d.deleted)
          await this.db.docs.put({
            key: d.key,
            body: null,
            deleted: true,
            version: d.version,
            dirty: false,
            conflict: null,
            serverNote: null,
          })
        else
          await this.db.docs.put({
            key: d.key,
            body: d.body,
            deleted: false,
            version: d.version,
            dirty: false,
            leaseGen: (d.body as ExamDocBody | null)?.leaseGen,
            conflict: null,
            origin: d.holder === this.clientId ? 'local' : 'remote',
          })
      }
      await this.db.meta.bulkPut([
        { k: 'cursor', v: res.head },
        { k: 'epoch', v: res.epoch },
        { k: 'resetSeq', v: res.resetSeq },
      ])
      // Ops before the last confirmed reset are dead everywhere: prune them.
      if (res.resetSeq > 0) {
        const dead = (await this.db.ops.where('seq').below(res.resetSeq).toArray())
          .filter((o) => !EPOCH_FREE_KINDS.includes(o.kind))
          .map((o) => o.order!)
        if (dead.length) await this.db.ops.bulkDelete(dead)
      }
    })
    // acked ops that the server did not list (they predate `since`) are confirmed too
    await this.db.transaction('rw', this.db.ops, async () => {
      const acked = await this.db.ops.where('state').equals('acked').toArray()
      for (const a of acked)
        if (a.seq !== null && a.seq <= res.head) await this.db.ops.update(a.order!, { state: 'confirmed' })
    })
    await this.reload()
    return res.more
  }

  /** If the server marked our exam submission late, the grader already fixed it; nothing else here. */
  private async maybeAutoFixLateExam() {}
}
