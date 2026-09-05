/**
 * Guard-surface coverage that bypasses the Loader: a hand-built context
 * applies the plugin with an unresolved partial config (the schema defaults
 * do not run here), and the exported request-parsing helpers are driven
 * through their malformed-input arms — cookie/Header fragments, unsafe
 * redirect targets, navigation detection, and the login page's HTML escaping.
 */

import { describe, expect, it } from 'vitest'
import type { IncomingMessage } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import * as AuthJwt from '../src/index.ts'

const SECRET = 'defaults-secret-0000000000000000000000000000'

function fakeRequest(headers: Record<string, string>): IncomingMessage {
  return { headers } as unknown as IncomingMessage
}

describe('apply with unresolved config', () => {
  it('falls back to the schema defaults for every optional field', async () => {
    const ctx = new Context()
    await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    AuthJwt.apply(ctx, { secret: SECRET })
    const port = ctx.webServer.port
    ctx.webServer.register({ kind: 'exact', path: '/p', handler: (_req, res) => { res.writeHead(200); res.end('P') } })

    // Defaults: /login renders, the default cookie name authenticates.
    const page = await fetch(`http://127.0.0.1:${String(port)}/login`)
    expect(page.status).toBe(200)
    const wrongMethod = await fetch(`http://127.0.0.1:${String(port)}/login`, { method: 'PUT', body: 'x' })
    expect(wrongMethod.status).toBe(405)

    // The GET form carries a root-relative `next` into a hidden field,
    // HTML-escaped.
    const withNext = await (await fetch(`http://127.0.0.1:${String(port)}/login?next=%2Fa%22b%3Cc`)).text()
    expect(withNext).toContain('<input type="hidden" name="next" value="/a&quot;b&lt;c">')

    // An oversized credential body is refused without draining the stream.
    const oversized = await fetch(`http://127.0.0.1:${String(port)}/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'x'.repeat(100_000) }),
    })
    expect(oversized.status).toBe(413)
    await oversized.body?.cancel()

    // JSON bodies at the wire boundary: invalid JSON, non-object JSON, and a
    // non-string password field are all wrong-credential answers, not 500s.
    for (const body of ['{bad json', '[1,2]', '{"password":123}', '{}']) {
      const wrong = await fetch(`http://127.0.0.1:${String(port)}/login`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body,
      })
      expect(wrong.status).toBe(401)
      await wrong.body?.cancel()
    }
    // A form body without a password field is the same wrong-credential answer.
    const noField = await fetch(`http://127.0.0.1:${String(port)}/login`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'novalue=1',
    })
    expect(noField.status).toBe(401)
    await noField.body?.cancel()

    // The default cookie name carries a valid token; an empty Bearer does not.
    const login = await fetch(`http://127.0.0.1:${String(port)}/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: SECRET }),
    })
    expect(login.headers.get('location')).toBeNull()
    const { token } = await login.json() as { token: string }
    const gated = await fetch(`http://127.0.0.1:${String(port)}/p`, { headers: { cookie: `dsh_token=${token}` } })
    expect(gated.status).toBe(200)
    expect((await fetch(`http://127.0.0.1:${String(port)}/p`, { headers: { authorization: 'Bearer ' } })).status).toBe(401)

    await ctx.fiber.dispose()
  })

  it('flags the cookie Secure under secureCookie', async () => {
    const ctx = new Context()
    await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    AuthJwt.apply(ctx, { secret: SECRET, secureCookie: true })
    const port = ctx.webServer.port
    const login = await fetch(`http://127.0.0.1:${String(port)}/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: SECRET }),
    })
    expect(login.headers.get('set-cookie') ?? '').toContain('Secure')
    await ctx.fiber.dispose()
  })
})

describe('presentedToken', () => {
  it('prefers the Bearer header and skips malformed cookie fragments', () => {
    expect(AuthJwt.presentedToken(fakeRequest({ authorization: 'Bearer hdr' }), 'c')).toBe('hdr')
    expect(AuthJwt.presentedToken(fakeRequest({ authorization: 'Basic x' }), 'c')).toBeUndefined()
    expect(AuthJwt.presentedToken(fakeRequest({ authorization: 'Bearer    ' }), 'c')).toBeUndefined()
    expect(AuthJwt.presentedToken(fakeRequest({ cookie: '=leading; bare; c=tok' }), 'c')).toBe('tok')
    expect(AuthJwt.presentedToken(fakeRequest({ cookie: 'c=' }), 'c')).toBeUndefined()
    expect(AuthJwt.presentedToken(fakeRequest({}), 'c')).toBeUndefined()
  })
})

describe('safeNext', () => {
  it('accepts root-relative paths and refuses protocol-relative and backslash forms', () => {
    expect(AuthJwt.safeNext('/session/42')).toBe('/session/42')
    expect(AuthJwt.safeNext('/x?a=1&b=2')).toBe('/x?a=1&b=2')
    expect(AuthJwt.safeNext('//evil.example')).toBeUndefined()
    expect(AuthJwt.safeNext('/\\evil.example')).toBeUndefined()
    expect(AuthJwt.safeNext('http://evil.example')).toBeUndefined()
    expect(AuthJwt.safeNext(undefined)).toBeUndefined()
  })
})

describe('isNavigation', () => {
  it('recognizes browser navigations and rejects API reads', () => {
    expect(AuthJwt.isNavigation(fakeRequest({ 'sec-fetch-mode': 'navigate', method: '' }))).toBe(true)
    expect(AuthJwt.isNavigation({ method: 'GET', headers: { accept: 'text/html,application/xhtml+xml' } } as unknown as IncomingMessage)).toBe(true)
    expect(AuthJwt.isNavigation({ method: 'POST', headers: { accept: 'text/html' } } as unknown as IncomingMessage)).toBe(false)
    expect(AuthJwt.isNavigation({ method: 'GET', headers: { accept: 'application/json' } } as unknown as IncomingMessage)).toBe(false)
  })
})
