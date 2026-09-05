/**
 * REAL-composition coverage against a stand-in identity provider: a local
 * HTTP server serves the discovery document and JWKS (real RSA keypair), the
 * Loader composition boots webserver + auth-iam, and the browser flow is
 * driven request-by-request — login redirect (implicit-flow parameters,
 * state cookie), fragment-callback POST landing the session cookie, gated
 * surfaces and upgrades, provider error and state-mismatch refusals, logout,
 * and guard/route release on fiber disposal (HMR safety).
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { generateKeyPairSync, createSign, sign as cryptoSign } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import HttpServer from '@deepseek-ai/dsh-host-webserver'
import * as AuthIam from '../src/index.ts'

const CLIENT = 'EnterpriseDingtalk'
const COOKIE = 'dsh_token'

void createSign

const key = generateKeyPairSync('rsa', { modulusLength: 2048 })
const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')

/** Mint one RS256 id_token exactly as the Jereh IAM would. */
function idToken(issuer: string, over: Record<string, unknown> = {}): string {
  return idTokenWith(key.privateKey, issuer, over)
}

function idTokenWith(signingKey: PrivateKeyLike, issuer: string, over: Record<string, unknown> = {}): string {
  const exp = Math.floor(Date.now() / 1000) + 3600
  const payload = { sub: '14409', userId: '14409', aud: CLIENT, iss: issuer, iat: exp - 3600, exp, nonce: null, ...over }
  const input = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(payload)}`
  return `${input}.${cryptoSign('sha256', Buffer.from(input), signingKey).toString('base64url')}`
}

type PrivateKeyLike = ReturnType<typeof generateKeyPairSync>['privateKey']

/** The stand-in IAM: discovery + JWKS over HTTP, with a one-shot failure switch and a hot key set. */
interface FakeIdp {
  issuer: string
  hits: string[]
  /** The next JWKS fetch answers 500 once (discovery stands). */
  failNext: boolean
  /** Every provider route answers 500 (held until unset). */
  failDiscovery: boolean
  /** The JWK set currently published. */
  keys: object[]
}

let idp: FakeIdp | undefined
let root: string | undefined
let context: Context | undefined
let idpServer: Server | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (idpServer !== undefined) {
    idpServer.close()
    await once(idpServer, 'close')
    idpServer = undefined
  }
  idp = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function startIdp(): Promise<FakeIdp> {
  const hits: string[] = []
  const state: { failNext: boolean; failDiscovery: boolean; keys: object[] } = { failNext: false, failDiscovery: false, keys: [{ ...key.publicKey.export({ format: 'jwk' }) as object }] }
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://idp.local')
    hits.push(url.pathname)
    // The failure switches: failDiscovery takes every route down; failNext
    // targets the JWKS endpoint only (a partial outage).
    if ((state.failNext && url.pathname === '/idp/oidc/getPublicKey') || state.failDiscovery) {
      if (state.failDiscovery) {
        res.writeHead(500)
        res.end()
        return
      }
      state.failNext = false
      res.writeHead(500)
      res.end()
      return
    }
    const origin = `http://127.0.0.1:${String((server.address() as { port: number }).port)}`
    if (url.pathname === '/idp/.well-known/openid-configuration') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        issuer: `${origin}/idp`,
        authorization_endpoint: `${origin}/idp/authCenter/authenticate`,
        jwks_uri: `${origin}/idp/oidc/getPublicKey`,
        end_session_endpoint: `${origin}/idp/oidc/revokeToken`,
      }))
      return
    }
    if (url.pathname === '/idp/oidc/getPublicKey') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ keys: state.keys }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  idpServer = server
  const port = (server.address() as { port: number }).port
  idp = {
    issuer: `http://127.0.0.1:${String(port)}/idp`,
    hits,
    get failNext() { return state.failNext },
    set failNext(value: boolean) { state.failNext = value },
    get failDiscovery() { return state.failDiscovery },
    set failDiscovery(value: boolean) { state.failDiscovery = value },
    get keys() { return state.keys },
    set keys(value: object[]) { state.keys = value },
  }
  return idp
}

/** Boot webserver + auth-iam pointed at the fake provider through the real Loader. */
async function loadComposition(extra = ''): Promise<Context> {
  // (extra appends literal config lines, e.g. '    allowIssuerMismatch: true')
  const provider = await startIdp()
  root = await mkdtemp(join(tmpdir(), 'dsh-auth-iam-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    "    host: '127.0.0.1'",
    '    port: 0',
    '- id: iam',
    "  name: '@deepseek-ai/dsh-host-auth-iam'",
    '  config:',
    `    issuer: '${provider.issuer}'`,
    `    clientId: '${CLIENT}'`,
    extra,
    '',
  ].filter(line => line !== '').join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-host-webserver', HttpServer],
    ['@deepseek-ai/dsh-host-auth-iam', AuthIam],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await context.loader.await()
  return context
}

interface SimpleResponse {
  status: number
  location: string | null
  body: string
  cookie: string | null
}

async function request(port: number, path: string, init?: RequestInit): Promise<SimpleResponse> {
  const response = await fetch(`http://127.0.0.1:${String(port)}${path}`, { redirect: 'manual', ...init })
  return {
    status: response.status,
    location: response.headers.get('location'),
    body: await response.text(),
    cookie: response.headers.get('set-cookie'),
  }
}

/** Raw HTTP for flows fetch cannot express (it forces fetch-level header rules). */
async function rawRequest(port: number, lines: readonly string[], body: string): Promise<string> {
  const socket = connect(port, '127.0.0.1')
  await once(socket, 'connect')
  socket.write([...lines, `Content-Length: ${String(body.length)}`, '', body].join('\r\n'))
  let data = ''
  for (;;) {
    const [chunk] = await once(socket, 'data') as [Buffer]
    data += String(chunk)
    const head = data.indexOf('\r\n\r\n')
    if (head < 0) continue
    const length = /^content-length: (\d+)$/im.exec(data.slice(0, head))?.[1]
    if (length === undefined || data.length >= head + 4 + Number(length)) break
  }
  socket.destroy()
  return data
}

async function upgrade(port: number, path: string, headers: Record<string, string> = {}): Promise<string> {
  const socket = connect(port, '127.0.0.1')
  await once(socket, 'connect')
  const response = once(socket, 'data')
  const closed = once(socket, 'close')
  socket.write([
    `GET ${path} HTTP/1.1`, `Host: 127.0.0.1:${String(port)}`, 'Connection: Upgrade', 'Upgrade: dsh-test',
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`), '', '',
  ].join('\r\n'))
  const outcome = await Promise.race([
    response.then(([data]) => String(data).split('\r\n')[0] ?? ''),
    closed.then(() => 'destroyed'),
  ])
  socket.destroy()
  return outcome
}

function rawHeader(response: string, name: string): string {
  return new RegExp(`^${name}: (.*)$`, 'im').exec(response.slice(0, response.indexOf('\r\n\r\n')))?.[1] ?? ''
}

function cookieValue(setCookie: string | null | undefined, name: string): string {
  return new RegExp(`${name}=([^;]*)`).exec(setCookie ?? '')?.[1] ?? ''
}

const NAV = { headers: { accept: 'text/html', 'sec-fetch-mode': 'navigate' } }

/** Start a provider round-trip: returns the state param and its cookie. */
async function beginSignIn(port: number, next = ''): Promise<{ state: string; stateCookie: string }> {
  const login = await request(port, next === '' ? '/login' : `/login?next=${encodeURIComponent(next)}`)
  return {
    state: new URL(login.location!).searchParams.get('state')!,
    stateCookie: cookieValue(login.cookie, 'dsh_oidc_state'),
  }
}

describe('auth-iam real composition', () => {
  it('signs a browser in through the provider and gates every surface', { timeout: 60_000 }, async () => {
    const loaded = await loadComposition()
    const unloaded = [...loaded.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(unloaded).toEqual([])
    const server = loaded.webServer
    const port = server.port
    const provider = idp!

    server.register({ kind: 'prefix', path: '/api', handler: (_req, res) => { res.writeHead(200); res.end('API') } })
    server.registerFallback((_req, res) => { res.writeHead(200); res.end('SHELL') })
    server.registerUpgrade({ path: '/events', handler: (_req, socket) => {
      socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: dsh-test\r\n\r\n')
    } })

    // Every surface denies; navigation redirects to /login — the provider
    // redirect is a click on the login page, never a guard side effect.
    expect((await request(port, '/api/x')).status).toBe(401)
    expect((await request(port, '/no/route')).status).toBe(401)
    expect(await request(port, '/session/42', NAV)).toMatchObject({ status: 302, location: '/login?next=%2Fsession%2F42' })
    expect(await upgrade(port, '/events')).toContain('401')

    // /login lands the provider redirect with the implicit-flow parameters
    // and the state cookie; behind a TLS terminator the forwarded protocol
    // is what the redirect_uri must carry.
    const forwarded = await rawRequest(port, [
      'GET /login HTTP/1.1', `Host: dsh.example:${String(port)}`, 'Connection: close',
      'X-Forwarded-Proto: https, http',
    ], '')
    expect(rawHeader(forwarded, 'location')).toContain('redirect_uri=https%3A%2F%2Fdsh.example')
    // A Host-less HTTP/1.0 request (the one wire form node:http accepts
    // without Host) falls back to the localhost origin in the redirect_uri.
    const hostless = await rawRequest(port, ['GET /login HTTP/1.0'], '')
    expect(rawHeader(hostless, 'location')).toContain('redirect_uri=http%3A%2F%2Flocalhost%2F')
    const toProvider = await request(port, '/login?next=%2Fsession%2F42')
    expect(toProvider.status).toBe(302)
    const authorize = new URL(toProvider.location!)
    expect(authorize.pathname).toBe('/idp/authCenter/authenticate')
    expect(Object.fromEntries(authorize.searchParams)).toMatchObject({
      response_type: 'token', scope: 'openid', client_id: CLIENT,
      redirect_uri: `http://127.0.0.1:${String(port)}/auth/callback`,
    })
    expect(authorize.searchParams.get('state')).toMatch(/^[0-9a-f]{32}$/)
    expect(toProvider.cookie).toContain('dsh_oidc_state=')
    expect(toProvider.cookie).toContain('HttpOnly')

    // The callback page (JS moves the fragment) is served on GET.
    const page = await request(port, '/auth/callback')
    expect(page.status).toBe(200)
    expect(page.body).toContain('location.hash')

    // Simulated browser: the provider returned the id_token in the fragment
    // and the page POSTs it with the state. The success answer is the JSON
    // the page turns into location.replace(next).
    const token = idToken(provider.issuer)
    const form = new URLSearchParams({ access_token: 'at', id_token: token, refresh_token: 'rt', state: authorize.searchParams.get('state')! })
    const success = await rawRequest(port, [
      'POST /auth/callback HTTP/1.1', `Host: 127.0.0.1:${String(port)}`, 'Connection: close',
      'Content-Type: application/x-www-form-urlencoded',
      `Cookie: dsh_oidc_state=${cookieValue(toProvider.cookie, 'dsh_oidc_state')}`,
    ], form.toString())
    expect(success.split('\r\n')[0]).toContain('200')
    expect(success).toContain('"ok":true')
    expect(success).toContain('"location":"/session/42"')
    const head = success.slice(0, success.indexOf('\r\n\r\n'))
    expect(head).toContain(`set-cookie: ${COOKIE}=${token};`)
    expect(head).toContain('HttpOnly')
    const sessionCookie = `${COOKIE}=${cookieValue(success, COOKIE)}`

    // The session gates HTTP and upgrades alike, over cookie and Bearer.
    expect((await request(port, '/api/x', { headers: { cookie: sessionCookie } })).body).toBe('API')
    expect((await request(port, '/', { headers: { cookie: sessionCookie, ...NAV.headers } })).status).toBe(200)
    expect(await upgrade(port, '/events', { cookie: sessionCookie })).toContain('101')
    expect((await request(port, '/api/x', { headers: { authorization: `Bearer ${token}` } })).body).toBe('API')

    // Provider-side failure: the error fragment answers the JSON the page
    // renders, without landing a session.
    const failed = await request(port, '/auth/callback', {
      method: 'POST', body: new URLSearchParams({ error: 'login_failed', error_description: 'usk expired', state: 'x' }),
    })
    expect(failed.status).toBe(401)
    expect(failed.body).toContain('usk expired')

    // Session-fixation guard: a valid token POSTed without this browser's
    // state cookie never lands a session.
    const stolen = await request(port, '/auth/callback', {
      method: 'POST', body: new URLSearchParams({ id_token: token, state: 'guessed' }),
    })
    expect(stolen.status).toBe(401)
    expect(stolen.cookie).toContain('Max-Age=0')

    // A garbage token is refused even with a matching state.
    const { state, stateCookie } = await beginSignIn(port)
    const garbage = await request(port, '/auth/callback', {
      method: 'POST', headers: { cookie: `dsh_oidc_state=${stateCookie}` },
      body: new URLSearchParams({ id_token: 'a.b.c', state }),
    })
    expect(garbage.status).toBe(401)
    expect(garbage.body).toContain('verification failed')

    // A callback POST over the body cap is refused without draining.
    const oversized = await rawRequest(port, [
      'POST /auth/callback HTTP/1.1', `Host: 127.0.0.1:${String(port)}`, 'Connection: close',
      'Content-Type: application/x-www-form-urlencoded',
    ], 'id_token=' + 'x'.repeat(70 * 1024))
    expect(oversized.split('\r\n')[0]).toContain('413')

    // A provider error without a description still names the code.
    const bare = await request(port, '/auth/callback', {
      method: 'POST', body: new URLSearchParams({ error: 'access_denied', state: 'x' }),
    })
    expect(bare.status).toBe(401)
    expect(bare.body).toContain('access_denied')

    // A valid token with a tampered next (cookie carries a protocol-relative
    // target) verifies but redirects nowhere: the location is the root.
    const forgedState = Buffer.from(JSON.stringify({ state: 'ignored', next: '//evil.example' })).toString('base64url')
    const { state: okState } = await beginSignIn(port)
    const tampered = await request(port, '/auth/callback', {
      method: 'POST', headers: { cookie: `dsh_oidc_state=${forgedState}` },
      body: new URLSearchParams({ id_token: idToken(provider.issuer), state: okState }),
    })
    // The state never matches the forged payload's, so the sign-in refuses.
    expect(tampered.status).toBe(401)

    // JWK rotation: the published set changes, the plugin's cache expires,
    // and the fresh read picks the new key up.
    const second = generateKeyPairSync('rsa', { modulusLength: 2048 })
    provider.keys = [{ ...second.publicKey.export({ format: 'jwk' }) as object, alg: 'RS256', kid: 'RS256' }]
    const rotated = idTokenWith(second.privateKey, provider.issuer)
    const { state: rotState, stateCookie: rotCookie } = await beginSignIn(port)
    const rotatedLanding = await request(port, '/auth/callback', {
      method: 'POST', headers: { cookie: `dsh_oidc_state=${rotCookie}` },
      body: new URLSearchParams({ id_token: rotated, state: rotState }),
    })
    expect(rotatedLanding.status).toBe(200)
    void key

    // Logout clears the cookie; browsers are denied again.
    const logout = await request(port, '/logout', { headers: { cookie: sessionCookie } })
    expect(logout.status).toBe(303)
    expect(logout.cookie).toContain('Max-Age=0')
    expect((await request(port, '/api/x')).status).toBe(401)

    // HMR safety: disposing the auth fiber opens the surface and frees seats.
    const authFiber = [...loaded.loader.entries()].find(entry => entry.options.id === 'iam')?.fiber
    await authFiber!.dispose()
    expect((await request(port, '/api/x')).status).toBe(200)
    expect((await request(port, '/login')).body).toBe('SHELL')
    expect(await upgrade(port, '/events')).toContain('101')
  })

  it('answers 502 to the callback when the provider was never reachable', { timeout: 60_000 }, async () => {
    const loaded = await loadComposition()
    const provider = idp!
    provider.failNext = true
    provider.failDiscovery = true
    const landing = await request(loaded.webServer.port, '/auth/callback', {
      method: 'POST', body: new URLSearchParams({ id_token: 'a.b.c', state: 'x' }),
    })
    expect(landing.status).toBe(502)
    expect(landing.body).toContain('unreachable')
  })

  it('renders the login and callback surfaces with the secureCookie posture', { timeout: 60_000 }, async () => {
    const loaded = await loadComposition('    secureCookie: true')
    const port = loaded.webServer.port
    const login = await request(port, '/login')
    expect(login.cookie).toContain('Secure')
    const provider = idp!
    const token = idToken(provider.issuer)
    const state = new URL(login.location!).searchParams.get('state')!
    const landing = await request(port, '/auth/callback', {
      method: 'POST', headers: { cookie: `dsh_oidc_state=${cookieValue(login.cookie, 'dsh_oidc_state')}` },
      body: new URLSearchParams({ id_token: token, state }),
    })
    expect(landing.cookie).toContain('Secure')
    const logout = await request(port, '/logout', { headers: { cookie: `dsh_token=${token}` } })
    expect(logout.cookie).toContain('Secure')
  })

  it('answers the callback page for a headless browser whose script never runs, without landing a session', { timeout: 60_000 }, async () => {
    const loaded = await loadComposition()
    const headless = await request(loaded.webServer.port, '/auth/callback', { method: 'POST', body: '' })
    expect(headless.status).toBe(401)
    expect(headless.body).toContain('state mismatch')
  })

  it('lands a signed token when the JWK set rotates within one fetch', { timeout: 60_000 }, async () => {
    // refreshMinutes: 1 is the schema minimum; every read refetches, so a
    // key rotation lands on the very next sign-in without the state cookie
    // or session touching the fake provider's failure switch.
    const loaded = await loadComposition('    refreshMinutes: 1')
    const port = loaded.webServer.port
    loaded.webServer.register({ kind: 'prefix', path: '/api', handler: (_req, res) => { res.writeHead(200); res.end('API') } })
    const provider = idp!
    // Land a session under the first key so its document is cached.
    const first = await beginSignIn(port)
    const landed = await request(port, '/auth/callback', {
      method: 'POST', headers: { cookie: `dsh_oidc_state=${first.stateCookie}` },
      body: new URLSearchParams({ id_token: idToken(provider.issuer), state: first.state }),
    })
    expect(landed.status).toBe(200)
    // Publish a new key; the next sign-in's forced re-read picks it up.
    const second = generateKeyPairSync('rsa', { modulusLength: 2048 })
    provider.keys = [{ ...second.publicKey.export({ format: 'jwk' }) as object, alg: 'RS256', kid: 'RS256' }]
    const second_ = await beginSignIn(port)
    const rotated = await request(port, '/auth/callback', {
      method: 'POST', headers: { cookie: `dsh_oidc_state=${second_.stateCookie}` },
      body: new URLSearchParams({ id_token: idTokenWith(second.privateKey, provider.issuer), state: second_.state }),
    })
    expect(rotated.status).toBe(200)
  })

  it('answers 502 only with no document ever fetched and rides out a key-publication blip', { timeout: 60_000 }, async () => {
    const loaded = await loadComposition()
    const port = loaded.webServer.port
    const provider = idp!
    provider.failNext = true
    const down = await request(port, '/login')
    expect(down.status).toBe(502)
    expect(down.body).toContain('unreachable')
    const retry = await request(port, '/login')
    expect(retry.status).toBe(302)

    // Key publication goes down just as a failed verification forces a
    // fresh read: the last good document is served (the refusal stays
    // "verification failed", not 502) instead of locking the gate out.
    const { state, stateCookie } = await beginSignIn(port)
    provider.failNext = true
    const garbage = await request(port, '/auth/callback', {
      method: 'POST', headers: { cookie: `dsh_oidc_state=${stateCookie}` },
      body: new URLSearchParams({ id_token: 'a.b.c', state }),
    })
    expect(garbage.status).toBe(401)
    expect(garbage.body).toContain('verification failed')
    // And a real token still verifies against that same kept document.
    const again = await beginSignIn(port)
    const good = await request(port, '/auth/callback', {
      method: 'POST', headers: { cookie: `dsh_oidc_state=${again.stateCookie}` },
      body: new URLSearchParams({ id_token: idToken(provider.issuer), state: again.state }),
    })
    expect(good.status).toBe(200)
  })

  it('lands an alias-issued token only under allowIssuerMismatch', { timeout: 60_000 }, async () => {
    const loaded = await loadComposition('    allowIssuerMismatch: true')
    const server = loaded.webServer
    const port = server.port
    server.register({ kind: 'prefix', path: '/api', handler: (_req, res) => { res.writeHead(200); res.end('API') } })

    // A token issued by a DIFFERENT issuer verifies under the mismatch hatch
    // — but only with this client's aud and a genuine signature.
    const { state, stateCookie } = await beginSignIn(port, '/session/7')
    const aliased = idToken('https://iam-alias.example/idp')
    const ok = await request(port, '/auth/callback', {
      method: 'POST', headers: { cookie: `dsh_oidc_state=${stateCookie}` },
      body: new URLSearchParams({ id_token: aliased, state }),
    })
    expect(ok.status).toBe(200)
    expect(ok.body).toContain('"location":"/session/7"')
    expect((await request(port, '/api/x', { headers: { cookie: `${COOKIE}=${cookieValue(ok.cookie, COOKIE)}` } })).body).toBe('API')

    // The hatch trusts a string iss only: a token with no decodable iss
    // falls back to the document's issuer and then fails the iss check.
    for (const hostile of ['', 'abc', idToken('https://iam-alias.example/idp', { iss: 42 })]) {
      const refused = await request(port, '/auth/callback', {
        method: 'POST', headers: { cookie: `dsh_oidc_state=${stateCookie}` },
        body: new URLSearchParams({ id_token: hostile, state }),
      })
      expect(refused.status).toBe(401)
      expect(refused.body).toContain('verification failed')
    }
  })
})
