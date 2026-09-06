/**
 * The portal HTTP surface (0008 Portal): the entry redirect, the IAM
 * fragment-relay callback, the JSON API, and the SSE live stream — all behind
 * the session guard. The static SPA (the start page) is served from
 * `web/dist`; the backend holds no page logic (front/back split).
 * @module
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PortalConfig } from './config.ts'
import { beginLogin, completeLogin, relayPage, sessionFromRequest, SESSION_COOKIE, type IamClient, type VerifiedSession } from './auth.ts'
import { resolveUid, type Orchestrator } from './orchestrator.ts'
import type { LiveEvent } from './events.ts'

/** Content types for the handful of static assets the start page ships. */
const ASSETS: Record<string, [contentType: string, file: string]> = {
  '/': ['text/html; charset=utf-8', 'index.html'],
  '/app.js': ['text/javascript; charset=utf-8', 'app.js'],
  '/app.css': ['text/css; charset=utf-8', 'app.css'],
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) })
  res.end(body)
}

/** Read a request body with a hard cap (form POSTs are tiny). */
async function readBody(req: IncomingMessage, max = 4096): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > max) return ''
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** The assembled portal server. */
export interface PortalServer {
  server: Server
  /** Start listening; resolves with the bound port. */
  listen(): Promise<number>
  /** Close listening sockets. */
  close(): Promise<void>
}

/** Wire the routes over an orchestrator + IAM client. */
export function createPortalServer(
  config: PortalConfig,
  orchestrator: Orchestrator,
  iam: IamClient,
  webRoot: string,
): PortalServer {
  async function sessionOf(req: IncomingMessage): Promise<VerifiedSession | undefined> {
    return await sessionFromRequest(iam, req)
  }

  /** The authenticated uid for a request, or undefined (guard denial). */
  async function guard(req: IncomingMessage): Promise<string | undefined> {
    const session = await sessionOf(req)
    if (session === undefined) return undefined
    return resolveUid(config, session.claims)
  }

  function serveStatic(path: string, res: ServerResponse): void {
    const asset = ASSETS[path]
    if (asset === undefined) {
      json(res, 404, { error: 'not found' })
      return
    }
    const [contentType, file] = asset
    const abs = join(webRoot, file)
    if (!existsSync(abs)) {
      json(res, 500, { error: `web asset missing: ${file}` })
      return
    }
    const body = readFileSync(abs)
    res.writeHead(200, { 'content-type': contentType, 'content-length': String(body.length) })
    res.end(body)
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://portal.invalid')
    const path = url.pathname

    if (path === config.iam.redirectPath) {
      if (req.method === 'POST') {
        const result = await completeLogin(iam, req, res)
        if (result.ok) {
          const uid = resolveUid(config, result.session.claims)
          if (uid === undefined) {
            json(res, 403, { ok: false, error: 'verified identity has no usable uid claim (SR1)' })
            return
          }
          json(res, 200, { ok: true, location: result.next })
          return
        }
        json(res, result.status, { ok: false, error: result.error })
        return
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(relayPage())
      return
    }

    if (path === '/login' && req.method === 'GET') {
      const next = url.searchParams.get('next') ?? '/'
      await beginLogin(config.iam, iam, req, res, next)
      return
    }

    if (path === '/logout') {
      res.setHeader('set-cookie', `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`)
      res.writeHead(302, { location: '/' })
      res.end()
      return
    }

    const uid = await guard(req)
    if (uid === undefined) {
      // Browser navigations get the login redirect (the round-trip is silent behind the IAM usk
      // session); API calls get a 401 they can act on.
      const acceptsHtml = (req.headers.accept ?? '').includes('text/html')
      if (acceptsHtml) {
        res.writeHead(302, { location: `/login?next=${encodeURIComponent(path)}` })
        res.end()
      } else {
        json(res, 401, { error: 'sign-in required' })
      }
      return
    }

    if (path === '/' && req.method === 'GET') {
      // Fast open (requester, 2026-09-06): the HTML answers immediately and
      // the arrival check runs behind the request — its chain streams to the
      // page over /api/events while the user already sees it. The reconcile
      // probe is read-only; provisioning stays behind the check button.
      void orchestrator.arrive(uid)
      serveStatic('/', res)
      return
    }

    if (path in ASSETS && req.method === 'GET') {
      serveStatic(path, res)
      return
    }

    if (path === '/api/state' && req.method === 'GET') {
      const run = orchestrator.run(uid)
      json(res, 200, { state: orchestrator.stateEvent(uid), steps: run.steps })
      return
    }

    if (path === '/api/events' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      const send = (event: LiveEvent): void => {
        res.write(`data: ${JSON.stringify(event)}\n\n`)
      }
      const unsubscribe = orchestrator.subscribe((eventUid, event) => {
        if (eventUid === uid) send(event)
      })
      send(orchestrator.stateEvent(uid))
      for (const step of orchestrator.run(uid).steps) send(step)
      const keepAlive = setInterval(() => { res.write(': ping\n\n') }, 15_000)
      req.on('close', () => {
        clearInterval(keepAlive)
        unsubscribe()
      })
      return
    }

    if (path === '/api/check' && req.method === 'POST') {
      await readBody(req)
      // The explicit re-check is the same read-only arrival probe; its chain
      // streams over /api/events.
      void orchestrator.arrive(uid)
      json(res, 202, orchestrator.stateEvent(uid))
      return
    }

    if (path === '/api/provision' && req.method === 'POST') {
      await readBody(req)
      // 开通 is idempotent (requester, 2026-09-06): a healthy service
      // short-circuits, an in-flight run is joined, and only absent/stopped
      // containers trigger create/start.
      void orchestrator.enter(uid)
      json(res, 202, orchestrator.stateEvent(uid))
      return
    }

    json(res, 404, { error: 'not found' })
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (!res.headersSent) json(res, 500, { error: error instanceof Error ? error.message : String(error) })
      else res.end()
    })
  })

  return {
    server,
    listen: () => new Promise<number>((resolve, reject) => {
      server.once('error', reject)
      server.listen(config.port, config.bindHost, () => {
        resolve((server.address() as { port: number }).port)
      })
    }),
    close: () => new Promise<void>((resolve) => { server.close(() => { resolve() }) }),
  }
}
