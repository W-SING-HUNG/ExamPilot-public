export type QuestionType = 'single' | 'multi' | 'judge' | 'short' | 'material'
export type Mastery = 'new' | 'learning' | 'mastered' | 'struggling'

export interface Question {
  id: string
  chapter: string
  chapterIndex: number
  type: QuestionType
  bankNo: number
  pageStart: number | null
  pageEnd: number | null
  stem: string
  options: string[]
  answer: string | null // normalized letters string, or boolean string for judge? keep string; see answerNorm
  answerNorm: string | boolean | null
  hasOfficialAnswer: boolean
  isFlagged: boolean
  flagReason: string
}

export interface QRecord {
  qid: string
  status: 'new' | 'learning' | 'mastered' | 'struggling'
  attempts: number
  correctCount: number
  wrongCount: number
  lastSeenAt: number
  lastCorrect: boolean | null
  lastAnswer: string | null
  intervalDays: number
  ease: number
  nextReviewAt: number
}

export interface HistoryEntry {
  id: string
  qid: string
  mode: string // practice | mock | review | chapter | special
  sessionId: string
  answer: string | null
  isCorrect: boolean | null // null => not auto-scored (subjective)
  submittedAt: number
  usedAI: boolean
}

export interface MockConfig {
  singleCount: number
  multiCount: number
  judgeCount: number
  shortCount: number
  singleScore: number
  multiScore: number
  judgeScore: number
  shortScore: number
  durationMin: number
  chapters: string[] | 'all'
}

/** Per-question grading outcome. `unanswered` is distinct from `wrong`. */
export interface MockQuestionResult {
  /** null = not auto-scored (subjective); true/false = objective grading */
  isCorrect: boolean | null
  points: number
  /** true when the user left the question blank (never counted as wrong) */
  unanswered: boolean
}

export interface MockRun {
  id: string
  startedAt: number
  endedAt: number | null
  config: MockConfig
  submissions: Record<string, string | null> // qid -> answer (letters/boolean/text)
  graded: boolean
  score: number | null
  maxScore: number
  /** Points obtainable from auto-graded objective questions only. */
  objectiveMaxScore: number
  /** Points reserved for subjective questions, never auto-scored. */
  subjectiveMaxScore: number
  perQuestion: Record<string, MockQuestionResult>
}

export interface AiReview {
  id: string
  qid: string
  userAnswer: string
  createdAt: number
  provider: string
  model: string
  result: AiGradeResult
}

export interface AiGradeResult {
  score: number // 0-100 simulated score
  maxScore: number // 100
  hitPoints: string[] // 命中的采分点
  missedPoints: string[] // 遗漏内容
  deductions: string[] // 扣分依据
  suggestions: string[] // 修改建议
  structureNote: string // 答题结构点评
  disclaimer: string // 参考评阅声明
}

export interface AppSettings {
  theme: 'light' | 'dark' | 'auto'
  reviewIntervalBase: number // days multiplier
  studyTarget: number // target minutes per day
  dailyGoalQuestions: number
}

export type BankData = {
  schema: string
  source: string
  generatedAt: string
  chapterOrder: string[]
  countsByType: Record<string, number>
  questions: Question[]
}
