import type { QRecord, Question, HistoryEntry } from './types'

/** How many weak/uncovered chapters the diagnosis surfaces. */
export const WEAK_POINT_LIMIT = 6

/**
 * A chapter with at least this share of its objective questions attempted and
 * this correct rate is considered consolidated and is not surfaced.
 */
const CONSOLIDATED_COVERAGE = 0.99
const CONSOLIDATED_RATE = 0.8

export interface TypeStat {
  type: Question['type']
  label: string
  total: number
  attempted: number
  coverage: number // attempted/total
  correct: number
  wrong: number
  correctRate: number // among attempted
  mastered: number
  struggling: number
}

export interface ChapterStat {
  chapter: string
  /** Objective + subjective questions in this chapter. */
  total: number
  /** Objective questions only — the denominator of `coverage`. */
  objectiveTotal: number
  /** Subjective questions only; never auto-scored. */
  subjectiveTotal: number
  attempted: number
  coverage: number
  correct: number
  wrong: number
  correctRate: number
  mastered: number
  struggling: number
  single: number
  multi: number
  judge: number
  subj: number
}

/**
 * Why a chapter appears in the weak-point list.
 *
 *  - `weak`      — attempted, but coverage or correct rate is still short.
 *  - `uncovered` — never attempted at all.
 *
 * The two kinds carry different evidence and must never be ranked against each
 * other by a single blended score: an all-wrong chapter and a never-touched
 * chapter are both problems, but only one of them has a measured failure rate.
 */
export type WeakPointKind = 'weak' | 'uncovered'

export interface WeakPoint {
  chapter: string
  score: number // lower = weaker (0-100); always 0 for `uncovered`
  detail: string
  kind: WeakPointKind
}

export interface Diagnosis {
  chapters: ChapterStat[]
  types: TypeStat[]
  weakPoints: WeakPoint[]
  overall: {
    total: number
    attempted: number
    coverage: number
    ourMastered: number
    correct: number
    wrong: number
    correctRate: number
    objectiveAttempted: number
    subjectiveAttempted: number
  }
}

const isSubjective = (q: Question) => q.type === 'short' || q.type === 'material'

export function computeDiagnosis(questions: Question[], records: Map<string, QRecord>): Diagnosis {
  const byChapterMap: Record<string, Question[]> = {}
  for (const q of questions) {
    ;(byChapterMap[q.chapter] ??= []).push(q)
  }
  const chapterOrder = Array.from(new Set(questions.map((q) => q.chapter)))

  const chapters: ChapterStat[] = chapterOrder.map((ch) => {
    const list = byChapterMap[ch] ?? []
    const obj = list.filter((q) => !isSubjective(q))
    const subj = list.filter(isSubjective)
    // Records only exist for questions that have been attempted; a missing record
    // means "no data", which is never treated as mastered or correct.
    const recs = obj.map((q) => records.get(q.id)).filter((r): r is QRecord => !!r)
    const attempted = recs.filter((r) => r.attempts > 0).length
    const correct = recs.reduce((s, r) => s + r.correctCount, 0)
    const wrong = recs.reduce((s, r) => s + r.wrongCount, 0)
    const totalAttempts = correct + wrong
    return {
      chapter: ch,
      total: obj.length + subj.length,
      objectiveTotal: obj.length,
      subjectiveTotal: subj.length,
      attempted,
      coverage: obj.length ? attempted / obj.length : 0,
      correct,
      wrong,
      correctRate: totalAttempts ? correct / totalAttempts : 0,
      mastered: recs.filter((r) => r.status === 'mastered').length,
      struggling: recs.filter((r) => r.status === 'struggling').length,
      single: obj.filter((q) => q.type === 'single').length,
      multi: obj.filter((q) => q.type === 'multi').length,
      judge: obj.filter((q) => q.type === 'judge').length,
      subj: subj.length,
    }
  })

  const typeLabels: Record<Question['type'], string> = {
    single: '单选题',
    multi: '多选题',
    judge: '判断题',
    short: '简答题',
    material: '材料分析题',
  }
  const types: TypeStat[] = (['single', 'multi', 'judge', 'short', 'material'] as Question['type'][]).map((t) => {
    const list = questions.filter((q) => q.type === t)
    const recs = list.map((q) => records.get(q.id)).filter((r): r is QRecord => !!r)
    const attempted = recs.filter((r) => r.attempts > 0).length
    const correct = recs.reduce((s, r) => s + r.correctCount, 0)
    const wrong = recs.reduce((s, r) => s + r.wrongCount, 0)
    const tt = correct + wrong
    return {
      type: t,
      label: typeLabels[t],
      total: list.length,
      attempted,
      coverage: list.length ? attempted / list.length : 0,
      correct,
      wrong,
      correctRate: tt ? correct / tt : 0,
      mastered: recs.filter((r) => r.status === 'mastered').length,
      struggling: recs.filter((r) => r.status === 'struggling').length,
    }
  })

  const obj = questions.filter((q) => !isSubjective(q))
  const allRecs = obj.map((q) => records.get(q.id)).filter((r): r is QRecord => !!r)
  const attempted = allRecs.filter((r) => r.attempts > 0).length
  const correct = allRecs.reduce((s, r) => s + r.correctCount, 0)
  const wrong = allRecs.reduce((s, r) => s + r.wrongCount, 0)
  const tt = correct + wrong
  return {
    chapters,
    types,
    weakPoints: rankWeakPoints(chapters),
    overall: {
      total: obj.length,
      attempted,
      coverage: obj.length ? attempted / obj.length : 0,
      ourMastered: allRecs.filter((r) => r.status === 'mastered').length,
      correct,
      wrong,
      correctRate: tt ? correct / tt : 0,
      objectiveAttempted: attempted,
      subjectiveAttempted: questions
        .filter((q) => isSubjective(q))
        .filter((q) => (records.get(q.id)?.attempts ?? 0) > 0).length,
    },
  }
}

/** True when a chapter has real evidence of being consolidated. */
function isConsolidated(c: ChapterStat): boolean {
  return (
    c.attempted > 0 && c.attempted >= c.objectiveTotal * CONSOLIDATED_COVERAGE && c.correctRate >= CONSOLIDATED_RATE
  )
}

function weakDetail(c: ChapterStat): string {
  const bits: string[] = []
  if (c.coverage < 0.7) bits.push(`覆盖率仅 ${Math.round(c.coverage * 100)}%`)
  if (c.correctRate < 0.6) bits.push(`正确率仅 ${Math.round(c.correctRate * 100)}%`)
  if (c.struggling > 0) bits.push(`${c.struggling} 道难点题`)
  return bits.join('；') || '待进一步巩固'
}

function uncoveredDetail(c: ChapterStat): string {
  const bits = ['尚未开始练习']
  if (c.subjectiveTotal > 0) bits.push(`含 ${c.subjectiveTotal} 道主观题`)
  return bits.join('，')
}

/**
 * Rank weak and uncovered chapters.
 *
 * The two groups are ranked SEPARATELY and then concatenated, `weak` first, up
 * to `WEAK_POINT_LIMIT` entries. They are never blended into one score:
 *
 *  - A `weak` score is a measured blend of coverage and correct rate. An
 *    all-wrong chapter scores `round((coverage*0.4 + 0*0.6) * 100)` — 40 at full
 *    coverage — using its REAL 0% rate, not a stand-in.
 *  - An `uncovered` chapter has no measured rate at all, so its score stays 0.
 *    Ranking it by score would put every untouched chapter ahead of every
 *    measured failure, which is exactly how an all-wrong chapter used to be
 *    pushed off the list by untouched chapters. It is ranked by how many
 *    objective questions it still has untouched instead.
 *
 * Ties inside a group break on the number of objective questions (descending):
 * a bigger chapter with the same rate is the larger gap.
 */
export function rankWeakPoints(chapters: ChapterStat[]): WeakPoint[] {
  const weak = chapters
    .filter((c) => c.attempted > 0 && !isConsolidated(c))
    .map((c) => ({
      chapter: c.chapter,
      score: Math.round((c.coverage * 0.4 + c.correctRate * 0.6) * 100),
      detail: weakDetail(c),
      kind: 'weak' as const,
      objectiveTotal: c.objectiveTotal,
    }))
    .sort((a, b) => a.score - b.score || b.objectiveTotal - a.objectiveTotal)
    .map(({ chapter, score, detail, kind }) => ({ chapter, score, detail, kind }))

  const uncovered = chapters
    .filter((c) => c.attempted === 0)
    .map((c) => ({
      chapter: c.chapter,
      score: 0,
      detail: uncoveredDetail(c),
      kind: 'uncovered' as const,
      objectiveTotal: c.objectiveTotal,
    }))
    .sort((a, b) => b.objectiveTotal - a.objectiveTotal)
    .map(({ chapter, score, detail, kind }) => ({ chapter, score, detail, kind }))

  // Weak chapters always come first: measured failures outrank unknown gaps.
  return [...weak, ...uncovered].slice(0, WEAK_POINT_LIMIT)
}

export function correctRateOfRecords(recs: QRecord[]): number {
  const tt = recs.reduce((s, r) => s + r.correctCount + r.wrongCount, 0)
  if (tt === 0) return 0
  return recs.reduce((s, r) => s + r.correctCount, 0) / tt
}

/**
 * Local calendar-day boundaries.
 *
 * Returns the local-midnight start of the day containing `ts`. Using
 * `setHours(0,0,0,0)` keeps this on the user's wall clock, so a record made at
 * 00:30 on Oct 22 belongs to Oct 22 — not to Oct 21 (a rolling 24h window would
 * put it there) and not to Oct 21 in UTC (a UTC label would).
 */
export function startOfLocalDay(ts: number): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/**
 * Local calendar day label, `YYYY-MM-DD`.
 *
 * Built from local getters, NOT `toISOString()` — the ISO form is UTC, so for
 * UTC+8 a record at local 00:30 Oct 22 would be labelled "2026-10-21".
 */
export function localDayLabel(ts: number): string {
  const d = new Date(ts)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * Recent study activity, grouped by LOCAL CALENDAR DAY.
 *
 * `days` buckets ending with today. Each bucket spans one local calendar day,
 * so bucket boundaries align with what the user calls "a day" and "today" is the
 * final bucket — which is what the home page's 今日已答 reads.
 *
 * The previous implementation used a rolling `now - d*86400000` window with a
 * UTC date label. That had two defects: the final bucket started at `now`, so
 * "today" was always empty; and records from local 00:00–08:00 (UTC+8) landed in
 * the previous UTC day. Both are fixed by grouping on local midnights.
 */
export function groupActivity(
  history: HistoryEntry[],
  days = 14,
  now: number = Date.now(),
): { date: string; count: number; correct: number; wrong: number }[] {
  const out: { date: string; count: number; correct: number; wrong: number }[] = []
  const todayStart = startOfLocalDay(now)

  for (let d = days - 1; d >= 0; d--) {
    // Step back by calendar day (via setDate) rather than by a fixed 86400000 ms,
    // so DST transitions (23h / 25h days) keep landing on real local midnights.
    const startDate = new Date(todayStart)
    startDate.setDate(startDate.getDate() - d)
    const start = startDate.getTime()
    // End = the NEXT local midnight, computed the same way (handles 23/25h days).
    const endDate = new Date(start)
    endDate.setDate(endDate.getDate() + 1)
    const end = endDate.getTime()

    const cnt = history.filter((h) => h.submittedAt >= start && h.submittedAt < end)
    out.push({
      date: localDayLabel(start),
      count: cnt.length,
      correct: cnt.filter((h) => h.isCorrect === true).length,
      wrong: cnt.filter((h) => h.isCorrect === false).length,
    })
  }
  return out
}
