/**
 * @deepseek-ai/dsh-host-auth-iam — enterprise OIDC gate for the Web server
 * (function plugin, config `{issuer, clientId, ...}`, requires `webServer`):
 * unauthenticated browser navigation signs in at the identity provider over
 * the OAuth2 implicit flow (`response_type=token&scope=openid`), receives the
 * provider-signed `id_token` in the redirect fragment, verifies it against
 * the provider's published JWKS (RS256/ES256; `iss`, `aud`, `exp` enforced),
 * and lands it in the session cookie the same way
 * [`dsh-host-auth-jwt`](../auth-jwt) does — so fetch, EventSource, and
 * same-origin WebSocket carry it without client changes. Every named route,
 * the fallback (SPA dist) surface, and every upgrade pass through the shared
 * auth-core guard. Scripted clients cannot sign in here (the identity lives
 * in a browser redirect);
 * [`dsh-host-auth-jwt`](../auth-jwt)'s HS256 login form is their gate.
 * @module @deepseek-ai/dsh-host-auth-iam
 */

import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import {
  DEFAULT_COOKIE,
  DEFAULT_LOGIN_PATH,
  DEFAULT_LOGOUT_PATH,
  decodeBase64UrlJson,
  escapeHtml,
  mountAuthSurface,
  presentedToken,
  readCookie,
  readCappedBody,
  renderHtml,
  requestUrl,
  safeNext,
  setSessionCookie,
} from '@deepseek-ai/dsh-host-auth-core'
import { createProviderSource, type ProviderDocument } from './discovery.ts'
import { verifyIdToken, type IdTokenClaims } from './id-token.ts'
import { loadTrustFile } from './trust.ts'

/** Stable Cordis plugin name. */
export const name = 'auth-iam'

/** Service required before the guards can be registered. */
export const inject = ['webServer']

/** Plugin config: the OIDC client, local surface, and verification knobs. */
export interface Config {
  /** Provider issuer URI; discovery and JWKS are read from it. */
  issuer: string
  /** OAuth2 client id issued to this deployment (e.g. `EnterpriseDingtalk`). */
  clientId: string
  /** Exact externally-visible callback path; must match the provider registration. Default: `/auth/callback`. */
  redirectPath?: string
  /** Cookie carrying the verified id_token for same-origin browser requests. Default: `dsh_token`. */
  cookie?: string
  /** Exact path that starts the provider redirect. Default: `/login`. */
  loginPath?: string
  /** Exact path that clears the session cookie. Default: `/logout`. */
  logoutPath?: string
  /** Add `Secure` to the session cookie; enable only behind TLS. Default: false. */
  secureCookie?: boolean
  /** Verify signature and `aud` only, skipping the `iss` equality check;
   * for deployments reached on a host alias of the provider URL. Default: false. */
  allowIssuerMismatch?: boolean
  /** Provider document / JWKS cache lifetime in minutes. Default: 60. */
  refreshMinutes?: number
  /** Timeout for one discovery or JWKS fetch in milliseconds. Default: 8000. */
  fetchTimeoutMs?: number
  /** Path to a JSON file with the provider's two published documents
   * (`{"discovery": …, "jwks": …}`) captured from a network that reaches the
   * IAM. Offline deployments answer login and verification from the file and
   * never fetch; loading refuses an unreadable, malformed, keyless file or a
   * file whose issuer disagrees with `issuer`. */
  trustFile?: string
}

/** Default callback path and provider-fetch knobs (schema mirrors). */
const DEFAULT_REDIRECT_PATH = '/auth/callback'
const DEFAULT_REFRESH_MINUTES = 60
const DEFAULT_FETCH_TIMEOUT_MS = 8000

/** State cookie: HttpOnly and host-scoped; it survives one provider round-trip (long enough for an SSO login with a phone scan). */
const STATE_COOKIE = 'dsh_oidc_state'
const STATE_TTL_SECONDS = 900

/** Login POST bodies are tiny key-value pairs; larger reads are refused. */
const MAX_BODY_BYTES = 64 * 1024

export const Config: z<Config> = z.object({
  issuer: z.string().pattern(/^https?:\/\/\S+$/).required(),
  clientId: z.string().min(1).required(),
  redirectPath: z.string().default(DEFAULT_REDIRECT_PATH),
  cookie: z.string().default(DEFAULT_COOKIE),
  loginPath: z.string().default(DEFAULT_LOGIN_PATH),
  logoutPath: z.string().default(DEFAULT_LOGOUT_PATH),
  secureCookie: z.boolean().default(false),
  allowIssuerMismatch: z.boolean().default(false),
  refreshMinutes: z.natural().min(1).default(DEFAULT_REFRESH_MINUTES),
  fetchTimeoutMs: z.natural().min(1000).default(DEFAULT_FETCH_TIMEOUT_MS),
  trustFile: z.string().default(''),
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stateCookieValue(state: string, next: string, secure: boolean): string {
  const payload = Buffer.from(JSON.stringify({ state, next })).toString('base64url')
  return `${STATE_COOKIE}=${payload}; Path=/; Max-Age=${String(STATE_TTL_SECONDS)}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`
}

/**
 * Match the state the callback presents against the one this browser was
 * sent. A cross-site POST cannot read the HttpOnly state cookie, so a missing
 * or foreign state is a session-fixation attempt and answers undefined.
 */
function readState(req: IncomingMessage, presented: string): string | undefined {
  const stored = readCookie(req, STATE_COOKIE)
  if (stored === undefined) return undefined
  const decoded = decodeBase64UrlJson(stored)
  if (isRecord(decoded) && typeof decoded.state === 'string' && decoded.state === presented && typeof decoded.next === 'string') {
    return safeNext(decoded.next) ?? ''
  }
  return undefined
}

function requestOrigin(req: IncomingMessage): string {
  const host = req.headers.host ?? 'localhost'
  // The leftmost forwarded protocol is the client-facing one.
  const [proto = 'http'] = String(req.headers['x-forwarded-proto'] ?? '').split(',')
  return `${proto.trim() === '' ? 'http' : proto}://${host}`
}

function page(res: ServerResponse, status: number, title: string, body: string): void {
  renderHtml(res, status, `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>`
    + '<meta name="robots" content="nostore">'
    + '</head><body style="font-family:sans-serif;display:grid;place-items:center;min-height:100vh;margin:0">'
    + `<div style="max-width:32rem;text-align:center">${body}</div></body></html>`)
}

function json(res: ServerResponse, status: number, payload: Record<string, unknown>): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(payload))
}

/**
 * Mount the OIDC gate: the shared guard surface plus the provider sign-in
 * round-trip (`/login` redirect, callback fragment exchange, `/logout`).
 * @param ctx - plugin context carrying the webServer service.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  // Cordis validates the row config against the schema before apply runs,
  // so defaults are resolved here; the fallbacks keep a direct apply call
  // (test fixtures, embedding) working off the same values the schema ships.
  const cookieName = config.cookie ?? DEFAULT_COOKIE
  const loginPath = config.loginPath ?? DEFAULT_LOGIN_PATH
  const logoutPath = config.logoutPath ?? DEFAULT_LOGOUT_PATH
  const redirectPath = config.redirectPath ?? DEFAULT_REDIRECT_PATH
  const secureCookie = config.secureCookie ?? false
  const allowIssuerMismatch = config.allowIssuerMismatch ?? false
  const refreshMinutes = config.refreshMinutes ?? DEFAULT_REFRESH_MINUTES
  const fetchTimeoutMs = config.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS
  const nowSeconds = (): number => Math.floor(Date.now() / 1000)

  // An offline deployment serves login and verification from the seeded file
  // and never fetches; a broken file refuses the gate at load.
  const staticDoc = config.trustFile === undefined || config.trustFile === ''
    ? undefined
    : loadTrustFile(config.trustFile, config.issuer)
  const provider = createProviderSource({ issuer: config.issuer, refreshMinutes, timeoutMs: fetchTimeoutMs }, globalThis.fetch)
  // The guard verdict must be synchronous: request-time verification runs
  // against the hot copy, and only the sign-in round-trip awaits a fetch.
  let document: ProviderDocument | undefined = staticDoc

  function verifyTokenPresented(req: IncomingMessage): IdTokenClaims | undefined {
    const token = presentedToken(req, cookieName)
    return token === undefined ? undefined : verifyToken(token)
  }

  function verifyToken(token: string): IdTokenClaims | undefined {
    // Uncached document (first fetch not yet completed): fail closed; login
    // and callback await the document before any verification runs.
    if (document === undefined) return undefined
    return verifyIdToken(token, document.keys, {
      // The issuer-mismatch hatch trusts the token's own iss (the signature
      // and aud checks still bind it to this client); the default requires
      // the discovery document's iss verbatim.
      issuer: allowIssuerMismatch ? claimIss(token) ?? document.issuer : document.issuer,
      audience: config.clientId,
    }, nowSeconds())
  }

  async function refreshDocument(): Promise<ProviderDocument | undefined> {
    if (staticDoc !== undefined) return staticDoc
    document = await provider.get() ?? document
    return document
  }

  async function forceRefresh(): Promise<void> {
    if (staticDoc !== undefined) return
    provider.invalidate()
    await refreshDocument()
  }

  mountAuthSurface(ctx, {
    cookieName,
    loginPath,
    logoutPath,
    secureCookie,
    exemptPaths: [redirectPath],
    verify: verifyTokenPresented,
  })

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: loginPath,
    handler: async (req, res) => {
      const current = await refreshDocument()
      if (current === undefined) {
        page(res, 502, 'dsh sign-in', '<h2 style="margin:0">Identity provider unreachable</h2>')
        return
      }
      const nextTarget = requestUrl(req).searchParams.get('next')
      const next = safeNext(nextTarget ?? undefined) ?? ''
      const state = randomBytes(16).toString('hex')
      res.setHeader('set-cookie', stateCookieValue(state, next, secureCookie))
      const target = new URL(current.authorizationEndpoint)
      target.searchParams.set('response_type', 'token')
      target.searchParams.set('scope', 'openid')
      target.searchParams.set('client_id', config.clientId)
      target.searchParams.set('redirect_uri', `${requestOrigin(req)}${redirectPath}`)
      target.searchParams.set('state', state)
      res.writeHead(302, { location: target.toString() })
      res.end()
    },
  }), 'auth-iam: login route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: redirectPath,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        // The IAM delivers tokens in the URL fragment, which never reaches
        // the server: this same-origin page moves the fragment into a POST.
        page(res, 200, 'dsh sign-in callback',
          '<h2 style="margin:0 0 .5rem">Signing you in…</h2><p style="margin:0">Completing sign-in.</p><script>'
          + '(function(){var f=new URLSearchParams(location.hash.slice(1)||location.search.slice(1));'
          + 'if(!f.get(\'id_token\')&&!f.get(\'error\'))f.set(\'error\',\'no tokens in redirect\');'
          + 'fetch(location.pathname,{method:\'POST\',body:f,credentials:\'same-origin\'})'
          + '.then(function(r){return r.json()}).then(function(d){'
          + 'if(d.ok)location.replace(d.location||\'/\');'
          + `else{document.body.innerHTML='<h2>Sign-in failed</h2><p>'+d.error.replace(/[<>&]/g,'')+'</p><p><a href="${escapeHtml(loginPath)}">Try again</a></p>'}`
          + '}).catch(function(){document.body.innerHTML=\'sign-in script failed\'})})();</script>')
        return
      }
      const body = await readCappedBody(req, MAX_BODY_BYTES)
      if (body === undefined) {
        res.writeHead(413, { connection: 'close' })
        res.end()
        return
      }
      const params = new URLSearchParams(body)
      res.setHeader('set-cookie', `${STATE_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secureCookie ? '; Secure' : ''}`)
      const error = params.get('error')
      const description = params.get('error_description')
      if (error !== null && error !== '') {
        json(res, 401, { ok: false, error: `Identity provider: ${description === null || description === '' ? error : description}` })
        return
      }
      const idToken = params.get('id_token') ?? ''
      const current = await refreshDocument()
      if (current === undefined) {
        json(res, 502, { ok: false, error: 'Identity provider unreachable' })
        return
      }
      // The state check precedes token handling: a cross-site POST cannot
      // carry the HttpOnly state this browser received, so a foreign or
      // absent state never lands a session.
      const presentedState = params.get('state')
      const next = readState(req, presentedState === null ? '' : presentedState)
      if (next === undefined) {
        json(res, 401, { ok: false, error: 'Sign-in state mismatch or expired; start again at the login page.' })
        return
      }
      // A failed verification may mean the JWK set rotated: force one fresh
      // read before rejecting the token outright.
      let claims = verifyToken(idToken)
      if (claims === undefined) {
        await forceRefresh()
        claims = verifyToken(idToken)
      }
      if (claims === undefined) {
        json(res, 401, { ok: false, error: 'Token verification failed (signature, audience, issuer, or expiry).' })
        return
      }
      const maxAge = Math.max(0, Math.floor(claims.exp) - nowSeconds())
      setSessionCookie(res, cookieName, idToken, maxAge, secureCookie)
      ctx.logger('auth-iam').info(`signed in ${claims.sub} via ${current.issuer}`)
      json(res, 200, { ok: true, location: next === '' ? '/' : next })
    },
  }), 'auth-iam: callback route')
}

/** Read (unverified) the `iss` claim for the issuer-mismatch escape hatch. */
function claimIss(token: string): string | undefined {
  const claims = decodeBase64UrlJson(token.split('.')[1] ?? '')
  return isRecord(claims) && typeof claims.iss === 'string' ? claims.iss : undefined
}
