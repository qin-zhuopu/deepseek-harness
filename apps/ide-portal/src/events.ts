/**
 * The live-log wire format (0008 Live log): SSE payloads are append-only JSON
 * objects — `state` snapshots and numbered `step` lines. The page consumes
 * both unchanged, so the shapes belong here, shared by backend and frontend.
 * @module
 */

import type { MachineSnapshot } from './state.ts'

/** A step line as it streams; `seq` is monotonic per run and replay is idempotent on it. */
export interface StepEvent {
  type: 'step'
  seq: number
  /** One of the fixed step names; unknown names are a bug, not a display fallback. */
  /** Step name as displayed: canonical run steps and the check chain's labels. */
  step: string
  status: 'ok' | 'fail' | 'info'
  detail: string
  /** Epoch millis the backend observed the step at. */
  atMs: number
}

/** The named steps of one run, in canonical order (0008 Live log). */
export const STEP_NAMES = [
  'service',
  'compose',
  'health',
  'reconcile',
  'lock',
  'jenkins-queued',
  'jenkins-running',
  'image-pull',
  'docker-run',
  'start-hook',
  'probe-internal',
  'probe-proxy',
  'ready',
  'failed',
] as const

export type StepName = (typeof STEP_NAMES)[number]

/** Type guard for a step name arriving from a Jenkins marker. */
export function isStepName(value: string): value is StepName {
  return (STEP_NAMES as readonly string[]).includes(value)
}

/** The current projection of the machine, sent on every state change and on SSE (re)connect. */
export interface StateEvent {
  type: 'state'
  state: MachineSnapshot['state']
  /** True while the arrival check runs; the page shows 检查中 instead of the stale banner. */
  checking: boolean
  /** Absolute IDE url once the run reaches READY; undefined before. */
  ideUrl: string | undefined
  /** Jenkins build owned by this run, for the console link (FR8). */
  build: number | undefined
}

/** Anything the SSE stream carries. */
export type LiveEvent = StateEvent | StepEvent
