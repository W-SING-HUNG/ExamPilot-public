import { describe, it, expect } from 'vitest'
import { groupActivity, localDayLabel, startOfLocalDay } from './analysis'
import type { HistoryEntry } from './types'

/**
 * Activity grouping must follow the USER'S LOCAL CALENDAR DAY.
 *
 * Regression: the previous implementation built buckets as
 * `[now - d*86400000, now - d*86400000 + 86400000)` and labelled them with
 * `toISOString()` (UTC). Two consequences, both reported by a real user:
 *
 *  1. The final bucket started at `now`, so "today" never contained anything —
 *     the home page showed 今日已答 0 even right after answering questions.
 *  2. The label was the UTC date, so for UTC+8 a record made at local 00:30 on
 *     Oct 22 was filed under Oct 21.
 *
 * These tests pin the correct behaviour and would fail against the old code.
 */

/** Build a history entry at a given absolute time. */
function h(id: string, submittedAt: number, isCorrect: boolean | null = true): HistoryEntry {
  return {
    id,
    qid: 'q1',
    mode: 'practice',
    sessionId: 's1',
    answer: 'A',
    isCorrect,
    submittedAt,
    usedAI: false,
  } as HistoryEntry
}

/** A local wall-clock timestamp, independent of the machine's timezone. */
function localTime(y: number, mo: number, d: number, hh = 0, mm = 0, ss = 0, ms = 0): number {
  return new Date(y, mo - 1, d, hh, mm, ss, ms).getTime()
}

describe('analysis / groupActivity — local calendar day', () => {
  it('the LAST bucket is today and contains records submitted today', () => {
    const now = localTime(2026, 10, 22, 15, 0)
    const today = localTime(2026, 10, 22, 9, 30)
    const out = groupActivity([h('a', today)], 7, now)

    expect(out).toHaveLength(7)
    const last = out[out.length - 1]
    expect(last.date).toBe('2026-10-22')
    // This is the exact user-visible defect: 今日已答 must not be 0.
    expect(last.count).toBe(1)
  })

  it('a record just after local midnight belongs to THAT day, not the previous one', () => {
    // 00:30 on Oct 22 local. Under the old UTC label this became "2026-10-21"
    // for UTC+8 users, and under the rolling window it fell outside "today".
    const now = localTime(2026, 10, 22, 10, 0)
    const afterMidnight = localTime(2026, 10, 22, 0, 30)
    const beforeMidnight = localTime(2026, 10, 21, 23, 30)

    const out = groupActivity([h('after', afterMidnight), h('before', beforeMidnight)], 7, now)
    const byDate = Object.fromEntries(out.map((d) => [d.date, d.count]))

    expect(byDate['2026-10-22']).toBe(1)
    expect(byDate['2026-10-21']).toBe(1)
    expect(out[out.length - 1].date).toBe('2026-10-22')
  })

  it('crossing midnight moves the count from today to yesterday', () => {
    const lateNight = localTime(2026, 10, 21, 23, 59)
    const rec = h('x', lateNight)

    // Viewed at 23:59:30 on Oct 21 → today.
    const beforeMidnight = groupActivity([rec], 7, localTime(2026, 10, 21, 23, 59, 30))
    expect(beforeMidnight[beforeMidnight.length - 1].date).toBe('2026-10-21')
    expect(beforeMidnight[beforeMidnight.length - 1].count).toBe(1)

    // Viewed at 00:00:30 on Oct 22 → yesterday, and today is empty.
    const afterMidnight = groupActivity([rec], 7, localTime(2026, 10, 22, 0, 0, 30))
    const last = afterMidnight[afterMidnight.length - 1]
    expect(last.date).toBe('2026-10-22')
    expect(last.count).toBe(0)
    expect(afterMidnight[afterMidnight.length - 2].date).toBe('2026-10-21')
    expect(afterMidnight[afterMidnight.length - 2].count).toBe(1)
  })

  it('a full day boundary is inclusive of the start and exclusive of the end', () => {
    const now = localTime(2026, 10, 22, 12, 0)
    const startOfToday = localTime(2026, 10, 22, 0, 0, 0, 0)
    const endOfToday = localTime(2026, 10, 23, 0, 0, 0, 0)

    const out = groupActivity(
      [h('atStart', startOfToday), h('atEnd', endOfToday), h('justBeforeEnd', endOfToday - 1)],
      3,
      now,
    )
    const byDate = Object.fromEntries(out.map((d) => [d.date, d.count]))
    // 00:00:00 today counts for today; 00:00:00 tomorrow does not.
    expect(byDate['2026-10-22']).toBe(2)
    expect(byDate['2026-10-23']).toBeUndefined()
  })

  it('labels are local dates, never UTC dates', () => {
    // Pick an instant whose UTC date differs from the local date in most
    // timezones: local 00:30 is still the previous day in UTC for UTC+8.
    const now = localTime(2026, 1, 15, 15, 0)
    const out = groupActivity([], 3, now)

    const expectedLast = localDayLabel(startOfLocalDay(now))
    expect(out[out.length - 1].date).toBe(expectedLast)

    // The label must be built from local parts, not from toISOString().
    const d = new Date(now)
    const localStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    expect(out[out.length - 1].date).toBe(localStr)
  })

  it('buckets are consecutive local days with no gaps or overlaps', () => {
    const now = localTime(2026, 3, 1, 9, 0)
    const out = groupActivity([], 7, now)
    expect(out).toHaveLength(7)

    for (let i = 1; i < out.length; i++) {
      const prev = new Date(`${out[i - 1].date}T00:00:00`)
      const cur = new Date(`${out[i].date}T00:00:00`)
      const diffDays = Math.round((cur.getTime() - prev.getTime()) / 86400000)
      // Exactly one calendar day apart. Around a DST change the millisecond gap
      // may be 23h or 25h, but the DATE must still advance by exactly 1.
      expect(diffDays).toBe(1)
    }
  })

  it('spans a DST transition without dropping or duplicating a day', () => {
    // Spring-forward and autumn-back dates for the common DST zones. On machines
    // without DST this still asserts the 1-day-per-bucket invariant.
    for (const [label, now] of [
      ['US spring forward', localTime(2026, 3, 10, 12, 0)],
      ['US fall back', localTime(2026, 11, 3, 12, 0)],
      ['EU spring forward', localTime(2026, 3, 29, 12, 0)],
      ['EU fall back', localTime(2026, 10, 25, 12, 0)],
    ] as const) {
      const out = groupActivity([], 10, now)
      expect(out, label).toHaveLength(10)
      const dates = new Set(out.map((d) => d.date))
      expect(dates.size, `${label}: no duplicate day labels`).toBe(10)
      for (let i = 1; i < out.length; i++) {
        const prev = new Date(`${out[i - 1].date}T00:00:00`)
        const cur = new Date(`${out[i].date}T00:00:00`)
        expect(Math.round((cur.getTime() - prev.getTime()) / 86400000), `${label} step ${i}`).toBe(1)
      }
    }
  })

  it('records exactly 7 and 30 days back are included when within the window', () => {
    const now = localTime(2026, 10, 22, 12, 0)
    // 6 days back (7-day window covers today + 6 previous days).
    const sixDaysBack = localTime(2026, 10, 16, 12, 0)
    // 7 days back is outside a 7-day window but inside a 30-day window.
    const sevenDaysBack = localTime(2026, 10, 15, 12, 0)

    const w7 = groupActivity([h('a', sixDaysBack), h('b', sevenDaysBack)], 7, now)
    expect(w7.reduce((s, d) => s + d.count, 0)).toBe(1)

    const w30 = groupActivity([h('a', sixDaysBack), h('b', sevenDaysBack)], 30, now)
    expect(w30.reduce((s, d) => s + d.count, 0)).toBe(2)
  })

  it('separates correct / wrong and ignores null (unscored) for both', () => {
    const now = localTime(2026, 10, 22, 12, 0)
    const t = localTime(2026, 10, 22, 8, 0)
    const out = groupActivity([h('c', t, true), h('w', t, false), h('n', t, null)], 1, now)
    const last = out[out.length - 1]
    expect(last.count).toBe(3)
    expect(last.correct).toBe(1)
    expect(last.wrong).toBe(1)
  })

  it('an empty history yields zeroed buckets, not an exception', () => {
    const out = groupActivity([], 14, localTime(2026, 10, 22, 12, 0))
    expect(out).toHaveLength(14)
    expect(out.every((d) => d.count === 0 && d.correct === 0 && d.wrong === 0)).toBe(true)
  })

  it('startOfLocalDay returns local midnight regardless of the time of day', () => {
    for (const hh of [0, 1, 11, 12, 23]) {
      const ts = localTime(2026, 7, 4, hh, 30)
      const s = new Date(startOfLocalDay(ts))
      expect(s.getHours()).toBe(0)
      expect(s.getMinutes()).toBe(0)
      expect(s.getSeconds()).toBe(0)
      expect(s.getMilliseconds()).toBe(0)
      expect(s.getDate()).toBe(4)
    }
  })
})
