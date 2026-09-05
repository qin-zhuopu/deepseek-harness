/**
 * REAL-composition coverage: a test-only cordis.yml booted through the
 * vendored Loader mounts webserver + auth-jwt + a /api probe route + an
 * upgrade route + a fallback-owner row, and every assertion observes the
 * served HTTP surface — unauthenticated denials per surface, the login
 * round trip over cookie and Bearer, WebSocket upgrade gating, token
 * expiry, and guard/route release on fiber disposal (HMR safety).
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import HttpServer from '@deepseek-ai/dsh-host-webserver'
import * as AuthJwt from '../src/index.ts'
import { signToken } from '../src/jwt.ts'

const SECRET = 'integration-secret-000000000000000000000000'
const COOKIE = 'dsh_token'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Write a cordis.yml mounting webserver + auth-jwt, then boot it through the real Loader. */
async function loadComposition(authConfig = `    secret: '${SECRET}'`): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-auth-jwt-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    "    host: '127.0.0.1'",
    '    port: 0',
    '- id: auth',
    "  name: '@deepseek-ai/dsh-host-auth-jwt'",
    '  config:',
    authConfig,
    '',
  ].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-host-webserver', HttpServer],
    ['@deepseek-ai/dsh-host-auth-jwt', AuthJwt],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  return context
}

/** GET (by default) one path; redirects are NOT followed, Location is captured. */
async function request(port: number, path: string, init?: RequestInit): Promise<{ status: number; location: string | null; body: string }> {
  const response = await fetch(`http://127.0.0.1:${String(port)}${path}`, { redirect: 'manual', ...init })
  return {
    status: response.status,
    location: response.headers.get('location'),
    body: (await response.text()).slice(0, 200),
  }
}

/** Read one complete raw HTTP/1.1 response (status line, headers, full body). */
async function readRaw(socket: ReturnType<typeof connect>): Promise<string> {
  let data = ''
  for (;;) {
    const [chunk] = await once(socket, 'data') as [Buffer]
    data += String(chunk)
    const head = data.indexOf('\r\n\r\n')
    if (head < 0) continue
    const length = /^content-length: (\d+)$/im.exec(data.slice(0, head))?.[1]
    if (length === undefined) return data
    if (data.length >= head + 4 + Number(length)) return data
  }
}

/** Raw socket request: fetch cannot set the forbidden Sec-Fetch-* headers a browser form navigation carries. */
async function rawRequest(port: number, request: string): Promise<string> {
  const socket = connect(port, '127.0.0.1')
  await once(socket, 'connect')
  socket.write(request)
  const response = await readRaw(socket)
  socket.destroy()
  return response
}

/** Raw upgrade attempt: resolves with the status line the server wrote (or 'destroyed'). */
async function upgrade(port: number, path: string, headers: Record<string, string> = {}): Promise<string> {
  const socket = connect(port, '127.0.0.1')
  await once(socket, 'connect')
  const response = once(socket, 'data')
  const closed = once(socket, 'close')
  socket.write([
    `GET ${path} HTTP/1.1`,
    `Host: 127.0.0.1:${String(port)}`,
    'Connection: Upgrade',
    'Upgrade: dsh-test',
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
    '',
    '',
  ].join('\r\n'))
  const outcome = await Promise.race([
    response.then(([data]) => String(data).split('\r\n')[0] ?? ''),
    closed.then(() => 'destroyed'),
  ])
  socket.destroy()
  return outcome
}

const NAV = { headers: { accept: 'text/html', 'sec-fetch-mode': 'navigate' } }
const API = { headers: { accept: 'application/json' } }

describe('real Loader composition', () => {
  it('gates every surface until the token lands, over both channels and upgrades', { timeout: 60_000 }, async () => {
    const loaded = await loadComposition()
    const unloaded = [...loaded.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(unloaded).toEqual([])
    const server = loaded.webServer
    expect(server).toBeInstanceOf(HttpServer)
    const port = server.port

    // Named routes behind the guard: a /api-style probe is unreachable with
    // no credential and reachable with a signed Bearer token.
    server.register({ kind: 'prefix', path: '/api', handler: (_req, res) => { res.writeHead(200); res.end('API') } })
    server.registerFallback((_req, res) => { res.writeHead(200); res.end('SHELL') })
    server.registerUpgrade({ path: '/events', handler: (_req, socket) => {
      socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: dsh-test\r\n\r\n')
    } })

    expect((await request(port, '/api/anything')).status).toBe(401)
    expect((await request(port, '/', API)).status).toBe(401)
    expect((await request(port, '/no/such/route', API)).status).toBe(401)
    // A navigation gets the login redirect instead of a bare 401.
    expect(await request(port, '/', NAV)).toMatchObject({ status: 302, location: '/login?next=' })
    expect(await request(port, '/session/42?tab=log', NAV)).toMatchObject({ status: 302, location: '/login?next=%2Fsession%2F42%3Ftab%3Dlog' })
    // Upgrades never reach the protocol owner without a token.
    expect(await upgrade(port, '/events')).toContain('401')
    // The Bearer challenge names the scheme.
    const challenge = await fetch(`http://127.0.0.1:${String(port)}/api/x`, API)
    expect(challenge.headers.get('www-authenticate')).toContain('Bearer')
    await challenge.body?.cancel()

    // The login page is reachable through the guard (path exemption).
    const page = await request(port, '/login')
    expect(page.status).toBe(200)
    expect(page.body).toContain('<form method="POST"')

    // Wrong password: a browser form POST (Sec-Fetch-Mode: navigate — a
    // forbidden header fetch cannot set) gets the form again with 401; a
    // scripted client gets JSON.
    const wrongForm = await rawRequest(port, [
      'POST /login HTTP/1.1', `Host: 127.0.0.1:${String(port)}`, 'Connection: close',
      'Content-Type: application/x-www-form-urlencoded', 'Sec-Fetch-Mode: navigate',
      `Content-Length: ${String('password=nope'.length)}`, '', 'password=nope',
    ].join('\r\n'))
    expect(wrongForm.split('\r\n')[0]).toContain('401')
    expect(wrongForm).toContain('Wrong password.')
    const wrongJson = await fetch(`http://127.0.0.1:${String(port)}/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"password":"nope"}' })
    expect(wrongJson.status).toBe(401)
    expect(await wrongJson.json()).toEqual({ error: 'wrong password' })

    // Correct password: the browser form flow lands a cookie that gates HTTP
    // and upgrades alike; the hidden next field survives POSTs without scripts.
    const loginRaw = await rawRequest(port, [
      'POST /login?next=%2Fsession%2F42 HTTP/1.1', `Host: 127.0.0.1:${String(port)}`, 'Connection: close',
      'Content-Type: application/x-www-form-urlencoded', 'Sec-Fetch-Mode: navigate',
      `Content-Length: ${String(`password=${SECRET}&next=%2Fsession%2F42`.length)}`, '',
      `password=${SECRET}&next=%2Fsession%2F42`,
    ].join('\r\n'))
    expect(loginRaw.split('\r\n')[0]).toContain('303')
    const loginHeaders = loginRaw.slice(0, loginRaw.indexOf('\r\n\r\n'))
    expect(loginHeaders).toContain('location: /session/42')
    const setCookie = /^set-cookie: (.*)$/im.exec(loginHeaders)?.[1] ?? ''
    expect(setCookie).toContain(`${COOKIE}=`)
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('SameSite=Lax')
    const cookie = setCookie.split(';')[0] ?? ''
    expect((await request(port, '/api/anything', { headers: { cookie } })).body).toBe('API')
    expect((await request(port, '/', { headers: { cookie, ...NAV.headers } })).status).toBe(200)
    expect(await upgrade(port, '/events', { cookie })).toContain('101')

    // JSON login returns the token for scripted clients and Bearer gates with it.
    const jsonLogin = await fetch(`http://127.0.0.1:${String(port)}/login`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-mode': 'cors' }, body: JSON.stringify({ password: SECRET }),
    })
    expect(jsonLogin.status).toBe(200)
    const { token } = await jsonLogin.json() as { token: string }
    expect((await request(port, '/api/anything', { headers: { authorization: `Bearer ${token}` } })).body).toBe('API')
    expect(await upgrade(port, '/events', { authorization: `Bearer ${token}` })).toContain('101')

    // Garbage and wrong-secret tokens stay denied; open-redirect next is dropped.
    expect((await request(port, '/api/x', { headers: { authorization: 'Bearer garbage' } })).status).toBe(401)
    const foreign = signToken({ sub: 'x' }, 'other-secret-00000000000000000000000000000')
    expect((await request(port, '/api/x', { headers: { authorization: `Bearer ${foreign}` } })).status).toBe(401)
    const evil = await request(port, '/login?next=%2F%2Fevil.example%2Fx')
    expect(evil.body).not.toContain('evil.example')
    const evilPost = await rawRequest(port, [
      'POST /login?next=%2F%2Fevil.example%2Fx HTTP/1.1', `Host: 127.0.0.1:${String(port)}`, 'Connection: close',
      'Content-Type: application/x-www-form-urlencoded', 'Sec-Fetch-Mode: navigate',
      `Content-Length: ${String(`password=${SECRET}`.length)}`, '', `password=${SECRET}`,
    ].join('\r\n'))
    expect(evilPost.slice(0, evilPost.indexOf('\r\n\r\n'))).toContain('location: /')

    // Logout clears the cookie for the browser, but tokens are stateless:
    // the same value replayed by header authenticates until exp (documented
    // limitation), while a credential-less client stays locked out.
    const logout = await fetch(`http://127.0.0.1:${String(port)}/logout`, { redirect: 'manual', headers: { cookie } })
    expect(logout.status).toBe(303)
    expect(logout.headers.get('set-cookie') ?? '').toContain('Max-Age=0')
    await logout.body?.cancel()
    const replay = cookie.split('=')[1] ?? ''
    expect((await request(port, '/api/anything', { headers: { authorization: `Bearer ${replay}` } })).body).toBe('API')
    expect((await request(port, '/api/anything')).status).toBe(401)

    // HMR safety: disposing the auth fiber disposes its guards and its
    // login/logout routes; the surface opens and re-registers.
    const authFiber = [...loaded.loader.entries()].find(entry => entry.options.id === 'auth')?.fiber
    expect(authFiber).toBeDefined()
    await authFiber!.dispose()
    expect((await request(port, '/api/anything')).status).toBe(200)
    // The login/logout routes are gone with the fiber: /login now falls to
    // the fallback seat instead of rendering the form.
    const after = await request(port, '/login')
    expect(after.status).toBe(200)
    expect(after.body).toBe('SHELL')
    expect(await upgrade(port, '/events')).toContain('101')
    // A second row mounts after the first released its route seats.
    const remount = context!.plugin(AuthJwt, { secret: SECRET })
    await remount.await()
    expect((await request(port, '/api/anything')).status).toBe(401)
    expect((await request(port, '/login')).body).toContain('<form method="POST"')
    await remount.dispose()
    expect((await request(port, '/api/anything')).status).toBe(200)
  })

  it('rejects expired tokens and refuses a secret below the minimum', { timeout: 60_000 }, async () => {
    const loaded = await loadComposition()
    const port = loaded.webServer.port
    loaded.webServer.register({ kind: 'prefix', path: '/api', handler: (_req, res) => { res.writeHead(200); res.end('API') } })
    const expired = signToken({ sub: 'dsh', exp: Math.floor(Date.now() / 1000) - 1 }, SECRET)
    expect((await request(port, '/api/x', { headers: { authorization: `Bearer ${expired}` } })).status).toBe(401)

    // Config boundary: a 31-character secret fails the row's load, loudly.
    await loaded.fiber.dispose()
    context = undefined
    await expect(loadComposition("    secret: '00000000000000000000000000000'")).rejects.toThrow()
  })
})
