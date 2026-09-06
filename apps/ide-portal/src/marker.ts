/**
 * The Jenkins progress channel (0008): the ide-provision job prints one
 * `[DSH_STEP] <seq> <step> <status> <detail...>` marker per step and the
 * portal parses them out of the progressive console text, tolerating the
 * interleaved plain log lines around them.
 * @module
 */

import { isStepName, type StepName } from './events.ts'

/** One parsed marker line. */
export interface Marker {
  seq: number
  step: StepName
  status: 'ok' | 'fail' | 'info'
  detail: string
}

// Live Jenkins (timestamps plugin) prefixes every console line with
// `[<ISO instant>] ` before the script's own text, so the marker tag may
// start anywhere in the line; the bracketed `[DSH_STEP]` itself is the anchor.
const MARKER = /\[DSH_STEP\]\s+(\d+)\s+(\S+)\s+(ok|fail|info)\s*(.*)$/

/** Parse every marker out of a console chunk; non-marker lines are ignored. Incomplete trailing lines belong to the next chunk's caller. */
export function parseMarkers(chunk: string): Marker[] {
  const out: Marker[] = []
  for (const line of chunk.split('\n')) {
    const match = MARKER.exec(line.trim())
    if (match === null) continue
    const [, seq, step, status, detail = ''] = match
    if (step === undefined || seq === undefined || status === undefined) continue
    if (!isStepName(step)) continue
    out.push({ seq: Number(seq), step, status: status as Marker['status'], detail })
  }
  return out
}

/** A byte-safe progressive-tail cursor: Jenkins serves `?start=<byteoffset>` and replies `X-Text-Size` plus `X-More-Data`. */
export interface ConsoleCursor {
  start: number
  more: boolean
}

/** The initial cursor: read from byte zero. */
export function freshCursor(): ConsoleCursor {
  return { start: 0, more: true }
}
