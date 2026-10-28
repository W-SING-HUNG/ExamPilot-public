/**
 * AI chat images store (2026-10-27): its own D1, owner-only reads, metadata stripped, size /
 * dimension / quota limits, deletion with the conversation, orphan + gone-account sweep.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.setConfig({ testTimeout: 60_000 })
import { readFileSync } from 'node:fs'
import { Miniflare } from 'miniflare'
import { makeHarness, HOST, type Harness } from '../sync/test-harness'
import { handleMedia, mediaSweep, parseImage, ACCOUNT_MAX_IMAGES } from '../../worker/media'
import { handleApi } from '../../worker/api'
import { validateOp } from '../../src/sync/protocol'
import { purgeMember } from '../../worker/platform/core'

const FIX = (f: string) => readFileSync(new URL('../fixtures/img/' + f, import.meta.url))
const uri = (f: string, mime = f.endsWith('.png') ? 'png' : 'jpeg') =>
  `data:image/${mime};base64,` + FIX(f).toString('base64')
let H: Harness
let mf: Miniflare
let media: any
let env: any
const now = Date.UTC(2026, 9, 27, 3, 0, 0)
let allowAi = new Set<string>()
beforeEach(async () => {
  H = await makeHarness()
  mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("x") } }',
    d1Databases: { M: 'media-' + Math.random().toString(36).slice(2) },
  })
  media = await mf.getD1Database('M')
  const sql = readFileSync(new URL('../../worker/migrations-media/0001_media.sql', import.meta.url), 'utf8')
  for (const s of sql
    .replace(/--.*$/gm, '')
    .split(';')
    .map((x) => x.trim())
    .filter(Boolean))
    await media.prepare(s).run()
  env = {
    ...H.env,
    MEDIA_DB: media,
    SUPER_OWNERS: 'owner@x.com',
    PLATFORM_SECRET: 's',
    PLATFORM_STAGE: 'test',
    MAIL_PROVIDER: 'outbox',
  }
  allowAi = new Set()
})
afterEach(async () => {
  await mf.dispose()
  await H.dispose()
})
async function accountOf(email: string) {
  const r = await H.call('GET', '/api/sync/me', { email })
  return r.json.accountId as string
}
async function call(
  method: string,
  p: string,
  email: string | null,
  body?: unknown,
  extra: Record<string, string> = {},
  e = env,
) {
  const headers: Record<string, string> = { 'X-ExamPilot-Client': '1' }
  if (email) headers['Cf-Access-Jwt-Assertion'] = await H.issuer.token(email)
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    headers.Origin = HOST
  }
  Object.assign(headers, extra)
  const res = (await handleMedia(
    new Request(HOST + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
    e,
    {
      now: () => now,
      auth: { fetchJwks: async () => H.issuer.jwks },
      aiAllowed: async (acc) => allowAi.has(acc),
    },
  ))!
  const ct = res.headers.get('content-type') || ''
  return {
    status: res.status,
    headers: res.headers,
    json: ct.includes('json') ? ((await res.json()) as any) : null,
    bytes: ct.includes('json') ? null : new Uint8Array(await res.arrayBuffer()),
  }
}
const has = (b: Uint8Array, s: string) => Buffer.from(b).includes(Buffer.from(s))

describe('image checks', () => {
  it('accepts real JPEG/PNG, strips EXIF/GPS/comments/text chunks, refuses fakes and oversize', () => {
    const j = parseImage(uri('exif.jpg')) as any
    expect(j.mime).toBe('image/jpeg')
    expect([j.w, j.h]).toEqual([320, 200])
    expect(has(FIX('exif.jpg'), 'SecretCam')).toBe(true)
    expect(has(j.data, 'SecretCam')).toBe(false)
    expect(has(j.data, 'secret-comment')).toBe(false)
    expect(has(j.data, 'Exif')).toBe(false)
    const p = parseImage(uri('text.png')) as any
    expect(p.mime).toBe('image/png')
    expect(has(p.data, 'secret-author')).toBe(false)
    expect(has(p.data, 'IDAT')).toBe(true)
    expect(parseImage(uri('exif.jpg', 'png'))).toBe('bad_format') // declared type ≠ bytes
    expect(parseImage('data:image/gif;base64,R0lGODlhAQABAAAAACw=')).toBe('bad_format')
    expect(parseImage(uri('huge.png'))).toBe('too_big_dimensions')
    const cut = FIX('exif.jpg').subarray(0, 600)
    expect(parseImage('data:image/jpeg;base64,' + cut.toString('base64'))).toBe('corrupt')
    expect(parseImage('data:image/jpeg;base64,' + 'A'.repeat(700_000))).toBe('too_large')
  })
})

describe('store API', () => {
  it('owner-only, permission-gated, revalidating; other accounts get 404', async () => {
    const a = await accountOf('a@x.com')
    const b = await accountOf('b@x.com')
    allowAi.add(a)
    // no AI permission → cannot save new pictures
    expect(
      (await call('POST', '/api/ai/images', 'b@x.com', { conv: 'conv_1', images: [uri('exif.jpg')] })).status,
    ).toBe(403)
    const up = await call('POST', '/api/ai/images', 'a@x.com', {
      conv: 'conv_1',
      images: [uri('exif.jpg'), uri('text.png')],
    })
    expect(up.status).toBe(200)
    expect(up.json.images).toHaveLength(2)
    const id = up.json.images[0].id
    expect(id).toMatch(/^img_[0-9a-f]{32}$/)
    // same picture again in the same conversation = same id (retry after a stop)
    const again = await call('POST', '/api/ai/images', 'a@x.com', { conv: 'conv_1', images: [uri('exif.jpg')] })
    expect(again.json.images[0].id).toBe(id)
    const g = await call('GET', '/api/ai/images/' + id, 'a@x.com')
    expect(g.status).toBe(200)
    expect(g.headers.get('content-type')).toBe('image/jpeg')
    expect(g.headers.get('cache-control')).toBe('private, no-cache')
    expect(g.headers.get('cross-origin-resource-policy')).toBe('same-origin')
    expect(has(g.bytes!, 'SecretCam')).toBe(false)
    expect(
      (await call('GET', '/api/ai/images/' + id, 'a@x.com', undefined, { 'If-None-Match': `"${id}"` })).status,
    ).toBe(304)
    // another account: 404 (same as missing), even with the right id
    expect((await call('GET', '/api/ai/images/' + id, 'b@x.com')).status).toBe(404)
    expect((await call('GET', '/api/ai/images/img_' + '0'.repeat(32), 'a@x.com')).status).toBe(404)
    // no session / no client header
    expect((await call('GET', '/api/ai/images/' + id, null)).status).toBe(401)
    const nh = await handleMedia(
      new Request(HOST + '/api/ai/images/' + id, {
        headers: { 'Cf-Access-Jwt-Assertion': await H.issuer.token('a@x.com') },
      }),
      env,
      { aiAllowed: async () => true, auth: { fetchJwks: async () => H.issuer.jwks } },
    )
    expect(nh!.status).toBe(400)
    // a downgraded (no AI) account can still SEE its old pictures
    allowAi.delete(a)
    expect((await call('GET', '/api/ai/images/' + id, 'a@x.com')).status).toBe(200)
    // a revoked member cannot
    await H.raw.prepare(`UPDATE members SET status = 'revoked' WHERE email = 'a@x.com'`).run()
    expect((await call('GET', '/api/ai/images/' + id, 'a@x.com')).status).toBe(403)
    // cross-origin upload refused
    await H.raw.prepare(`UPDATE members SET status = 'active' WHERE email = 'a@x.com'`).run()
    allowAi.add(a)
    expect(
      (
        await call(
          'POST',
          '/api/ai/images',
          'a@x.com',
          { conv: 'c2', images: [uri('exif.jpg')] },
          { Origin: 'https://evil.example.org' },
        )
      ).status,
    ).toBe(403)
    expect(
      (
        await call('POST', '/api/ai/images', 'a@x.com', {
          conv: 'c2',
          images: [uri('exif.jpg'), uri('exif.jpg'), uri('exif.jpg'), uri('exif.jpg')],
        })
      ).status,
    ).toBe(400)
    void b
  })
  it('quotas: per-account count / bytes and whole-store cap answer 507 with a clear reason', async () => {
    const a = await accountOf('q@x.com')
    allowAi.add(a)
    const st = []
    for (let i = 0; i < ACCOUNT_MAX_IMAGES; i++)
      st.push(
        media
          .prepare(
            `INSERT INTO ai_images (id, account_id, conv, mime, bytes, w, h, sha, data, created_at, linked_at) VALUES (?, ?, 'cx', 'image/jpeg', 10, 1, 1, ?, x'00', 0, 0)`,
          )
          .bind('img_' + i.toString(16).padStart(32, '0'), a, 's' + i),
      )
    await media.batch(st)
    const full = await call('POST', '/api/ai/images', 'q@x.com', { conv: 'c9', images: [uri('exif.jpg')] })
    expect(full.status).toBe(507)
    expect(full.json.error).toBe('account_full')
    expect(full.json.reason).toContain('图片空间已满')
    const b = await accountOf('r@x.com')
    allowAi.add(b)
    const small = await call(
      'POST',
      '/api/ai/images',
      'r@x.com',
      { conv: 'c9', images: [uri('exif.jpg')] },
      {},
      { ...env, MEDIA_MAX_BYTES: '1000' },
    )
    expect(small.status).toBe(507)
    expect(small.json.error).toBe('store_full')
    const usage = await call('GET', '/api/ai/images/usage', 'q@x.com')
    expect(usage.json.images).toBe(ACCOUNT_MAX_IMAGES)
  })
  it('without the store binding: honest 503 media_unavailable', async () => {
    await accountOf('n@x.com')
    const r = await call(
      'POST',
      '/api/ai/images',
      'n@x.com',
      { conv: 'c', images: [uri('exif.jpg')] },
      {},
      { ...env, MEDIA_DB: undefined },
    )
    expect(r.status).toBe(503)
    expect(r.json.error).toBe('media_unavailable')
  })
})

describe('lifecycle', () => {
  async function push(email: string, accountId: string, ops: any[]) {
    const res = await handleApi(
      new Request(HOST + '/api/sync/push', {
        method: 'POST',
        headers: {
          'X-ExamPilot-Sync': '1',
          'Content-Type': 'application/json',
          Origin: HOST,
          'Cf-Access-Jwt-Assertion': await H.issuer.token(email),
        },
        body: JSON.stringify({ protocol: 1, accountId, bankFp: 'fp-test', clientId: 'client_test_1', ops, docs: [] }),
      }),
      env,
      { auth: { fetchJwks: async () => H.issuer.jwks }, now: () => now },
    )
    return res.json() as Promise<any>
  }
  it('message links images; deleting the conversation deletes them; orphans and gone accounts are swept', async () => {
    const a = await accountOf('l@x.com')
    allowAi.add(a)
    const up = await call('POST', '/api/ai/images', 'l@x.com', { conv: 'conv_keep', images: [uri('exif.jpg')] })
    const keep = up.json.images[0]
    const orphan = (await call('POST', '/api/ai/images', 'l@x.com', { conv: 'conv_orphan', images: [uri('text.png')] }))
      .json.images[0]
    const gone = (await call('POST', '/api/ai/images', 'l@x.com', { conv: 'conv_gone', images: [uri('text.png')] }))
      .json.images[0]
    const msg = (id: string, conv: string, im: any) => ({
      id,
      kind: 'ai_msg',
      epoch: 1,
      createdAt: now,
      body: {
        conv,
        msg: {
          id: 'm_' + id,
          role: 'user',
          content: '看图',
          status: 'done',
          at: now,
          images: [{ id: im.id, w: im.w, h: im.h }],
        },
      },
    })
    const r1 = await push('l@x.com', a, [msg('op_a1', 'conv_keep', keep), msg('op_a2', 'conv_gone', gone)])
    expect(r1.ok).toBe(true)
    const linked = await media.prepare('SELECT id FROM ai_images WHERE linked_at IS NOT NULL').all()
    expect(linked.results.map((x: any) => x.id).sort()).toEqual([keep.id, gone.id].sort())
    // delete one conversation → its picture goes immediately
    await push('l@x.com', a, [
      { id: 'op_del1', kind: 'ai_conv_del', epoch: 1, createdAt: now, body: { conv: 'conv_gone' } },
    ])
    expect(await media.prepare('SELECT id FROM ai_images WHERE id = ?').bind(gone.id).first()).toBeNull()
    // the sweep: unlinked after 24 h goes, linked stays
    const s = await mediaSweep({ ...env }, now + 25 * 3600_000)
    expect(s.orphans).toBe(1)
    expect(await media.prepare('SELECT id FROM ai_images WHERE id = ?').bind(orphan.id).first()).toBeNull()
    expect(await media.prepare('SELECT id FROM ai_images WHERE id = ?').bind(keep.id).first()).not.toBeNull()
    // the sweep also repairs a delete whose hook did not run
    await media
      .prepare(
        `INSERT INTO ai_images (id, account_id, conv, mime, bytes, w, h, sha, data, created_at, linked_at) VALUES ('img_${'a'.repeat(32)}', ?, 'conv_gone', 'image/jpeg', 1, 1, 1, 'zz', x'00', 0, 1)`,
      )
      .bind(a)
      .run()
    expect((await mediaSweep(env, now)).deletedConvs).toBe(1)
    // pictures of an account that no longer exists in the learning DB (purged) are swept
    await media
      .prepare(
        `INSERT INTO ai_images (id, account_id, conv, mime, bytes, w, h, sha, data, created_at, linked_at) VALUES ('img_${'c'.repeat(32)}', 'acc_purged_0000', 'cv', 'image/jpeg', 1, 1, 1, 'yy', x'00', 0, 1)`,
      )
      .run()
    expect((await mediaSweep(env, now)).goneAccounts).toBe(1)
    expect((await media.prepare('SELECT COUNT(*) AS n FROM ai_images WHERE account_id = ?').bind(a).first()).n).toBe(1)
    expect(
      (await media.prepare(`SELECT COUNT(*) AS n FROM ai_images WHERE account_id = 'acc_purged_0000'`).first()).n,
    ).toBe(0)
  })
  it('final deletion of a member removes all of their pictures and records the count', async () => {
    const a = await accountOf('p@x.com')
    allowAi.add(a)
    await call('POST', '/api/ai/images', 'p@x.com', { conv: 'conv_p', images: [uri('exif.jpg'), uri('text.png')] })
    const other = await accountOf('o@x.com')
    allowAi.add(other)
    await call('POST', '/api/ai/images', 'o@x.com', { conv: 'conv_o', images: [uri('exif.jpg')] })
    await H.raw
      .prepare(
        `UPDATE members SET status = 'revoked', delete_after = ?, delete_reason = 'admin_revoke' WHERE email = 'p@x.com'`,
      )
      .bind(now - 1000)
      .run()
    const r = await purgeMember(env, now, 'p@x.com')
    expect(r.ok).toBe(true)
    expect((await media.prepare('SELECT COUNT(*) AS n FROM ai_images WHERE account_id = ?').bind(a).first()).n).toBe(0)
    expect(
      (await media.prepare('SELECT COUNT(*) AS n FROM ai_images WHERE account_id = ?').bind(other).first()).n,
    ).toBe(1)
    const log = await H.raw.prepare('SELECT rows FROM deletion_log').first<any>()
    expect(JSON.parse(log.rows).ai_images).toBe(2)
  })
  it('protocol: image refs only on user messages, at most 3, well-formed ids', () => {
    const base = {
      conv: 'conv_test_0001',
      msg: { id: 'msg_test_0001', role: 'user', content: 'x', status: 'done', at: 1 },
    }
    const op = (msg: any) => ({
      id: 'op_test_0001',
      kind: 'ai_msg',
      epoch: 1,
      createdAt: 1,
      body: { ...base, msg: { ...base.msg, ...msg } },
    })
    expect(validateOp(op({ images: [{ id: 'img_' + 'b'.repeat(32), w: 10, h: 10 }] }))).toBeNull()
    expect(validateOp(op({ images: [{ id: 'x', w: 1, h: 1 }] }))).toBe('bad image ref')
    expect(validateOp(op({ role: 'assistant', status: 'done', images: [] }))).toBe('bad images')
    expect(validateOp(op({ images: new Array(4).fill({ id: 'img_' + 'b'.repeat(32), w: 1, h: 1 }) }))).toBe(
      'bad images',
    )
  })
})
