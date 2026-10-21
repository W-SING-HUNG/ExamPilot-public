import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'

/**
 * Config file location. Overridable with AI_CONFIG_PATH so tests (and multi
 * instance setups) never touch the real `server/ai-config.json`.
 */
const CONFIG_PATH =
  process.env.AI_CONFIG_PATH && process.env.AI_CONFIG_PATH.length > 0
    ? path.resolve(process.env.AI_CONFIG_PATH)
    : path.resolve(process.cwd(), 'server', 'ai-config.json')

export const CONFIG_FILE = CONFIG_PATH

export const DEFAULTS = {
  baseUrl: process.env.AI_BASE_URL || '',
  apiKey: process.env.AI_API_KEY || '',
  model: process.env.AI_MODEL || '',
  timeoutMs: Number(process.env.AI_TIMEOUT_MS || 60000),
  maxTokens: Number(process.env.AI_MAX_TOKENS || 2048),
}

let cache = null

export async function loadAiConfig() {
  if (cache) return cache
  if (existsSync(CONFIG_PATH)) {
    try {
      const raw = await readFile(CONFIG_PATH, 'utf-8')
      cache = { ...DEFAULTS, ...JSON.parse(raw) }
      return cache
    } catch {
      /* fall through to defaults */
    }
  }
  cache = { ...DEFAULTS }
  return cache
}

export async function saveAiConfig(cfg) {
  const merged = { ...(await loadAiConfig()), ...cfg }
  await mkdir(path.dirname(CONFIG_PATH), { recursive: true })
  await writeFile(CONFIG_PATH, JSON.stringify(merged, null, 2), 'utf-8')
  cache = merged
  return merged
}

export function isConfigured(c) {
  return Boolean(c.baseUrl && c.apiKey && c.model)
}
