// Bank fingerprint — MUST stay equivalent to src/lib/bank-fingerprint.ts.
import { createHash } from 'node:crypto'

export function canonicalJson(v) {
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']'
  if (v && typeof v === 'object') {
    return (
      '{' +
      Object.keys(v)
        .sort()
        .filter((k) => v[k] !== undefined)
        .map((k) => JSON.stringify(k) + ':' + canonicalJson(v[k]))
        .join(',') +
      '}'
    )
  }
  return JSON.stringify(v ?? null)
}

export function fingerprintParts(bank) {
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

export function bankFingerprint(bank) {
  const byType = {}
  for (const q of bank.questions) byType[q.type] = (byType[q.type] ?? 0) + 1
  const hashes = {}
  for (const [k, v] of Object.entries(fingerprintParts(bank))) {
    hashes[k] = createHash('sha256').update(canonicalJson(v), 'utf8').digest('hex')
  }
  return { total: bank.questions.length, byType, hashes }
}
