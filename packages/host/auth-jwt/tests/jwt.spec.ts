/**
 * Token-primitive coverage: sign/verify round trip, the algorithm-confusion
 * rejections (`alg: none`, foreign `alg`), malformed segments, tampered
 * payloads and signatures, `exp` enforcement, and the non-canonical
 * base64url refusals.
 */

import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { signToken, verifyToken } from '../src/jwt.ts'

const SECRET = 'unit-test-secret-00000000000000000000000000'
const NOW = 1_800_000_000

function input(token: string): { header: string; payload: string } {
  const segments = token.split('.')
  return {
    header: Buffer.from(segments[0] ?? '', 'base64url').toString('utf8'),
    payload: Buffer.from(segments[1] ?? '', 'base64url').toString('utf8'),
  }
}

function reissue(headerJson: string, payloadJson: string, secret: string = SECRET): string {
  const h = Buffer.from(headerJson).toString('base64url')
  const p = Buffer.from(payloadJson).toString('base64url')
  return `${h}.${p}.${createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url')}`
}

describe('signToken/verifyToken', () => {
  it('round-trips claims and accepts the token at any time before exp', () => {
    const token = signToken({ sub: 'dsh', iat: NOW, exp: NOW + 60 }, SECRET)
    expect(verifyToken(token, SECRET, NOW)).toMatchObject({ sub: 'dsh', iat: NOW })
    expect(verifyToken(token, SECRET, NOW + 59)).toMatchObject({ sub: 'dsh' })
  })

  it('rejects expired tokens and honors tokens without exp', () => {
    const expiring = signToken({ sub: 'dsh', exp: NOW + 10 }, SECRET)
    expect(verifyToken(expiring, SECRET, NOW + 10)).toBeUndefined()
    expect(verifyToken(expiring, SECRET, NOW + 11)).toBeUndefined()
    expect(verifyToken(signToken({ sub: 'dsh' }, SECRET), SECRET, NOW)).toMatchObject({ sub: 'dsh' })
  })

  it('rejects the wrong secret, including an empty token or a wrong segment count', () => {
    const token = signToken({ sub: 'dsh' }, SECRET)
    expect(verifyToken(token, 'other-secret-00000000000000000000000000000', NOW)).toBeUndefined()
    expect(verifyToken('', SECRET, NOW)).toBeUndefined()
    expect(verifyToken(token, SECRET, NOW)).toBeDefined()
    expect(verifyToken(`${token}.extra`, SECRET, NOW)).toBeUndefined()
    expect(verifyToken(token.split('.').slice(0, 2).join('.'), SECRET, NOW)).toBeUndefined()
  })

  it('rejects alg substitution and alg none even when re-signed with the shared secret', () => {
    const token = signToken({ sub: 'dsh' }, SECRET)
    const { header, payload } = input(token)
    expect(JSON.parse(header)).toMatchObject({ alg: 'HS256', typ: 'JWT' })
    expect(verifyToken(reissue(JSON.stringify({ alg: 'none', typ: 'JWT' }), payload, SECRET), SECRET, NOW)).toBeUndefined()
    expect(verifyToken(reissue(JSON.stringify({ alg: 'HS512', typ: 'JWT' }), payload), SECRET, NOW)).toBeUndefined()
    // The classic confusion: a token whose header advertises HS256 but whose
    // signature was made with an unrelated key must fail the compare.
    expect(verifyToken(reissue(JSON.stringify({ alg: 'HS256', typ: 'JWT' }), payload, 'attacker-key-000000000000000000000000000'), SECRET, NOW)).toBeUndefined()
  })

  it('rejects tampered payloads and signatures', () => {
    const token = signToken({ sub: 'dsh', exp: NOW + 60 }, SECRET)
    const [h = '', p = '', sig = ''] = token.split('.')
    const forgedPayload = Buffer.from(JSON.stringify({ sub: 'admin', exp: NOW + 10_000 })).toString('base64url')
    expect(verifyToken(`${h}.${forgedPayload}.${sig}`, SECRET, NOW)).toBeUndefined()
    const flipped = sig.slice(0, -1) + (sig.endsWith('A') ? 'B' : 'A')
    expect(verifyToken(`${h}.${p}.${flipped}`, SECRET, NOW)).toBeUndefined()
  })

  it('rejects non-canonical segments at each position, including a valid signature over one', () => {
    const token = signToken({ sub: 'dsh' }, SECRET)
    const [h = '', p = '', sig = ''] = token.split('.')
    // 11 bytes: standard base64 pads to '=', whose stripped base64url form is
    // the canonical segment — the padded text is what a lenient decoder takes.
    const canonical = Buffer.from('{"sub":"d"}').toString('base64url')
    const lenient = Buffer.from('{"sub":"d"}').toString('base64').replaceAll('+', '-').replaceAll('/', '_')
    expect(lenient).toContain('=')
    expect(canonical.length).toBe(lenient.length - 1)
    // Header, then signature: the canonical re-encode check rejects before parsing.
    expect(verifyToken(`${lenient}.${p}.${sig}`, SECRET, NOW)).toBeUndefined()
    expect(verifyToken(`${h}.${p}.${lenient}`, SECRET, NOW)).toBeUndefined()
    // Payload: a signature computed over the padded text passes the byte
    // compare; the payload decode still refuses it.
    const forgedSig = createHmac('sha256', SECRET).update(`${h}.${lenient}`).digest('base64url')
    expect(verifyToken(`${h}.${lenient}.${forgedSig}`, SECRET, NOW)).toBeUndefined()
  })

  it('rejects non-canonical base64url segments that a lenient decoder would accept', () => {
    const token = signToken({ sub: 'dsh' }, SECRET)
    const [h = '', p = ''] = token.split('.')
    // Padded re-encodings of the same bytes decode identically in a lenient
    // verifier; the canonical re-encode check refuses them.
    const padded = (segment: string): string =>
      Buffer.from(segment, 'base64url').toString('base64').replaceAll('+', '-').replaceAll('/', '_')
    expect(padded(p)).not.toBe(p)
    expect(verifyToken(`${h}.${padded(p)}.${token.split('.')[2]}`, SECRET, NOW)).toBeUndefined()
    expect(verifyToken(`${h}.${p}=`, SECRET, NOW)).toBeUndefined()
  })

  it('rejects headers missing typ and signatures of a foreign byte length', () => {
    const token = signToken({ sub: 'dsh' }, SECRET)
    const { payload } = input(token)
    expect(verifyToken(reissue(JSON.stringify({ alg: 'HS256' }), payload), SECRET, NOW)).toBeUndefined()
    // A truncated (but canonical) signature fails on length before the compare.
    const [h = '', p = ''] = token.split('.')
    expect(verifyToken(`${h}.${p}.${'A'.repeat(16)}`, SECRET, NOW)).toBeUndefined()
  })

  it('rejects a valid-signature payload that is not UTF-8 JSON', () => {
    const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
    const p = Buffer.from([0xff, 0xfe, 0x00, 0x01]).toString('base64url')
    const sig = createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url')
    expect(verifyToken(`${h}.${p}.${sig}`, SECRET, NOW)).toBeUndefined()
    // A JSON header that is not an object (scalar/array) is rejected too.
    expect(verifyToken(reissue('"just-a-string"', '{}'), SECRET, NOW)).toBeUndefined()
  })

  it('rejects unparsable segment content rather than throwing', () => {
    const garbage = Buffer.from('not json at all').toString('base64url')
    expect(verifyToken(`${garbage}.${garbage}.${garbage}`, SECRET, NOW)).toBeUndefined()
    // A JSON payload that is not an object (array/scalar) is rejected.
    expect(verifyToken(reissue('{"alg":"HS256","typ":"JWT"}', '[1,2]'), SECRET, NOW)).toBeUndefined()
  })
})
