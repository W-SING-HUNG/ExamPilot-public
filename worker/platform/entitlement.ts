/**
 * Pro entitlement ledger → current state (pure, deterministic).
 *
 * Rules (docs/platform-design.md §Pro):
 *  - A permanent grant that is active makes the user Pro permanently. While one is
 *    active the finite clock does NOT run (finite days are kept, not burned).
 *  - Finite grants form one FIFO queue ordered by (starts_at, id); time is consumed
 *    from the head. Topping up just appends: 30 d admin + 2×7 d referral = 44 d.
 *  - A forced suspension blocks Pro features. mode 'freeze' stops the clock for its
 *    duration; mode 'continue' lets it run.
 *  - Revoking a grant at t removes only its unused part at t; what was used stays used.
 *  - 'held' grants (under review / issued during a suspension) are not in the queue.
 */

export interface GrantRow {
  id: string
  kind: 'permanent' | 'days'
  duration_ms: number
  starts_at: number
  state: 'active' | 'held' | 'revoked'
  revoked_at: number | null
  source?: string
}
export interface SuspensionRow {
  mode: 'freeze' | 'continue'
  started_at: number
  ended_at: number | null
}

export interface GrantUsage {
  used: number
  remaining: number
}

export interface Entitlement {
  tier: 'standard' | 'pro'
  permanent: boolean
  /** projected end of finite Pro (null when permanent, paused, or none left) */
  until: number | null
  /** remaining finite ms at `now` */
  remainingMs: number
  /** a forced suspension is open */
  suspended: boolean
  /** clock stopped by a freeze suspension */
  paused: boolean
  /** Pro features usable right now (tier pro and not suspended) */
  active: boolean
  usage: Record<string, GrantUsage>
}

const isLiveAt = (g: GrantRow, t: number) =>
  g.state !== 'held' && g.starts_at <= t && (g.revoked_at === null || g.revoked_at > t)

export function computeEntitlement(grants: GrantRow[], suspensions: SuspensionRow[], now: number): Entitlement {
  const gs = grants
    .filter((g) => g.state !== 'held')
    .map((g) => ({ ...g, revoked_at: g.state === 'revoked' ? (g.revoked_at ?? g.starts_at) : null }))
    .sort((a, b) => a.starts_at - b.starts_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  const points = new Set<number>([now])
  for (const g of gs) {
    if (g.starts_at <= now) points.add(g.starts_at)
    if (g.revoked_at !== null && g.revoked_at <= now) points.add(g.revoked_at)
  }
  for (const s of suspensions) {
    if (s.started_at <= now) points.add(s.started_at)
    if (s.ended_at !== null && s.ended_at <= now) points.add(s.ended_at)
  }
  const ts = [...points].sort((a, b) => a - b)

  const remaining = new Map<string, number>()
  const used = new Map<string, number>()
  const inQueue: string[] = []
  const permanentLive = (t: number) => gs.some((g) => g.kind === 'permanent' && isLiveAt(g, t))
  const frozenAt = (t: number) =>
    suspensions.some((s) => s.mode === 'freeze' && s.started_at <= t && (s.ended_at === null || s.ended_at > t))

  const enter = (t: number) => {
    for (const g of gs) {
      if (g.kind !== 'days') continue
      if (g.starts_at <= t && !remaining.has(g.id)) {
        remaining.set(g.id, g.duration_ms)
        used.set(g.id, 0)
        inQueue.push(g.id)
      }
      if (g.revoked_at !== null && g.revoked_at <= t && inQueue.includes(g.id)) {
        inQueue.splice(inQueue.indexOf(g.id), 1)
        remaining.set(g.id, 0) // unused part dropped
      }
    }
  }

  for (let i = 0; i < ts.length; i++) {
    const t = ts[i]
    enter(t)
    const next = ts[i + 1]
    if (next === undefined) break
    if (permanentLive(t) || frozenAt(t)) continue
    let span = next - t
    while (span > 0 && inQueue.length) {
      const head = inQueue[0]
      const left = remaining.get(head) ?? 0
      const take = Math.min(left, span)
      remaining.set(head, left - take)
      used.set(head, (used.get(head) ?? 0) + take)
      span -= take
      if (left - take <= 0) inQueue.shift()
    }
  }

  const permanent = permanentLive(now)
  const remainingMs = inQueue.reduce((s, id) => s + (remaining.get(id) ?? 0), 0)
  const suspended = suspensions.some((s) => s.started_at <= now && (s.ended_at === null || s.ended_at > now))
  const paused = frozenAt(now)
  const tier = permanent || remainingMs > 0 ? 'pro' : 'standard'
  const until = !permanent && !paused && remainingMs > 0 ? now + remainingMs : null
  const usage: Record<string, GrantUsage> = {}
  for (const g of gs) {
    if (g.kind !== 'days') continue
    usage[g.id] = { used: used.get(g.id) ?? 0, remaining: inQueue.includes(g.id) ? (remaining.get(g.id) ?? 0) : 0 }
  }
  return { tier, permanent, until, remainingMs, suspended, paused, active: tier === 'pro' && !suspended, usage }
}

export const DAY = 86_400_000
