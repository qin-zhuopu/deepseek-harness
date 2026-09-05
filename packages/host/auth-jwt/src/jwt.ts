/**
 * Compact HS256 JWT sign/verify over node:crypto — the token primitives the
 * auth guard runs on every request. Only the one algorithm this package
 * issues is accepted: an unexpected `alg` (including `none`) never verifies,
 * and every malformed token is a rejection, never an exception.
 * @module @deepseek-ai/dsh-host-auth-jwt/jwt
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

/** Claims a verified token carries; issuers may add fields, so unknown members stay visible. */
export interface JwtClaims {
  /** Subject the token was issued for. */
  sub?: string
  /** Issued-at, epoch seconds. */
  iat?: number
  /** Expiry, epoch seconds; a token at or past its `exp` never verifies. */
  exp?: number
  /** Additional issuer-defined claims. */
  [claim: string]: unknown
}

function base64url(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url')
}

/**
 * Strict base64url decode: Node's decoder is lenient (it ignores stray and
 * missing padding), so the re-encode must reproduce the segment exactly —
 * otherwise a mutated or re-padded segment would verify against the same
 * signature bytes.
 * @param segment - one compact-JWT segment.
 * @returns the decoded bytes, or undefined when the segment is not canonical base64url.
 */
function decodeSegment(segment: string): Buffer | undefined {
  const bytes = Buffer.from(segment, 'base64url')
  return bytes.toString('base64url') === segment ? bytes : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Sign one compact HS256 JWT over the JSON-serialized payload.
 * @param payload - claims to embed; values must be JSON-serializable.
 * @param secret - HMAC-SHA256 shared secret.
 * @returns the `header.payload.signature` compact form.
 */
export function signToken(payload: Record<string, unknown>, secret: string): string {
  const signingInput = `${base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${base64url(JSON.stringify(payload))}`
  const signature = createHmac('sha256', secret).update(signingInput).digest('base64url')
  return `${signingInput}.${signature}`
}

/**
 * Verify one compact JWT: exact three-segment form, canonical base64url
 * segments, `alg` fixed to HS256, constant-time signature compare, and a
 * numeric `exp` in the future when present.
 * @param token - the compact JWT as received.
 * @param secret - HMAC-SHA256 shared secret.
 * @param now - verification clock in epoch seconds.
 * @returns the claims, or undefined for any rejected token.
 */
export function verifyToken(token: string, secret: string, now: number): JwtClaims | undefined {
  const segments = token.split('.')
  if (segments.length !== 3) return undefined
  const [header, payload, signature] = segments as [string, string, string]
  const headerBytes = decodeSegment(header)
  if (headerBytes === undefined) return undefined
  let headerJson: unknown
  try {
    headerJson = JSON.parse(headerBytes.toString('utf8'))
  } catch {
    return undefined
  }
  if (!isRecord(headerJson) || headerJson.alg !== 'HS256' || headerJson.typ !== 'JWT') return undefined
  const provided = decodeSegment(signature)
  if (provided === undefined) return undefined
  const expected = createHmac('sha256', secret).update(`${header}.${payload}`).digest()
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return undefined
  const payloadBytes = decodeSegment(payload)
  if (payloadBytes === undefined) return undefined
  let claims: unknown
  try {
    claims = JSON.parse(payloadBytes.toString('utf8'))
  } catch {
    return undefined
  }
  if (!isRecord(claims)) return undefined
  if (typeof claims.exp === 'number' && claims.exp <= now) return undefined
  return claims
}
