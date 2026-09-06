/**
 * Orchestrator behavior against the fake Jenkins and a zero-sleep clock: the
 * cold run to READY, the warm reconcile short-circuit, joiner semantics for
 * FR7, failure and timeout terminals, uid resolution, and marker-file
 * persistence across a portal restart (N3).
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { PortalConfig } from '../src/config.ts'
import { parsePortalConfig } from '../src/config.ts'
import { ideUrl, Orchestrator, resolveUid, type Clock } from '../src/orchestrator.ts'
import type { LiveEvent } from '../src/events.ts'
import { FakeJenkins } from './fake-jenkins.ts'

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

/** Zero-duration sleeps: the driver loop runs to its terminal state without wall-clock cost. */
const instantClock: Clock = { sleep: async () => {}, now: () => Date.now() }

/** A clock whose now() advances 30 s per call: the drive deadline expires after two loops. */
function crawlingClock(): Clock {
  let base = Date.now()
  return { sleep: async () => {}, now: () => { const at = base; base += 30_000; return at } }
}

interface Harness {
  orchestrator: Orchestrator
  jenkins: FakeJenkins
  config: PortalConfig
  stateDir: string
  events: LiveEvent[]
}

async function harness(clock: Clock = instantClock): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'ide-portal-orch-'))
  dirs.push(dir)
  const stateDir = join(dir, 'state')
  const config: PortalConfig = {
    ...parsePortalConfig(`
domainSuffix: jereh-pe.cn
entryHost: ide.jereh-pe.cn
uid: {claim: sub, crossCheckClaim: userId, pattern: "^[0-9]{1,8}$"}
imageTag: dev-amd64-abc1234
jenkins: {url: https://jenkins.test, job: ide-provision, user: portal, tokenEnv: IDE_JENKINS_TOKEN}
iam: {issuer: https://iam.test/idp, clientId: EnterpriseDingtalk, redirectPath: /auth/callback}
health: {intervalSec: 30, timeoutSec: 600, pollMs: 1}
`),
    port: 0,
  }
  const jenkins = new FakeJenkins()
  const orchestrator = new Orchestrator(config, jenkins, stateDir, clock)
  const events: LiveEvent[] = []
  orchestrator.subscribe((_uid, event) => events.push(event))
  return { orchestrator, jenkins, config, stateDir, events }
}

const COLD = `[DSH_STEP] 2 image-pull ok pulled dev-amd64-abc1234
[DSH_STEP] 3 docker-run ok created ide-14409
[DSH_STEP] 4 start-hook ok entrypoint fired
[DSH_STEP] 5 probe-internal ok 200 after 15 tries, 450s
[DSH_STEP] 6 probe-proxy ok 200 after 1 try
[DSH_STEP] 7 ready ok build SUCCESS
`

describe('cold path (FR4, US1)', () => {
  it('drives absent -> READY translating markers into steps and states', async () => {
    const { orchestrator, jenkins, events } = await harness()
    jenkins.script('probe', { console: '[DSH_STEP] 1 reconcile info absent\n', result: 'SUCCESS' })
    jenkins.script('create', { console: COLD, result: 'SUCCESS' })
    const state = await orchestrator.enter('14409')
    expect(state).toBe('READY')
    expect(orchestrator.run('14409').steps.map(s => s.step)).toEqual([
      '工号', '域名', '检查', 'jenkins-running', '结论', 'lock', 'jenkins-queued', 'jenkins-running',
      'image-pull', 'docker-run', 'start-hook', 'probe-internal', 'probe-proxy', 'ready',
    ])
    const create = jenkins.triggered.find(t => t.action === 'create')
    expect(create?.imageTag).toBe('dev-amd64-abc1234')
    const states = events.filter(e => e.type === 'state').map(e => e.state)
    expect(states).toContain('PROVISIONING')
    expect(states.at(-1)).toBe('READY')
    expect(orchestrator.stateEvent('14409').ideUrl).toBe('http://ide-14409.jereh-pe.cn/')
  })

  it('a stopped container starts without any key transport (FR10, SR5)', async () => {
    const { orchestrator, jenkins } = await harness()
    jenkins.script('probe', { console: '[DSH_STEP] 1 reconcile info stopped\n', result: 'SUCCESS' })
    jenkins.script('start', { console: '[DSH_STEP] 2 start-hook ok fired\n[DSH_STEP] 3 probe-internal ok 200\n[DSH_STEP] 4 probe-proxy ok 200\n[DSH_STEP] 5 ready ok done\n', result: 'SUCCESS' })
    expect(await orchestrator.enter('14409')).toBe('READY')
    const start = jenkins.triggered.find(t => t.action === 'start')
    expect(start?.imageTag).toBe('dev-amd64-abc1234')
  })
})

describe('arrival check (fast open, 2026-09-06)', () => {
  it('each reconcile renders exactly one chain; seq stays monotonic across the reset', async () => {
    const { orchestrator, jenkins } = await harness()
    jenkins.script('probe', { console: '[DSH_STEP] 1 reconcile info healthy\n', result: 'SUCCESS' })
    jenkins.script('probe', { console: '[DSH_STEP] 1 reconcile info absent\n', result: 'SUCCESS' })
    await orchestrator.reconcile('14409')
    const firstSeqs = orchestrator.run('14409').steps.map(s => s.seq)
    await orchestrator.reconcile('14409')
    const run = orchestrator.run('14409')
    // The second check shows one fresh chain (no replayed history drowning the
    // new verdict) and its seqs continue past the first check's.
    expect(run.steps.map(s => s.step)).toEqual(['工号', '域名', '检查', 'jenkins-running', '结论'])
    expect(run.snapshot.state).toBe('NO_SERVICE')
    expect(Math.min(...run.steps.map(s => s.seq))).toBeGreaterThan(Math.max(...firstSeqs))
  })

  it('arrive surfaces a probe failure as a step without flipping the machine state', async () => {
    const { orchestrator, jenkins } = await harness()
    // A probe build with no reconcile marker throws inside reconcile.
    jenkins.script('probe', { console: '', result: 'SUCCESS' })
    await orchestrator.arrive('14409')
    const run = orchestrator.run('14409')
    expect(orchestrator.stateEvent('14409').checking).toBe(false)
    expect(run.steps.map(s => s.step)).toEqual(['工号', '域名', '检查', 'jenkins-running', '检查'])
    expect(run.steps.at(-1)?.status).toBe('fail')
    expect(run.snapshot.state).toBe('NO_SERVICE')
  })
})

describe('warm path (FR3)', () => {
  it('reconcile finding a healthy container returns HEALTHY without provisioning', async () => {
    const { orchestrator, jenkins } = await harness()
    jenkins.script('probe', { console: '[DSH_STEP] 1 reconcile info healthy\n', result: 'SUCCESS' })
    expect(await orchestrator.enter('14409')).toBe('HEALTHY')
    expect(jenkins.triggered.map(t => t.action)).toEqual(['probe'])
  })
})

describe('single flight (FR7)', () => {
  it('a second enter joins the in-flight run instead of triggering a second create', async () => {
    const { orchestrator, jenkins } = await harness()
    jenkins.script('probe', { console: '[DSH_STEP] 1 reconcile info absent\n', result: 'SUCCESS' })
    jenkins.script('create', { console: COLD, result: 'SUCCESS' })
    const first = orchestrator.enter('14409')
    const second = orchestrator.enter('14409')
    expect(await first).toBe('READY')
    expect(await second).toBe('READY')
    expect(jenkins.triggered.filter(t => t.action === 'create').length).toBeLessThanOrEqual(1)
  })
})

describe('failure terminals (FR8, FR6)', () => {
  it('a failed marker ends the run FAILED with the failed step named', async () => {
    const { orchestrator, jenkins } = await harness()
    jenkins.script('probe', { console: '[DSH_STEP] 1 reconcile info absent\n', result: 'SUCCESS' })
    jenkins.script('create', { console: '[DSH_STEP] 2 docker-run ok created\n[DSH_STEP] 3 probe-internal fail never answered 200\n', result: 'FAILURE' })
    expect(await orchestrator.enter('14409')).toBe('FAILED')
    expect(orchestrator.run('14409').snapshot.failedStep).toBe('probe-internal')
  })

  it('a silent healthy-less run ends TIMEOUT past the budget', async () => {
    const { orchestrator, jenkins } = await harness(crawlingClock())
    jenkins.script('probe', { console: '[DSH_STEP] 1 reconcile info running-unhealthy\n', result: 'SUCCESS' })
    jenkins.script('start', { console: '[DSH_STEP] 2 start-hook ok fired\n', result: undefined })
    expect(await orchestrator.enter('14409')).toBe('TIMEOUT')
  })

  it('retry re-reconciles and re-provisions', async () => {
    const { orchestrator, jenkins } = await harness()
    jenkins.script('probe',
      { console: '[DSH_STEP] 1 reconcile info absent\n', result: 'SUCCESS' },
      { console: '[DSH_STEP] 1 reconcile info stopped\n', result: 'SUCCESS' })
    jenkins.script('create', { console: '[DSH_STEP] 2 docker-run fail name conflict handled\n', result: 'FAILURE' })
    jenkins.script('start', { console: COLD.replace('absent', 'stopped'), result: 'SUCCESS' })
    expect(await orchestrator.enter('14409')).toBe('FAILED')
    expect(await orchestrator.retry('14409')).toBe('READY')
  })
})

describe('restart attach (N3)', () => {
  it('resume re-attaches to the build the marker file names and finishes the run', async () => {
    const { orchestrator, jenkins, config, stateDir } = await harness(crawlingClock())
    // The create build stays unfinished (result undefined) while the first portal is alive; the crawling clock drives it to TIMEOUT.
    jenkins.script('probe', { console: '[DSH_STEP] 1 reconcile info absent\n', result: 'SUCCESS' })
    jenkins.script('create', { console: '[DSH_STEP] 2 docker-run ok created\n', result: undefined })
    const state = await orchestrator.enter('14409')
    expect(state).toBe('TIMEOUT')
    // A fresh orchestrator over the same state dir reads the marker and drives the still-running build to its end.
    const second = new FakeJenkins()
    // Deterministic numbering: probe took build 100, create took 101; the marker names 101, still building.
    second.seed(101, { console: '[DSH_STEP] 3 ready ok done\n', result: undefined })
    const restarted = new Orchestrator({ ...config, health: { ...config.health, timeoutSec: 120 } }, second, stateDir, instantClock)
    await restarted.resume('14409')
    expect(restarted.run('14409').snapshot.state).toBe('READY')
  })

  it('resume is a no-op when no marker file exists', async () => {
    const { config, stateDir } = await harness()
    const restarted = new Orchestrator(config, new FakeJenkins(), stateDir, instantClock)
    await restarted.resume('14409')
    expect(restarted.run('14409').snapshot.state).toBe('NO_SERVICE')
  })

  it('resumable lists exactly the uids a marker file names', async () => {
    const { orchestrator, jenkins, config, stateDir } = await harness(crawlingClock())
    jenkins.script('probe', { console: '[DSH_STEP] 1 reconcile info absent\n', result: 'SUCCESS' })
    jenkins.script('create', { console: '[DSH_STEP] 2 docker-run ok created\n', result: undefined })
    await orchestrator.enter('14409')
    const restarted = new Orchestrator(config, new FakeJenkins(), stateDir, instantClock)
    expect(restarted.resumable()).toEqual(['14409'])
  })
})

describe('uid resolution (FR1, FR2, SR1)', () => {
  const config = {
    domainSuffix: 'jereh-pe.cn',
    uid: { claim: 'sub', crossCheckClaim: 'userId', pattern: '^[0-9]{1,8}$' },
  } as unknown as PortalConfig

  it('accepts matching sub/userId', () => {
    expect(resolveUid(config, { sub: '14409', userId: '14409' })).toBe('14409')
  })

  it('refuses a cross-check mismatch, a non-numeric sub, and the session-id uid claim', () => {
    expect(resolveUid(config, { sub: '14409', userId: '99' })).toBeUndefined()
    expect(resolveUid(config, { sub: 'root', userId: 'root' })).toBeUndefined()
    expect(resolveUid(config, { userId: '14409' })).toBeUndefined()
    expect(resolveUid(config, { sub: '14409' })).toBeUndefined()
  })

  it('ideUrl derives the fixed vhost (FR2)', () => {
    expect(ideUrl(config, '14409')).toBe('http://ide-14409.jereh-pe.cn/')
  })
})
