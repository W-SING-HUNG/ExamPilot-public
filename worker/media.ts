/**
 * AI chat images: compressed copies kept per account so a conversation shows its pictures on
 * every device of that account (2026-10-27).
 *
 * Storage: its own free D1 database (binding MEDIA_DB), never the learning database. On the
 * Workers Free plan D1 has hard limits (500 MB per database, 5 GB per account, daily read/write
 * caps) that refuse instead of billing; on top of that this module enforces its own lower caps so
 * the store fills up and says so long before any platform limit:
 *   - one stored image ≤ MAX_IMAGE_BYTES (the client compresses; the server re-checks),
 *   - per account ≤ ACCOUNT_MAX_IMAGES images and ≤ ACCOUNT_MAX_BYTES,
 *   - whole store ≤ MEDIA_MAX_BYTES (default 300 MB).
 * Only real JPEG / PNG (magic bytes + parsed dimensions) is accepted; metadata that may carry
 * personal data (EXIF/GPS, XMP, comments, PNG text/time chunks) is removed before storing.
 * Every read checks the owner (another account's id answers 404, same as a missing one).
 * Lifecycle: deleting a conversation deletes its images; an account purge deletes all of them;
 * an image never linked to a synced chat message is removed after 24 h; the cron sweep repairs
 * anything a failed hook left behind.
 */
import { platformAuth, type ProtectedEnv } from './platform/http'
import type { AuthConfig } from './auth'

export const MAX_IMAGE_BYTES = 450_000
export const MAX_SIDE = 2048
export const MAX_PER_UPLOAD = 3
export const ACCOUNT_MAX_IMAGES = 300
export const ACCOUNT_MAX_BYTES = 60 * 1024 * 1024
const DEFAULT_MEDIA_MAX = 300 * 1024 * 1024
const ORPHAN_AFTER = 24 * 3600_000

export interface MediaEnv {
  MEDIA_DB?: D1Database
  MEDIA_MAX_BYTES?: string
}

const SEC = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
}
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), {
    status,
    headers: { ...SEC, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  })
const fail = (status: number, error: string, reason: string) => json({ ok: false, error, reason }, status)

/* ------------------------------ image checks ------------------------------ */

export type Parsed = { mime: 'image/jpeg' | 'image/png'; w: number; h: number; data: Uint8Array }

function b64decode(s: string): Uint8Array | null {
  try {
    const bin = atob(s)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  } catch {
    return null
  }
}

/** JPEG: keep image data, drop APP1–APP13/APP15 (EXIF, XMP, IPTC…) and COM segments. */
function cleanJpeg(b: Uint8Array): { data: Uint8Array; w: number; h: number } | null {
  if (b[0] !== 0xff || b[1] !== 0xd8) return null
  const parts: Uint8Array[] = [b.subarray(0, 2)]
  let i = 2
  let w = 0
  let h = 0
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null
    const marker = b[i + 1]
    if (marker === 0xd9) return null // EOI before SOS: no image
    if (marker === 0xda) {
      // start of scan: the rest is entropy-coded data up to EOI
      if (!w || !h) return null
      parts.push(b.subarray(i))
      break
    }
    if (marker >= 0xd0 && marker <= 0xd7) return null
    const len = (b[i + 2] << 8) | b[i + 3]
    if (len < 2 || i + 2 + len > b.length) return null
    const seg = b.subarray(i, i + 2 + len)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      h = (seg[5] << 8) | seg[6]
      w = (seg[7] << 8) | seg[8]
    }
    const drop = (marker >= 0xe1 && marker <= 0xed) || marker === 0xef || marker === 0xfe
    if (!drop) parts.push(seg)
    i += 2 + len
  }
  if (!w || !h) return null
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  // must end with EOI
  if (out[out.length - 2] !== 0xff || out[out.length - 1] !== 0xd9) return null
  return { data: out, w, h }
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const PNG_DROP = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME'])
/** PNG: keep every chunk except text / EXIF / time chunks. */
function cleanPng(b: Uint8Array): { data: Uint8Array; w: number; h: number } | null {
  for (let k = 0; k < 8; k++) if (b[k] !== PNG_SIG[k]) return null
  const parts: Uint8Array[] = [b.subarray(0, 8)]
  let i = 8
  let w = 0
  let h = 0
  let sawEnd = false
  while (i + 12 <= b.length) {
    const len = ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0
    const type = String.fromCharCode(b[i + 4], b[i + 5], b[i + 6], b[i + 7])
    if (!/^[A-Za-z]{4}$/.test(type) || i + 12 + len > b.length) return null
    if (i === 8 && type !== 'IHDR') return null
    if (type === 'IHDR') {
      w = ((b[i + 8] << 24) | (b[i + 9] << 16) | (b[i + 10] << 8) | b[i + 11]) >>> 0
      h = ((b[i + 12] << 24) | (b[i + 13] << 16) | (b[i + 14] << 8) | b[i + 15]) >>> 0
    }
    if (!PNG_DROP.has(type)) parts.push(b.subarray(i, i + 12 + len))
    i += 12 + len
    if (type === 'IEND') {
      sawEnd = true
      break
    }
  }
  if (!sawEnd || !w || !h) return null
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return { data: out, w, h }
}

const DATA_URI = /^data:image\/(jpeg|png);base64,([A-Za-z0-9+/]+={0,2})$/
export function parseImage(v: unknown): Parsed | string {
  if (typeof v !== 'string' || v.length > Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 40) return 'too_large'
  const m = DATA_URI.exec(v)
  if (!m) return 'bad_format'
  const raw = b64decode(m[2])
  if (!raw || raw.length < 24) return 'bad_format'
  const isPng = raw[0] === 0x89 && raw[1] === 0x50
  const isJpeg = raw[0] === 0xff && raw[1] === 0xd8 && raw[2] === 0xff
  // the declared type must match the bytes
  if ((m[1] === 'png') !== isPng || (m[1] === 'jpeg') !== isJpeg) return 'bad_format'
  const c = isPng ? cleanPng(raw) : cleanJpeg(raw)
  if (!c) return 'corrupt'
  if (c.w > MAX_SIDE || c.h > MAX_SIDE) return 'too_big_dimensions'
  if (c.data.length > MAX_IMAGE_BYTES) return 'too_large'
  return { mime: isPng ? 'image/png' : 'image/jpeg', w: c.w, h: c.h, data: c.data }
}

async function sha(b: Uint8Array) {
  const d = await crypto.subtle.digest('SHA-256', b)
  return [...new Uint8Array(d).slice(0, 16)].map((x) => x.toString(16).padStart(2, '0')).join('')
}
function newId() {
  const b = new Uint8Array(16)
  crypto.getRandomValues(b)
  return 'img_' + [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
}
const ID_RE = /^img_[0-9a-f]{32}$/
const CONV_RE = /^[A-Za-z0-9_-]{1,100}$/

const REASON: Record<string, string> = {
  too_large: '图片压缩后仍超过 450KB，请裁剪后再试',
  bad_format: '只支持 JPEG / PNG 图片',
  corrupt: '图片已损坏或无法识别',
  too_big_dimensions: '图片尺寸过大（最长边需不超过 2048 像素）',
}

/* -------------------------------- handler -------------------------------- */

export async function handleMedia(
  req: Request,
  env: ProtectedEnv & MediaEnv,
  deps: {
    now?: () => number
    auth?: Partial<AuthConfig>
    aiAllowed: (accountId: string, now: number) => Promise<boolean>
  },
): Promise<Response | null> {
  const url = new URL(req.url)
  const p = url.pathname
  if (p !== '/api/ai/images' && !p.startsWith('/api/ai/images/')) return null
  const now = deps.now ? deps.now() : Date.now()
  if (req.headers.get('X-ExamPilot-Client') !== '1')
    return fail(
      400,
      'bad_request',
      req.headers.get('X-ExamPilot-Client') === null ? 'missing client header' : 'invalid client header',
    )
  const a = await platformAuth(req, env, now, deps.auth)
  if (!a.ok) return json({ ok: false, error: a.error, code: a.code, reason: a.reason }, a.status)
  const db = env.MEDIA_DB
  if (!db) return fail(503, 'media_unavailable', '图片保存功能未开通，图片只用于本次对话，不会保存')
  const acc = a.account.id

  if (p === '/api/ai/images/usage' && req.method === 'GET') {
    const u = await db
      .prepare('SELECT COUNT(*) AS n, COALESCE(SUM(bytes),0) AS b FROM ai_images WHERE account_id = ?')
      .bind(acc)
      .first<{ n: number; b: number }>()
    return json({
      ok: true,
      images: u?.n ?? 0,
      bytes: u?.b ?? 0,
      maxImages: ACCOUNT_MAX_IMAGES,
      maxBytes: ACCOUNT_MAX_BYTES,
    })
  }

  if (p === '/api/ai/images' && req.method === 'POST') {
    const origin = req.headers.get('Origin')
    if (origin && origin !== url.origin) return fail(403, 'forbidden_origin', '')
    if (!(req.headers.get('Content-Type') || '').startsWith('application/json')) return fail(415, 'bad_request', '')
    if (Number(req.headers.get('Content-Length') || 0) > 2_200_000)
      return fail(413, 'too_large', '一次最多上传 3 张图片')
    // saving new pictures is part of asking the AI: same permission as the AI itself
    if (!(await deps.aiAllowed(acc, now)))
      return json({ ok: false, error: 'ai_forbidden', code: 'AI_FORBIDDEN', reason: '当前账号没有 AI 使用权限' }, 403)
    let b: { conv?: unknown; images?: unknown }
    try {
      b = JSON.parse(await req.text())
    } catch {
      return fail(400, 'bad_request', '')
    }
    if (typeof b.conv !== 'string' || !CONV_RE.test(b.conv)) return fail(400, 'bad_request', 'conv')
    if (!Array.isArray(b.images) || b.images.length === 0 || b.images.length > MAX_PER_UPLOAD)
      return fail(400, 'bad_request', '一次最多上传 3 张图片')
    const parsed: Parsed[] = []
    for (const it of b.images) {
      const r = parseImage(it)
      if (typeof r === 'string') return fail(400, 'bad_image', REASON[r] || '图片无法处理')
      parsed.push(r)
    }
    const add = parsed.reduce((n, x) => n + x.data.length, 0)
    const u = await db
      .prepare('SELECT COUNT(*) AS n, COALESCE(SUM(bytes),0) AS b FROM ai_images WHERE account_id = ?')
      .bind(acc)
      .first<{ n: number; b: number }>()
    if ((u?.n ?? 0) + parsed.length > ACCOUNT_MAX_IMAGES || (u?.b ?? 0) + add > ACCOUNT_MAX_BYTES)
      return fail(507, 'account_full', '你的图片空间已满。删除一些带图片的 AI 对话后再试，或不带图片发送。')
    const g = await db.prepare('SELECT COALESCE(SUM(bytes),0) AS b FROM ai_images').first<{ b: number }>()
    const cap = Number(env.MEDIA_MAX_BYTES || 0) > 0 ? Number(env.MEDIA_MAX_BYTES) : DEFAULT_MEDIA_MAX
    if ((g?.b ?? 0) + add > cap)
      return fail(507, 'store_full', '图片存储空间已满，暂时不能保存新图片。请不带图片发送，或联系管理员。')
    const out: { id: string; w: number; h: number; bytes: number }[] = []
    for (const x of parsed) {
      const s = await sha(x.data)
      const id = newId()
      await db
        .prepare(
          `INSERT OR IGNORE INTO ai_images (id, account_id, conv, mime, bytes, w, h, sha, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(id, acc, b.conv, x.mime, x.data.length, x.w, x.h, s, x.data, now)
        .run()
      const row = await db
        .prepare('SELECT id, w, h, bytes FROM ai_images WHERE account_id = ? AND conv = ? AND sha = ?')
        .bind(acc, b.conv, s)
        .first<{ id: string; w: number; h: number; bytes: number }>()
      if (!row) return fail(503, 'media_failed', '图片保存失败，请稍后再试')
      out.push(row)
    }
    return json({ ok: true, images: out })
  }

  const m = /^\/api\/ai\/images\/(img_[0-9a-f]{32})$/.exec(p)
  if (m && req.method === 'GET') {
    // reading old pictures stays allowed after a Pro downgrade (history is read-only, not gone)
    const row = await db
      .prepare('SELECT mime, data FROM ai_images WHERE id = ? AND account_id = ?')
      .bind(m[1], acc)
      .first<{ mime: string; data: ArrayBuffer | number[] }>()
    if (!row) return fail(404, 'not_found', '图片不存在或已删除')
    const etag = '"' + m[1] + '"'
    const h = {
      ...SEC,
      'Content-Type': row.mime,
      'Cache-Control': 'private, no-cache',
      ETag: etag,
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    }
    if (req.headers.get('If-None-Match') === etag) return new Response(null, { status: 304, headers: h })
    const body = row.data instanceof ArrayBuffer ? new Uint8Array(row.data) : new Uint8Array(row.data as number[])
    return new Response(body, { status: 200, headers: h })
  }
  return fail(404, 'not_found', '')
}

/* ------------------------------- lifecycle ------------------------------- */

export async function deleteConvImages(env: MediaEnv, accountId: string, convs: string[]) {
  if (!env.MEDIA_DB || !convs.length) return 0
  let n = 0
  for (let i = 0; i < convs.length; i += 50) {
    const part = convs.slice(i, i + 50)
    const r = await env.MEDIA_DB.prepare(
      `DELETE FROM ai_images WHERE account_id = ? AND conv IN (${part.map(() => '?').join(',')})`,
    )
      .bind(accountId, ...part)
      .run()
    n += r.meta?.changes ?? 0
  }
  return n
}
/** images referenced by a synced chat message are no longer orphans */
export async function linkImages(env: MediaEnv, accountId: string, ids: string[], now: number) {
  const ok = ids.filter((x) => ID_RE.test(x))
  if (!env.MEDIA_DB || !ok.length) return
  for (let i = 0; i < ok.length; i += 50) {
    const part = ok.slice(i, i + 50)
    await env.MEDIA_DB.prepare(
      `UPDATE ai_images SET linked_at = ? WHERE account_id = ? AND linked_at IS NULL AND id IN (${part.map(() => '?').join(',')})`,
    )
      .bind(now, accountId, ...part)
      .run()
  }
}
export async function purgeAccountImages(env: MediaEnv, accountId: string) {
  if (!env.MEDIA_DB) return 0
  const r = await env.MEDIA_DB.prepare('DELETE FROM ai_images WHERE account_id = ?').bind(accountId).run()
  return r.meta?.changes ?? 0
}

/**
 * Cron repair (≤ 8 queries): orphans older than 24 h, images of accounts that no longer exist,
 * images of conversations that were deleted (ai_conv_del op) but whose hook did not run.
 */
export async function mediaSweep(env: MediaEnv & { DB: D1Database }, now: number) {
  const out = { orphans: 0, goneAccounts: 0, deletedConvs: 0 }
  const db = env.MEDIA_DB
  if (!db) return out
  const o = await db
    .prepare('DELETE FROM ai_images WHERE linked_at IS NULL AND created_at < ?')
    .bind(now - ORPHAN_AFTER)
    .run()
  out.orphans = o.meta?.changes ?? 0
  const accs = (
    await db.prepare('SELECT DISTINCT account_id AS a FROM ai_images LIMIT 50').all<{ a: string }>()
  ).results.map((r) => r.a)
  if (accs.length) {
    const live = new Set(
      (
        await env.DB.prepare(`SELECT id FROM accounts WHERE id IN (${accs.map(() => '?').join(',')})`)
          .bind(...accs)
          .all<{ id: string }>()
      ).results.map((r) => r.id),
    )
    const gone = accs.filter((a) => !live.has(a))
    if (gone.length) {
      const r = await db
        .prepare(`DELETE FROM ai_images WHERE account_id IN (${gone.map(() => '?').join(',')})`)
        .bind(...gone)
        .run()
      out.goneAccounts = r.meta?.changes ?? 0
    }
    const liveAccs = accs.filter((a) => live.has(a))
    if (liveAccs.length) {
      const dels = await env.DB.prepare(
        `SELECT account_id AS a, json_extract(body, '$.conv') AS c FROM ops WHERE kind = 'ai_conv_del' AND account_id IN (${liveAccs.map(() => '?').join(',')})`,
      )
        .bind(...liveAccs)
        .all<{ a: string; c: string }>()
      const by = new Map<string, string[]>()
      for (const d of dels.results) if (d.c) by.set(d.a, [...(by.get(d.a) || []), d.c])
      for (const [a, cs] of [...by].slice(0, 10)) out.deletedConvs += await deleteConvImages(env, a, cs.slice(0, 50))
    }
  }
  return out
}
