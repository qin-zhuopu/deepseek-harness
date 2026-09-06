/**
 * The offline trust file (`trustFile`): the provider's two published documents
 * — the OIDC discovery document and the JWKS — captured once from a network
 * that reaches the IAM and seeded where the gated server cannot. Loading is a
 * boot-time refuse: unreadable, malformed, or keyless files, and a file whose
 * issuer disagrees with the configured one, keep the gate from mounting.
 * @module @deepseek-ai/dsh-host-auth-iam/trust
 */

import { readFileSync } from 'node:fs'

import type { ProviderDocument } from './discovery.ts'
import type { Jwk } from './id-token.ts'

/** The JSON an operator seeds: `{"discovery": <document>, "jwks": {"keys": [...]}}`. */
interface TrustFile {
  discovery: Record<string, unknown>
  jwks: { keys: unknown }
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

function parseTrustFile(path: string, raw: string): TrustFile {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch (error) {
    throw new Error(`auth-iam: trustFile ${path} is not readable JSON: ${String(error instanceof Error ? error.message : error)}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`auth-iam: trustFile ${path} must be a JSON object with "discovery" and "jwks"`)
  }
  const record = parsed as Record<string, unknown>
  const discovery = record['discovery']
  const jwks = record['jwks']
  if (typeof discovery !== 'object' || discovery === null || Array.isArray(discovery)) {
    throw new Error(`auth-iam: trustFile ${path} must carry the discovery document under "discovery"`)
  }
  if (typeof jwks !== 'object' || jwks === null || Array.isArray(jwks)) {
    throw new Error(`auth-iam: trustFile ${path} must carry the JWK set document under "jwks"`)
  }
  return { discovery: discovery as Record<string, unknown>, jwks: jwks as { keys: unknown } }
}

/**
 * Read and validate the offline trust file.
 * @param path - The configured `trustFile`; raw JSON of the two provider documents.
 * @param configuredIssuer - The configured issuer; the file must agree with it.
 * @returns The provider document, keys included, to serve without any fetch.
 * @throws When the file is unreadable, malformed, keyless, or names a different issuer.
 */
export function loadTrustFile(path: string, configuredIssuer: string): ProviderDocument {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    throw new Error(`auth-iam: trustFile ${path} is not readable: ${String(error instanceof Error ? error.message : error)}`)
  }
  const { discovery, jwks } = parseTrustFile(path, raw)
  const issuer = readString(discovery, 'issuer')
  const authorizationEndpoint = readString(discovery, 'authorization_endpoint')
  const jwksUri = readString(discovery, 'jwks_uri')
  if (issuer === undefined || authorizationEndpoint === undefined || jwksUri === undefined) {
    throw new Error(`auth-iam: trustFile ${path} discovery must carry issuer, authorization_endpoint, and jwks_uri`)
  }
  if (issuer.replace(/\/+$/, '') !== configuredIssuer) {
    throw new Error(`auth-iam: trustFile ${path} issuer "${String(issuer)}" disagrees with the configured issuer "${configuredIssuer}"`)
  }
  const keys = Array.isArray(jwks.keys)
    ? jwks.keys.filter((item): item is Jwk => typeof item === 'object' && item !== null && !Array.isArray(item)
      && typeof (item as Record<string, unknown>).kty === 'string')
    : []
  if (keys.length === 0) throw new Error(`auth-iam: trustFile ${path} carries no usable JWKS keys (each needs "kty")`)
  return {
    issuer,
    authorizationEndpoint,
    jwksUri,
    endSessionEndpoint: readString(discovery, 'end_session_endpoint'),
    keys,
  }
}
