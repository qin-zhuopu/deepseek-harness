/**
 * @deepseek-ai/dsh-host-auth-core — shared auth-surface mechanics for the
 * webserver guard plugins ([`dsh-host-auth-jwt`](../auth-jwt) and
 * [`dsh-host-auth-iam`](../auth-iam)). This package registers nothing itself;
 * it owns the request-facing vocabulary both plugins share: token
 * presentation (`Authorization: Bearer` over the auth cookie), cookie
 * issuance, safe `next` redirect targets, navigation detection, the Bearer
 * challenge, and the guard/upgrade-guard mount that gates every webserver
 * surface around a verification function. Keeping one implementation means
 * the two gate owners cannot drift on how a challenge, exemption, or cookie
 * behaves.
 * @module @deepseek-ai/dsh-host-auth-core
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'

/** Fixed `WWW-Authenticate` realm for the Bearer challenge. */
export const REALM = 'dsh'

/** Default cookie carrying the session token for same-origin browser requests. */
export const DEFAULT_COOKIE = 'dsh_token'

/** Default login surface path. */
export const DEFAULT_LOGIN_PATH = '/login'
/** Default logout surface path. */
export const DEFAULT_LOGOUT_PATH = '/logout'

/**
 * Resolve a server request URL against an internal origin; node:http always
 * sets `url` on server requests.
 * @param req - the request being gated.
 * @returns the parsed request URL.
 */
export function requestUrl(req: IncomingMessage): URL {
  /* v8 ignore next -- `?? '/'` arm: node:http always sets url on server
  requests; the field is only optional on the client-side IncomingMessage type */
  return new URL(req.url ?? '/', 'http://dsh.internal')
}

/**
 * Read one cookie's value from the request's Cookie header.
 * @param req - the request to inspect.
 * @param cookieName - cookie name to look up.
 * @returns the cookie value, or undefined when absent or empty.
 */
export function readCookie(req: IncomingMessage, cookieName: string): string | undefined {
  return parseCookies(req.headers.cookie)[cookieName] || undefined
}

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
  return readCookie(req, cookieName)
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

/**
 * The `next` target a request would return to after login: its pathname plus
 * query, with the root path collapsing to the empty string so the login URL
 * stays clean.
 * @param req - the request being gated.
 * @returns the verbatim next value (validated by {@link safeNext} at use).
 */
export function nextFromRequest(req: IncomingMessage): string {
  const url = requestUrl(req)
  return `${url.pathname === '/' ? '' : url.pathname}${url.search}`
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

/**
 * Answer a denied request with the `WWW-Authenticate: Bearer` challenge.
 * @param res - the response to finish.
 */
export function bearerChallenge(res: ServerResponse): void {
  res.writeHead(401, { 'www-authenticate': `Bearer realm="${REALM}"` })
  res.end('unauthorized')
}

/**
 * Send an unauthenticated browser navigation to the login surface with its
 * next target attached.
 * @param req - the request being gated.
 * @param res - the response to finish.
 * @param loginPath - configured login surface path.
 */
export function loginRedirect(req: IncomingMessage, res: ServerResponse, loginPath: string): void {
  res.writeHead(302, { location: `${loginPath}?next=${encodeURIComponent(nextFromRequest(req))}` })
  res.end()
}

/**
 * Set the session cookie for the token: root path, `HttpOnly`, `SameSite=Lax`
 * (top-level navigation from the identity provider must carry it back), and
 * `Secure` only when the deployment runs behind TLS.
 * @param res - the response carrying the cookie.
 * @param cookieName - configured cookie name.
 * @param token - token value; empty clears the cookie content.
 * @param maxAge - cookie Max-Age in seconds; 0 expires it.
 * @param secure - append the `Secure` attribute.
 */
export function setSessionCookie(res: ServerResponse, cookieName: string, token: string, maxAge: number, secure: boolean): void {
  res.setHeader('set-cookie', `${cookieName}=${token}; Path=/; Max-Age=${String(maxAge)}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`)
}

const HTML_MIME = { 'content-type': 'text/html; charset=utf-8' } as const

/**
 * Answer with an HTML body.
 * @param res - the response to finish.
 * @param status - HTTP status code.
 * @param html - complete document body.
 */
export function renderHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, HTML_MIME)
  res.end(html)
}

/**
 * Escape text for interpolation into double-quoted HTML attribute and text
 * contexts.
 * @param value - untrusted text.
 * @returns HTML-safe text.
 */
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/**
 * Read a request body under a byte cap.
 * @param req - the request to drain.
 * @param maxBytes - refusal threshold.
 * @returns the body text, or undefined when oversized (the caller answers the
 *   connection-closing error; the unread remainder dies with the socket).
 */
export async function readCappedBody(req: IncomingMessage, maxBytes: number): Promise<string | undefined> {
  const chunks: Buffer[] = []
  let received = 0
  for await (const chunk of req) {
    received += (chunk as Buffer).byteLength
    if (received > maxBytes) return undefined
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Strict base64url decode: Node's decoder is lenient (it ignores stray and
 * missing padding), so the re-encode must reproduce the segment exactly —
 * otherwise a mutated or re-padded segment would verify against the same
 * signature bytes.
 * @param segment - one compact-JWT segment.
 * @returns the decoded bytes, or undefined when the segment is not canonical base64url.
 */
export function decodeBase64Url(segment: string): Buffer | undefined {
  const bytes = Buffer.from(segment, 'base64url')
  return bytes.toString('base64url') === segment ? bytes : undefined
}

/**
 * Base64url-decode a compact-JWT segment and parse it as JSON.
 * @param segment - one compact-JWT segment.
 * @returns the parsed JSON value, or undefined for non-canonical or unparsable segments.
 */
export function decodeBase64UrlJson(segment: string): unknown {
  const bytes = decodeBase64Url(segment)
  if (bytes === undefined) return undefined
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown
  } catch {
    return undefined
  }
}

/** Shared configuration of the guarded surface both auth plugins mount. */
export interface AuthSurfaceOptions {
  /** Cookie cleared by the logout surface. */
  cookieName: string
  /** Login surface path, exempt from the guard. */
  loginPath: string
  /** Logout surface path, exempt from the guard. */
  logoutPath: string
  /** Add `Secure` to the session cookie writes. */
  secureCookie: boolean
  /** Additional exempt paths (the IAM sign-in callback). */
  exemptPaths?: readonly string[]
  /** Validate the token a request presents; any claim record means admitted. */
  verify: (req: IncomingMessage) => object | undefined
}

/**
 * Mount the guard pair over the whole webserver surface: a `WebGuard` admits
 * exempt paths and verified requests, sends fallback-surface navigations to
 * the login path, challenges everything else with Bearer 401; an
 * `UpgradeGuard` rejects unverified upgrades with a Bearer 401 verdict ahead
 * of the upgrade route table. Registrations are effects, so disposing the
 * caller's fiber reopens the surface.
 * @param ctx - plugin context carrying the webServer service.
 * @param options - cookie name, exempt paths, and verification function.
 */
export function mountAuthSurface(ctx: Context, options: AuthSurfaceOptions): void {
  const { cookieName, loginPath, logoutPath, secureCookie, verify } = options
  const exempt = new Set([loginPath, logoutPath, ...options.exemptPaths ?? []])
  ctx.effect(() => ctx.webServer.registerGuard((req, res, surface) => {
    if (exempt.has(requestUrl(req).pathname)) return true
    if (verify(req) !== undefined) return true
    // The fallback surface carries the SPA shell and assets: a browser
    // navigation gets the login redirect, everything else the Bearer
    // challenge. API routes (surface 'route') never redirect: their callers
    // are fetch/WS clients that read the 401.
    if (surface === 'fallback' && isNavigation(req)) loginRedirect(req, res, loginPath)
    else bearerChallenge(res)
    return false
  }), 'auth-surface: HTTP guard')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: logoutPath,
    handler: (_req, res) => {
      setSessionCookie(res, cookieName, '', 0, secureCookie)
      res.writeHead(303, { location: '/' })
      res.end()
    },
  }), 'auth-surface: logout route')

  ctx.effect(() => ctx.webServer.registerUpgradeGuard((req) => {
    if (verify(req) !== undefined) return true
    return {
      status: 401,
      headers: { 'www-authenticate': `Bearer realm="${REALM}"`, 'content-type': 'text/plain; charset=utf-8' },
    }
  }), 'auth-surface: upgrade guard')
}
