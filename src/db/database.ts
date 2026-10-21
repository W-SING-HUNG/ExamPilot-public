import Dexie, { type EntityTable } from 'dexie'
import type { QRecord, HistoryEntry, MockRun, AiReview, AppSettings } from '../lib/types'

type SettingsRow = AppSettings & { id: 'main' }

const DB_VERSION = 1

export const DB_NAME = 'exampilot-xigai'

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'auto',
  reviewIntervalBase: 1,
  studyTarget: 30,
  dailyGoalQuestions: 30,
}

export class ExamPilotDB extends Dexie {
  records!: EntityTable<QRecord, 'qid'>
  history!: EntityTable<HistoryEntry, 'id'>
  mocks!: EntityTable<MockRun, 'id'>
  aiReviews!: EntityTable<AiReview, 'id'>
  settings!: EntityTable<SettingsRow, 'id'>

  constructor(name = DB_NAME) {
    super(name)
    this.version(DB_VERSION).stores({
      records: 'qid, status, nextReviewAt, lastSeenAt, attempts, wrongCount',
      history: 'id, qid, mode, sessionId, submittedAt',
      mocks: 'id, startedAt, endedAt',
      aiReviews: 'id, qid, createdAt',
      settings: 'id',
    })
  }
}

/** Create an isolated database instance (used by tests to avoid touching real data). */
export function createDb(name: string): ExamPilotDB {
  return new ExamPilotDB(name)
}

export const db = createDb(DB_NAME)

export async function readSettings(): Promise<AppSettings> {
  const row = await db.settings.get('main')
  return row ?? DEFAULT_SETTINGS
}
export async function writeSettings(s: AppSettings): Promise<void> {
  const row: SettingsRow = { ...s, id: 'main' }
  await db.settings.put(row)
}

/**
 * How a restore should treat the settings table.
 *
 *  - `keep`  — leave the existing settings untouched (merge with no backup settings)
 *  - `set`   — replace settings with `settings`
 *  - `reset` — clear the table so the app falls back to DEFAULT_SETTINGS
 *              (replace with no usable settings in the backup)
 */
export type SettingsAction = 'keep' | 'set' | 'reset'

export interface RestoreInput {
  records: QRecord[]
  history: HistoryEntry[]
  mocks: MockRun[]
  aiReviews: AiReview[]
  /** Explicit settings semantics; defaults to 'keep' so nothing is lost silently. */
  settingsAction?: SettingsAction
  /** required when settingsAction === 'set' */
  settings?: AppSettings | null
}

/**
 * Restore a backup into a database in a SINGLE transaction.
 *
 * All-or-nothing: if any write throws, Dexie aborts the transaction and every
 * table keeps its previous content, so a failed import cannot leave a
 * half-restored database. Returns the number of rows written per table.
 *
 * Settings are handled according to `settingsAction` so the database always
 * matches what the UI reported to the user:
 *  - 'keep'  → the settings row is not touched at all
 *  - 'set'   → the row becomes `settings`
 *  - 'reset' → the row is deleted, so `readSettings()` returns DEFAULT_SETTINGS
 */
export async function restoreBackupInto(
  target: ExamPilotDB,
  input: RestoreInput,
): Promise<{ records: number; history: number; mocks: number; aiReviews: number; settings: number }> {
  const counts = { records: 0, history: 0, mocks: 0, aiReviews: 0, settings: 0 }
  const action: SettingsAction = input.settingsAction ?? 'keep'
  await target.transaction(
    'rw',
    target.records,
    target.history,
    target.mocks,
    target.aiReviews,
    target.settings,
    async () => {
      await target.records.clear()
      await target.history.clear()
      await target.mocks.clear()
      await target.aiReviews.clear()

      if (action === 'reset') {
        await target.settings.clear()
      } else if (action === 'set') {
        if (input.settings) {
          await target.settings.put({ ...input.settings, id: 'main' })
          counts.settings = 1
        } else {
          // 'set' without a value is meaningless; behave like reset rather than
          // leaving a half-applied state.
          await target.settings.clear()
        }
      }
      // action === 'keep' -> settings table is deliberately left as-is

      if (input.records.length) {
        await target.records.bulkPut(input.records)
        counts.records = input.records.length
      }
      if (input.history.length) {
        await target.history.bulkPut(input.history)
        counts.history = input.history.length
      }
      if (input.mocks.length) {
        await target.mocks.bulkPut(input.mocks)
        counts.mocks = input.mocks.length
      }
      if (input.aiReviews.length) {
        await target.aiReviews.bulkPut(input.aiReviews)
        counts.aiReviews = input.aiReviews.length
      }
    },
  )
  return counts
}

/** Read the whole database as a plain snapshot (for export / verification). */
export async function snapshotDb(target: ExamPilotDB): Promise<{
  records: QRecord[]
  history: HistoryEntry[]
  mocks: MockRun[]
  aiReviews: AiReview[]
  settings: AppSettings | null
}> {
  const [records, history, mocks, aiReviews, settingsRow] = await Promise.all([
    target.records.toArray(),
    target.history.toArray(),
    target.mocks.toArray(),
    target.aiReviews.toArray(),
    target.settings.get('main'),
  ])
  let settings: AppSettings | null = null
  if (settingsRow) {
    const { id: _id, ...rest } = settingsRow
    settings = rest
  }
  return { records, history, mocks, aiReviews, settings }
}
