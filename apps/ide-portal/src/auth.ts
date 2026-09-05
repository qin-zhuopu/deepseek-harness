/**
 * Sign-in against the Jereh IAM (C10), reusing the shipped gate's verification
 * and request primitives: `verifyIdToken` (JWKS signature + `iss`/`aud`/`exp`)
 * from dsh-host-auth-iam and the cookie/redirect helpers from
 * dsh-host-auth-core. The gate itself is a webserver-plugin fiber, so the
 * portal composes the same parts into its own routes rather than mounting it.
 *
 * IAM specifics this module hardcodes because the portal targets this one
 * provider (0007 C10): the implicit authorization URL is `GET
 * <issuer>/authCenter/authenticate?response_type=token&scope=openid&client_id=
 * <clientId>&redirect_uri=<origin><redirectPath>&state=<nonce>` — the
 * `redirect_uri` is composed from the deployment's own origin and the IAM
 * does not validate it against a registration; tokens arrive in the URL
 * fragment, so a same-origin relay page POSTs them to `redirectPath`.
 * @module
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { createProviderSource, type ProviderDocument } from '@deepseek-ai/dsh-host-auth-iam/src/discovery.ts'
import { verifyIdToken } from '@deepseek-ai/dsh-host-auth-iam/src/id-token.ts'
import {
  DEFAULT_COOKIE,
  decodeBase64UrlJson,
  readCookie,
  readCappedBody,
  safeNext,
  setSessionCookie,
} from '@deepseek-ai/dsh-host-auth-core'
import type { IamConfig } from './config.ts'

/** Session cookie carrying the verified id_token (same posture as the shipped gate). */
export const SESSION_COOKIE = DEFAULT_COOKIE

/** Anti-fixation state cookie, single round-trip lifetime (the shipped gate's 15-minute window). */
const STATE_COOKIE = 'ide_oidc_state'
const STATE_TTL_SECONDS = 900
const MAX_BODY_BYTES = 64 * 1024

/** Claims the portal acts on after verification. */
export interface VerifiedSession {
  /** The verified `sub`: the employee number. */
  sub: string
  /** Full verified payload (signature-bound), for the `userId` cross-check. */
  claims: Record<string, unknown>
  /** The compact token itself, for the session cookie. */
  token: string
  /** Expiry in epoch seconds. */
  exp: number
}

/** The IAM-facing half: provider document, verification, and the two login routes' logic. */
export interface IamClient {
  /** Verify a compact id_token against the live JWKS; undefined on any failure. */
  verify(token: string): Promise<VerifiedSession | undefined>
  /** The discovery document (authorization endpoint, JWKS), refreshed per cache window. */
  document(): Promise<ProviderDocument | undefined>
}

/** Build the IAM client over the configured issuer. */
export function createIamClient(config: IamConfig, fetchImpl: typeof globalThis.fetch = globalThis.fetch): IamClient {
  const provider = createProviderSource({ issuer: config.issuer, refreshMinutes: 60, timeoutMs: 8000 }, fetchImpl)
  async function document(): Promise<ProviderDocument | undefined> {
    return await provider.get()
  }
  async function verify(token: string): Promise<VerifiedSession | undefined> {
    let doc = await document()
    if (doc === undefined) return undefined
    let claims = verifyIdToken(token, doc.keys, { issuer: doc.issuer, audience: config.clientId }, Math.floor(Date.now() / 1000))
    if (claims === undefined) {
      // A failure may mean the JWK set rotated: one fresh read before rejecting (the shipped gate's rule).
      provider.invalidate()
      doc = await document()
      if (doc === undefined) return undefined
      claims = verifyIdToken(token, doc.keys, { issuer: doc.issuer, audience: config.clientId }, Math.floor(Date.now() / 1000))
    }
    if (claims === undefined) return undefined
    const payload = decodeBase64UrlJson(token.split('.')[1] ?? '')
    const record = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {}
    return { sub: claims.sub, claims: record, token, exp: claims.exp }
  }
  return { verify, document }
}

/** The implicit-flow authorize URL for this deployment; `redirect_uri` composes from the request origin (C10). */
export function authorizeUrl(config: IamConfig, origin: string, state: string, doc: ProviderDocument): string {
  const target = new URL(doc.authorizationEndpoint)
  target.searchParams.set('response_type', 'token')
  target.searchParams.set('scope', 'openid')
  target.searchParams.set('client_id', config.clientId)
  target.searchParams.set('redirect_uri', `${origin}${config.redirectPath}`)
  target.searchParams.set('state', state)
  return target.toString()
}

/** The origin the browser used (forwarded proto first; the proxy terminates nothing today but the front-proxy may). */
export function requestOrigin(req: IncomingMessage): string {
  const proto = req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'
  const host = req.headers.host ?? 'localhost'
  return `${proto}://${host}`
}

/** Seed the state cookie and send the browser to the IAM authorize endpoint. */
export async function beginLogin(
  config: IamConfig,
  iam: IamClient,
  req: IncomingMessage,
  res: ServerResponse,
  next: string,
): Promise<void> {
  const doc = await iam.document()
  if (doc === undefined) {
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('identity provider unreachable')
    return
  }
  const state = randomBytes(16).toString('hex')
  const payload = Buffer.from(JSON.stringify({ state, next })).toString('base64url')
  res.setHeader('set-cookie', `${STATE_COOKIE}=${payload}; Path=/; Max-Age=${String(STATE_TTL_SECONDS)}; HttpOnly; SameSite=Lax`)
  res.writeHead(302, { location: authorizeUrl(config, requestOrigin(req), state, doc) })
  res.end()
}

/** The fragment-relay page: the IAM delivers the token in the URL fragment, which never reaches the server. */
export function relayPage(): string {
  return '<!doctype html><meta charset="utf-8"><title>signing in</title><body>Signing you in…<script>'
    + '(function(){var f=new URLSearchParams(location.hash.slice(1)||location.search.slice(1));'
    + "if(!f.get('id_token')&&!f.get('error'))f.set('error','no tokens in redirect');"
    + "fetch(location.pathname,{method:'POST',body:f,credentials:'same-origin'})"
    + '.then(function(r){return r.json()}).then(function(d){'
    + "if(d.ok)location.replace(d.location||'/');"
    + "else{document.body.innerHTML='<h2>Sign-in failed</h2><p>'+String(d.error).replace(/[<>&]/g,'')+'</p><p><a href=\"/\">Try again</a></p>'}"
    + '})})()</script>'
}

/** Outcome of the callback POST: a landed session, or the error to surface. */
export type CallbackResult = { ok: true; session: VerifiedSession; next: string } | { ok: false; status: number; error: string }

/**
 * Handle the relayed callback: state first (a cross-site POST cannot carry the
 * HttpOnly state cookie), then verification, then the session cookie.
 */
export async function completeLogin(
  iam: IamClient,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<CallbackResult> {
  const body = await readCappedBody(req, MAX_BODY_BYTES)
  if (body === undefined) return { ok: false, status: 413, error: 'body too large' }
  res.setHeader('set-cookie', `${STATE_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`)
  const params = new URLSearchParams(body)
  const error = params.get('error')
  if (error !== null && error !== '') return { ok: false, status: 401, error: `identity provider: ${params.get('error_description') ?? error}` }
  const presented = params.get('state') ?? ''
  const stored = readCookie(req, STATE_COOKIE)
  const decoded = stored === undefined ? undefined : decodeBase64UrlJson(stored)
  if (typeof decoded !== 'object' || decoded === null || (decoded as Record<string, unknown>)['state'] !== presented || presented === '') {
    return { ok: false, status: 401, error: 'sign-in state mismatch or expired; start again' }
  }
  const nextRaw = (decoded as Record<string, unknown>)['next']
  const next = typeof nextRaw === 'string' ? safeNext(nextRaw) ?? '/' : '/'
  const idToken = params.get('id_token') ?? ''
  if (idToken === '') return { ok: false, status: 401, error: 'missing id_token' }
  const session = await iam.verify(idToken)
  if (session === undefined) return { ok: false, status: 401, error: 'token verification failed (signature, audience, issuer, or expiry)' }
  setSessionCookie(res, SESSION_COOKIE, idToken, Math.max(0, session.exp - Math.floor(Date.now() / 1000)), false)
  return { ok: true, session, next }
}

/** Read the session from a request: cookie first, then an Authorization bearer (scripted clients). */
export async function sessionFromRequest(iam: IamClient, req: IncomingMessage): Promise<VerifiedSession | undefined> {
  const token = presentedTokenOf(req)
  if (token === undefined) return undefined
  return await iam.verify(token)
}

/** The presented token: bearer header wins over the session cookie (auth-core's order). */
function presentedTokenOf(req: IncomingMessage): string | undefined {
  const auth = req.headers.authorization
  if (auth !== undefined && auth.startsWith('Bearer ')) return auth.slice(7).trim()
  return readCookie(req, SESSION_COOKIE)
}
