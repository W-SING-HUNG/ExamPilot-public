import { describe, it, expect } from 'vitest'
import { computeEntitlement, DAY, type GrantRow, type SuspensionRow } from '../../worker/platform/entitlement'

const g = (
  id: string,
  kind: 'permanent' | 'days',
  days: number,
  at: number,
  extra: Partial<GrantRow> = {},
): GrantRow => ({
  id,
  kind,
  duration_ms: days * DAY,
  starts_at: at,
  state: 'active',
  revoked_at: null,
  ...extra,
})
const T0 = 1_800_000_000_000

describe('entitlement ledger', () => {
  it('standard with no grants', () => {
    const e = computeEntitlement([], [], T0)
    expect(e.tier).toBe('standard')
    expect(e.active).toBe(false)
  })
  it('admin 30 d + 2 referrals 7 d = 44 d', () => {
    const e = computeEntitlement(
      [g('a', 'days', 30, T0), g('r1', 'days', 7, T0 + 1), g('r2', 'days', 7, T0 + 2)],
      [],
      T0 + 2,
    )
    expect(e.tier).toBe('pro')
    expect(e.until).toBe(T0 + 44 * DAY)
  })
  it('expires to standard exactly at the end', () => {
    const gs = [g('a', 'days', 7, T0)]
    expect(computeEntitlement(gs, [], T0 + 7 * DAY - 1).tier).toBe('pro')
    expect(computeEntitlement(gs, [], T0 + 7 * DAY).tier).toBe('standard')
  })
  it('reward added mid-way extends the current end', () => {
    const gs = [g('a', 'days', 7, T0), g('r', 'days', 7, T0 + 3 * DAY)]
    const e = computeEntitlement(gs, [], T0 + 3 * DAY)
    expect(e.until).toBe(T0 + 14 * DAY)
  })
  it('reward after expiry restarts from the reward time', () => {
    const gs = [g('a', 'days', 7, T0), g('r', 'days', 7, T0 + 10 * DAY)]
    expect(computeEntitlement(gs, [], T0 + 10 * DAY).until).toBe(T0 + 17 * DAY)
    expect(computeEntitlement(gs, [], T0 + 8 * DAY).tier).toBe('standard')
  })
  it('permanent stays permanent; finite days are not burned while permanent', () => {
    const gs = [g('p', 'permanent', 0, T0), g('r', 'days', 7, T0 + DAY)]
    const e = computeEntitlement(gs, [], T0 + 30 * DAY)
    expect(e.permanent).toBe(true)
    expect(e.until).toBeNull()
    expect(e.usage.r.remaining).toBe(7 * DAY)
    // ordinary revoke of the admin permanent grant: referral days remain and start running
    const gs2 = [
      g('p', 'permanent', 0, T0, { state: 'revoked', revoked_at: T0 + 30 * DAY }),
      g('r', 'days', 7, T0 + DAY),
    ]
    const e2 = computeEntitlement(gs2, [], T0 + 30 * DAY)
    expect(e2.permanent).toBe(false)
    expect(e2.until).toBe(T0 + 37 * DAY)
  })
  it('revoking a violating reward removes only its unused part', () => {
    // admin 7 d at T0, reward 7 d at T0 → reward starts being used at T0+7d
    const base = [g('a', 'days', 7, T0), g('r', 'days', 7, T0 + 1)]
    const revokedAt = T0 + 10 * DAY // reward used for ~3 days
    const gs = [base[0], { ...base[1], state: 'revoked' as const, revoked_at: revokedAt }]
    const e = computeEntitlement(gs, [], revokedAt)
    expect(e.tier).toBe('standard')
    expect(e.usage.r.used).toBe(3 * DAY - 1 + 1) // ~3 days used, kept (no negative, no debt)
    // other legitimate grants untouched
    const gs2 = [...gs, g('b', 'days', 30, T0 + 2)]
    const e2 = computeEntitlement(gs2, [], revokedAt)
    expect(e2.usage.b.remaining).toBeGreaterThan(0)
    expect(e2.remainingMs).toBeGreaterThan(0)
  })
  it('freeze suspension stops the clock and restores the remaining time', () => {
    const gs = [g('a', 'days', 10, T0)]
    const s: SuspensionRow[] = [{ mode: 'freeze', started_at: T0 + 2 * DAY, ended_at: null }]
    const during = computeEntitlement(gs, s, T0 + 5 * DAY)
    expect(during.suspended).toBe(true)
    expect(during.active).toBe(false)
    expect(during.paused).toBe(true)
    expect(during.remainingMs).toBe(8 * DAY)
    const lifted = computeEntitlement(gs, [{ ...s[0], ended_at: T0 + 5 * DAY }], T0 + 5 * DAY)
    expect(lifted.active).toBe(true)
    expect(lifted.until).toBe(T0 + 13 * DAY)
  })
  it('continue suspension keeps consuming but blocks use', () => {
    const gs = [g('a', 'days', 10, T0)]
    const s: SuspensionRow[] = [{ mode: 'continue', started_at: T0 + 2 * DAY, ended_at: null }]
    const e = computeEntitlement(gs, s, T0 + 5 * DAY)
    expect(e.active).toBe(false)
    expect(e.remainingMs).toBe(5 * DAY)
    expect(computeEntitlement(gs, [{ ...s[0], ended_at: T0 + 5 * DAY }], T0 + 5 * DAY).until).toBe(T0 + 10 * DAY)
  })
  it('permanent can be suspended without losing permanence', () => {
    const gs = [g('p', 'permanent', 0, T0)]
    const e = computeEntitlement(gs, [{ mode: 'freeze', started_at: T0 + DAY, ended_at: null }], T0 + 2 * DAY)
    expect(e.permanent).toBe(true)
    expect(e.active).toBe(false)
  })
  it('held grants do not count', () => {
    const e = computeEntitlement([g('r', 'days', 7, T0, { state: 'held' })], [], T0 + 1)
    expect(e.tier).toBe('standard')
  })
})
