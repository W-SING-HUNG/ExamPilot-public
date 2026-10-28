/**
 * Build edition switch.
 *
 * `desktop` (default) — the normal local app. Every existing behaviour, including
 * the AI assistant, is unchanged. Nothing sets the variable, so `npm run dev`,
 * `npm run build` and `npm run build:public` all stay on this edition.
 *
 * `web` — the access-controlled website (`npm run build:web`). AI is off by
 * default and only the server can turn it on for an account (lib/ai-access.ts):
 * until GET /api/ai/status says `allowed`, no AI UI is rendered and `lib/ai.ts`
 * returns without issuing any network request. There are no client-side gateway
 * settings on the web.
 */
export const EDITION: 'web' | 'desktop' = import.meta.env.VITE_EXAMPILOT_EDITION === 'web' ? 'web' : 'desktop'

export const IS_WEB_EDITION = EDITION === 'web'

/**
 * Static part of the AI switch. False on the web edition, where the per-account
 * server decision in lib/ai-access.ts takes over (`useAiUsable()` / `aiUsable()`).
 */
export const AI_ENABLED = !IS_WEB_EDITION

/** Build marker checked by tools/web/verify-web.mjs (must survive minification). */
export const WEB_EDITION_MARKER = IS_WEB_EDITION ? 'exampilot-web-edition:account-ai' : ''

export const AI_DISABLED_REASON = '网页版暂不提供 AI 功能，刷题、判分与学习记录不受影响。'
