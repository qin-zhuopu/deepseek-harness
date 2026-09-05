# `@deepseek-ai/dsh-host-auth-jwt`

English | [中文](README.zh.md)

JWT bearer authentication for the Web server: a function plugin (`name`/`inject`/`Config`/`apply`, requires `webServer`). While its fiber is mounted, every named HTTP route, the fallback (SPA dist) surface, and every WebSocket upgrade requires a compact HS256 JWT; unauthenticated requests never reach a route handler. The row is opt-in: with no `auth-jwt` row (or the row disabled) the server stays exactly as unauthenticated as before, and disposing the fiber restores the open surface (HMR-safe).

The token is a compact JWT signed with the configured `secret` (HMAC-SHA256, constant-time verify; only `alg: HS256` is accepted, so `alg: none` and algorithm substitution never verify; a numeric `exp` is enforced). It travels on either channel:

- `Authorization: Bearer <token>` — non-browser clients, curl, scripts.
- The `dsh_token` cookie (config `cookie`) — the browser's channel: `fetch`, `EventSource`, and same-origin `WebSocket` all carry it without client code, which is what makes the guarded GUI work with the stock client bundle.

The package ships the issuance surface itself: `GET /login` (config `loginPath`) renders a password form, `POST /login` checks the password against `secret` (hashed compare) and issues a `{sub, iat, exp}` token as an `HttpOnly` `SameSite=Lax` cookie (plus `Secure` under `secureCookie`); a JSON request gets `200 {token}` or `401` instead of HTML, so scripted clients use the same endpoint. `GET /logout` clears the cookie. The guard distinguishes browser navigation (`Sec-Fetch-Mode: navigate`, or `Accept: text/html` on GET/HEAD) — redirected `302` to `/login?next=…` — from every other request, which gets `401` with `WWW-Authenticate: Bearer`. The `next` redirect target must be root-relative and protocol-free, so the login page cannot be used as an open redirect. The login and logout routes are exempt from the guard by path, so the login page stays reachable; an unauthenticated navigation to the SPA shell redirects to `/login`, and once the cookie lands the same navigation delivers the shell and its asset requests carry it — the guard gates the whole surface including the dist.

`secret` is required and at least 32 characters; it is both the signing key and the shared password (a deployment running multiple replicas shares one secret the same way it shares one config). Everything else has a default: `cookie`, `loginPath`, `logoutPath`, `lifetimeSeconds` (default 24h), `secureCookie`.

Configuring the shipped Web composition (a profile patch layer):

```yaml
- id: auth-jwt
  name: '@deepseek-ai/dsh-host-auth-jwt'
  config:
    secret: !!js process.env.DSH_AUTH_SECRET
```

## Model Experience

None, as the package gates HTTP transport between the browser and the Host and registers nothing model-facing.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

- **Password is the secret** — one configured `secret` is both the HMAC key and the login credential, so rotating it invalidates every issued token and there is no per-user account. User accounts, issuance APIs, and rotation belong to a real auth seam; this package is the deployment-level lock.
- **No CSRF token on the login form** — the cookie is `SameSite=Lax`, login POSTs are same-site or rejected by the cookie's `HttpOnly` absence of readable state, and the guarded surface exposes only `Host`-fenced same-origin APIs; a hostile cross-site login POST can only burn the correct password.
- **Tokens are stateless** — a logged-out-but-unexpired token stays valid inside its lifetime on other clients; `logoutPath` clears only the calling browser's cookie. Revocation lists belong to the same future seam as accounts.
