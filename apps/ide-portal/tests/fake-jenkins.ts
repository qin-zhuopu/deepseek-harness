/**
 * The test double for the ide-provision job: scripted marker scripts per
 * action, queue-to-build resolution, byte-offset progressive console, and a
 * result the driver reads. The orchestrator drives it exactly as it drives
 * the live JenkinsClient.
 */

import type { BuildResult, ConsoleChunk, JenkinsClient, TriggerParams } from '../src/jenkins.ts'

/** One scripted build: the console text it produces and the result it ends with. */
export interface ScriptedBuild {
  console: string
  result: BuildResult
}

/** The fake: trigger records, builds addressed by number, console byte cursor. */
export class FakeJenkins implements JenkinsClient {
  /** Every trigger call in order. */
  readonly triggered: TriggerParams[] = []
  /** Builds per action, consumed in order; each build gets the next script. */
  private readonly scripts = new Map<string, ScriptedBuild[]>()
  private readonly builds = new Map<number, ScriptedBuild>()
  private nextBuild = 100
  /** Queue latency in followQueue calls before the executable appears. */
  queueDelay = 0
  private queueFollows = 0
  /** The build number the queue currently points at, once assigned. */
  private assigned: number | undefined

  /** Script the builds of one action; each entry is consumed by the next trigger. */
  script(action: string, ...builds: ScriptedBuild[]): void {
    this.scripts.set(action, [...(this.scripts.get(action) ?? []), ...builds])
  }

  /** Place a build directly, simulating a build a restarted portal re-attaches to by number. */
  seed(build: number, scripted: ScriptedBuild): void {
    this.builds.set(build, scripted)
  }

  async trigger(params: TriggerParams): Promise<string> {
    this.triggered.push(params)
    const scripted = this.scripts.get(params.action)
    const build: ScriptedBuild = scripted !== undefined && scripted.length > 0
      ? (scripted.shift() as ScriptedBuild)
      : { console: '[DSH_STEP] 1 reconcile info absent\n', result: 'SUCCESS' }
    this.queueFollows = 0
    this.assigned = this.nextBuild++
    this.builds.set(this.assigned, build)
    return `/queue/item/${String(this.assigned)}/`
  }

  async followQueue(): Promise<number | undefined> {
    this.queueFollows += 1
    return this.queueFollows > this.queueDelay ? this.assigned : undefined
  }

  async console(build: number, start: number): Promise<ConsoleChunk> {
    const scripted = this.builds.get(build)
    if (scripted === undefined) throw new Error(`no build ${String(build)}`)
    const bytes = Buffer.byteLength(scripted.console)
    const text = scripted.console.slice(start)
    return { text, more: false, size: bytes }
  }

  async result(build: number): Promise<BuildResult> {
    return this.builds.get(build)?.result
  }
}
