/**
 * Unit coverage for the provider source: candidate order, partial and
 * malformed documents, transport failure, single-flight, cache expiry,
 * invalidation, and the last-good-document rule, all through an injected
 * fetch implementation.
 */

import { describe, expect, it, vi } from 'vitest'
import { createProviderSource, discoveryCandidates } from '../src/discovery.ts'

const ISS = 'https://iam.example/idp'

function jsonResponse(body: unknown, ok = true): Response {
  return new Response(JSON.stringify(body), { status: ok ? 200 : 500 })
}

const DOCUMENT = {
  issuer: ISS,
  authorization_endpoint: `${ISS}/authCenter/authenticate`,
  jwks_uri: `${ISS}/oidc/getPublicKey`,
  end_session_endpoint: `${ISS}/oidc/revokeToken`,
}
const KEYS = { keys: [{ kty: 'RSA', alg: 'RS256', kid: 'RS256', n: 'abc', e: 'AQAB' }] }

function sourceFor(handler: (url: string) => Response, refreshMinutes = 60) {
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => handler(input instanceof Request ? input.url : String(input)))
  return { source: createProviderSource({ issuer: ISS, refreshMinutes, timeoutMs: 5_000 }, fetchImpl), fetchImpl }
}

describe('discoveryCandidates', () => {
  it('probes the well-known path first and tolerates a trailing slash on the issuer', () => {
    expect(discoveryCandidates(`${ISS}/`)).toEqual([
      `${ISS}/.well-known/openid-configuration`,
      `${ISS}/openid-configuration.json`,
    ])
  })
})

describe('createProviderSource', () => {
  it('reads the document and JWKS through the primary candidate', async () => {
    const { source, fetchImpl } = sourceFor(url => url === `${ISS}/.well-known/openid-configuration`
      ? jsonResponse(DOCUMENT)
      : jsonResponse(KEYS))
    const document = await source.get()
    expect(document).toMatchObject({ issuer: ISS, jwksUri: `${ISS}/oidc/getPublicKey`, endSessionEndpoint: `${ISS}/oidc/revokeToken` })
    expect(document?.keys).toHaveLength(1)
    // A second read is served from cache: still 2 fetches total.
    await source.get()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('falls through to the top-level JSON variant when well-known 404s', async () => {
    const { source } = sourceFor(url => url === `${ISS}/.well-known/openid-configuration`
      ? jsonResponse({}, false)
      : url === `${ISS}/openid-configuration.json` ? jsonResponse(DOCUMENT) : jsonResponse(KEYS))
    expect((await source.get())?.authorizationEndpoint).toBe(`${ISS}/authCenter/authenticate`)
  })

  it('survives garbage and partial documents on both candidates', async () => {
    for (const bad of ['not json', '[1,2]', '{"issuer":"x"}']) {
      const { source } = sourceFor(url => url.includes('getPublicKey') ? jsonResponse(KEYS) : new Response(bad))
      expect(await source.get()).toBeUndefined()
    }
  })

  it('refuses when the JWKS is unreachable, malformed, or empty', async () => {
    const fetches: Record<string, (url: string) => Response> = {
      down: url => url.includes('getPublicKey') ? jsonResponse({}, false) : jsonResponse(DOCUMENT),
      malformed: url => url.includes('getPublicKey') ? new Response('nope') : jsonResponse(DOCUMENT),
      notKeys: url => url.includes('getPublicKey') ? jsonResponse({ nope: 1 }) : jsonResponse(DOCUMENT),
      // Some providers answer a bare key array instead of { keys: [...] }.
      arrayBody: url => url.includes('getPublicKey') ? new Response('[{"kty":"RSA"}]') : jsonResponse(DOCUMENT),
      nullBody: url => url.includes('getPublicKey') ? new Response('null') : jsonResponse(DOCUMENT),
      noKty: url => url.includes('getPublicKey') ? jsonResponse({ keys: [{ alg: 'RS256' }, [1], 'x'] }) : jsonResponse(DOCUMENT),
      empty: url => url.includes('getPublicKey') ? jsonResponse({ keys: [] }) : jsonResponse(DOCUMENT),
    }
    for (const behavior of Object.values(fetches)) {
      expect(await sourceFor(behavior).source.get()).toBeUndefined()
    }
  })

  it('accepts a minimal document without end_session_endpoint', async () => {
    const minimal = { issuer: ISS, authorization_endpoint: `${ISS}/authCenter/authenticate`, jwks_uri: `${ISS}/oidc/getPublicKey` }
    const { source } = sourceFor(url => url.includes('getPublicKey') ? jsonResponse(KEYS) : jsonResponse(minimal))
    expect((await source.get())?.endSessionEndpoint).toBeUndefined()
  })

  it('invalidate on a source that never fetched stays undefined', async () => {
    const { source } = sourceFor(() => jsonResponse({}, false))
    source.invalidate()
    expect(await source.get()).toBeUndefined()
  })

  it('answers undefined when a fetch rejects outright', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('socket hang up')
    })
    const source = createProviderSource({ issuer: ISS, refreshMinutes: 60, timeoutMs: 5_000 }, fetchImpl)
    expect(await source.get()).toBeUndefined()
  })

  it('deduplicates concurrent readers into one fetch round', async () => {
    const { source, fetchImpl } = sourceFor(url => url.includes('getPublicKey') ? jsonResponse(KEYS) : jsonResponse(DOCUMENT))
    const both = await Promise.all([source.get(), source.get()])
    expect(both[0]).toBe(both[1])
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('keeps serving the last good document through an outage and refetches after invalidate or expiry', async () => {
    let serve = true
    const { source, fetchImpl } = sourceFor((url) => {
      if (!serve) return jsonResponse({}, false)
      return url.includes('getPublicKey') ? jsonResponse(KEYS) : jsonResponse(DOCUMENT)
    })
    const good = await source.get()
    expect(good).toBeDefined()
    const firstCalls = fetchImpl.mock.calls.length
    serve = false
    // invalidate forces a refetch; the failed round must return the cache.
    source.invalidate()
    expect(await source.get()).toBe(good)
    // An expired cache refetches too, and garbage never replaces the cache.
    // An expired cache (refreshMinutes 0) of a source that once succeeded
    // refetches, and the garbage round still answers the last good document.
    let up = true
    const flapping = sourceFor((url) => {
      if (!up) return jsonResponse({}, false)
      return url.includes('getPublicKey') ? jsonResponse(KEYS) : jsonResponse(DOCUMENT)
    }, 0)
    const first = await flapping.source.get()
    up = false
    expect(await flapping.source.get()).toBe(first)
    expect(flapping.fetchImpl.mock.calls.length).toBeGreaterThan(2)
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(firstCalls)
  })
})
