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
 * before. The guard surface, cookie, and challenge mechanics are shared with
 * [`dsh-host-auth-iam`](../auth-iam) through
 * [`dsh-host-auth-core`](../auth-core).
 * @module @deepseek-ai/dsh-host-auth-jwt
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import {
  DEFAULT_COOKIE,
  DEFAULT_LOGIN_PATH,
  DEFAULT_LOGOUT_PATH,
  escapeHtml,
  mountAuthSurface,
  presentedToken,
  readCappedBody,
  renderHtml,
  requestUrl,
  safeNext,
  setSessionCookie,
} from '@deepseek-ai/dsh-host-auth-core'
import { signToken, verifyToken } from './jwt.ts'

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

/** Default token lifetime (schema mirror). */
const DEFAULT_LIFETIME_SECONDS = 86400

export const Config: z<Config> = z.object({
  secret: z.string().min(32).required(),
  cookie: z.string().default(DEFAULT_COOKIE),
  loginPath: z.string().default(DEFAULT_LOGIN_PATH),
  logoutPath: z.string().default(DEFAULT_LOGOUT_PATH),
  lifetimeSeconds: z.natural().min(60).default(DEFAULT_LIFETIME_SECONDS),
  secureCookie: z.boolean().default(false),
})

/** Login POST bodies are tiny key-value payloads; larger reads are refused. */
const MAX_LOGIN_BODY_BYTES = 64 * 1024

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

/**
 * Compare the submitted password with the secret without leaking its length
 * or content through timing or the comparison branch: both sides are hashed
 * first so `timingSafeEqual` gets equal-length digests for wrong-length input.
 */
function credentialMatches(candidate: string, secret: string): boolean {
  return timingSafeEqual(createHash('sha256').update(candidate).digest(), createHash('sha256').update(secret).digest())
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

/** Scripted clients (JSON content-type or CORS reads) get JSON answers. */
function wantsJson(req: IncomingMessage): boolean {
  const contentType = req.headers['content-type']
  if (typeof contentType === 'string' && contentType.includes('application/json')) return true
  return req.headers['sec-fetch-mode'] === 'cors' || req.headers['sec-fetch-mode'] === 'no-cors'
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

/**
 * Mount the HS256 gate: the shared guard surface plus the built-in login and
 * logout routes.
 * @param ctx - plugin context carrying the webServer service.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  // The Loader resolves schema defaults; hand-built test contexts may pass none.
  const secret = config.secret
  const cookieName = config.cookie ?? DEFAULT_COOKIE
  const loginPath = config.loginPath ?? DEFAULT_LOGIN_PATH
  const logoutPath = config.logoutPath ?? DEFAULT_LOGOUT_PATH
  const lifetimeSeconds = config.lifetimeSeconds ?? DEFAULT_LIFETIME_SECONDS
  const secureCookie = config.secureCookie ?? false

  mountAuthSurface(ctx, {
    cookieName,
    loginPath,
    logoutPath,
    secureCookie,
    verify: (req) => {
      const token = presentedToken(req, cookieName)
      return token === undefined ? undefined : verifyToken(token, secret, nowSeconds())
    },
  })

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
      const body = await readCappedBody(req, MAX_LOGIN_BODY_BYTES)
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
      setSessionCookie(res, cookieName, token, lifetimeSeconds, secureCookie)
      if (wantsJson(req)) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ token }))
        return
      }
      res.writeHead(303, { location: next ?? '/' })
      res.end()
    },
  }), 'auth-jwt: login route')

}
