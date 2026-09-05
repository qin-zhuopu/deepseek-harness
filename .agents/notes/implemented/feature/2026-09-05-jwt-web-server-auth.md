# Agent Note: Gate the Web server with JWT bearer auth

Status: implemented

English | [中文](2026-09-05-jwt-web-server-auth.zh.md)

## Problem

The webserver served every surface — the `/api` RPC bridge, WebSocket downlinks, plugin bundles, the HMR event stream, and the SPA shell — with no authentication. The DNS-rebinding/Host fence in `dsh-client-connection` is an origin defense, and its privileged-method rule is documented as loopback-only "until a real authentication layer exists". Any peer able to reach the bind host could drive sessions. The replacement must cover routes registered after the auth plugin, upgrades that cannot carry header injection from browser code, and must stay optional so the shipped default composition is unchanged.

## Decision

`@deepseek-ai/dsh-host-auth-jwt` is a function plugin injecting `webServer`. While its fiber is active, every named route, the fallback handler, and every HTTP upgrade require a compact HS256 JWT presented as `Authorization: Bearer` or as the `dsh_token` cookie; disposal removes all of it (HMR-safe). The webserver gained the seats it owns: `registerGuard(guard)` gates HTTP per surface (`'route'` | `'fallback'`) in registration order — the first rejection stops the chain and owns its response, an unwritten denial gets an empty 401, and the bare 404 of an unclaimed fallback seat sees no guard — and `registerUpgradeGuard(guard)` runs ahead of the upgrade route table, so a rejected connection (`{status, headers?}` verdict) never reveals whether the pathname has an owner. Guards are additive; with none registered the server behaves exactly as before.

The package carries its own login surface: `GET /login` renders a password form, `POST /login` verifies the password against the configured `secret` with a hash compare and issues `{sub, iat, exp}` as an `HttpOnly` `SameSite=Lax` cookie (JSON clients get `{token}` instead of HTML), and `GET /logout` clears the cookie. Both paths are exempt from the guard by pathname. Navigations (`Sec-Fetch-Mode: navigate`, or `Accept: text/html` on GET/HEAD) get `302` to `/login?next=…`; everything else gets `401` with `WWW-Authenticate: Bearer realm="dsh"`. `next` must be root-relative and backslash-free, so the login page cannot serve as an open redirect.

The configured `secret` (required, minimum 32 characters) is both the HMAC key and the shared password. Tokens are stateless HS256 over `node:crypto`: `alg` must be exactly `HS256` (so `alg: none` and algorithm swaps fail verification), segments must canonicalize through base64url (rejecting padded or lenient forms before parsing), the signature compare is constant-time, and a numeric `exp` at or before now is rejected. `jose` exists only transitively in the lockfile; adding it as a direct dependency would replace roughly 60 lines of pinned, fully tested crypto glue with a dependency carrying its own audit surface, so the repository's dependencies-over-hand-rolling rule does not apply at this seam.

## Consequences

A browser cannot set headers on `WebSocket` or `EventSource`, so the cookie channel is what lets the stock client bundle cross the gate without modification; Electron keeps an open path because it loads dist over `file://` and never rides the webserver. The login page ships as one inline HTML string in the plugin, not a built asset, so the gate owns no fallback seat and frontend-static remains the sole dist owner. `auth-jwt` is not in any shipped bundle: enabling it means adding the cordis.yml row with a deployment-provided `!!js process.env.DSH_AUTH_SECRET`. Tests cover the JWT codec at unit level, guard-surface edges through a hand-built context, and the full Loader composition (both channels, upgrades, login flow, open-redirect refusal, disposal/remount) in `packages/host/auth-jwt/tests/`.

## Alternatives considered

Client-side header injection was rejected because `WebSocket` and `EventSource` expose no header hook, which would force a fork of the client transport for every consumer. A reverse-proxy front was rejected as a repo requirement because the harness already owns the listener, the bind host, and the origin fence, and a proxy cannot see upgrade-path semantics it does not terminate. Gating only `/api` was rejected because unauthenticated shells leak the app surface and future routes would silently escape the gate; gating at the webserver seats means a route registered after the auth fiber is still covered. Putting the password in a separate field from the signing key was rejected for v1: single-secret deployments are the shipped shape, and the README states the rotation consequence.
