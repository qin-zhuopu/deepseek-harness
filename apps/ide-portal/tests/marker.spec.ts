/**
 * The [DSH_STEP] marker protocol (0008): parse what the Jenkins job prints,
 * ignore what it does not, and refuse unknown step names.
 */

import { describe, expect, it } from 'vitest'
import { freshCursor, parseMarkers } from '../src/marker.ts'
import { isStepName, STEP_NAMES } from '../src/events.ts'

describe('parseMarkers', () => {
  it('parses a marker with a multi-word detail', () => {
    const [marker] = parseMarkers('[DSH_STEP] 7 probe-proxy ok 200 after 4 tries, 210s\n')
    expect(marker).toEqual({ seq: 7, step: 'probe-proxy', status: 'ok', detail: '200 after 4 tries, 210s' })
  })

  it('accepts a marker with empty detail', () => {
    const [marker] = parseMarkers('[DSH_STEP] 1 reconcile info')
    expect(marker?.detail).toBe('')
  })

  it('ignores plain console lines around markers', () => {
    const markers = parseMarkers('Started\n[DSH_STEP] 1 lock ok action=create\nSending request\n[DSH_STEP] 2 docker-run ok created\n')
    expect(markers.map(m => m.step)).toEqual(['lock', 'docker-run'])
  })

  it('refuses unknown step names and bad statuses', () => {
    expect(parseMarkers('[DSH_STEP] 1 not-a-step ok x')).toEqual([])
    expect(parseMarkers('[DSH_STEP] 1 lock maybe x')).toEqual([])
    expect(parseMarkers('[DSH_STEP] x lock ok y')).toEqual([])
  })

  it('keeps every marker of a chunk in order', () => {
    const chunk = STEP_NAMES.map((name, i) => `[DSH_STEP] ${String(i)} ${name} info`).join('\n')
    expect(parseMarkers(chunk).map(m => m.step)).toEqual([...STEP_NAMES])
  })

  it('freshCursor starts at byte zero with more data', () => {
    expect(freshCursor()).toEqual({ start: 0, more: true })
  })

  it('isStepName accepts only the canonical set', () => {
    expect(isStepName('probe-internal')).toBe(true)
    expect(isStepName('Probe-Internal')).toBe(false)
    expect(isStepName('')).toBe(false)
  })
})
