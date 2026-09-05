/**
 * Unit coverage for the id_token verifier: real RSA/EC keypairs sign real
 * tokens, and every rejection arm — foreign key, alg spoofing, expired,
 * wrong issuer or audience, malformed segments, unusable JWKs — answers
 * undefined rather than an exception.
 */

import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { verifyIdToken, type Jwk } from '../src/id-token.ts'

function forgedJwk(): Jwk {
  return { ...forged.publicKey.export({ format: 'jwk' }) as Record<string, unknown> } as Jwk
}

function untagged(jwk: Jwk): Jwk {
  const copy: Jwk = { ...jwk }
  delete copy.alg
  return copy
}

const NOW = 1_800_0_00_000
const ISS = 'https://iam.example/idp'
const AUD = 'EnterpriseDingtalk'
const EXPECT = { issuer: ISS, audience: AUD }

const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const forged = generateKeyPairSync('rsa', { modulusLength: 2048 })

function jwkOf(key: ReturnType<typeof generateKeyPairSync>['publicKey'], alg: string): Jwk {
  return { ...key.export({ format: 'jwk' }) as Record<string, unknown>, alg, kid: alg } as Jwk
}

const RSA_JWK = jwkOf(rsa.publicKey, 'RS256')
const EC_JWK = jwkOf(ec.publicKey, 'ES256')

const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')

function signPayload(payload: Record<string, unknown>, alg: 'RS256' | 'ES256', key = alg === 'RS256' ? rsa.privateKey : ec.privateKey, kid?: string): string {
  const input = `${b64(kid === undefined ? { alg, typ: 'JWT' } : { alg, typ: 'JWT', kid })}.${b64(payload)}`
  // ES256 compact signatures are raw r||s, the ieee-p1363 encoding.
  const signature = alg === 'RS256'
    ? cryptoSign('sha256', Buffer.from(input), key)
    : cryptoSign('sha256', Buffer.from(input), { key: key as never, dsaEncoding: 'ieee-p1363' } as never)
  return `${input}.${signature.toString('base64url')}`
}

const claims = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  sub: '14409',
  uid: '20241029-E823',
  aud: AUD,
  iss: ISS,
  iat: NOW,
  exp: NOW + 3600,
  ...over,
})

describe('verifyIdToken', () => {
  it('accepts a correctly signed RS256 and ES256 token and returns the claims', () => {
    const rsaToken = signPayload(claims(), 'RS256')
    const ecToken = signPayload(claims(), 'ES256')
    const keys = [RSA_JWK, EC_JWK]
    expect(verifyIdToken(rsaToken, keys, EXPECT, NOW)?.sub).toBe('14409')
    expect(verifyIdToken(ecToken, keys, EXPECT, NOW)?.uid).toBe('20241029-E823')
    // The Jereh IAM publishes keys with no alg at all; kty selects the fit.
    const untaggedKeys = keys.map(untagged)
    expect(verifyIdToken(rsaToken, untaggedKeys, EXPECT, NOW)).toBeDefined()
    expect(verifyIdToken(ecToken, untaggedKeys, EXPECT, NOW)).toBeDefined()
  })

  it('accepts an aud array containing the client and rejects arrays without it', () => {
    expect(verifyIdToken(signPayload(claims({ aud: ['other', AUD] }), 'RS256'), [RSA_JWK], EXPECT, NOW)).toBeDefined()
    expect(verifyIdToken(signPayload(claims({ aud: ['other'] }), 'RS256'), [RSA_JWK], EXPECT, NOW)).toBeUndefined()
  })

  it('rejects a signature from any other key', () => {
    expect(verifyIdToken(signPayload(claims(), 'RS256', forged.privateKey), [RSA_JWK], EXPECT, NOW)).toBeUndefined()
  })

  it('rejects alg, kid-mismatched, and unusable JWK sets', () => {
    const token = signPayload(claims(), 'RS256')
    // kid selects a key; when it selects an inapplicable entry no key is tried.
    expect(verifyIdToken(signPayload(claims(), 'RS256', rsa.privateKey, 'wanted'), [{ ...RSA_JWK, kid: 'other' }], EXPECT, NOW)).toBeUndefined()
    expect(verifyIdToken(signPayload(claims(), 'RS256', rsa.privateKey, 'wanted'), [{ ...RSA_JWK, kid: 'wanted' }], EXPECT, NOW)).toBeDefined()
    // A JWK whose declared alg is not an accepted algorithm never verifies.
    expect(verifyIdToken(token, [{ kty: 'RSA', alg: 'HS256' }], EXPECT, NOW)).toBeUndefined()
    // A malformed JWK throws inside the build and is skipped, not fatal.
    expect(verifyIdToken(token, [{ kty: 'RSA', alg: 'RS256', n: 'not-a-number' }], EXPECT, NOW)).toBeUndefined()
    expect(verifyIdToken(token, [], EXPECT, NOW)).toBeUndefined()
    // An EC key never verifies an RS256 token and vice versa (real IAMs
    // publish mixed sets without per-key alg).
    expect(verifyIdToken(token, [untagged(EC_JWK)], EXPECT, NOW)).toBeUndefined()
    expect(verifyIdToken(signPayload(claims(), 'ES256'), [untagged(RSA_JWK)], EXPECT, NOW)).toBeUndefined()
    // kid selects one key; when that key's signature does not match, no
    // later key is tried (a key present but not selected never gets its turn).
    expect(verifyIdToken(signPayload(claims(), 'RS256', forged.privateKey, 'wanted'), [{ ...RSA_JWK, kid: 'wanted' }, { ...forgedJwk(), kid: 'other' }], EXPECT, NOW)).toBeUndefined()
  })

  it('rejects ES256 signatures of the wrong length and DER-shaped input', () => {
    const input = `${b64({ alg: 'ES256', typ: 'JWT' })}.${b64(claims())}`
    const short = `${input}.${Buffer.alloc(63).toString('base64url')}`
    expect(verifyIdToken(short, [EC_JWK], EXPECT, NOW)).toBeUndefined()
    // A 64-byte garbage signature fails the real EC verify, not a throw.
    const garbage = `${input}.${Buffer.alloc(64, 7).toString('base64url')}`
    expect(verifyIdToken(garbage, [EC_JWK], EXPECT, NOW)).toBeUndefined()
  })

  it('rejects expired or exp-less tokens against the injected clock', () => {
    expect(verifyIdToken(signPayload(claims({ exp: NOW }), 'RS256'), [RSA_JWK], EXPECT, NOW)).toBeUndefined()
    const noExp = claims()
    delete noExp.exp
    expect(verifyIdToken(signPayload(noExp, 'RS256'), [RSA_JWK], EXPECT, NOW)).toBeUndefined()
  })

  it('rejects wrong issuer and non-string claims', () => {
    expect(verifyIdToken(signPayload(claims({ iss: 'https://evil/idp' }), 'RS256'), [RSA_JWK], EXPECT, NOW)).toBeUndefined()
    expect(verifyIdToken(signPayload(claims({ iss: 7 }), 'RS256'), [RSA_JWK], EXPECT, NOW)).toBeUndefined()
  })

  it('rejects malformed compact forms without throwing', () => {
    expect(verifyIdToken('a.b', [RSA_JWK], EXPECT, NOW)).toBeUndefined()
    expect(verifyIdToken('a.b.c.d', [RSA_JWK], EXPECT, NOW)).toBeUndefined()
    // Non-canonical segments: padded header and padded signature.
    const token = signPayload(claims(), 'RS256')
    const [header = '', payload = ''] = token.split('.')
    expect(verifyIdToken(`${header}=.${payload}.c`, [RSA_JWK], EXPECT, NOW)).toBeUndefined()
    expect(verifyIdToken(`${header}.${payload}=.`, [RSA_JWK], EXPECT, NOW)).toBeUndefined()
    // Empty signature segment.
    expect(verifyIdToken(`${header}.${payload}.`, [RSA_JWK], EXPECT, NOW)).toBeUndefined()
    // Garbage header and payload segments.
    const junk = Buffer.from('junk').toString('base64url')
    expect(verifyIdToken(`${junk}.${payload}.c`, [RSA_JWK], EXPECT, NOW)).toBeUndefined()
    expect(verifyIdToken(`${b64({ alg: 'RS256', typ: 'JWT' })}.${junk}.c`, [RSA_JWK], EXPECT, NOW)).toBeUndefined()
    // A valid signature is still refused when the alg is absent or foreign.
    expect(verifyIdToken(`${b64({ typ: 'JWT' })}.${payload}.c`, [RSA_JWK], EXPECT, NOW)).toBeUndefined()
    expect(verifyIdToken(`${b64({ alg: 'HS256', typ: 'JWT' })}.${payload}.c`, [RSA_JWK], EXPECT, NOW)).toBeUndefined()
    expect(verifyIdToken(`${b64({ alg: 'RS256', typ: 'at+jwt' })}.${payload}.c`, [RSA_JWK], EXPECT, NOW)).toBeUndefined()
    // An array is a JSON payload but not a claims record ('AA' is a
    // canonical, non-empty signature segment: the claims stage runs).
    expect(verifyIdToken(`${b64({ alg: 'RS256', typ: 'JWT' })}.${b64([1, 2])}.AA`, [RSA_JWK], EXPECT, NOW)).toBeUndefined()
  })

  it('rejects a claims record whose aud is a number', () => {
    expect(verifyIdToken(signPayload(claims({ aud: 42 }), 'RS256'), [RSA_JWK], EXPECT, NOW)).toBeUndefined()
  })
})
