/**
 * Compact-JWT verification against an identity provider's JWKS: the id_token
 * arrives base64url-segmented and RS256/ES256-signed, and the provider
 * publishes its public keys as a JWK set. `verifyIdToken` checks the
 * signature with `node:crypto` (keys built from JWK material, `null` algorithm
 * refused by construction) and then the claims that bind the token to this
 * deployment (`iss`, `aud`, `exp`).
 * @module @deepseek-ai/dsh-host-auth-iam/id-token
 */

import { createPublicKey, verify as cryptoVerify, type JsonWebKeyInput } from 'node:crypto'
import { decodeBase64Url, decodeBase64UrlJson } from '@deepseek-ai/dsh-host-auth-core'

/** Claims this package reads off a verified id_token. */
export interface IdTokenClaims {
  /** Subject identifier (the employee number in the Jereh IAM). */
  sub: string
  /** Issuer URI; must equal the discovery document's issuer. */
  iss: string
  /** Audience client id; must contain the configured client. */
  aud: string | string[]
  /** Expiry (seconds since epoch); a numeric value at or before now is rejected. */
  exp: number
  /** Issued-at (seconds since epoch), informational. */
  iat?: number
  /** Stable user id beyond `sub`, when the provider sends one. */
  uid?: string
}

/** One JWK entry of a discovery-published JWKS. */
export interface Jwk {
  kty: string
  kid?: string
  alg?: string
  [key: string]: unknown
}

/**
 * Accepted signing algorithms paired with the JWK type each requires. The
 * JWK carries no `alg` at the Jereh IAM, so the algorithm set is protocol
 * here, not a tunable; key type and algorithm must agree.
 */
const ALGORITHMS: readonly [alg: string, kty: string][] = [['RS256', 'RSA'], ['ES256', 'EC']]

function acceptsAlg(jwk: Jwk): boolean {
  return jwk.alg === undefined || ALGORITHMS.some(([alg]) => alg === jwk.alg)
}

function keyMatches(jwk: Jwk, alg: string): boolean {
  return ALGORITHMS.some(([candidate, kty]) => candidate === alg && jwk.kty === kty)
}

function buildKey(jwk: Jwk): ReturnType<typeof createPublicKey> | undefined {
  try {
    return createPublicKey({ key: { ...jwk } as JsonWebKeyInput['key'], format: 'jwk' })
  } catch {
    return undefined
  }
}

function signatureMatches(alg: string, key: ReturnType<typeof createPublicKey>, signed: string, signature: Buffer): boolean {
  if (alg === 'RS256') return cryptoVerify('sha256', Buffer.from(signed), key, signature)
  // ES256 signatures arrive as raw r||s (64 bytes); node:crypto expects DER.
  // Malformed scalars make crypto.verify answer false, never throw.
  if (signature.length !== 64) return false
  return cryptoVerify('sha256', Buffer.from(signed), { key, dsaEncoding: 'ieee-p1363' } as never, signature)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Verify a compact id_token against a JWK set and this deployment's issuer
 * and audience. Never throws: every malformed input answers `undefined`.
 * @param token - the compact JWT as presented.
 * @param keys - the provider's published JWK set.
 * @param expect - `{ issuer, audience }` values to enforce.
 * @param now - current epoch seconds (injectable for tests).
 * @returns the verified claims, or undefined for any rejection.
 */
export function verifyIdToken(
  token: string,
  keys: readonly Jwk[],
  expect: { issuer: string; audience: string },
  now: number,
): IdTokenClaims | undefined {
  const segments = token.split('.')
  if (segments.length !== 3) return undefined
  const [headerSegment = '', payloadSegment = '', signatureSegment = ''] = segments

  const header = decodeBase64UrlJson(headerSegment)
  if (!isRecord(header) || typeof header.alg !== 'string') return undefined
  const { alg } = header
  if (!ALGORITHMS.some(([candidate]) => candidate === alg)) return undefined
  if (header.typ !== undefined && header.typ !== 'JWT') return undefined

  const signature = decodeBase64Url(signatureSegment)
  if (signature === undefined || signature.length === 0) return undefined

  const claims = decodeBase64UrlJson(payloadSegment)
  // A verified signature binds the payload, but its claim values are the
  // provider's data: every claim read is type-checked before use.
  if (!isRecord(claims)) return undefined
  if (typeof claims.exp !== 'number' || claims.exp <= now) return undefined
  if (claims.iss !== expect.issuer) return undefined
  const aud = claims.aud
  const audienceOk = typeof aud === 'string'
    ? aud === expect.audience
    : Array.isArray(aud) && aud.includes(expect.audience)
  if (!audienceOk) return undefined

  // kid selects one key when both algorithms are published; otherwise the
  // signature check across accepted keys is the discriminator (the payload
  // and header are already bound by the signed input).
  const kid = typeof header.kid === 'string' ? header.kid : undefined
  for (const jwk of keys) {
    if (kid !== undefined && jwk.kid !== kid) continue
    if (!keyMatches(jwk, alg) || !acceptsAlg(jwk)) continue
    const key = buildKey(jwk)
    if (key === undefined) continue
    if (!signatureMatches(alg, key, `${headerSegment}.${payloadSegment}`, signature)) continue
    return claims as unknown as IdTokenClaims
  }
  return undefined
}
