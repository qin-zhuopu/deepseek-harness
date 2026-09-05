/**
 * Guard-surface coverage that bypasses the Loader: a hand-built context
 * applies the plugin with a partial config (the schema defaults do not run
 * here, so the direct-call fallbacks and their values are pinned), and the
 * request-time arms no composed-provider test reaches are driven directly —
 * verification before any document was fetched, and the empty state cookie.
 */

import { describe, expect, it } from 'vitest'
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import InvariantService from '@deepseek-ai/dsh-invariants'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import * as AuthIam from '../src/index.ts'
import * as AuthIamInvariant from '../src/invariant.ts'

const CLIENT = 'EnterpriseDingtalk'
const key = generateKeyPairSync('rsa', { modulusLength: 2048 })
const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')

/** A token this test's private key signs. */
function sign(claims: Record<string, unknown>): string {
  const exp = Math.floor(Date.now() / 1000) + 3600
  const input = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ aud: CLIENT, exp, ...claims })}`
  return `${input}.${cryptoSign('sha256', Buffer.from(input), key.privateKey).toString('base64url')}`
}

describe('apply with a partial config', () => {
  it('mounts the default surface and fails closed before any document', async () => {
    const ctx = new Context()
    await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    // No reachable provider: issuer points at a closed port.
    AuthIam.apply(ctx, { issuer: 'http://127.0.0.1:1/idp', clientId: CLIENT })
    const port = ctx.webServer.port
    ctx.webServer.register({ kind: 'exact', path: '/p', handler: (_req, res) => { res.writeHead(200); res.end('P') } })

    // Default paths: /login answers the unreachable page (502), /logout
    // clears the default cookie name, and the guard redirects a navigation.
    const login = await fetch(`http://127.0.0.1:${String(port)}/login`)
    expect(login.status).toBe(502)
    expect(await login.text()).toContain('unreachable')
    // An unclaimed fallback with no registered shell stays a bare 404: the
    // guard never claims pages nobody owns.
    const nav = await fetch(`http://127.0.0.1:${String(port)}/anything`, {
      headers: { accept: 'text/html' }, redirect: 'manual',
    })
    expect(nav.status).toBe(404)
    const logout = await fetch(`http://127.0.0.1:${String(port)}/logout`, { redirect: 'manual' })
    expect(logout.headers.getSetCookie().join()).toContain('dsh_token=;')

    // A Bearer token cannot pass while the verifier holds no document:
    // fail-closed, not unauthenticated-open.
    const gated = await fetch(`http://127.0.0.1:${String(port)}/p`, { headers: { authorization: `Bearer ${sign({ iss: 'http://127.0.0.1:1/idp' })}` } })
    expect(gated.status).toBe(401)

    // The provider error precedes the document fetch, so it is answerable
    // even with no provider ever reached.
    expect((await fetch(`http://127.0.0.1:${String(port)}/auth/callback`, { method: 'POST', body: 'error=x' })).status).toBe(401)
    await ctx.fiber.dispose()
  })
})

describe('invariant companion', () => {
  it('registers the explained empty installer under its package name', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantService, { enabled: true })
    await expect(ctx.plugin(AuthIamInvariant).await()).resolves.toBeDefined()
  })
})
