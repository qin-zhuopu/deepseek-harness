/**
 * @deepseek-ai/dsh-host-auth-jwt — JWT bearer authentication for the Web
 * server (function plugin, config `{secret, ...}`, requires `webServer`): a
 * compact HS256 token is required for every named HTTP route, the fallback
 * (SPA dist) surface, and every WebSocket upgrade. The token travels as an
 * `Authorization: Bearer` header (non-browser clients) or the configured
 * auth cookie (browser: fetch, EventSource, and same-origin WebSocket all
 * carry it), so a guarded deployment works without any client code. The
 * cookie is issued by the built-in login page (a `GET/POST` pair this plugin
 * owns at `loginPath`/`logoutPath`): the guard redirects unauthenticated
 * browser navigation there, the form checks the password against `secret`,
 * signs `{sub, iat, exp}`, and sets the `HttpOnly` `SameSite=Lax` cookie.
 * Non-navigation requests get `401` with a `WWW-Authenticate: Bearer`
 * challenge. A deployment mounts nothing until it configures a secret: with
 * no row, or the row disabled, the server stays unauthenticated exactly as
 * before.
 * @module @deepseek-ai/dsh-host-auth-jwt
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { signToken, verifyToken, type JwtClaims } from './jwt.ts'

/** Stable Cordis plugin name. */
export const name = 'auth-jwt'

/** Service required before the guards can be registered. */
export const inject = ['webServer']

/** Plugin config: the shared secret and the login-surface knobs. */
export interface Config {
  /** HMAC-SHA256 secret; also the login password. Minimum 32 characters. */
  secret: string
  /** Cookie carrying the token for same-origin browser requests. Default: `dsh_token`. */
  cookie?: string
  /** Exact path of the built-in login page (GET form, POST credential). Default: `/login`. */
  loginPath?: string
  /** Exact path that clears the auth cookie. Default: `/logout`. */
  logoutPath?: string
  /** Token lifetime in seconds. Default: 86400 (24h). */
  lifetimeSeconds?: number
  /** Add `Secure` to the auth cookie; enable only behind TLS. Default: false. */
  secureCookie?: boolean
}

/** Fixed `WWW-Authenticate` realm for the Bearer challenge. */
const REALM = 'dsh'

/** Default cookie name, login/logout paths, and token lifetime (schema mirrors). */
const DEFAULT_COOKIE = 'dsh_token'
const DEFAULT_LOGIN_PATH = '/login'
const DEFAULT_LOGOUT_PATH = '/logout'
const DEFAULT_LIFETIME_SECONDS = 86400

export const Config: z<Config> = z.object({
  secret: z.string().min(32).required(),
  cookie: z.string().default(DEFAULT_COOKIE),
  loginPath: z.string().default(DEFAULT_LOGIN_PATH),
  logoutPath: z.string().default(DEFAULT_LOGOUT_PATH),
  lifetimeSeconds: z.natural().min(60).default(DEFAULT_LIFETIME_SECONDS),
  secureCookie: z.boolean().default(false),
})

const HTML_MIME = { 'content-type': 'text/html; charset=utf-8' } as const

/** Upper bound for a credential POST body; login payloads are tiny. */
const MAX_LOGIN_BODY_BYTES = 64 * 1024


function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of header?.split(';') ?? []) {
    const eq = part.indexOf('=')
    if (eq > 0) out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim()
  }
  return out
}

/**
 * Extract a presented token: `Authorization: Bearer <token>` wins over the
 * auth cookie (header is the explicit, cache-free channel; the cookie exists
 * for browser surfaces that cannot set headers).
 * @param req - the request being gated.
 * @param cookieName - configured cookie name.
 * @returns the compact JWT, or undefined when neither channel carries one.
 */
export function presentedToken(req: IncomingMessage, cookieName: string): string | undefined {
  const auth = req.headers.authorization
  if (typeof auth === 'string' && /^Bearer (.+)$/i.test(auth)) return auth.slice(7).trim() || undefined
  return parseCookies(req.headers.cookie)[cookieName] || undefined
}

/**
 * A root-relative in-app redirect target (`/`-prefixed, protocol- and
 * backslash-free), rejecting open-redirect payloads like `//host` or `/\host`.
 * @param value - the candidate `next` parameter, verbatim.
 * @returns the value when safe as a same-origin Location, else undefined.
 */
export function safeNext(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  return /^\/(?!\/)/.test(value) && !value.includes('\\') ? value : undefined
}

function requestUrl(req: IncomingMessage): URL {
  /* v8 ignore next -- node:http always sets url on server requests */
  return new URL(req.url ?? '/', 'http://dsh.internal')
}

function bearerChallenge(res: ServerResponse): void {
  res.writeHead(401, { 'www-authenticate': `Bearer realm="${REALM}"` })
  res.end('unauthorized')
}

function loginPageHtml(next: string | undefined, error: boolean): string {
  // `next` rides a hidden field, not the form action: the target survives
  // clients that do not run the page script.
  const nextField = next === undefined ? '' : `<input type="hidden" name="next" value="${escapeHtml(next)}">`
  return '<!doctype html><html><head><meta charset="utf-8"><title>dsh login</title></head>'
    + '<body style="font-family:sans-serif;display:grid;place-items:center;height:100vh;margin:0">'
    + '<form method="POST" style="display:grid;gap:8px;min-width:240px">'
    + '<h2 style="margin:0">DeepSeek Harness</h2>'
    + (error ? '<p style="color:#c00;margin:0">Wrong password.</p>' : '')
    + '<input type="password" name="password" placeholder="password" autocomplete="current-password" autofocus>'
    + nextField
    + '<button type="submit">Sign in</button>'
    + '</form>'
    + '</body></html>'
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function renderHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, HTML_MIME)
  res.end(html)
}

function setTokenCookie(res: ServerResponse, cookieName: string, token: string, maxAge: number, secure: boolean): void {
  res.setHeader('set-cookie', `${cookieName}=${token}; Path=/; Max-Age=${String(maxAge)}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`)
}

/**
 * A browser top-level navigation (vs an API/fetch call): `Sec-Fetch-Mode:
 * navigate`, or the legacy `Accept: text/html` + GET/HEAD reading. Only these
 * get the login redirect; everything else must see a machine-readable 401.
 * @param req - the request being gated.
 * @returns whether the request should see the login redirect over a 401.
 */
export function isNavigation(req: IncomingMessage): boolean {
  if (req.headers['sec-fetch-mode'] === 'navigate') return true
  const accept = req.headers.accept
  return typeof accept === 'string'
    && accept.includes('text/html')
    && (req.method === 'GET' || req.method === 'HEAD')
}

function credentialMatches(candidate: string, secret: string): boolean {
  const a = createHash('sha256').update(candidate).digest()
  const b = createHash('sha256').update(secret).digest()
  return timingSafeEqual(a, b)
}

async function readBody(req: IncomingMessage): Promise<string | undefined> {
  const chunks: Buffer[] = []
  let received = 0
  for await (const chunk of req) {
    received += (chunk as Buffer).byteLength
    // Oversized credential bodies are refused without draining or destroying
    // the socket: the 413 answer below closes the connection, so the unread
    // remainder is discarded on close instead of poisoning a kept-alive one.
    if (received > MAX_LOGIN_BODY_BYTES) return undefined
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function submittedPassword(contentType: string | undefined, body: string): string | undefined {
  if (contentType !== undefined && contentType.includes('application/json')) {
    try {
      const parsed: unknown = JSON.parse(body)
      if (typeof parsed === 'object' && parsed !== null && 'password' in parsed) {
        const value = parsed.password
        if (typeof value === 'string') return value
      }
    } catch {
      return undefined
    }
    return undefined
  }
  return new URLSearchParams(body).get('password') ?? undefined
}

/** Whether the login POST should be answered as JSON (fetch/API client) rather than a redirect. */
function wantsJson(req: IncomingMessage): boolean {
  const contentType = req.headers['content-type']
  if (typeof contentType === 'string' && contentType.includes('application/json')) return true
  return req.headers['sec-fetch-mode'] === 'cors' || req.headers['sec-fetch-mode'] === 'no-cors'
}

/**
 * Mount the auth guards and the login surface.
 * @param ctx - plugin context carrying the webServer service.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  // The Loader resolves schema defaults; hand-built test contexts may pass none.
  const secret = config.secret
  const lifetimeSeconds = config.lifetimeSeconds ?? DEFAULT_LIFETIME_SECONDS
  const secureCookie = config.secureCookie ?? false
  const cookieName = config.cookie ?? DEFAULT_COOKIE
  const loginPath = config.loginPath ?? DEFAULT_LOGIN_PATH
  const logoutPath = config.logoutPath ?? DEFAULT_LOGOUT_PATH
  const nowSeconds = (): number => Math.floor(Date.now() / 1000)
  const verify = (req: IncomingMessage): JwtClaims | undefined => {
    const token = presentedToken(req, cookieName)
    return token === undefined ? undefined : verifyToken(token, secret, nowSeconds())
  }
  const challenge = (req: IncomingMessage, res: ServerResponse): void => {
    const url = requestUrl(req)
    if (isNavigation(req)) {
      // Root paths carry only their query in `next`; the redirect back lands
      // at '/' either way, and the param stays empty instead of '%2F'.
      const next = `${url.pathname === '/' ? '' : url.pathname}${url.search}`
      res.writeHead(302, { location: `${loginPath}?next=${encodeURIComponent(next)}` })
      res.end()
      return
    }
    bearerChallenge(res)
  }

  // Guards first: registration order puts the verdict ahead of every route
  // (including this plugin's own login/logout pair, which the guard lets
  // through by path), so a disabled auth row is the only way to open the
  // surface and a disposed auth fiber closes it again.
  ctx.effect(() => ctx.webServer.registerGuard((req, res, surface) => {
    const pathname = requestUrl(req).pathname
    if (pathname === loginPath || pathname === logoutPath) return true
    if (verify(req) !== undefined) return true
    // The fallback surface carries the SPA shell and assets; a browser
    // navigation gets the login redirect, everything else the Bearer
    // challenge. API routes (surface 'route') never redirect: their callers
    // are fetch/WS clients that read the 401.
    if (surface === 'fallback') challenge(req, res)
    else bearerChallenge(res)
    return false
  }), 'auth-jwt: HTTP guard')

  ctx.effect(() => ctx.webServer.registerUpgradeGuard((req) => {
    if (verify(req) !== undefined) return true
    return { status: 401, headers: { 'www-authenticate': `Bearer realm="${REALM}"`, 'content-type': 'text/plain; charset=utf-8' } }
  }), 'auth-jwt: upgrade guard')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: loginPath,
    handler: async (req, res) => {
      const url = requestUrl(req)
      if (req.method === 'GET' || req.method === 'HEAD') {
        renderHtml(res, 200, loginPageHtml(safeNext(url.searchParams.get('next') ?? undefined), false))
        return
      }
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'GET, HEAD, POST' })
        res.end()
        return
      }
      const body = await readBody(req)
      if (body === undefined) {
        res.writeHead(413, { connection: 'close' })
        res.end()
        return
      }
      const params = new URLSearchParams(body)
      const next = safeNext(params.get('next') ?? url.searchParams.get('next') ?? undefined)
      const password = submittedPassword(req.headers['content-type'], body)
      if (password === undefined || !credentialMatches(password, secret)) {
        if (wantsJson(req)) {
          res.writeHead(401, { 'content-type': 'application/json' })
          res.end('{"error":"wrong password"}')
          return
        }
        renderHtml(res, 401, loginPageHtml(next, true))
        return
      }
      const token = signToken({ sub: 'dsh', iat: nowSeconds(), exp: nowSeconds() + lifetimeSeconds }, secret)
      setTokenCookie(res, cookieName, token, lifetimeSeconds, secureCookie)
      if (wantsJson(req)) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ token }))
        return
      }
      res.writeHead(303, { location: next ?? '/' })
      res.end()
    },
  }), 'auth-jwt: login route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: logoutPath,
    handler: (_req, res) => {
      setTokenCookie(res, cookieName, '', 0, secureCookie)
      res.writeHead(303, { location: '/' })
      res.end()
    },
  }), 'auth-jwt: logout route')
}
