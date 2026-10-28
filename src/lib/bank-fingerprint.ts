import type { BankData } from './types'

/**
 * Bank fingerprint — MUST stay byte-for-byte equivalent to tools/web/bank-fingerprint.mjs.
 *
 * Canonical form: JSON with object keys sorted recursively, arrays kept in order,
 * UTF-8, SHA-256 hex. Each part is hashed separately so a mismatch can be located.
 */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']'
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return (
      '{' +
      Object.keys(o)
        .sort()
        .filter((k) => o[k] !== undefined)
        .map((k) => JSON.stringify(k) + ':' + canonicalJson(o[k]))
        .join(',') +
      '}'
    )
  }
  return JSON.stringify(v ?? null)
}

export function fingerprintParts(bank: BankData): Record<string, unknown> {
  const qs = bank.questions
  return {
    chapterOrder: bank.chapterOrder,
    ids: qs.map((q) => q.id),
    chapters: qs.map((q) => [q.id, q.chapter, q.chapterIndex]),
    types: qs.map((q) => [q.id, q.type]),
    stemsOptions: qs.map((q) => [q.id, q.stem, q.options]),
    answers: qs.map((q) => [q.id, q.answer, q.answerNorm, q.hasOfficialAnswer]),
    full: qs,
  }
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export interface BankFingerprint {
  total: number
  byType: Record<string, number>
  hashes: Record<string, string>
}

export async function bankFingerprint(bank: BankData): Promise<BankFingerprint> {
  const byType: Record<string, number> = {}
  for (const q of bank.questions) byType[q.type] = (byType[q.type] ?? 0) + 1
  const hashes: Record<string, string> = {}
  for (const [k, v] of Object.entries(fingerprintParts(bank))) hashes[k] = await sha256Hex(canonicalJson(v))
  return { total: bank.questions.length, byType, hashes }
}
