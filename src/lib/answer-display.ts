/**
 * Pure display helpers for the mock-exam review screen.
 *
 * Kept in `lib/` (not the page) so they can be unit-tested without pulling React,
 * the router or IndexedDB into the test environment. The page imports them from
 * here; nothing else duplicates this logic.
 *
 * Why this exists: judge answers are stored and scored as the strings 'true' /
 * 'false'. Interpolating the stored value into the UI printed "你的作答：true",
 * exposing an internal representation to the user.
 */
import type { Question } from './types'
import { formatAnswerNorm } from './scoring'

/** How an unanswered question is labelled. */
export const UNANSWERED_LABEL = '未作答'

/**
 * Render the user's answer for any question type.
 *
 * Judge answers ('true'/'false') become 正确 / 错误. An empty or unknown value
 * becomes 未作答 — never the raw wire format, and never a bare `false`, which
 * would otherwise read as "no answer".
 */
export function displayUserAnswer(type: Question['type'], raw: string | null | undefined): string {
  if (raw === null || raw === undefined || raw === '') return UNANSWERED_LABEL
  if (type === 'judge') {
    if (raw === 'true') return '正确'
    if (raw === 'false') return '错误'
    return UNANSWERED_LABEL
  }
  return String(raw)
}

/** Render a correct answer; boolean judge answers become 正确 / 错误. */
export function displayCorrectAnswer(v: string | boolean | null | undefined): string {
  if (v === null || v === undefined) return '无标准答案'
  return formatAnswerNorm(v)
}
