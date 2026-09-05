/**
 * State machine edges (0007): legal moves advance, illegal moves throw, and
 * a fresh reconcile picks the shortest entry state (FR6).
 */

import { describe, expect, it } from 'vitest'
import { advance, freshRun, stateFromReconcile } from '../src/state.ts'

describe('advance', () => {
  it('walks the cold path NO_SERVICE -> READY', () => {
    let snapshot = freshRun().snapshot
    for (const next of ['PROVISIONING', 'STARTING', 'HEALTHY', 'READY'] as const) snapshot = advance(snapshot, next)
    expect(snapshot.state).toBe('READY')
  })

  it('rejects skipping PROVISIONING', () => {
    expect(() => advance(freshRun().snapshot, 'HEALTHY')).toThrow(/NO_SERVICE -> HEALTHY/)
  })

  it('keeps failedStep only on failure terminals', () => {
    const failed = advance({ state: 'STARTING', build: 3, failedStep: 'probe-internal' }, 'TIMEOUT')
    expect(failed.failedStep).toBe('probe-internal')
    const retried = advance(failed, 'STARTING')
    expect(retried.failedStep).toBeUndefined()
  })

  it('allows the failure loop back through PROVISIONING', () => {
    const failed = advance({ state: 'PROVISIONING', build: 1, failedStep: undefined }, 'FAILED')
    expect(advance(failed, 'PROVISIONING').state).toBe('PROVISIONING')
  })
})

describe('stateFromReconcile (FR6)', () => {
  it('maps probe verdicts to shortest-path states', () => {
    expect(stateFromReconcile({ kind: 'healthy' })).toBe('HEALTHY')
    expect(stateFromReconcile({ kind: 'exists', running: false })).toBe('STARTING')
    expect(stateFromReconcile({ kind: 'exists', running: true })).toBe('STARTING')
    expect(stateFromReconcile({ kind: 'absent' })).toBe('NO_SERVICE')
  })
})
