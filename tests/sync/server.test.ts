import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeHarness, type Harness, TEAM, AUD } from './test-harness'

let H: Harness
beforeEach(async () => {
  H = await makeHarness()
})
afterEach(async () => {
  await H.dispose()
})

const att = (id: string, qid = 'q1', isCorrect: boolean | null = true, t = 1000) => ({
  id,
  kind: 'attempt',
  epoch: 1,
  createdAt: t,
  body: {
    h: { id, qid, mode: 'practice', sessionId: 's1', answer: 'A', isCorrect, submittedAt: t, usedAI: false },
    ef: 1,
  },
})

async function me(email = 'a@example.com') {
  const r = await H.call('GET', '/api/sync/me', { email })
  expect(r.status).toBe(200)
  return r.json as { accountId: string; epoch: number; head: number }
}
const pushBody = (accountId: string, ops: unknown[], docs: unknown[] = [], clientId = 'client-aaaa') => ({
  protocol: 1,
  clientId,
  accountId,
  bankFp: 'fp-test',
  ops,
  docs,
})

describe('identity', () => {
  it('rejects missing, forged, expired, wrong-aud, wrong-iss, wrong-key and alg=none tokens', async () => {
    const now = Math.floor(Date.now() / 1000)
    const base = { aud: [AUD], email: 'a@example.com', iss: TEAM, exp: now + 600, iat: now, type: 'app' }
    const cases: [string, string | undefined][] = [
      ['missing', undefined],
      ['garbage', 'abc.def.ghi'],
      ['expired', await H.issuer.sign({ ...base, exp: now - 3600 })],
      ['wrong aud', await H.issuer.sign({ ...base, aud: ['other'] })],
      ['wrong iss', await H.issuer.sign({ ...base, iss: 'https://evil.cloudflareaccess.com' })],
      ['not yet valid', await H.issuer.sign({ ...base, nbf: now + 3600 })],
      ['wrong key', await H.issuer.sign(base, { key: H.issuer.otherKey })],
      ['unknown kid', await H.issuer.sign(base, { kid: 'kid-x' })],
      ['no email', await H.issuer.sign({ ...base, email: undefined })],
      [
        'alg none',
        btoa(JSON.stringify({ alg: 'none', kid: 'kid-1' })).replace(/=+$/, '') +
          '.' +
          btoa(JSON.stringify(base)).replace(/=+$/, '') +
          '.',
      ],
    ]
    for (const [name, tok] of cases) {
      const r =
        tok === undefined
          ? await H.call('GET', '/api/sync/me', { email: null })
          : await H.call('GET', '/api/sync/me', { token: tok })
      expect(r.status, name).toBe(401)
    }
  })

  it('tampered payload (email swapped) fails signature', async () => {
    const tok = await H.issuer.token('a@example.com')
    const [h, , s] = tok.split('.')
    const forged = btoa(
      JSON.stringify({ aud: [AUD], email: 'b@example.com', iss: TEAM, exp: 9e9, type: 'app' }),
    ).replace(/=+$/, '')
    expect((await H.call('GET', '/api/sync/me', { token: `${h}.${forged}.${s}` })).status).toBe(401)
  })

  it('same email -> same account, case-insensitive; different email -> different account', async () => {
    const a1 = await me('A@Example.com')
    const a2 = await me('a@example.com')
    const b = await me('b@example.com')
    expect(a1.accountId).toBe(a2.accountId)
    expect(b.accountId).not.toBe(a1.accountId)
  })

  it('requires the client header, same-origin POST and JSON', async () => {
    const a = await me()
    expect(
      (
        await H.call('POST', '/api/sync/push', {
          body: pushBody(a.accountId, []),
          headers: { Origin: 'https://evil.example' },
        })
      ).status,
    ).toBe(403)
    const r = await H.call('GET', '/api/sync/me', { headers: { 'X-ExamPilot-Sync': '0' } })
    expect(r.status).toBe(400)
  })

  it('account A cannot write into or read B (accountId in body is only compared)', async () => {
    const a = await me('a@example.com')
    const b = await me('b@example.com')
    // A claims B's account id
    const r = await H.call('POST', '/api/sync/push', {
      email: 'a@example.com',
      body: pushBody(b.accountId, [att('op-aaaaaa1')]),
    })
    expect(r.status).toBe(409)
    expect(r.json.error).toBe('identity_mismatch')
    // A writes to A
    expect(
      (
        await H.call('POST', '/api/sync/push', {
          email: 'a@example.com',
          body: pushBody(a.accountId, [att('op-aaaaaa1')]),
        })
      ).status,
    ).toBe(200)
    // B pulls: sees nothing of A
    const pb = await H.call('GET', '/api/sync/pull?since=0', { email: 'b@example.com' })
    expect(pb.json.ops).toHaveLength(0)
    const pa = await H.call('GET', '/api/sync/pull?since=0', { email: 'a@example.com' })
    expect(pa.json.ops).toHaveLength(1)
  })
})

describe('ops log', () => {
  it('accepts real question ids with CJK characters', async () => {
    const a = await me()
    const id = 'op-h-1792831875925-S001-a1b2c3d4-导论-6e4t3'
    const r = await H.call('POST', '/api/sync/push', {
      body: pushBody(a.accountId, [{ ...att('h-1792831875925-S001-a1b2c3d4-导论-6e4t3', 'S001-a1b2c3d4-导论'), id }]),
    })
    expect(r.json.ops[0].status).toBe('ok')
    const bad = await H.call('POST', '/api/sync/push', {
      body: pushBody(a.accountId, [{ ...att('x y z', 'q'), id: 'has space' }]),
    })
    expect(bad.json.ops[0].status).toBe('rejected')
  })

  it('is idempotent: the same op pushed 10 times is stored once', async () => {
    const a = await me()
    for (let i = 0; i < 10; i++) {
      const r = await H.call('POST', '/api/sync/push', { body: pushBody(a.accountId, [att('op-dup-0001')]) })
      expect(r.status).toBe(200)
      expect(['ok', 'dup']).toContain(r.json.ops[0].status)
    }
    const p = await H.call('GET', '/api/sync/pull?since=0')
    expect(p.json.ops.filter((o: { id: string }) => o.id === 'op-dup-0001')).toHaveLength(1)
  })

  it('duplicate ids inside one push are stored once', async () => {
    const a = await me()
    const r = await H.call('POST', '/api/sync/push', {
      body: pushBody(a.accountId, [att('op-x-000001'), att('op-x-000001')]),
    })
    expect(r.json.ops.map((o: { status: string }) => o.status)).toEqual(['ok', 'dup'])
  })

  it('assigns gap-free increasing seq across concurrent pushes from two devices', { timeout: 30000 }, async () => {
    const a = await me()
    const pushes = []
    for (let i = 0; i < 6; i++) {
      pushes.push(
        H.call('POST', '/api/sync/push', {
          body: pushBody(
            a.accountId,
            [att(`op-c${i}-aaaa`, 'q' + i), att(`op-c${i}-bbbb`, 'q' + i)],
            [],
            i % 2 ? 'client-bbbb' : 'client-aaaa',
          ),
        }),
      )
    }
    const res = await Promise.all(pushes)
    for (const r of res) expect(r.status).toBe(200)
    const p = await H.call('GET', '/api/sync/pull?since=0')
    const seqs = p.json.ops.map((o: { seq: number }) => o.seq)
    expect(seqs).toEqual(Array.from({ length: 12 }, (_, i) => i + 1))
    expect(p.json.head).toBe(12)
  })

  it('a failed D1 batch commits nothing and the retry commits exactly once', async () => {
    const a = await me()
    H.failNextBatch(1)
    const r1 = await H.call('POST', '/api/sync/push', { body: pushBody(a.accountId, [att('op-fail-001')]) })
    expect(r1.status).toBe(503)
    const p1 = await H.call('GET', '/api/sync/pull?since=0')
    expect(p1.json.ops).toHaveLength(0)
    const r2 = await H.call('POST', '/api/sync/push', { body: pushBody(a.accountId, [att('op-fail-001')]) })
    expect(r2.json.ops[0].status).toBe('ok')
  })

  it('pull pages without skipping and resumes from a cursor', { timeout: 60000 }, async () => {
    const a = await me()
    let n = 0
    for (let k = 0; k < 20; k++) {
      const ops = Array.from({ length: 25 }, () => att(`op-page-${String(n++).padStart(5, '0')}`, 'q' + (n % 50)))
      expect((await H.call('POST', '/api/sync/push', { body: pushBody(a.accountId, ops) })).status).toBe(200)
    }
    let since = 0
    const got: number[] = []
    for (let guard = 0; guard < 10; guard++) {
      const p = await H.call('GET', `/api/sync/pull?since=${since}`)
      got.push(...p.json.ops.map((o: { seq: number }) => o.seq))
      since = p.json.head
      if (!p.json.more) break
    }
    expect(got).toEqual(Array.from({ length: 500 }, (_, i) => i + 1))
  })

  it('reset bumps the epoch; ops created against the old epoch are rejected as stale', async () => {
    const a = await me()
    await H.call('POST', '/api/sync/push', { body: pushBody(a.accountId, [att('op-r-00001')]) })
    const r = await H.call('POST', '/api/sync/push', {
      body: pushBody(a.accountId, [{ id: 'op-reset-01', kind: 'reset', epoch: 1, createdAt: 2, body: {} }]),
    })
    expect(r.json.epoch).toBe(2)
    const stale = await H.call('POST', '/api/sync/push', {
      body: pushBody(a.accountId, [att('op-r-00002')], [], 'client-old1'),
    })
    expect(stale.json.ops[0].status).toBe('stale_epoch')
    // settings survive resets and are not epoch checked
    const s = await H.call('POST', '/api/sync/push', {
      body: pushBody(a.accountId, [
        { id: 'op-set-0001', kind: 'settings', epoch: 1, createdAt: 3, body: { patch: { theme: 'dark' } } },
      ]),
    })
    expect(s.json.ops[0].status).toBe('ok')
    // pull from scratch skips everything before the reset
    const p = await H.call('GET', '/api/sync/pull?since=0')
    expect(p.json.ops.map((o: { kind: string }) => o.kind)).toEqual(['reset', 'settings'])
  })

  it('rejects invalid ops and oversize requests', async () => {
    const a = await me()
    const r = await H.call('POST', '/api/sync/push', {
      body: pushBody(a.accountId, [
        { id: 'op-bad-0001', kind: 'attempt', epoch: 1, createdAt: 1, body: { h: { id: 'x' } } },
      ]),
    })
    expect(r.json.ops[0].status).toBe('rejected')
    const big = Array.from({ length: 26 }, (_, i) => att('op-big-' + String(i).padStart(4, '0')))
    expect((await H.call('POST', '/api/sync/push', { body: pushBody(a.accountId, big) })).status).toBe(413)
    const bank = await H.call('POST', '/api/sync/push', { body: { ...pushBody(a.accountId, []), bankFp: 'other' } })
    expect(bank.json.error).toBe('bank_mismatch')
  })
})

describe('documents', () => {
  it('draft CAS: an older base version cannot overwrite a newer draft', async () => {
    const a = await me()
    const put = (opId: string, base: number, body: unknown, client = 'client-aaaa') =>
      H.call('POST', '/api/sync/push', {
        body: pushBody(
          a.accountId,
          [],
          [{ opId, key: 'draft.practice', type: 'put', baseVersion: base, body }],
          client,
        ),
      })
    expect((await put('d-op-00001', 0, { sessionId: 's1', idx: 0 })).json.docs[0].status).toBe('ok')
    expect((await put('d-op-00002', 1, { sessionId: 's1', idx: 3 }, 'client-bbbb')).json.docs[0].status).toBe('ok')
    const stale = await put('d-op-00003', 1, { sessionId: 's1', idx: 1 })
    expect(stale.json.docs[0].status).toBe('conflict')
    expect(stale.json.docs[0].doc.body.idx).toBe(3)
    // retry of an applied op is a dup, not a conflict
    expect((await put('d-op-00002', 1, { sessionId: 's1', idx: 3 }, 'client-bbbb')).json.docs[0].status).toBe('dup')
  })

  it('exam: lease fencing, deadline cannot be extended, single settlement', async () => {
    const a = await me()
    const now = Date.now()
    const start = await H.call('POST', '/api/sync/push', {
      body: pushBody(
        a.accountId,
        [],
        [
          {
            opId: 'e-op-00001',
            key: 'exam.current',
            type: 'exam_start',
            baseVersion: 0,
            body: {
              runId: 'm-run-1',
              qids: ['q1', 'q2'],
              config: {},
              startedAt: now,
              endsAt: now + 99 * 3600_000,
              durationMs: 600_000,
              answers: {},
              idx: 0,
            },
          },
        ],
      ),
    })
    const doc = start.json.docs[0].doc
    expect(doc.body.endsAt).toBeLessThanOrEqual(Date.now() + 600_000)
    // device B takes over
    const tk = await H.call('POST', '/api/sync/push', {
      body: pushBody(
        a.accountId,
        [],
        [
          {
            opId: 'e-op-00002',
            key: 'exam.current',
            type: 'exam_takeover',
            baseVersion: doc.version,
            leaseGen: 1,
            body: { runId: 'm-run-1' },
          },
        ],
        'client-bbbb',
      ),
    })
    expect(tk.json.docs[0].doc.body.leaseGen).toBe(2)
    // device A (old lease) can no longer save
    const save = await H.call('POST', '/api/sync/push', {
      body: pushBody(
        a.accountId,
        [],
        [
          {
            opId: 'e-op-00003',
            key: 'exam.current',
            type: 'exam_save',
            baseVersion: 2,
            leaseGen: 1,
            body: { runId: 'm-run-1', answers: { q1: 'A' }, idx: 1 },
          },
        ],
      ),
    })
    expect(save.json.docs[0].status).toBe('lease_lost')
    const mock = (lease: number, client: string, opId = 'mock:m-run-1') =>
      H.call('POST', '/api/sync/push', {
        body: pushBody(
          a.accountId,
          [
            {
              id: opId,
              kind: 'mock',
              epoch: 1,
              createdAt: now,
              body: {
                leaseGen: lease,
                run: {
                  id: 'm-run-1',
                  startedAt: now,
                  endedAt: now + 1,
                  config: {},
                  submissions: { q1: 'A', q2: null },
                  graded: true,
                  score: 1,
                  maxScore: 2,
                  perQuestion: {},
                },
                attempts: [
                  {
                    h: {
                      id: 'h-att-m-run-1-q1',
                      qid: 'q1',
                      mode: 'mock',
                      sessionId: 'm-run-1',
                      answer: 'A',
                      isCorrect: true,
                      submittedAt: now + 1,
                      usedAI: false,
                    },
                    ef: 1,
                  },
                ],
              },
            },
          ],
          [],
          client,
        ),
      })
    expect((await mock(1, 'client-aaaa')).json.ops[0].status).toBe('lease_lost')
    expect((await mock(2, 'client-bbbb')).json.ops[0].status).toBe('ok')
    expect((await mock(2, 'client-bbbb')).json.ops[0].status).toBe('dup')
    const p = await H.call('GET', '/api/sync/pull?since=0')
    expect(p.json.ops.filter((o: { kind: string }) => o.kind === 'mock')).toHaveLength(1)
    expect(p.json.docs.find((d: { key: string }) => d.key === 'exam.current').body.status).toBe('submitted')
    // a submitted exam cannot be saved or restarted under the same id
    const again = await H.call('POST', '/api/sync/push', {
      body: pushBody(
        a.accountId,
        [],
        [
          {
            opId: 'e-op-00009',
            key: 'exam.current',
            type: 'exam_save',
            baseVersion: 9,
            leaseGen: 2,
            body: { runId: 'm-run-1', answers: {}, idx: 0 },
          },
        ],
        'client-bbbb',
      ),
    })
    expect(again.json.docs[0].status).toBe('expired')
  })
})
