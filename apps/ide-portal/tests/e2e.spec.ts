/**
 * End-to-end against a real portal process: the CLI starts under
 * `node --experimental-strip-types` with a temp config, a fake IAM publishing
 * discovery and JWKS over real sockets (an RSA keypair the suite owns), and a
 * fake Jenkins answering the same REST routes the live client calls. The suite
 * drives the implicit sign-in round-trip, the check-button flow (probe →
 * create/start → READY) with its marker steps and SSE stream, the healthy
 * short-circuit, the always-on read-only entry check, and the offline trust file boot — over
 * loopback HTTP, with no test seams inside the portal and no user credential
 * anywhere.
 */

import { createServer } from 'node:http'
import { once } from 'node:events'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSign, generateKeyPairSync } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))
const cliPath = join(repoRoot, 'apps/ide-portal/src/cli.ts')
const webRoot = join(repoRoot, 'apps/ide-portal/web')
const key = generateKeyPairSync('rsa', { modulusLength: 2048 })
const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')

/** Mint one RS256 id_token in the Jereh IAM claim set (0007 Identity claims). */
function idToken(issuer: string, over: Record<string, unknown> = {}): string {
  const exp = Math.floor(Date.now() / 1000) + 3600
  const payload = { sub: '14409', userId: '14409', uid: '20241029082727096-E823-55B596A1D', aud: 'EnterpriseDingtalk', iss: issuer, iat: exp - 60, exp, nonce: null, ...over }
  const input = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(payload)}`
  const signer = createSign('sha256')
  signer.update(input)
  return `${input}.${signer.sign(key.privateKey).toString('base64url')}`
}

/** Console scripts per Jenkins action; the create/start sets drive the portal to READY. */
const rawConsoles: Record<string, string> = {
  'probe:absent': [
    '[DSH_STEP] 1 service info docker: absent',
    '[DSH_STEP] 2 compose info 非 compose 管理(docker run,由 provision.sh 创建)',
    '[DSH_STEP] 3 reconcile info absent',
  ].join('\n') + '\n',
  'probe:healthy': [
    '[DSH_STEP] 1 service info docker: running',
    '[DSH_STEP] 2 compose info 非 compose 管理(docker run,由 provision.sh 创建)',
    '[DSH_STEP] 3 health ok HTTP 302 from container',
    '[DSH_STEP] 4 reconcile info healthy',
  ].join('\n') + '\n',
  'probe:stopped': '[DSH_STEP] 1 service info docker: exited\n[DSH_STEP] 2 compose info 非 compose 管理\n[DSH_STEP] 3 reconcile info stopped\n',
  create: [
    '[DSH_STEP] 1 image-pull ok pulled dev-amd64-abc1234',
    '[DSH_STEP] 2 docker-run ok created ide-14409',
    '[DSH_STEP] 3 start-hook ok entrypoint fired',
    '[DSH_STEP] 4 probe-internal ok 200 after 2 tries',
    '[DSH_STEP] 5 probe-proxy ok 200 after 1 try',
    '[DSH_STEP] 6 ready ok build SUCCESS',
  ].join('\n') + '\n',
  start: [
    '[DSH_STEP] 1 docker-run ok started ide-14409',
    '[DSH_STEP] 2 start-hook ok entrypoint fired',
    '[DSH_STEP] 3 probe-internal ok 200 after 3 tries',
    '[DSH_STEP] 4 probe-proxy ok 200 after 1 try',
    '[DSH_STEP] 5 ready ok build SUCCESS',
  ].join('\n') + '\n',
}

// Live Jenkins (timestamps plugin) prefixes each console line before the
// script text reaches the console; the fake serves the same shape.
const stamp = (text: string): string =>
  text.split('\n').filter(l => l !== '').map(l => `[2026-09-06T08:39:29.081Z] ${l}`).join('\n') + '\n'

const consoles: Record<string, string> = Object.fromEntries(
  Object.entries(rawConsoles).map(([action, text]) => [action, stamp(text)]),
)

interface StartOptions {
  /** Issuer the portal config names; defaults to the fake IAM's live issuer. */
  iamIssuer?: string
  /** Offline trust file to seed instead of reaching the fake IAM. */
  trustFile?: string
  /** Seed a marker file into the state dir before the portal boots. */
  marker?: { build: number; requestId: string; action: string }
  /** Host truth the fake Jenkins probe answers. */
  probe?: 'absent' | 'healthy' | 'stopped'
}

interface Stack {
  portalBase: string
  /** Requests the fake Jenkins received, as `METHOD path`. */
  jenkinsHits: string[]
  /** Requests the fake IAM received; empty whenever the portal runs offline. */
  iamHits: string[]
  /** The token this stack's IAM accepts, signed for its issuer. */
  token: string
  stateDir: string
  portalErr: () => string
  restart: () => Promise<void>
  stop: () => Promise<void>
}

async function freePort(): Promise<number> {
  const probe = createServer()
  probe.listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const { port } = probe.address() as { port: number }
  probe.close()
  await once(probe, 'close')
  return port
}

async function startStack(opts: StartOptions = {}): Promise<Stack> {
  const dir = await mkdtemp(join(tmpdir(), 'ide-e2e-'))
  const stateDir = join(dir, 'state')
  await mkdir(stateDir, { recursive: true })
  if (opts.marker !== undefined) await writeFile(join(stateDir, 'ide-14409.json'), JSON.stringify(opts.marker))
  const jenkinsHits: string[] = []
  const iamHits: string[] = []
  const queueItem = new Map<number, string>()
  let nextBuild = 41
  const queueSeen = new Map<number, number>()
  /** The item lingers one poll round before naming its build, as a real queue does. */
  const executable = (n: number): { executable?: { number: number } } => {
    const seen = (queueSeen.get(n) ?? 0) + 1
    queueSeen.set(n, seen)
    return seen >= 2 || n === seededBuild ? { executable: { number: n } } : {}
  }
  const seededBuild = opts.marker?.build ?? -1

  // The fake IAM: discovery + JWKS over real sockets, the Jereh claim shape.
  const iamServer = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://iam.local')
    iamHits.push(url.pathname)
    const origin = `http://127.0.0.1:${String((iamServer.address() as { port: number }).port)}`
    if (url.pathname === '/idp/.well-known/openid-configuration') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        issuer: `${origin}/idp`,
        authorization_endpoint: `${origin}/idp/authCenter/authenticate`,
        jwks_uri: `${origin}/idp/oidc/getPublicKey`,
      }))
      return
    }
    if (url.pathname === '/idp/oidc/getPublicKey') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ keys: [key.publicKey.export({ format: 'jwk' })] }))
      return
    }
    res.writeHead(404); res.end()
  })
  iamServer.listen(0, '127.0.0.1')
  await once(iamServer, 'listening')
  const iamIssuer = opts.iamIssuer ?? `http://127.0.0.1:${String((iamServer.address() as { port: number }).port)}/idp`
  const token = idToken(opts.trustFile === undefined ? iamIssuer : 'https://iam.jereh.cn/idp')

  // The fake Jenkins: the same REST routes the live JenkinsClient calls. Each
  // action gets its own build number and console script; the probe answers the
  // host truth the scenario names.
  const jenkinsServer = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://jenkins.local')
    jenkinsHits.push(`${req.method} ${url.pathname}`)
    if ((req.headers.authorization ?? '') === '') { res.writeHead(401); res.end(); return }
    const json = (status: number, body: object): void => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (url.pathname === '/job/ide-provision/buildWithParameters') {
      let raw = ''
      req.on('data', (chunk: Buffer) => { raw += chunk.toString() })
      req.on('end', () => {
        const action = new URLSearchParams(raw).get('ACTION') ?? 'probe'
        nextBuild += 1
        queueItem.set(nextBuild, action)
        // Live Jenkins answers the queue location absolutely; the fake mirrors it.
        const port = String((jenkinsServer.address() as { port: number }).port)
        res.writeHead(201, { location: `http://127.0.0.1:${port}/queue/item/${String(nextBuild)}/` })
        res.end()
      })
      return
    }
    const queueMatch = /^\/queue\/item\/(\d+)\/(?:api\/json)?$/.exec(url.pathname)
    if (queueMatch !== null) { json(200, executable(Number(queueMatch[1]))); return }
    const consoleMatch = /^\/job\/ide-provision\/(\d+)\/logText\/progressiveText$/.exec(url.pathname)
    if (consoleMatch !== null) {
      const action = queueItem.get(Number(consoleMatch[1])) ?? 'create'
      const text = (action === 'probe' ? consoles[`probe:${opts.probe ?? 'absent'}`] : consoles[action]) ?? ''
      const start = Number(url.searchParams.get('start') ?? '0')
      // Jenkins reports the absolute console size so the portal can advance its cursor.
      res.writeHead(200, { 'content-type': 'text/plain', 'x-text-size': String(text.length) })
      res.end(text.slice(start))
      return
    }
    const apiMatch = /^\/job\/ide-provision\/(\d+)\/api\/json$/.exec(url.pathname)
    if (apiMatch !== null) {
      const n = Number(apiMatch[1])
      json(200, n === seededBuild ? { building: true } : { building: false, result: 'SUCCESS' })
      return
    }
    res.writeHead(404); res.end()
  })
  jenkinsServer.listen(0, '127.0.0.1')
  await once(jenkinsServer, 'listening')

  const port = await freePort()
  const configPath = join(dir, 'portal.yaml')
  const iamExtra = opts.trustFile === undefined ? '' : `, trustFile: ${JSON.stringify(opts.trustFile)}`
  await writeFile(configPath, [
    'domainSuffix: jereh-pe.cn',
    'entryHost: ide.jereh-pe.cn',
    'uid: {claim: sub, crossCheckClaim: userId, pattern: "^[0-9]{1,8}$"}',
    'imageTag: dev-amd64-abc1234',
    `jenkins: {url: http://127.0.0.1:${String((jenkinsServer.address() as { port: number }).port)}, job: ide-provision, user: portal, tokenEnv: IDE_JENKINS_TOKEN}`,
    `iam: {issuer: ${iamIssuer}, clientId: EnterpriseDingtalk, redirectPath: /auth/callback${iamExtra}}`,
    'health: {intervalSec: 30, timeoutSec: 600, pollMs: 10}',
    'bindHost: 127.0.0.1',
    `port: ${String(port)}`,
    '',
  ].join('\n'))

  let child: ChildProcess | undefined
  let stderr = ''
  async function boot(): Promise<void> {
    child = spawn(process.execPath, ['--experimental-strip-types', cliPath, '--config', configPath, '--web', webRoot, '--state', stateDir], {
      cwd: repoRoot,
      env: { ...process.env, IDE_JENKINS_TOKEN: '~e2etoken0000000000000000000000000000' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error(`portal did not start within 30s: ${stderr}`)) }, 30_000)
      child?.stdout?.on('data', (chunk: Buffer) => {
        if (chunk.toString().includes('listening on')) { clearTimeout(timer); resolve() }
      })
      child?.on('exit', (code) => { clearTimeout(timer); reject(new Error(`portal exited ${String(code)}: ${stderr}`)) })
    })
  }
  await boot()

  return {
    portalBase: `http://127.0.0.1:${String(port)}`,
    jenkinsHits,
    iamHits,
    token,
    stateDir,
    portalErr: () => stderr,
    async restart() {
      if (child !== undefined && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM')
        await once(child, 'exit')
      }
      await boot()
    },
    async stop() {
      if (child !== undefined && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM')
        await once(child, 'exit')
      }
      iamServer.close(); jenkinsServer.close()
      await Promise.all([once(iamServer, 'close').catch(() => {}), once(jenkinsServer, 'close').catch(() => {})])
      await rm(dir, { recursive: true, force: true })
    },
  }
}

/** Drive the implicit round-trip: /login → state cookie → callback POST → session cookie. */
async function signIn(stack: Stack): Promise<string> {
  const login = await fetch(`${stack.portalBase}/login?next=%2F`, { redirect: 'manual' })
  expect(login.status).toBe(302)
  const stateCookie = login.headers.getSetCookie().find(raw => raw.startsWith('ide_oidc_state='))?.split(';')[0]
  if (stateCookie === undefined) throw new Error('no state cookie on the login redirect')
  const state = JSON.parse(Buffer.from(stateCookie.slice('ide_oidc_state='.length), 'base64url').toString()) as { state: string }
  const relay = await fetch(`${stack.portalBase}/auth/callback`, {
    method: 'POST',
    headers: { cookie: stateCookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ id_token: stack.token, state: state.state }).toString(),
  })
  expect(relay.status).toBe(200)
  expect(relay.headers.get('set-cookie') ?? '').toContain('dsh_token=')
  return stack.token
}

async function pollState(base: string, token: string, until: string, tries = 400, stack?: Stack): Promise<Record<string, unknown>> {
  let last: Record<string, unknown> = {}
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const res = await fetch(`${base}/api/state`, { headers: { cookie: `dsh_token=${token}` } })
    last = JSON.parse(await res.text()) as Record<string, unknown>
    const cur = (last['state'] as { state?: string } | undefined)?.state
    if (cur === until) return last
    await new Promise<void>((resolve) => { setTimeout(resolve, 25) })
  }
  const jk = stack === undefined ? '' : `; jenkins: ${JSON.stringify(stack.jenkinsHits.slice(0, 40))}`
  const err = stack === undefined ? '' : `; portal stderr: ${stack.portalErr().slice(-400)}`
  throw new Error(`state never reached ${until}; last: ${JSON.stringify(last)}${jk}${err}`)
}

/** Read the SSE stream until a JSON fragment appears (or the budget runs out). */
async function readStream(base: string, token: string, marker: string, ms = 8000): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, ms)
  try {
    const res = await fetch(`${base}/api/events`, { headers: { cookie: `dsh_token=${token}` }, signal: controller.signal })
    if (!res.ok || res.body === null) throw new Error(`events: HTTP ${String(res.status)}`)
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let acc = ''
    while (!acc.includes(marker)) {
      const { done, value } = await reader.read()
      if (done) break
      acc += decoder.decode(value, { stream: true })
    }
    return acc
  } catch (error) {
    if (!String(error).includes('abort')) throw error
    return ''
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}

let stack: Stack | undefined
afterEach(async () => {
  if (stack !== undefined) { await stack.stop(); stack = undefined }
})

describe('portal end-to-end (real process, real sockets)', () => {
  it('signs in through the IAM round-trip and answers the API as the verified user', async () => {
    stack = await startStack()
    expect((await fetch(`${stack.portalBase}/api/state`)).status).toBe(401)

    const login = await fetch(`${stack.portalBase}/login?next=%2F`, { redirect: 'manual' })
    const authorize = new URL(String(login.headers.get('location')))
    expect(authorize.pathname).toBe('/idp/authCenter/authenticate')
    expect(authorize.searchParams.get('redirect_uri')).toBe(`${stack.portalBase}/auth/callback`)

    const token = await signIn(stack)
    await pollState(stack.portalBase, token, 'NO_SERVICE', 400, stack)

    const home = await fetch(`${stack.portalBase}/`, { headers: { cookie: `dsh_token=${token}`, accept: 'text/html' } })
    expect(home.status).toBe(200)
    // The gate only ever reached the IAM's two published documents, not a login.
    expect(stack.iamHits).toEqual(['/idp/.well-known/openid-configuration', '/idp/oidc/getPublicKey'])
  }, 30_000)

  it('drives the manual check button through fake Jenkins to READY, markers and SSE included', async () => {
    stack = await startStack()
    const token = await signIn(stack)

    const accepted = await fetch(`${stack.portalBase}/api/provision`, { method: 'POST', headers: { cookie: `dsh_token=${token}` } })
    expect(accepted.status).toBe(202)

    const final = await pollState(stack.portalBase, token, 'READY', 400, stack)
    expect((final['state'] as { ideUrl?: string }).ideUrl).toBe('http://ide-14409.jereh-pe.cn/')
    const steps = (final['steps'] ?? []) as { step: string; status: string }[]
    expect(steps.some(step => step.step === 'jenkins-queued' && step.status === 'ok')).toBe(true)
    expect(steps.some(step => step.step === 'image-pull' && step.status === 'ok')).toBe(true)
    expect(stack.jenkinsHits).toContain('POST /job/ide-provision/buildWithParameters')
    expect(stack.jenkinsHits.some(hit => hit.startsWith('GET /job/ide-provision/') && hit.endsWith('/logText/progressiveText'))).toBe(true)

    // The SSE stream replays the finished run and lands on READY with the url.
    const sse = await readStream(stack.portalBase, token, '"state":"READY"')
    expect(sse).toContain('"step":"ready"')
    expect(sse).toContain('"ideUrl":"http://ide-14409.jereh-pe.cn/"')
  }, 30_000)

  it('starts a stopped container: reconcile picks start, never create', async () => {
    stack = await startStack({ probe: 'stopped' })
    const token = await signIn(stack)
    const accepted = await fetch(`${stack.portalBase}/api/provision`, { method: 'POST', headers: { cookie: `dsh_token=${token}` } })
    expect(accepted.status).toBe(202)
    const final = await pollState(stack.portalBase, token, 'READY', 400, stack)
    expect((final['state'] as { ideUrl?: string }).ideUrl).toBe('http://ide-14409.jereh-pe.cn/')
    const steps = (final['steps'] ?? []) as { step: string; detail: string }[]
    expect(steps.some(step => step.step === 'lock' && step.detail.includes('action=start'))).toBe(true)
  }, 30_000)

  it('short-circuits a healthy container: exactly the probe runs, the entry still answers READY', async () => {
    stack = await startStack({ probe: 'healthy' })
    const token = await signIn(stack)
    const accepted = await fetch(`${stack.portalBase}/api/provision`, { method: 'POST', headers: { cookie: `dsh_token=${token}` } })
    expect(accepted.status).toBe(202)
    const final = await pollState(stack.portalBase, token, 'HEALTHY', 400, stack)
    expect((final['state'] as { ideUrl?: string }).ideUrl).toBe('http://ide-14409.jereh-pe.cn/')
    expect(stack.jenkinsHits.filter(hit => hit === 'POST /job/ide-provision/buildWithParameters')).toHaveLength(1)
    // The check reads as the requested chain: identity, domain, host facts, verdict.
    const steps = (final['steps'] ?? []) as { step: string; detail: string }[]
    const chain = steps.filter(step => ['工号', '域名', '服务状态', 'Compose 位置', '健康检查', '检查结论', '结论'].includes(step.step))
    expect(chain.map(step => `${step.step}: ${step.detail}`)).toEqual([
      '工号: 14409',
      '域名: http://ide-14409.jereh-pe.cn/',
      '服务状态: docker: running',
      'Compose 位置: 非 compose 管理(docker run,由 provision.sh 创建)',
      '健康检查: HTTP 302 from container',
      '检查结论: healthy',
      '结论: 专属IDE状态正常',
    ])
  }, 30_000)

  it('the entry auto-checks on arrival: a healthy container renders the page on HEALTHY without provisioning', async () => {
    stack = await startStack({ probe: 'healthy' })
    const token = await signIn(stack)
    const entry = await fetch(`${stack.portalBase}/`, { redirect: 'manual', headers: { cookie: `dsh_token=${token}`, accept: 'text/html' } })
    expect(entry.status).toBe(200)
    const final = await pollState(stack.portalBase, token, 'HEALTHY', 400, stack)
    expect((final['state'] as { ideUrl?: string }).ideUrl).toBe('http://ide-14409.jereh-pe.cn/')
    expect(stack.jenkinsHits.filter(hit => hit === 'POST /job/ide-provision/buildWithParameters')).toHaveLength(1)
    // The check reads as the requested chain: identity, domain, host facts, verdict.
    const steps = (final['steps'] ?? []) as { step: string; detail: string }[]
    const chain = steps.filter(step => ['工号', '域名', '服务状态', 'Compose 位置', '健康检查', '检查结论', '结论'].includes(step.step))
    expect(chain.map(step => `${step.step}: ${step.detail}`)).toEqual([
      '工号: 14409',
      '域名: http://ide-14409.jereh-pe.cn/',
      '服务状态: docker: running',
      'Compose 位置: 非 compose 管理(docker run,由 provision.sh 创建)',
      '健康检查: HTTP 302 from container',
      '检查结论: healthy',
      '结论: 专属IDE状态正常',
    ])
  }, 30_000)

  it('attaches to the marker-named build after a portal restart and drives it to READY', async () => {
    // Boot with a marker file whose build is still running (api/json answers
    // building:true, console answers the full create script): the boot resume
    // attaches, not re-triggers, and completes the run (N3).
    stack = await startStack({ marker: { build: 42, requestId: 'seed', action: 'create' }, probe: 'absent' })
    const token = await signIn(stack)
    const final = await pollState(stack.portalBase, token, 'READY', 400, stack)
    expect((final['state'] as { ideUrl?: string }).ideUrl).toBe('http://ide-14409.jereh-pe.cn/')
    // The attach never triggers a second build: only the resume path ran.
    expect(stack.jenkinsHits.filter(hit => hit === 'POST /job/ide-provision/buildWithParameters')).toHaveLength(0)
  }, 30_000)

  it('boots offline from a seeded trust file: sign-in works and the IAM is never contacted', async () => {
    const trust = {
      discovery: { issuer: 'https://iam.jereh.cn/idp', authorization_endpoint: 'https://iam.jereh.cn/idp/authCenter/authenticate', jwks_uri: 'https://iam.jereh.cn/idp/oidc/getPublicKey' },
      jwks: { keys: [key.publicKey.export({ format: 'jwk' })] },
    }
    const dir = await mkdtemp(join(tmpdir(), 'ide-e2e-trust-'))
    const trustFile = join(dir, 'iam-trust.json')
    await writeFile(trustFile, JSON.stringify(trust))
    stack = await startStack({ trustFile, iamIssuer: 'https://iam.jereh.cn/idp' })
    const login = await fetch(`${stack.portalBase}/login`, { redirect: 'manual' })
    expect(login.status).toBe(302)
    expect(new URL(String(login.headers.get('location'))).origin).toBe('https://iam.jereh.cn')

    const token = await signIn(stack)
    expect((await pollState(stack.portalBase, token, 'NO_SERVICE', 400, stack))['state']).toBeTruthy()
    expect(stack.iamHits).toEqual([])
    await rm(dir, { recursive: true, force: true })
  }, 30_000)

  it('refuses to boot when the trust file disagrees with the configured issuer', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ide-e2e-badtrust-'))
    const trustFile = join(dir, 'iam-trust.json')
    await writeFile(trustFile, JSON.stringify({
      discovery: { issuer: 'https://iam.other.invalid/idp', authorization_endpoint: 'https://iam.other.invalid/idp/a', jwks_uri: 'https://iam.other.invalid/idp/j' },
      jwks: { keys: [key.publicKey.export({ format: 'jwk' })] },
    }))
    const port = await freePort()
    const configPath = join(dir, 'portal.yaml')
    await writeFile(configPath, [
      'domainSuffix: jereh-pe.cn', 'entryHost: ide.jereh-pe.cn',
      'uid: {claim: sub, crossCheckClaim: userId, pattern: "^[0-9]{1,8}$"}', 'imageTag: t',
      'jenkins: {url: http://jenkins.invalid, job: j, user: u, tokenEnv: IDE_JENKINS_TOKEN}',
      `iam: {issuer: https://iam.jereh.cn/idp, clientId: EnterpriseDingtalk, redirectPath: /auth/callback, trustFile: ${JSON.stringify(trustFile)}}`,
      'health: {intervalSec: 30, timeoutSec: 600, pollMs: 10}',
      'bindHost: 127.0.0.1', `port: ${String(port)}`, '',
    ].join('\n'))
    const child: ChildProcess = spawn(process.execPath, ['--experimental-strip-types', cliPath, '--config', configPath], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    const [exit] = (await once(child, 'exit')) as [number | null]
    expect(exit).not.toBe(0)
    expect(stderr).toContain('disagrees')
    await rm(dir, { recursive: true, force: true })
  }, 30_000)
})
