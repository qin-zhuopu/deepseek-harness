/**
 * Sign-in against a stand-in IAM over real sockets: the fake publishes the
 * discovery document and JWKS (real RSA keypair, the Jereh claim shape), and
 * the portal's relay/login/verify path is driven exactly like the shipped
 * gate's host test drives the plugin.
 */

import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSign, generateKeyPairSync } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { parsePortalConfig } from '../src/config.ts'
import { authorizeUrl, beginLogin, completeLogin, createIamClient, sessionFromRequest, type IamClient } from '../src/auth.ts'
import type { PortalConfig } from '../src/config.ts'
import type { IncomingMessage, ServerResponse } from 'node:http'

const key = generateKeyPairSync('rsa', { modulusLength: 2048 })
const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')

/** Mint one RS256 id_token in the Jereh IAM shape (0007 Identity claims). */
function idToken(issuer: string, over: Record<string, unknown> = {}, secret = key.privateKey): string {
  const exp = Math.floor(Date.now() / 1000) + 3600
  const payload = { sub: '14409', userId: '14409', uid: '20241029082727096-E823-55B596A1D', aud: 'EnterpriseDingtalk', iss: issuer, iat: exp - 60, exp, nonce: null, ...over }
  const input = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(payload)}`
  const signer = createSign('sha256')
  signer.update(input)
  return `${input}.${signer.sign(secret).toString('base64url')}`
}

let idpServer: Server | undefined
let context: { dir: string } | undefined

afterEach(async () => {
  if (idpServer !== undefined) { idpServer.close(); await once(idpServer, 'close'); idpServer = undefined }
  if (context !== undefined) { await rm(context.dir, { recursive: true, force: true }); context = undefined }
})

async function startIdp(): Promise<{ issuer: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'ide-portal-auth-'))
  context = { dir }
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://idp.local')
    const origin = `http://127.0.0.1:${String((server.address() as { port: number }).port)}`
    if (url.pathname === '/idp/.well-known/openid-configuration') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ issuer: `${origin}/idp`, authorization_endpoint: `${origin}/idp/authCenter/authenticate`, jwks_uri: `${origin}/idp/oidc/getPublicKey` }))
      return
    }
    if (url.pathname === '/idp/oidc/getPublicKey') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ keys: [key.publicKey.export({ format: 'jwk' })] }))
      return
    }
    res.writeHead(404); res.end()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  idpServer = server
  return { issuer: `http://127.0.0.1:${String((server.address() as { port: number }).port)}/idp` }
}

async function setup(): Promise<{ config: PortalConfig; iam: IamClient }> {
  const { issuer } = await startIdp()
  const dir = await mkdtemp(join(tmpdir(), 'ide-portal-auth-'))
  const envFile = join(dir, '.env')
  await writeFile(envFile, 'NR_API_KEY=sk-test\n')
  const config = parsePortalConfig(`
domainSuffix: jereh-pe.cn
entryHost: ide.jereh-pe.cn
uid: {claim: sub, crossCheckClaim: userId, pattern: "^[0-9]{1,8}$"}
imageTag: t
modelKey: {envFile: ${JSON.stringify(envFile)}, varName: NR_API_KEY}
jenkins: {url: http://jenkins.invalid, job: j, user: u, tokenEnv: IDE_JENKINS_TOKEN}
iam: {issuer: ${issuer}, clientId: EnterpriseDingtalk, redirectPath: /auth/callback}
health: {intervalSec: 30, timeoutSec: 600, pollMs: 1}
`)
  return { config, iam: createIamClient(config.iam) }
}

/** A minimal fake response capturing writes live, enough for the auth helpers. */
function fakeRes(): { res: ServerResponse; headers: Record<string, string | string[]>; body: string; status: number } {
  const out = { headers: {} as Record<string, string | string[]>, body: '', status: 0 }
  const res = {
    setHeader(name: string, value: string | string[]) { out.headers[name.toLowerCase()] = value },
    writeHead(status: number, headers?: Record<string, string>) {
      out.status = status
      for (const [name, value] of Object.entries(headers ?? {})) out.headers[name.toLowerCase()] = value
    },
    end(chunk?: string) { if (typeof chunk === 'string') out.body += chunk },
  } as unknown as ServerResponse
  return new Proxy(out, {
    get: (target, key) => key === 'res' ? res : Reflect.get(target, key) as unknown,
  }) as typeof out & { res: ServerResponse }
}

/** A fake request with cookies, enough for beginLogin/completeLogin/sessionFromRequest. */
function fakeReq(opts: { cookies?: string; authorization?: string; host?: string }): IncomingMessage {
  const headers: Record<string, string> = { host: opts.host ?? 'ide.jereh-pe.cn' }
  if (opts.cookies !== undefined) headers.cookie = opts.cookies
  if (opts.authorization !== undefined) headers.authorization = opts.authorization
  return { headers, method: 'GET', url: '/' } as unknown as IncomingMessage
}

describe('createIamClient + verify (FR1)', () => {
  it('verifies a Jereh-shaped token and surfaces the full payload', async () => {
    const { config, iam } = await setup()
    const token = idToken(config.iam.issuer)
    const session = await iam.verify(token)
    expect(session?.sub).toBe('14409')
    expect(session?.claims['userId']).toBe('14409')
    expect(session?.claims['uid']).toBe('20241029082727096-E823-55B596A1D')
  })

  it('refuses a foreign issuer, a foreign audience, an expired token, and a foreign signature', async () => {
    const { config, iam } = await setup()
    expect(await iam.verify(idToken('http://evil.invalid/idp'))).toBeUndefined()
    expect(await iam.verify(idToken(config.iam.issuer, { aud: 'OtherClient' }))).toBeUndefined()
    const expired = idToken(config.iam.issuer, { exp: Math.floor(Date.now() / 1000) - 5 })
    expect(await iam.verify(expired)).toBeUndefined()
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 })
    expect(await iam.verify(idToken(config.iam.issuer, {}, other.privateKey))).toBeUndefined()
  })
})

describe('login + callback (C10)', () => {
  it('beginLogin seeds state and builds the implicit URL with the composed redirect_uri', async () => {
    const { config, iam } = await setup()
    const captured = fakeRes()
    await beginLogin(config.iam, iam, fakeReq({}), captured.res, '/')
    expect(captured.status).toBe(302)
    const location = new URL(String(captured.headers['location']))
    expect(location.searchParams.get('response_type')).toBe('token')
    expect(location.searchParams.get('client_id')).toBe('EnterpriseDingtalk')
    expect(location.searchParams.get('redirect_uri')).toBe(`http://ide.jereh-pe.cn${config.iam.redirectPath}`)
    const cookie = String(captured.headers['set-cookie'] ?? '')
    expect(cookie).toContain('ide_oidc_state=')
    expect(cookie).toContain('HttpOnly')
  })

  it('completeLogin lands the session cookie on state match and verification', async () => {
    const { config, iam } = await setup()
    const begin = fakeRes()
    await beginLogin(config.iam, iam, fakeReq({}), begin.res, '/')
    const cookieRaw = String(begin.headers['set-cookie'] ?? '')
    const stateCookie = cookieRaw.split(';')[0] ?? ''
    const stored = JSON.parse(Buffer.from(stateCookie.split('=')[1] ?? '', 'base64url').toString()) as { state: string }
    const state = stored.state
    const formReq = { headers: { cookie: stateCookie, host: 'ide.jereh-pe.cn' }, method: 'POST', url: config.iam.redirectPath } as unknown as IncomingMessage
    // Feed the body by pre-reading through the same interface readCappedBody expects.
    ;(formReq as unknown as { [Symbol.asyncIterator]: () => AsyncIterator<Buffer> })[Symbol.asyncIterator] = (function* () {
      yield Buffer.from(new URLSearchParams({ id_token: idToken(config.iam.issuer), state }).toString())
    }) as never
    const done = fakeRes()
    const result = await completeLogin(iam, formReq, done.res)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.session.sub).toBe('14409')
    const setCookie = String(done.headers['set-cookie'] ?? '')
    expect(setCookie).toContain('dsh_token=')
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('SameSite=Lax')
  })

  it('a foreign state or a missing state refuses without landing a session', async () => {
    const { config, iam } = await setup()
    const formReq = { headers: { cookie: 'ide_oidc_state=nope', host: 'ide.jereh-pe.cn' }, method: 'POST', url: config.iam.redirectPath } as unknown as IncomingMessage
    ;(formReq as unknown as { [Symbol.asyncIterator]: () => AsyncIterator<Buffer> })[Symbol.asyncIterator] = (function* () {
      yield Buffer.from(new URLSearchParams({ id_token: idToken(config.iam.issuer), state: 'x' }).toString())
    }) as never
    const done = fakeRes()
    const result = await completeLogin(iam, formReq, done.res)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(401)
  })
})

describe('sessionFromRequest', () => {
  it('reads the bearer header ahead of the cookie and verifies it', async () => {
    const { config, iam } = await setup()
    const session = await sessionFromRequest(iam, fakeReq({ authorization: `Bearer ${idToken(config.iam.issuer)}` }))
    expect(session?.sub).toBe('14409')
    expect(await sessionFromRequest(iam, fakeReq({}))).toBeUndefined()
  })
})

describe('authorizeUrl', () => {
  it('appends every implicit-flow parameter to the discovered endpoint', async () => {
    const { config, iam } = await setup()
    const doc = await iam.document()
    if (doc === undefined) throw new Error('document unavailable')
    const url = new URL(authorizeUrl(config.iam, 'http://ide.jereh-pe.cn', 'st123', doc))
    expect(url.pathname).toBe('/idp/authCenter/authenticate')
    expect(url.searchParams.get('scope')).toBe('openid')
    expect(url.searchParams.get('state')).toBe('st123')
  })
})

describe('offline trust (iam.trustFile)', () => {
  /** Capture the live fake's two published documents the way an operator seeds the file. */
  async function seedTrustFile(issuer: string, dir: string): Promise<string> {
    const base = issuer.replace(/\/+$/, '')
    const readJson = async (url: string): Promise<Record<string, unknown>> =>
      JSON.parse(await (await fetch(url)).text()) as Record<string, unknown>
    const discovery = await readJson(`${base}/.well-known/openid-configuration`)
    const jwks = await readJson(String(discovery['jwks_uri']))
    const path = join(dir, 'iam-trust.json')
    await writeFile(path, JSON.stringify({ discovery, jwks }))
    return path
  }

  async function offlineSetup(): Promise<{ config: PortalConfig; iam: IamClient; issuer: string }> {
    const { issuer } = await startIdp()
    const trustFile = await seedTrustFile(issuer, context?.dir ?? '/tmp')
    const dir = await mkdtemp(join(tmpdir(), 'ide-portal-auth-'))
    const envFile = join(dir, '.env')
    await writeFile(envFile, 'NR_API_KEY=sk-test\n')
    const config = parsePortalConfig(`
domainSuffix: jereh-pe.cn
entryHost: ide.jereh-pe.cn
uid: {claim: sub, crossCheckClaim: userId, pattern: "^[0-9]{1,8}$"}
imageTag: t
modelKey: {envFile: ${JSON.stringify(envFile)}, varName: NR_API_KEY}
jenkins: {url: http://jenkins.invalid, job: j, user: u, tokenEnv: IDE_JENKINS_TOKEN}
iam: {issuer: ${issuer}, clientId: EnterpriseDingtalk, redirectPath: /auth/callback, trustFile: ${JSON.stringify(trustFile)}}
health: {intervalSec: 30, timeoutSec: 600, pollMs: 1}
`)
    // No fetch ever: an unreachable IAM answers every request with a refusal.
    const never = ((): never => { throw new Error('offline deployment must not fetch') }) as unknown as typeof globalThis.fetch
    return { config, iam: createIamClient(config.iam, never), issuer }
  }

  it('verifies and redirects from the seeded file with the IAM unreachable', async () => {
    const { config, iam } = await offlineSetup()
    const session = await iam.verify(idToken(config.iam.issuer))
    expect(session?.sub).toBe('14409')
    const captured = fakeRes()
    await beginLogin(config.iam, iam, fakeReq({}), captured.res, '/')
    expect(captured.status).toBe(302)
  })

  it('refuses a token signed with a key outside the seeded set', async () => {
    const { config, iam } = await offlineSetup()
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 })
    expect(await iam.verify(idToken(config.iam.issuer, {}, other.privateKey))).toBeUndefined()
  })

  it('refuses a trust file whose issuer disagrees with iam.issuer', async () => {
    const { issuer } = await startIdp()
    const dir = await mkdtemp(join(tmpdir(), 'ide-portal-auth-'))
    const path = join(dir, 'iam-trust.json')
    await writeFile(path, JSON.stringify({
      discovery: { issuer: 'https://iam.other.cn/idp', authorization_endpoint: 'https://iam.other.cn/idp/authCenter/authenticate', jwks_uri: 'https://iam.other.cn/idp/oidc/getPublicKey' },
      jwks: { keys: [key.publicKey.export({ format: 'jwk' })] },
    }))
    expect(() => createIamClient({ issuer, clientId: 'EnterpriseDingtalk', redirectPath: '/auth/callback', trustFile: path })).toThrow(/disagrees/)
  })

  it('refuses an unreadable or keyless trust file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ide-portal-auth-'))
    const base = { issuer: 'https://iam.jereh.cn/idp', clientId: 'c', redirectPath: '/auth/callback' }
    expect(() => createIamClient({ ...base, trustFile: join(dir, 'missing.json') })).toThrow(/not readable JSON/)
    const keyless = join(dir, 'keyless.json')
    await writeFile(keyless, JSON.stringify({
      discovery: { issuer: base.issuer, authorization_endpoint: `${base.issuer}/authCenter/authenticate`, jwks_uri: `${base.issuer}/oidc/getPublicKey` },
      jwks: { keys: [] },
    }))
    expect(() => createIamClient({ ...base, trustFile: keyless })).toThrow(/no usable JWKS keys/)
  })
})
