/**
 * Per-user provisioning orchestrator (0008): owns the per-uid run state,
 * the single-flight lock, Jenkins trigger + console tail, and the append-only
 * step log the SSE stream replays. Marker files keep the last triggered
 * build across portal restarts; Docker host state stays the truth (N3).
 * @module
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { PortalConfig } from './config.ts'
import type { LiveEvent, StepEvent, StepName, StateEvent } from './events.ts'
import { freshCursor, parseMarkers, type ConsoleCursor } from './marker.ts'
import type { JenkinsClient, TriggerParams } from './jenkins.ts'
import { advance, freshRun, stateFromReconcile, type MachineSnapshot, type Reconcile, type Run, type ServiceState } from './state.ts'

/** Injectable timing hooks; production uses the real timers, tests step the loop. */
export interface Clock {
  sleep(ms: number): Promise<void>
  now(): number
}

/** The real clock. */
export const realClock: Clock = {
  sleep: ms => new Promise<void>((resolve) => { setTimeout(resolve, ms) }),
  now: () => Date.now(),
}

/** Subscriber signature for the live event stream. */
export type Listener = (uid: string, event: LiveEvent) => void

/** The absolute IDE url derived from the uid (FR2). */
export function ideUrl(config: PortalConfig, uid: string): string {
  return `http://ide-${uid}.${config.domainSuffix}/`
}

/**
 * Validate the uid against the configured pattern and cross-check claims
 * (SR1/FR2): fail-closed on anything the pattern rejects or the claims
 * disagree on.
 */
export function resolveUid(config: PortalConfig, claims: Record<string, unknown>): string | undefined {
  const sub = claims[config.uid.claim]
  const cross = claims[config.uid.crossCheckClaim]
  if (typeof sub !== 'string' || !new RegExp(config.uid.pattern).test(sub)) return undefined
  if (cross !== sub) return undefined
  return sub
}

/** Display labels for the probe's host-fact markers (requester chain, 2026-09-06). */
const CHECK_LABELS: Record<string, string> = { service: '服务状态', compose: 'Compose 位置', health: '健康检查' }

/** Docker states provision.sh reports through the `service` marker, in Chinese. */
const DOCKER_STATES: Record<string, string> = {
  running: '容器运行中',
  absent: '容器不存在(尚未开通)',
  exited: '容器已停止',
  created: '容器已创建但未启动',
  dead: '容器已死亡(dead)',
  frozen: '容器冻结(frozen)',
}

/** Translate one probe marker's raw detail into page Chinese (the log is for operators in China). */
function humanizeDetail(step: string, detail: string): string {
  if (step === 'service') return DOCKER_STATES[detail.replace(/^docker:\s*/, '')] ?? `容器状态:${detail}`
  if (step === 'compose') {
    if (detail.startsWith('非 compose')) return '独立容器(由开通脚本创建,非 compose 项目)'
    const match = /^(.+?)(?::(\d+))?\s+service=(.+)$/.exec(detail)
    if (match !== null) return `compose 配置 ${match[1] ?? ''}${match[2] !== undefined ? ` 第${match[2]}行` : ''},服务名 ${match[3] ?? ''}`
    return detail
  }
  if (step === 'health') {
    const http = /^HTTP (\d+) from container$/.exec(detail)
    if (http !== null) {
      const code = http[1] ?? ''
      const gate = code === '401' || code === '302' ? '(登录保护正常)' : ''
      return `容器应答 HTTP ${code}${gate}`
    }
    const none = /^no answer \(last (\d+)\)$/.exec(detail)
    if (none !== null) return `容器无应答(最后一次 HTTP ${none[1] ?? ''})`
    return detail
  }
  return detail
}

/** The final verdict line for a reconcile result, in Chinese. */
function verdictDetail(reconcile: Reconcile): string {
  switch (reconcile.kind) {
    case 'healthy': return '专属IDE状态正常'
    case 'absent': return '未开通——点击「开通」创建你的 IDE'
    case 'exists': return reconcile.running ? '容器在运行,但健康检查未通过' : '容器存在但未运行——点击「开通」重新启动'
  }
}

/** The reconcile verdict the probe job reports via its `reconcile` marker detail. */
function reconcileFromDetail(detail: string): Reconcile {
  switch (detail.trim()) {
    case 'absent': return { kind: 'absent' }
    case 'healthy': return { kind: 'healthy' }
    case 'stopped': case 'frozen': return { kind: 'exists', running: false }
    case 'running-unhealthy': return { kind: 'exists', running: true }
    default: throw new Error(`reconcile: unknown probe detail ${JSON.stringify(detail)}`)
  }
}

/** Map a marker step name to the service state it establishes (monotonic within a run). */
const STEP_STATE: Readonly<Partial<Record<StepName, ServiceState>>> = {
  'docker-run': 'PROVISIONING',
  'start-hook': 'STARTING',
  'probe-proxy': 'HEALTHY',
  'ready': 'READY',
}

/** Per-uid run registry, event fan-out, and the Jenkins driver loop. */
export class Orchestrator {
  private readonly runs = new Map<string, Run>()
  private readonly listeners = new Set<Listener>()
  /** Uids with a provisioning or start action in flight (FR7 in-process lock). */
  private readonly busy = new Set<string>()

  readonly config: PortalConfig
  readonly jenkins: JenkinsClient
  readonly clock: Clock
  private readonly markerDir: string

  /** Build the orchestrator; the marker directory is created eagerly. */
  constructor(config: PortalConfig, jenkins: JenkinsClient, markerDir: string, clock: Clock = realClock) {
    this.config = config
    this.jenkins = jenkins
    this.clock = clock
    this.markerDir = markerDir
    mkdirSync(markerDir, { recursive: true })
  }

  /** The current run for a uid, observed or fresh. */
  run(uid: string): Run {
    return this.runs.get(uid) ?? freshRun()
  }

  /** Subscribe to the live stream; returns the disposer. */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** The current StateEvent projection for a uid. */
  stateEvent(uid: string): StateEvent {
    const run = this.run(uid)
    const ready = run.snapshot.state === 'READY' || run.snapshot.state === 'HEALTHY'
    return {
      type: 'state',
      state: run.snapshot.state,
      checking: run.checking,
      ideUrl: ready ? ideUrl(this.config, uid) : undefined,
      build: run.snapshot.build,
    }
  }

  private emit(uid: string, event: LiveEvent): void {
    for (const listener of this.listeners) listener(uid, event)
  }

  private appendStep(uid: string, step: string, status: StepEvent['status'], detail: string): void {
    const run = this.ensure(uid)
    const event: StepEvent = { type: 'step', seq: ++run.seq, step, status, detail, atMs: this.clock.now() }
    run.steps.push(event)
    run.updatedMs = event.atMs
    this.emit(uid, event)
  }

  private setState(uid: string, next: ServiceState, patch: Partial<MachineSnapshot> = {}): void {
    const run = this.ensure(uid)
    if (run.snapshot.state === next) {
      run.snapshot = { ...run.snapshot, ...patch }
    } else if (!transitionAllowed(run.snapshot.state, next)) {
      // Reconcile-driven resets rewrite the snapshot outright; machine edges cover run-internal moves only.
      run.snapshot = { ...run.snapshot, state: next, ...patch }
    } else {
      run.snapshot = advance({ ...run.snapshot, ...patch }, next)
    }
    run.updatedMs = this.clock.now()
    this.emit(uid, this.stateEvent(uid))
  }

  private ensure(uid: string): Run {
    let run = this.runs.get(uid)
    if (run === undefined) {
      run = freshRun()
      this.runs.set(uid, run)
    }
    return run
  }

  /**
   * Arrival check (requester, 2026-09-06: fast open + streamed progress): the
   * page serves immediately and the reconcile runs behind the request. Unlike
   * the button flow, a probe failure surfaces as a visible step instead of a
   * machine transition — the host, not a transient Jenkins outage, is the
   * truth the banner reflects.
   */
  async arrive(uid: string): Promise<void> {
    const run = this.ensure(uid)
    run.checking = true
    this.emit(uid, this.stateEvent(uid))
    try {
      await this.reconcile(uid)
    } catch (error) {
      this.appendStep(uid, '检查', 'fail', `探针未完成: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      run.checking = false
      this.emit(uid, this.stateEvent(uid))
    }
  }

  /**
   * Reconcile (FR6): run the probe job and adopt what the host reports. The
   * result replaces any stale in-memory state unless a provisioning run is
   * in flight for this uid.
   */
  async reconcile(uid: string): Promise<Reconcile> {
    if (this.busy.has(uid)) {
      const current = this.run(uid).snapshot.state
      return current === 'HEALTHY' || current === 'READY' ? { kind: 'healthy' } : { kind: 'exists', running: true }
    }
    const build = await this.trigger(uid, 'probe')
    const markers = await this.tailBuild(build)
    const line = markers.find(marker => marker.step === 'reconcile')
    if (line === undefined || line.status === 'fail') throw new Error(`reconcile: probe build #${String(build)} returned no reconcile marker`)
    const reconcile = reconcileFromDetail(line.detail)
    const run = this.ensure(uid)
    run.snapshot = { state: stateFromReconcile(reconcile), build, failedStep: undefined }
    run.updatedMs = this.clock.now()
    // Each check renders as one chain (requester, 2026-09-06): a fresh arrival
    // must not replay the day's older chains, or a stale 正常 verdict drowns
    // the new one. `seq` stays monotonic, so connected pages dedup correctly.
    run.steps = []
    this.appendStep(uid, '工号', 'info', uid)
    this.appendStep(uid, '域名', 'info', ideUrl(this.config, uid))
    for (const marker of markers) {
      const label = CHECK_LABELS[marker.step]
      if (label !== undefined) this.appendStep(uid, label, marker.status, humanizeDetail(marker.step, marker.detail))
    }
    // Absent and healthy are legitimate verdicts (info); a container that
    // exists but fails its health probe is the only red conclusion.
    this.appendStep(uid, '结论', reconcile.kind === 'exists' ? 'fail' : 'info', verdictDetail(reconcile))
    this.emit(uid, this.stateEvent(uid))
    return reconcile
  }

  /**
   * Drive reconcile, reporting a failed probe (Jenkins unreachable, a build
   * without a reconcile marker) as FAILED, so the button-triggered flow always
   * lands on a rendered terminal state (FR8).
   */
  private async reconcileOrFail(uid: string): Promise<Reconcile | undefined> {
    try {
      return await this.reconcile(uid)
    } catch (error) {
      this.appendStep(uid, 'failed', 'fail', error instanceof Error ? error.message : String(error))
      this.failTo(uid, 'FAILED')
      return undefined
    }
  }

  /**
   * Enter the portal for a uid: reconcile, take the shortest path (warm →
   * return healthy), or provision (FR3/FR4). Idempotent: an in-flight run is
   * joined, never duplicated (FR7).
   */
  async enter(uid: string): Promise<ServiceState> {
    const reconcile = await this.reconcileOrFail(uid)
    if (reconcile === undefined) return 'FAILED'
    if (reconcile.kind === 'healthy') return 'HEALTHY'
    const action = reconcile.kind === 'absent' ? 'create' : 'start'
    return await this.provision(uid, action)
  }

  /**
   * Drive one create/start run to READY, FAILED, or TIMEOUT under the
   * per-uid single-flight lock (FR7).
   */
  async provision(uid: string, action: 'create' | 'start'): Promise<ServiceState> {
    if (this.busy.has(uid)) {
      // Joiner view: wait for the owner's terminal signal instead of triggering a second build.
      return await this.waitForTerminal(uid)
    }
    this.busy.add(uid)
    try {
      this.appendStep(uid, 'lock', 'ok', `action=${action}`)
      this.setState(uid, action === 'create' ? 'PROVISIONING' : 'STARTING', { failedStep: undefined })
      const build = await this.trigger(uid, action)
      this.appendStep(uid, 'jenkins-queued', 'ok', `build pending #${String(build)}`)
      const state = await this.drive(uid, build)
      return state
    } catch (error) {
      this.appendStep(uid, 'failed', 'fail', error instanceof Error ? error.message : String(error))
      this.failTo(uid, 'FAILED')
      return 'FAILED'
    } finally {
      this.busy.delete(uid)
    }
  }

  /** Trigger the job and persist the marker file (portal-restart attach point, N3). */
  private async trigger(uid: string, action: TriggerParams['action']): Promise<number> {
    const requestId = randomUUID()
    const itemPath = await this.jenkins.trigger({
      uid,
      action,
      imageTag: this.config.imageTag,
      requestId,
    })
    let build: number | undefined
    const queueDeadline = this.clock.now() + 120_000
    for (;;) {
      build = await this.jenkins.followQueue(itemPath)
      if (build !== undefined || this.clock.now() > queueDeadline) break
      await this.clock.sleep(this.config.health.pollMs)
    }
    if (build === undefined) throw new Error(`jenkins: build for ${action} ${uid} never left the queue`)
    writeFileSync(this.markerPath(uid), JSON.stringify({ build, requestId, action }))
    this.ensure(uid).snapshot.build = build
    return build
  }

  /** Run the short probe build to completion and return its markers (reconcile reads the `reconcile` marker). */
  private async tailBuild(build: number): Promise<{ step: StepName; status: 'ok' | 'fail' | 'info'; detail: string }[]> {
    const all: { step: StepName; status: 'ok' | 'fail' | 'info'; detail: string }[] = []
    let cursor = freshCursor()
    const deadline = this.clock.now() + 120_000
    for (;;) {
      const chunk = await this.jenkins.console(build, cursor.start)
      cursor = { start: chunk.size, more: chunk.more }
      all.push(...parseMarkers(chunk.text))
      if (all.some(marker => marker.step === 'ready' || marker.step === 'failed')) break
      const result = await this.jenkins.result(build)
      if (result !== undefined || this.clock.now() > deadline) break
      await this.clock.sleep(this.config.health.pollMs)
    }
    return all
  }

  /** Tail one build's console, translating markers into steps and state, until it finishes or the budget ends. */
  private async drive(uid: string, build: number): Promise<ServiceState> {
    this.appendStep(uid, 'jenkins-running', 'ok', `build #${String(build)}`)
    const deadline = this.clock.now() + this.config.health.timeoutSec * 1000
    let cursor: ConsoleCursor = freshCursor()
    let lastResult = ''
    while (this.clock.now() < deadline) {
      const chunk = await this.jenkins.console(build, cursor.start)
      cursor = { start: chunk.size, more: chunk.more }
      for (const marker of parseMarkers(chunk.text)) {
        this.appendStep(uid, marker.step, marker.status, marker.detail)
        if (marker.status === 'fail') {
          this.ensure(uid).snapshot.failedStep = marker.step
          this.failTo(uid, 'FAILED')
          return 'FAILED'
        }
        const target = STEP_STATE[marker.step]
        if (target !== undefined && target !== 'READY') this.setState(uid, target)
        if (marker.step === 'ready') {
          this.setState(uid, 'HEALTHY')
          this.setState(uid, 'READY')
          return 'READY'
        }
      }
      const result = await this.jenkins.result(build)
      if (result !== undefined) {
        if (result !== 'SUCCESS' && result !== lastResult) {
          this.ensure(uid).snapshot.failedStep = 'jenkins-running'
          this.appendStep(uid, 'failed', 'fail', `build #${String(build)} ${result}`)
          this.failTo(uid, 'FAILED')
          return 'FAILED'
        }
        lastResult = result
      }
      await this.clock.sleep(this.config.health.pollMs)
    }
    this.failTo(uid, 'TIMEOUT')
    return 'TIMEOUT'
  }

  private failTo(uid: string, terminal: 'FAILED' | 'TIMEOUT'): void {
    const run = this.ensure(uid)
    // Failed edges can arrive from several states; rewrite outright rather than fight the edge table.
    run.snapshot = { ...run.snapshot, state: terminal }
    run.updatedMs = this.clock.now()
    this.emit(uid, this.stateEvent(uid))
  }

  private async waitForTerminal(uid: string): Promise<ServiceState> {
    const deadline = this.clock.now() + this.config.health.timeoutSec * 1000
    for (;;) {
      const state = this.run(uid).snapshot.state
      if (state === 'READY' || state === 'FAILED' || state === 'TIMEOUT' || state === 'HEALTHY') return state
      if (this.clock.now() > deadline) return state
      await this.clock.sleep(this.config.health.pollMs)
    }
  }

  /** Uids whose marker files name a build this restarted portal should re-attach to. */
  resumable(): string[] {
    const out: string[] = []
    for (const name of readdirSync(this.markerDir)) {
      const match = /^ide-([0-9]{1,8})\.json$/.exec(name)
      if (match?.[1] !== undefined) out.push(match[1])
    }
    return out
  }

  /** Re-run the failed action from reconciled state (FR8). */
  async retry(uid: string): Promise<ServiceState> {
    const reconcile = await this.reconcileOrFail(uid)
    if (reconcile === undefined) return 'FAILED'
    return await this.provision(uid, reconcile.kind === 'absent' ? 'create' : 'start')
  }

  /** Attach to the build the marker file names after a portal restart (N3); no-op when absent or finished. */
  async resume(uid: string): Promise<void> {
    const marker = this.markerPath(uid)
    if (!existsSync(marker)) return
    const recorded = JSON.parse(readFileSync(marker, 'utf8')) as { build: number; action: TriggerParams['action'] }
    if (recorded.action === 'probe') return
    const result = await this.jenkins.result(recorded.build)
    if (result !== undefined) return
    await this.drive(uid, recorded.build)
  }

  private markerPath(uid: string): string {
    return join(this.markerDir, `ide-${uid}.json`)
  }
}

/** Edge-table lookup shared with the state module's validator without re-import cycles. */
function transitionAllowed(from: ServiceState, to: ServiceState): boolean {
  const allowed: Readonly<Partial<Record<ServiceState, readonly ServiceState[]>>> = {
    NO_SERVICE: ['PROVISIONING', 'STARTING'],
    PROVISIONING: ['STARTING', 'FAILED'],
    STARTING: ['HEALTHY', 'TIMEOUT'],
    HEALTHY: ['READY', 'UNHEALTHY'],
    FAILED: ['PROVISIONING', 'STARTING'],
    TIMEOUT: ['STARTING'],
    UNHEALTHY: ['STARTING'],
  }
  return (allowed[from] ?? []).includes(to)
}
