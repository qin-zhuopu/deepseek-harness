/**
 * The identity provider's published configuration: the OIDC discovery
 * document (when reachable) plus the JWKS it points at. The IAM deployments
 * answer discovery at `<issuer>/.well-known/openid-configuration` and publish
 * their JWK set at `jwks_uri` (the Jereh IAM also answers a top-level
 * `openid-configuration.json` variant with the same fields). This module
 * fetches, caches for `refreshMinutes`, and keeps serving the last good
 * document when the provider is briefly unreachable.
 * @module @deepseek-ai/dsh-host-auth-iam/discovery
 */

import type { Jwk } from './id-token.ts'

/** The subset of the discovery document this package reads. */
export interface ProviderDocument {
  /** Canonical issuer URI; enforced as the id_token `iss`. */
  issuer: string
  /** Authorization endpoint the browser is sent to. */
  authorizationEndpoint: string
  /** Where the JWK set is published. */
  jwksUri: string
  /** End-session endpoint the document published, when it published one. */
  endSessionEndpoint: string | undefined
  /** The JWK set currently published at `jwksUri`. */
  keys: readonly Jwk[]
}

/**
 * Discovery-document candidates tried in order, relative to the configured
 * issuer: the RFC 8414 well-known path first, then the top-level variant
 * some deployments publish.
 * @param issuer - The configured provider issuer URI.
 * @returns Candidate discovery-document URLs, preferred first.
 */
export function discoveryCandidates(issuer: string): readonly string[] {
  const base = issuer.replace(/\/+$/, '')
  return [`${base}/.well-known/openid-configuration`, `${base}/openid-configuration.json`]
}

function parseDocument(raw: string): Omit<ProviderDocument, 'keys'> | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const record = parsed as Record<string, unknown>
  const read = (key: string): string | undefined => {
    const value = record[key]
    return typeof value === 'string' && value !== '' ? value : undefined
  }
  const issuer = read('issuer')
  const authorizationEndpoint = read('authorization_endpoint')
  const jwksUri = read('jwks_uri')
  if (issuer === undefined || authorizationEndpoint === undefined || jwksUri === undefined) return undefined
  return { issuer, authorizationEndpoint, jwksUri, endSessionEndpoint: read('end_session_endpoint') }
}

function parseKeys(raw: string): readonly Jwk[] | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  // A non-array or empty keys member yields no usable keys; getOnce treats
  // the empty set as a failed read.
  const keys = (parsed as Record<string, unknown>).keys
  return Array.isArray(keys)
    ? keys.filter((key): key is Jwk => typeof key === 'object' && key !== null && !Array.isArray(key)
      && typeof (key as Record<string, unknown>).kty === 'string')
    : []
}

/** Settings a provider source fetches under. */
export interface ProviderSourceSettings {
  /** Issuer URI whose well-known paths are probed. */
  issuer: string
  /** Cache lifetime before a read refetches. */
  refreshMinutes: number
  /** Per-request timeout for discovery and JWKS fetches. */
  timeoutMs: number
}

/** A cached provider document and its fetch time. */
interface CacheEntry {
  document: ProviderDocument
  fetchedAt: number
}

/**
 * Create the provider document + JWK set source: cached per settings window,
 * single-flight across concurrent readers, and sticky to the last good
 * document when the provider is briefly unreachable or answers garbage.
 * @param settings - issuer, refresh window, and fetch timeout.
 * @param fetchImpl - `fetch` implementation (injectable for tests).
 * @returns the read/invalidate interface used by the auth plugin.
 */
export function createProviderSource(
  settings: ProviderSourceSettings,
  fetchImpl: typeof globalThis.fetch,
): {
  /** Current document; refetches when absent or older than the refresh window. */
  get(): Promise<ProviderDocument | undefined>
  /** Drop the cache so the next read refetches (login failures use this). */
  invalidate(): void
} {
  let cached: CacheEntry | undefined
  let inflight: Promise<ProviderDocument | undefined> | undefined

  async function getText(url: string): Promise<string | undefined> {
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(settings.timeoutMs) })
      if (!response.ok) return undefined
      return await response.text()
    } catch {
      return undefined
    }
  }

  async function getOnce(): Promise<ProviderDocument | undefined> {
    let document: Omit<ProviderDocument, 'keys'> | undefined
    for (const candidate of discoveryCandidates(settings.issuer)) {
      const raw = await getText(candidate)
      if (raw === undefined) continue
      document = parseDocument(raw)
      if (document !== undefined) break
    }
    if (document === undefined) return undefined
    const keysRaw = await getText(document.jwksUri)
    const keys = keysRaw === undefined ? undefined : parseKeys(keysRaw)
    if (keys === undefined || keys.length === 0) return undefined
    return { ...document, keys }
  }

  return {
    get(): Promise<ProviderDocument | undefined> {
      if (cached !== undefined && Date.now() - cached.fetchedAt < settings.refreshMinutes * 60_000) {
        return Promise.resolve(cached.document)
      }
      if (inflight !== undefined) return inflight
      inflight = getOnce().then((fresh) => {
        inflight = undefined
        if (fresh !== undefined) cached = { document: fresh, fetchedAt: Date.now() }
        // Garbage or a brief outage must not lock the gate out: serve the
        // last good document so verification keeps working on known keys.
        return fresh ?? cached?.document
      })
      return inflight
    },
    invalidate(): void {
      // Expire freshness while keeping the last good document: a forced
      // re-read that fails must not strand the gate without keys.
      cached = cached === undefined ? undefined : { ...cached, fetchedAt: 0 }
    },
  }
}
