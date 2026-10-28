import { useId } from 'react'
import { BRAND } from '../lib/meta'
import type { Tier } from '../lib/ai-access'

/**
 * Brand assets for the web edition. Pure inline SVG (no image requests, crisp at
 * any DPR). Colours come from CSS variables so every theme recolours them:
 *   --mark-a / --mark-b / --mark-c  facet tones (Standard: accent blues; Pro: champagne metal)
 */

/** The ExamPilot mark: a faceted compass needle ("pilot") inside a soft tile. */
export function LogoMark({ size = 30 }: { size?: number }) {
  const id = useId().replace(/:/g, '')
  return (
    <svg className="logo-mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={`t${id}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--mark-tile-a)" />
          <stop offset="1" stopColor="var(--mark-tile-b)" />
        </linearGradient>
        <linearGradient id={`n${id}`} x1="0.2" y1="0" x2="0.8" y2="1">
          <stop offset="0" stopColor="var(--mark-a)" />
          <stop offset="0.48" stopColor="var(--mark-b)" />
          <stop offset="1" stopColor="var(--mark-c)" />
        </linearGradient>
      </defs>
      <rect x="0.5" y="0.5" width="31" height="31" rx="8.5" fill={`url(#t${id})`} stroke="var(--mark-edge)" />
      {/* needle: two facets so light reads as coming from the top-left */}
      <path d="M16 5.5 21.2 16 16 26.5 10.8 16Z" fill={`url(#n${id})`} />
      <path d="M16 5.5 16 26.5 10.8 16Z" fill="var(--mark-shade)" />
      <circle cx="16" cy="16" r="1.6" fill="var(--mark-pin)" />
    </svg>
  )
}

/** "Pro" label: a foil-ruled serif mark. Decorative; pair it with text for meaning. */
export function ProBadge({ size = 'md' }: { size?: 'sm' | 'md' | 'lg' }) {
  return (
    <span className={`pro-badge pro-badge-${size}`} aria-hidden="true">
      <span className="pro-badge-face">Pro</span>
    </span>
  )
}

/** Sidebar brand block: mark + wordmark + identity line. */
export function BrandMark({ tier }: { tier: Tier }) {
  return (
    <div className="brand-mark">
      <LogoMark />
      <div className="brand-words">
        <span className="brand-title">
          {BRAND.en}
          {tier === 'pro' && <ProBadge size="sm" />}
        </span>
        <span className="brand-sub">
          {BRAND.zh}
          {tier === 'pro' && <span className="sr-only">（ExamPilot Pro 账号）</span>}
        </span>
      </div>
    </div>
  )
}
