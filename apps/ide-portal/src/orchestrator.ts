/**
 * Per-user provisioning orchestrator (0008): owns the per-uid run state,
 * the single-flight lock, Jenkins trigger + console tail, and the append-only
 * step log the SSE stream replays. Marker files keep the last triggered
 * build across portal restarts; Docker host state stays the truth (N3).
 * @module
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { get as httpGet, type IncomingMessage } from 'node:http'
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

/** One direct HTTP GET against the IDE vhost; the status code, or undefined on any failure or timeout. */
export function probeUrl(url: URL, timeoutMs: number): Promise<number | undefined> {
  return new Promise((resolve) => {
    const request = httpGet(
      { hostname: url.hostname, port: url.port === '' ? 80 : Number(url.port), path: url.pathname || '/', headers: { host: url.host } },
      (res: IncomingMessage) => { res.resume(); resolve(res.statusCode) },
    )
    request.setTimeout(timeoutMs, () => { request.destroy(); resolve(undefined) })
    request.on('error', () => resolve(undefined))
  })
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

/** The final verdict line for a check result, in Chinese (the log is for business users). */
function verdictDetail(reconcile: Reconcile): string {
  return reconcile.kind === 'healthy' ? '专属IDE状态正常' : '未运行——点击「启动我的IDE」部署或启动'
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
  /** The direct vhost check used by reconcile; tests inject a scripted fake. */
  private readonly probe: (url: URL, timeoutMs: number) => Promise<number | undefined>

  constructor(
    config: PortalConfig,
    jenkins: JenkinsClient,
    markerDir: string,
    clock: Clock = realClock,
    probe: (url: URL, timeoutMs: number) => Promise<number | undefined> = probeUrl,
  ) {
    this.probe = probe
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
      this.appendStep(uid, '检查', 'fail', `自动检查没有完成,请点击「检查我的IDE」重试;多次失败请联系管理员。（原因：${error instanceof Error ? error.message : String(error)}）`)
    } finally {
      run.checking = false
      this.emit(uid, this.stateEvent(uid))
    }
  }

  /**
   * Check (requester decision, revised 2026-09-06): NO Jenkins build — the
   * portal fetches the IDE's own vhost; any answer below 500 (401/302 are
   * the login gate protecting a healthy service) reads as running, silence
   * or a proxy 5xx reads as not running. The absent/stopped distinction
   * does not matter to the user: 启动 converges both.
   */
  async reconcile(uid: string): Promise<Reconcile> {
    const run = this.ensure(uid)
    // TODO(requester, 2026-09-07): only a page refresh (GET /) should clear
    // the log; a button click (检查我的IDE via /api/check, 启动我的IDE via
    // /api/provision) must append to the existing steps instead. Today this
    // reset runs on every reconcile(), so /api/check also wipes prior log
    // lines. Needs a caller-supplied clear/append flag threaded from
    // server.ts through arrive()/reconcile(), plus updated tests for the
    // "check preserves prior log" case.
    run.steps = []
    this.appendStep(uid, '工号', 'info', uid)
    const url = ideUrl(this.config, uid)
    this.appendStep(uid, '域名', 'info', url)
    this.appendStep(uid, '检查', 'info', '正在检查服务…')
    const code = await this.probe(new URL(url), this.config.health.probeTimeoutMs)
    const healthy = code !== undefined && code < 500
    const reconcile: Reconcile = healthy ? { kind: 'healthy' } : { kind: 'notrunning' }
    if (healthy) {
      const gate = code === 401 || code === 302 ? '(登录保护正常)' : ''
      this.appendStep(uid, '服务状态', 'ok', `服务应答 HTTP ${String(code)}${gate}`)
    } else {
      this.appendStep(uid, '服务状态', 'fail', '服务无应答(未部署或已停止)')
    }
    run.snapshot = { state: stateFromReconcile(reconcile), build: undefined, failedStep: undefined }
    run.updatedMs = this.clock.now()
    this.appendStep(uid, '结论', healthy ? 'ok' : 'info', verdictDetail(reconcile))
    this.emit(uid, this.stateEvent(uid))
    return reconcile
  }

  /**
   * 启动我的IDE (requester decision, revised 2026-09-06): ALWAYS exactly one
   * build — the portal holds no host truth, so the create action converges
   * host-side (absent → create; stopped → start; running+answering → the
   * start is skipped and the probes confirm) and every case ends ready.
   * Idempotence lives in provision.sh, never in cached portal state.
   */
  async start(uid: string): Promise<ServiceState> {
    return await this.provision(uid, 'create')
  }

  /**
   * Drive one create/start run to READY, FAILED, or TIMEOUT under the
   * per-uid single-flight lock (FR7). Steps render in business language
   * (requester decision, 2026-09-06): 开始启动/部署/启动服务/启动后自检/
   * 外部访问检查/就绪; the state machine still consumes the raw marker names.
   */
  async provision(uid: string, action: 'create' | 'start'): Promise<ServiceState> {
    if (this.busy.has(uid)) {
      // Joiner view: wait for the owner's terminal signal instead of triggering a second build.
      return await this.waitForTerminal(uid)
    }
    this.busy.add(uid)
    try {
      this.appendStep(uid, '开始启动', 'info', '准备部署并启动你的 IDE…')
      this.setState(uid, action === 'create' ? 'PROVISIONING' : 'STARTING', { failedStep: undefined })
      const build = await this.trigger(uid, action)
      this.appendStep(uid, '排队', 'info', `启动任务已提交,等待执行…(构建 #${String(build)})`)
      const state = await this.drive(uid, build)
      return state
    } catch (error) {
      this.appendStep(uid, '启动失败', 'fail', error instanceof Error ? error.message : String(error))
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

  /**
   * The business-language rendering of one run marker (requester decision,
   * 2026-09-06): normal users read 部署/启动服务/启动后自检 — not
   * docker-run/probe-internal. Status passes through; failures stay failures.
   */
  private businessStep(marker: { step: StepName; status: 'ok' | 'fail' | 'info'; detail: string }): {
    step: string
    status: 'ok' | 'fail' | 'info'
    detail: string
  } {
    const code = /HTTP (\d+)/.exec(marker.detail)?.[1]
    switch (marker.step) {
      case 'image-pull':
        return marker.detail.includes('already')
          ? { step: '准备运行环境', status: 'info', detail: '运行环境已就绪,无需重新准备' }
          : { step: '准备运行环境', status: 'info', detail: '正在准备运行环境…' }
      case 'docker-run':
        if (marker.detail.includes('already exists')) return { step: '部署', status: 'info', detail: '此前已部署,跳过创建' }
        return marker.status === 'ok'
          ? { step: '部署', status: 'ok', detail: 'IDE 容器创建完成' }
          : { step: '部署', status: marker.status, detail: marker.detail }
      case 'start-hook':
        if (marker.detail.includes('skipping start')) return { step: '启动服务', status: 'info', detail: 'IDE 已在运行,无需启动' }
        return marker.status === 'ok'
          ? { step: '启动服务', status: 'info', detail: '服务启动中,健康检查随后进行…' }
          : { step: '启动服务', status: 'info', detail: '首次无响应,正在重试启动…' }
      case 'probe-internal':
        return marker.status === 'ok'
          ? { step: '启动后自检', status: 'ok', detail: `通过(HTTP ${code ?? '200'})` }
          : { step: '启动后自检', status: 'fail', detail: '未通过' }
      case 'probe-proxy':
        return marker.status === 'ok'
          ? { step: '外部访问检查', status: 'ok', detail: `通过(HTTP ${code ?? '200'}),外部可正常访问` }
          : { step: '外部访问检查', status: 'fail', detail: '未通过' }
      case 'ready':
        return { step: '就绪', status: 'ok', detail: 'IDE 已就绪,点击「进入我的IDE」进入。' }
      default:
        return marker
    }
  }

  /** Tail one build's console, translating markers into steps and state, until it finishes or the budget ends. */
  private async drive(uid: string, build: number): Promise<ServiceState> {
    this.appendStep(uid, '启动中', 'ok', '启动任务执行中…')
    const deadline = this.clock.now() + this.config.health.timeoutSec * 1000
    let cursor: ConsoleCursor = freshCursor()
    let lastResult = ''
    while (this.clock.now() < deadline) {
      const chunk = await this.jenkins.console(build, cursor.start)
      cursor = { start: chunk.size, more: chunk.more }
      for (const marker of parseMarkers(chunk.text)) {
        const business = this.businessStep(marker)
        this.appendStep(uid, business.step, business.status, business.detail)
        if (marker.status === 'fail') {
          this.ensure(uid).snapshot.failedStep = marker.step
          this.appendStep(uid, '启动失败', 'fail', '启动未完成,可再次点击「启动我的IDE」重试。')
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
          this.appendStep(uid, '启动失败', 'fail', `启动未完成(构建 #${String(build)} ${result}),可再次点击「启动我的IDE」重试。`)
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
