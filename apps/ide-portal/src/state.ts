/**
 * Server-side state machine (0007 State machine) plus the append-only step
 * log the live page projects. State here is authoritative; the browser
 * renders exactly what this module has accepted.
 * @module
 */

import type { StepEvent } from './events.ts'

/** The per-user service states from 0007. IDLE is typed but unreachable in the first version (O4 parked). */
export type ServiceState =
  | 'NO_SERVICE'
  | 'PROVISIONING'
  | 'STARTING'
  | 'HEALTHY'
  | 'READY'
  | 'FAILED'
  | 'TIMEOUT'
  | 'IDLE'
  | 'UNHEALTHY'

/** The reconciled Docker/proxy observation the machine transitions from. */
export type Reconcile =
  | { kind: 'absent' }
  | { kind: 'exists'; running: boolean }
  | { kind: 'healthy' }

/** Edges accepted by the machine; anything else is a bug at the caller, asserted. */
const EDGES: Readonly<Record<ServiceState, readonly ServiceState[]>> = {
  NO_SERVICE: ['PROVISIONING', 'STARTING'],
  PROVISIONING: ['STARTING', 'FAILED'],
  STARTING: ['HEALTHY', 'TIMEOUT'],
  HEALTHY: ['READY', 'UNHEALTHY', 'IDLE'],
  READY: ['UNHEALTHY'],
  FAILED: ['PROVISIONING'],
  TIMEOUT: ['STARTING'],
  IDLE: ['STARTING'],
  UNHEALTHY: ['STARTING'],
}

/** One machine snapshot: the state plus the Jenkins build currently owned, if any. */
export interface MachineSnapshot {
  state: ServiceState
  /** Jenkins build number of the in-flight or last run, for marker attribution and console links. */
  build: number | undefined
  /** The failed or timed-out step name, kept for the retry affordance (FR8). */
  failedStep: string | undefined
}

/** Move the machine, rejecting an edge it does not own. */
export function advance(snapshot: MachineSnapshot, next: ServiceState): MachineSnapshot {
  if (!EDGES[snapshot.state].includes(next)) {
    throw new Error(`state machine: illegal edge ${snapshot.state} -> ${next}`)
  }
  return { ...snapshot, state: next, failedStep: next === 'FAILED' || next === 'TIMEOUT' ? snapshot.failedStep : undefined }
}

/** The shortest path from a fresh reconcile observation to the state a new entry starts in (FR6). */
export function stateFromReconcile(reconcile: Reconcile): ServiceState {
  switch (reconcile.kind) {
    case 'healthy': return 'HEALTHY'
    case 'exists': return 'STARTING'
    case 'absent': return 'NO_SERVICE'
  }
}

/** One user's tracked run: machine state plus its step log, keyed by uid upstream. */
export interface Run {
  snapshot: MachineSnapshot
  steps: StepEvent[]
  /** Monotonic step counter; survives the per-check step-log reset so replay dedup stays correct. */
  seq: number
  /** True while the arrival check is in flight (the page shows 检查中, not a stale banner). */
  checking: boolean
  /** Wall clock of the last state change, for display only. */
  updatedMs: number
}

/** A fresh run for a uid whose state has not been observed yet. */
export function freshRun(): Run {
  return {
    snapshot: { state: 'NO_SERVICE', build: undefined, failedStep: undefined },
    steps: [],
    seq: 0,
    checking: false,
    updatedMs: Date.now(),
  }
}
