# `@deepseek-ai/dsh-host-auth-core`

English | [中文](README.zh.md)

Shared auth-surface mechanics for the webserver guard plugins: a library package (no plugin row of its own) that owns the request-facing vocabulary the two shipped gate owners — [`dsh-host-auth-jwt`](../auth-jwt/README.md) (HS256 shared-secret tokens) and [`dsh-host-auth-iam`](../auth-iam/README.md) (enterprise OIDC id_tokens) — would otherwise implement twice: token presentation (`Authorization: Bearer` over the auth cookie), `HttpOnly` `SameSite=Lax` session-cookie issuance, root-relative `next` validation, browser-navigation detection, the `WWW-Authenticate: Bearer` challenge, capped body reads, canonical base64url JSON decoding, and `mountAuthSurface()`.

`mountAuthSurface(ctx, options)` is the package's product: inside the calling plugin's fiber it registers the webserver `WebGuard` (exempt paths pass; a verified token passes; an unauthenticated fallback-surface browser navigation is redirected `302` to the login path with `next`; everything else gets `401` with the Bearer challenge), the `UpgradeGuard` (unverified upgrades are rejected `401` ahead of the upgrade route table), the shared logout route (clears the cookie, redirects `/`), the state route (`GET /auth-state`, an exact route so the guard alone answers an unadmitted request with its 401 challenge, and the JSON body `{"authenticated":true}` is the served admission verdict), and the `authPrincipal` service (its `isPrivate(req)` reports a presented credential — safe to consult from routes, because the guard rejects unverified requests before any route runs, and an unmounted gate leaves no service behind). Every registration is an effect of the caller's fiber, so disposing a gate owner reopens the surface exactly as the webserver's guard contract requires. The `dsh-client-connection` node half consults `authPrincipal` at exactly one decision — its privileged-method pin, where a presented credential substitutes for loopback — never at the `/api` authority fence.

The package registers nothing at load and speaks no transport of its own; it runs inside whichever gate owner's row is configured. See the gate owners' READMEs for the user-facing flows and configuration.

## Model Experience

None, as the package is shared HTTP-transport mechanics between the browser and the Host and registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Login-surface styles are per-owner** — the core mounts only the guard pair and the logout route; each gate owner renders its own login surface, so visual polish lives in the owners rather than here.
