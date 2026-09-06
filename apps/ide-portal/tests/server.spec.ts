/**
 * The full portal over real sockets: unauthenticated refusals and navigation
 * redirects, the static SPA, the replaying SSE stream, and the entry's
 * warm-path redirect — with the IAM and Jenkins stood in, the orchestrator
 * real.
 */

import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateKeyPairSync, createSign } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { parsePortalConfig } from '../src/config.ts'
import { createIamClient } from '../src/auth.ts'
import { Orchestrator, type Clock } from '../src/orchestrator.ts'
import { createPortalServer, type PortalServer } from '../src/server.ts'
import { FakeJenkins } from './fake-jenkins.ts'

const key = generateKeyPairSync('rsa', { modulusLength: 2048 })
const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')

function idToken(issuer: string, sub = '14409'): string {
  const exp = Math.floor(Date.now() / 1000) + 3600
  const payload = { sub, userId: sub, aud: 'EnterpriseDingtalk', iss: issuer, iat: exp - 60, exp }
  const input = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(payload)}`
  const signer = createSign('sha256')
  signer.update(input)
  return `${input}.${signer.sign(key.privateKey).toString('base64url')}`
}

const instantClock: Clock = { sleep: async () => {}, now: () => Date.now() }

interface Harness {
  base: string
  token: string
  server: PortalServer
  jenkins: FakeJenkins
  close(): Promise<void>
}

let open: Harness | undefined

afterEach(async () => {
  if (open !== undefined) { await open.close(); open = undefined }
})

async function start(): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'ide-portal-srv-'))

  const idp = createServer((req, res) => {
    const origin = `http://127.0.0.1:${String((idp.address() as { port: number }).port)}`
    const url = new URL(req.url ?? '/', origin)
    if (url.pathname === '/idp/.well-known/openid-configuration') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ issuer: `${origin}/idp`, authorization_endpoint: `${origin}/idp/authCenter/authenticate`, jwks_uri: `${origin}/idp/oidc/jwks` }))
      return
    }
    if (url.pathname === '/idp/oidc/jwks') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ keys: [key.publicKey.export({ format: 'jwk' })] }))
      return
    }
    res.writeHead(404); res.end()
  })
  idp.listen(0, '127.0.0.1')
  await once(idp, 'listening')
  const issuer = `http://127.0.0.1:${String((idp.address() as { port: number }).port)}/idp`

  const config = parsePortalConfig(`
domainSuffix: jereh-pe.cn
entryHost: ide.jereh-pe.cn
uid: {claim: sub, crossCheckClaim: userId, pattern: "^[0-9]{1,8}$"}
imageTag: dev-amd64-abc1234
jenkins: {url: http://jenkins.invalid, job: ide-provision, user: portal, tokenEnv: IDE_JENKINS_TOKEN}
iam: {issuer: ${issuer}, clientId: EnterpriseDingtalk, redirectPath: /auth/callback}
health: {intervalSec: 30, timeoutSec: 600, pollMs: 1}
port: 0
`)
  const jenkins = new FakeJenkins()
  const orchestrator = new Orchestrator(config, jenkins, join(dir, 'state'), instantClock)
  const server = createPortalServer(config, orchestrator, createIamClient(config.iam), new URL('../web', import.meta.url).pathname)
  const port = await server.listen()
  const harness: Harness = {
    base: `http://127.0.0.1:${String(port)}`,
    token: idToken(issuer),
    server,
    jenkins,
    close: async () => { await server.close(); idp.close(); await once(idp, 'close'); await rm(dir, { recursive: true, force: true }) },
  }
  open = harness
  return harness
}

async function get(h: Harness, path: string, cookie?: string, accept = '*/*'): Promise<Response> {
  const headers: Record<string, string> = { accept }
  if (cookie !== undefined) headers.cookie = cookie
  return await fetch(`${h.base}${path}`, { headers, redirect: 'manual' })
}

describe('guard', () => {
  it('answers 401 to unauthenticated API calls and 302 to HTML navigations', async () => {
    const h = await start()
    const api = await get(h, '/api/state')
    expect(api.status).toBe(401)
    const nav = await get(h, '/', undefined, 'text/html')
    expect(nav.status).toBe(302)
    expect(nav.headers.get('location')).toBe('/login?next=%2F')
  })

  it('serves the static shell only with a valid bearer session', async () => {
    const h = await start()
    h.jenkins.script('probe', { console: '[DSH_STEP] 1 reconcile info absent\n', result: 'SUCCESS' })
    const page = await fetch(`${h.base}/app.js`, { headers: { authorization: `Bearer ${h.token}` } })
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('EventSource')
  })

  it('refuses a forged bearer', async () => {
    const h = await start()
    const response = await fetch(`${h.base}/api/state`, { headers: { authorization: 'Bearer not.a.jwt' } })
    expect(response.status).toBe(401)
  })
})

describe('entry auto-checks on arrival (read-only, fast open)', () => {
  it('GET / with a healthy service renders the page immediately; the probe lands HEALTHY behind the request', async () => {
    const h = await start()
    h.jenkins.script('probe', { console: '[DSH_STEP] 1 reconcile info healthy\n', result: 'SUCCESS' })
    const direct = await fetch(`${h.base}/`, { headers: { authorization: `Bearer ${h.token}`, accept: 'text/html' }, redirect: 'manual' })
    expect(direct.status).toBe(200)
    expect(await direct.text()).toContain('开通')
    const snapshot = await pollChecked(h)
    expect(h.jenkins.triggered.map(t => t.action)).toEqual(['probe'])
    expect(snapshot.state.state).toBe('HEALTHY')
    expect(snapshot.state.ideUrl).toBe('http://ide-14409.jereh-pe.cn/')
  })

  it('GET / on an absent container renders the start page and stays NO_SERVICE until the button', async () => {
    const h = await start()
    h.jenkins.script('probe', { console: '[DSH_STEP] 1 reconcile info absent\n', result: 'SUCCESS' })
    const page = await fetch(`${h.base}/`, { headers: { authorization: `Bearer ${h.token}`, accept: 'text/html' } })
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('开通')
    const snapshot = await pollChecked(h)
    expect(h.jenkins.triggered.map(t => t.action)).toEqual(['probe'])
    expect(snapshot.state.state).toBe('NO_SERVICE')
  })

  it('GET / answers before the probe finishes — the check streams over SSE, never blocking the HTML', async () => {
    const h = await start()
    h.jenkins.script('probe', { console: '[DSH_STEP] 1 reconcile info healthy\n', result: 'SUCCESS' })
    // Hold the trigger until the page has provably answered without it.
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const unheld = h.jenkins.trigger.bind(h.jenkins)
    h.jenkins.trigger = async (params) => { await held; return await unheld(params) }
    const page = await fetch(`${h.base}/`, { headers: { authorization: `Bearer ${h.token}`, accept: 'text/html' } })
    expect(page.status).toBe(200)
    expect(h.jenkins.triggered).toHaveLength(0)
    expect(await page.text()).toContain('IDE 门户')
    release()
    const snapshot = await pollChecked(h)
    expect(snapshot.state.state).toBe('HEALTHY')
    expect(h.jenkins.triggered.map(t => t.action)).toEqual(['probe'])
  })
})

describe('warm path (FR3)', () => {
  it('the check action on a healthy container yields READY-able state without provisioning', async () => {
    const h = await start()
    h.jenkins.script('probe', { console: '[DSH_STEP] 1 reconcile info healthy\n', result: 'SUCCESS' })
    const started = await fetch(`${h.base}/api/provision`, { method: 'POST', headers: { authorization: `Bearer ${h.token}` } })
    expect(started.status).toBe(202)
    const state = await pollState(h)
    expect(state.state.state).toBe('HEALTHY')
    expect(state.state.ideUrl).toBe('http://ide-14409.jereh-pe.cn/')
    expect(h.jenkins.triggered.map(t => t.action)).toEqual(['probe'])
  })

  it('POST /api/check re-runs the read-only probe and renders the chain (检查 button)', async () => {
    const h = await start()
    h.jenkins.script('probe', { console: '[DSH_STEP] 1 reconcile info absent\n', result: 'SUCCESS' })
    const check = await fetch(`${h.base}/api/check`, { method: 'POST', headers: { authorization: `Bearer ${h.token}` } })
    expect(check.status).toBe(202)
    const snapshot = await pollChecked(h)
    expect(h.jenkins.triggered.map(t => t.action)).toEqual(['probe'])
    expect(snapshot.state.state).toBe('NO_SERVICE')
    expect(snapshot.steps.map(s => s.step)).toEqual(['工号', '域名', '结论'])
  })
})

describe('cold path page (FR4, FR5)', () => {
  it('GET / renders the start page, /api/provision drives the run, /api/state carries the steps', async () => {
    const h = await start()
    h.jenkins.script('probe', { console: '[DSH_STEP] 1 reconcile info absent\n', result: 'SUCCESS' })
    h.jenkins.script('create', { console: '[DSH_STEP] 2 docker-run ok created\n[DSH_STEP] 3 ready ok done\n', result: 'SUCCESS' })
    const page = await fetch(`${h.base}/`, { headers: { authorization: `Bearer ${h.token}`, accept: 'text/html' } })
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('IDE 门户')
    const started = await fetch(`${h.base}/api/provision`, { method: 'POST', headers: { authorization: `Bearer ${h.token}` } })
    expect(started.status).toBe(202)
    // Provisioning runs detached; poll the authoritative snapshot until it settles.
    const state = await pollState(h)
    expect(state.state.state).toBe('READY')
    expect(state.steps.map(s => s.step)).toContain('docker-run')
  })
})

/** The /api/state snapshot as the page consumes it. */
interface StateSnapshot {
  state: { state: string; checking: boolean; ideUrl: string | undefined }
  steps: { step: string }[]
}

/** Poll /api/state until the arrival check settles (checking=false with a rendered chain). */
async function pollChecked(h: Harness, tries = 200): Promise<StateSnapshot> {
  for (let attempt = 0; attempt < tries; attempt++) {
    const response = await fetch(`${h.base}/api/state`, { headers: { authorization: `Bearer ${h.token}` } })
    const snapshot = await response.json() as StateSnapshot
    if (!snapshot.state.checking && snapshot.steps.length > 0) return snapshot
    await new Promise<void>((resolve) => { setTimeout(resolve, 5) })
  }
  throw new Error('arrival check did not settle')
}

/** Poll /api/state until the run reaches a terminal state (the detached POST drives it). */
async function pollState(h: Harness, tries = 200): Promise<StateSnapshot> {
  for (let attempt = 0; attempt < tries; attempt++) {
    const response = await fetch(`${h.base}/api/state`, { headers: { authorization: `Bearer ${h.token}` } })
    const snapshot = await response.json() as StateSnapshot
    if (snapshot.state.state !== 'NO_SERVICE' && snapshot.state.state !== 'PROVISIONING' && snapshot.state.state !== 'STARTING') return snapshot
    await new Promise<void>((resolve) => { setTimeout(resolve, 5) })
  }
  throw new Error('run did not settle')
}

describe('SSE stream (FR5)', () => {
  it('/api/events replays the current state and steps, then live events until aborted', async () => {
    const h = await start()
    h.jenkins.script('probe', { console: '[DSH_STEP] 1 reconcile info absent\n', result: 'SUCCESS' })
    h.jenkins.script('create', { console: '[DSH_STEP] 2 docker-run ok created\n[DSH_STEP] 3 ready ok done\n', result: 'SUCCESS' })
    await fetch(`${h.base}/api/provision`, { method: 'POST', headers: { authorization: `Bearer ${h.token}` } })
    // The stream stays open (keep-alive); collect replayed frames until READY lands, then abort.
    const controller = new AbortController()
    const response = await fetch(`${h.base}/api/events`, { headers: { authorization: `Bearer ${h.token}` }, signal: controller.signal })
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const reader = response.body?.getReader()
    if (reader === undefined) throw new Error('no stream body')
    const decoder = new TextDecoder()
    let buffer = ''
    const events: { type: string; step?: string; state?: string }[] = []
    for (let guard = 0; guard < 50 && !events.some(e => e.type === 'state' && e.state === 'READY'); guard++) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const blocks = buffer.split('\n\n')
      buffer = blocks.pop() ?? ''
      for (const block of blocks) {
        if (block.startsWith('data: ')) events.push(JSON.parse(block.slice(6)) as { type: string })
      }
    }
    controller.abort()
    expect(events[0]?.type).toBe('state')
    expect(events.some(e => e.type === 'step' && e.step === 'docker-run')).toBe(true)
    expect(events.some(e => e.type === 'state' && e.state === 'READY')).toBe(true)
  })
})
