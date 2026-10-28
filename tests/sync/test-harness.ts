/**
 * Test harness: a real workerd/SQLite D1 (Miniflare) running the production
 * schema, plus an Access-like token issuer with its own RSA key pair.
 * Used only by *.test.ts files; never bundled into the app or the Worker.
 */
import { Miniflare } from 'miniflare'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const HERE = path.dirname(fileURLToPath(import.meta.url))
import { handleApi, type Env, _resetRateLimits } from '../../worker/api'
import { _resetJwksCache } from '../../worker/auth'

export const TEAM = 'https://test-team.cloudflareaccess.com'
export const AUD = 'aud-test-0123456789'
export const BANK_FP = 'fp-test'
export const HOST = 'https://sync.test'

function b64url(buf: ArrayBuffer | Uint8Array | string): string {
  const bytes = typeof buf === 'string' ? new TextEncoder().encode(buf) : new Uint8Array(buf as ArrayBuffer)
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export interface Issuer {
  jwks: { keys: JsonWebKey[] }
  sign(claims: Record<string, unknown>, opts?: { kid?: string; key?: CryptoKey }): Promise<string>
  token(email: string, extra?: Record<string, unknown>): Promise<string>
  otherKey: CryptoKey
}

export async function makeIssuer(): Promise<Issuer> {
  const gen = () =>
    crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify'],
    ) as Promise<CryptoKeyPair>
  const kp = await gen()
  const other = await gen()
  const pub = (await crypto.subtle.exportKey('jwk', kp.publicKey)) as JsonWebKey
  const jwks = { keys: [{ ...pub, kid: 'kid-1', alg: 'RS256', use: 'sig' } as JsonWebKey] }
  const sign = async (claims: Record<string, unknown>, opts: { kid?: string; key?: CryptoKey } = {}) => {
    const header = b64url(JSON.stringify({ alg: 'RS256', kid: opts.kid ?? 'kid-1', typ: 'JWT' }))
    const payload = b64url(JSON.stringify(claims))
    const sig = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      opts.key ?? kp.privateKey,
      new TextEncoder().encode(header + '.' + payload),
    )
    return header + '.' + payload + '.' + b64url(sig)
  }
  const token = (email: string, extra: Record<string, unknown> = {}) => {
    const now = Math.floor(Date.now() / 1000)
    return sign({
      aud: [AUD],
      email,
      exp: now + 3600,
      iat: now,
      nbf: now,
      iss: TEAM,
      type: 'app',
      sub: 'sub-' + email,
      ...extra,
    })
  }
  return { jwks, sign, token, otherKey: other.privateKey }
}

export interface Harness {
  mf: Miniflare
  env: Env
  issuer: Issuer
  /** call the API as `email` (null = no token) */
  call(
    method: string,
    path: string,
    opts?: { email?: string | null; token?: string; body?: unknown; headers?: Record<string, string> },
  ): Promise<{ status: number; json: any }>
  /** inject failures into DB.batch */
  failNextBatch(n?: number): void
  /** make every query matching these patterns fail (empty list = none) */
  failQueries(patterns: RegExp[]): void
  /** raw D1 (no failure injection) */
  raw: Awaited<ReturnType<Miniflare['getD1Database']>>
  dispose(): Promise<void>
}

/** Apply every forward migration in order (the same files deploy-sync runs). */
export async function applyMigrations(db: { prepare(s: string): { run(): Promise<unknown> } }) {
  const dir = path.join(HERE, '../../worker/migrations')
  for (const f of readdirSync(dir)
    .filter((x) => /^\d+_.+\.sql$/.test(x) && !x.includes('down'))
    .sort()) {
    await runSqlFile(db, path.join(dir, f))
  }
}
export async function runSqlFile(db: { prepare(s: string): { run(): Promise<unknown> } }, file: string) {
  const sql = readFileSync(file, 'utf-8')
  for (const stmt of sql
    .split(/;\s*\n/)
    .map((s) => s.replace(/--.*$/gm, '').trim())
    .filter(Boolean)) {
    await db.prepare(stmt).run()
  }
}

export async function makeHarness(): Promise<Harness> {
  _resetJwksCache()
  _resetRateLimits()
  const mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("x") } }',
    d1Databases: { DB: 'test-db-' + Math.random().toString(36).slice(2) },
  })
  const db = await mf.getD1Database('DB')
  await applyMigrations(db)
  let failBatches = 0
  const failSql: RegExp[] = []
  const wrapped = {
    prepare: (s: string) => {
      if (failSql.some((r) => r.test(s))) {
        const boom = () => Promise.reject(new Error('D1_ERROR: simulated query failure'))
        const st = { bind: () => st, first: boom, all: boom, run: boom }
        return st as unknown as ReturnType<typeof db.prepare>
      }
      return db.prepare(s)
    },
    batch: async (stmts: unknown[]) => {
      if (failBatches > 0) {
        failBatches--
        throw new Error('D1_ERROR: simulated outage')
      }
      return db.batch(stmts as never)
    },
  }
  const issuer = await makeIssuer()
  const env: Env = {
    DB: wrapped as unknown as Env['DB'],
    ACCESS_TEAM_DOMAIN: TEAM,
    ACCESS_AUD: AUD,
    BANK_FP,
  }
  const call: Harness['call'] = async (method, p, opts = {}) => {
    const headers: Record<string, string> = { 'X-ExamPilot-Sync': '1', ...(opts.headers ?? {}) }
    if (opts.token !== undefined) headers['Cf-Access-Jwt-Assertion'] = opts.token
    else if (opts.email !== null) headers['Cf-Access-Jwt-Assertion'] = await issuer.token(opts.email ?? 'a@example.com')
    let body: string | undefined
    if (opts.body !== undefined) {
      body = JSON.stringify(opts.body)
      headers['Content-Type'] = headers['Content-Type'] ?? 'application/json'
      headers['Origin'] = headers['Origin'] ?? HOST
    }
    const res = await handleApi(new Request(HOST + p, { method, headers, body }), env, {
      auth: { fetchJwks: async () => issuer.jwks },
    })
    return { status: res.status, json: await res.json() }
  }
  return {
    mf,
    env,
    issuer,
    call,
    failNextBatch: (n = 1) => {
      failBatches = n
    },
    failQueries: (patterns) => {
      failSql.splice(0, failSql.length, ...patterns)
    },
    raw: db,
    dispose: () => mf.dispose(),
  }
}
