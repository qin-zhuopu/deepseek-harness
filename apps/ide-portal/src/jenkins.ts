/**
 * Jenkins executor client (0008 Jenkins executor): trigger with masked
 * parameters, follow the queue item to its build, tail the progressive
 * console, and read the final result. Basic auth over an API-token user; the
 * host SSH credential never passes through here (SR3).
 * @module
 */

import type { JenkinsConfig } from './config.ts'

/**
 * Parameters of one job run; the model key is no longer among them — the
 * create-stage build binds the Jenkins `ide-model-key` credential itself
 * (FR10, SR5).
 */
export interface TriggerParams {
  uid: string
  action: 'create' | 'start' | 'probe' | 'stop'
  imageTag: string
  requestId: string
}

/** Final Jenkins result of a finished build, or undefined while it runs. */
export type BuildResult = 'SUCCESS' | 'FAILURE' | 'ABORTED' | 'UNSTABLE' | undefined

/** One progressive-console read. */
export interface ConsoleChunk {
  text: string
  /** True while Jenkins has more bytes to serve for this build. */
  more: boolean
  /** Byte size to request next. */
  size: number
}

/** The job-facing surface, injectable in tests. */
export interface JenkinsClient {
  /** Queue-item path of the triggered build (`queue/item/<n>/`). */
  trigger(params: TriggerParams): Promise<string>
  /** Follow a queue item to its executable build number; undefined while still queued. */
  followQueue(itemPath: string): Promise<number | undefined>
  /** Read console bytes from `start`. */
  console(build: number, start: number): Promise<ConsoleChunk>
  /** Build result; undefined while building. */
  result(build: number): Promise<BuildResult>
}

/** Build the live client over the configured Jenkins root. */
export function createJenkinsClient(config: JenkinsConfig, fetchImpl: typeof globalThis.fetch = globalThis.fetch): JenkinsClient {
  const auth = () => Buffer.from(`${config.user}:${process.env[config.tokenEnv] ?? ''}`).toString('base64')
  async function request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers)
    headers.set('authorization', `Basic ${auth()}`)
    return await fetchImpl(`${config.url}${path}`, { ...init, headers })
  }
  return {
    async trigger(params) {
      const form = new URLSearchParams({ UID: params.uid, ACTION: params.action, IMAGE_TAG: params.imageTag, REQUEST_ID: params.requestId })
      const res = await request(`/job/${config.job}/buildWithParameters`, { method: 'POST', body: form })
      const location = res.headers.get('location')
      if (!res.ok || location === null) throw new Error(`jenkins: trigger ${params.action} for ${params.uid} failed with ${String(res.status)}`)
      return location
    },
    async followQueue(itemPath) {
      const res = await request(itemPath.replace(/\/+$/, '') + '/api/json')
      if (!res.ok) return undefined
      const item = (await res.json()) as { executable?: { number?: number } }
      return typeof item.executable?.number === 'number' ? item.executable.number : undefined
    },
    async console(build, start) {
      const res = await request(`/job/${config.job}/${String(build)}/consoleText?start=${String(start)}`)
      if (!res.ok) throw new Error(`jenkins: console read of #${String(build)} failed with ${String(res.status)}`)
      const text = await res.text()
      const size = Number(res.headers.get('x-text-size') ?? String(start + text.length))
      const more = res.headers.get('x-more-data') === 'true'
      return { text, more, size }
    },
    async result(build) {
      const res = await request(`/job/${config.job}/${String(build)}/api/json`)
      if (!res.ok) return undefined
      const info = (await res.json()) as { building?: boolean; result?: BuildResult }
      return info.building === true ? undefined : info.result
    },
  }
}
