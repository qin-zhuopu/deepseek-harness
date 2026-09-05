# `@deepseek-ai/dsh-host-auth-iam`

English | [中文](README.zh.md)

Enterprise OIDC gate for the Web server: a function plugin (`name`/`inject`/`Config`/`apply`, requires `webServer`). While its fiber is mounted, every named HTTP route, the fallback (SPA dist) surface, and every WebSocket upgrade requires a provider-signed `id_token`; unauthenticated requests never reach a route handler. The row is opt-in: with no `auth-iam` row (or the row disabled) the server stays exactly as unauthenticated as before, and disposing the fiber restores the open surface (HMR-safe). The guard, cookie, and challenge mechanics are shared with [`dsh-host-auth-jwt`](../auth-jwt/README.md) through [`dsh-host-auth-core`](../auth-core/README.md) — the two gates mount the same surface and can coexist or be chosen per deployment.

Sign-in is the OAuth2 implicit flow the Jereh IAM (`iam.jereh.cn` / `iam-test.jereh.cn`) speaks: `GET /login` (config `loginPath`) redirects the browser to the provider's `authorization_endpoint` with `response_type=token&scope=openid&client_id=…&redirect_uri=…&state=…` and a `HttpOnly` state cookie. The provider authenticates the user (the `usk` session cookie at the IAM is its business) and returns to the exact `redirectPath` (default `/auth/callback`) with the tokens in the URL **fragment** — fragments never reach the server, so the callback page is a one-line same-origin script that moves the fragment into a `POST` to the same path. The callback verifies the `state` (a cross-site POST cannot carry the HttpOnly state cookie, so a foreign or absent state refuses: session-fixation protection), verifies the `id_token` signature against the provider's published **JWKS** (RS256 and ES256 keys, `alg` taken from the JWK; the token's own `alg: none` or `HS256` never verifies), enforces `aud` equals `clientId` and `iss` equals the discovery document's `issuer`, enforces `exp`, then sets the `id_token` itself as the `HttpOnly` `SameSite=Lax` session cookie (`dsh_token` by default; plus `Secure` under `secureCookie`) and answers the JSON the page turns into `location.replace(next)`. From then on `fetch`, `EventSource`, and same-origin `WebSocket` carry the cookie without client code — the guarded GUI works with the stock client bundle — and `Authorization: Bearer <id_token>` works for clients that can set headers.

Discovery reads `<issuer>/.well-known/openid-configuration` first and the top-level `openid-configuration.json` variant second, caches the document plus JWKS for `refreshMinutes` (default 60), serves the last good document while the provider is briefly unreachable, and forces one fresh read after a verification failure so a JWK rotation lands within one window. Guard-time verification is synchronous against the cached document: before the first successful fetch every request is denied (the login page answers `502 Identity provider unreachable`).

`GET /logout` clears the session cookie (the provider's own `usk` session lives on the provider's host and is left alone). Unauthenticated browser navigation redirects `302` to `/login?next=…`; everything else gets `401` with `WWW-Authenticate: Bearer` — this gate does not issue its own tokens, so scripted clients belong to `auth-jwt`.

Required config: `issuer` (an `http(s)://` URL; discovery and JWKS are read from it) and `clientId`. Optional: `redirectPath`, `cookie`, `loginPath`, `logoutPath`, `secureCookie`, `refreshMinutes`, `fetchTimeoutMs`, and `allowIssuerMismatch` — the escape hatch for a deployment reached on a host alias the provider issues tokens for; it skips only the `iss` equality check (signature and `aud` still bind the token).

Configuring the shipped Web composition against the production IAM (a profile patch layer; `redirectPath` must match the provider registration — the real IAM requires the externally visible URL):

```yaml
- id: auth-iam
  name: '@deepseek-ai/dsh-host-auth-iam'
  config:
    issuer: https://iam.jereh.cn/idp
    clientId: EnterpriseDingtalk
```

## Model Experience

None, as the package gates HTTP transport between the browser and the Host and registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Implicit flow only** — `response_type=token&scope=openid` matches the shipped IAM client; an `authorization_code` deployment would need a client secret and code exchange this plugin does not do.
- **The session token is the provider id_token** — it rides the cookie until its own `exp` (24h at the Jereh IAM); `refresh_token` is ignored, so a signed-out provider session does not revoke the local cookie until expiry, and `/logout` does not end the provider's `usk` session (that host's cookies are outside this server's reach).
- **No provider end-session redirect** — the IAM's `end_session_endpoint` is form-encoded POST-only; a browser-side end of the IAM session is a future enhancement, not wired to `/logout`.
