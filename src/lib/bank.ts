import type { Question, BankData } from './types'
import sampleBank from '../../data/sample-bank.json'
import { LOCAL_BANK } from './local-bank.generated'

/**
 * Question bank loader.
 *
 * The public repository ships only `data/sample-bank.json` (a small, self-authored
 * demo set) so the project installs, builds and tests without any private content.
 *
 * A user with the full licensed course bank places it at `data/bank.json`
 * (git-ignored) and runs `npm run bank:local`. That generates a git-ignored
 * loader which this module prefers over the sample. The full bank is never
 * committed and never enters the public build.
 *
 * At runtime a bank exported from another ExamPilot instance can also be loaded
 * through 「导入导出」→ 题库导入 without rebuilding.
 */
const sample = sampleBank as unknown as BankData

function detectFullBank(): BankData | null {
  if (typeof window === 'undefined') return null
  const cached = (window as unknown as { __EXAMPILOT_BANK__?: BankData }).__EXAMPILOT_BANK__
  if (cached && Array.isArray(cached.questions) && cached.questions.length > 0) return cached
  return null
}

export const bank: BankData = detectFullBank() ?? LOCAL_BANK ?? sample

/** True when the running app uses the bundled demo bank instead of a full course bank. */
export const usingSampleBank: boolean = bank === sample

export const allQuestions: Question[] = bank.questions

export const chapterOrder: string[] = bank.chapterOrder

export const questionById = new Map(allQuestions.map((q) => [q.id, q]))

export const TYPE_LABEL: Record<Question['type'], string> = {
  single: '单选题',
  multi: '多选题',
  judge: '判断题',
  short: '简答题',
  material: '材料分析题',
}

export const objectiveQuestions = allQuestions.filter((q) => q.type !== 'short' && q.type !== 'material')
export const subjectiveQuestions = allQuestions.filter((q) => q.type === 'short' || q.type === 'material')

export function questionsOfChapter(ch: string): Question[] {
  return allQuestions.filter((q) => q.chapter === ch)
}

export function questionsOfType(t: Question['type']): Question[] {
  return allQuestions.filter((q) => q.type === t)
}

export const CHAPTER_ORDER_FULL = chapterOrder

/**
 * Load a full bank at runtime (e.g. a JSON exported from another ExamPilot
 * instance) and validate it before it becomes the active bank.
 */
export function installFullBank(data: unknown): { ok: boolean; error?: string } {
  if (!data || typeof data !== 'object') return { ok: false, error: '数据不是对象' }
  const d = data as Partial<BankData>
  if (!Array.isArray(d.questions) || d.questions.length === 0) return { ok: false, error: 'questions 为空或不是数组' }
  if (!Array.isArray(d.chapterOrder) || d.chapterOrder.length === 0)
    return { ok: false, error: 'chapterOrder 为空或不是数组' }
  for (const q of d.questions) {
    if (typeof q?.id !== 'string' || !q.id) return { ok: false, error: '存在缺少 id 的题目' }
    if (typeof q?.stem !== 'string' || !q.stem) return { ok: false, error: `题目 ${q.id} 缺少题干` }
    if (!['single', 'multi', 'judge', 'short', 'material'].includes(q.type)) {
      return { ok: false, error: `题目 ${q.id} 题型非法` }
    }
  }
  ;(window as unknown as { __EXAMPILOT_BANK__?: BankData }).__EXAMPILOT_BANK__ = data as BankData
  return { ok: true }
}
