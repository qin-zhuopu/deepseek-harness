# 2026-09-05 dsh.jereh-pe.cn settings-plane login gate and litellm egress diagnosis

English | [中文](2026-09-05-dsh-web-login-gate-and-litellm-egress.zh.md)

> Ops session journal. No passwords or tokens are recorded here; the gate secret and `NR_API_KEY` live only in the host compose environment.

## Reproduction (CDP browser, https://dsh.jereh-pe.cn/)

1. 设置 → 模型：provider directory modal answers 加载提供方目录失败: settings are unavailable in this browser. DevTools network shows every `settings.describe`/`llm.providers` privileged call refused; the page itself (ordinary methods) works.
2. A configured provider chat never answers: the Host-side fetch to `https://litellm.jereh.cn/v1/chat/completions` dies on connect.

Both were reproduced in the CDP browser before any change.

## Cause A and fix (modal / configuration plane)

The `/api` privileged-method pin admitted only loopback pages, so a remote browser — signed in or not — could never reach the settings/credentials plane, and the browser mirror refused the calls client-side too. Fixed in-repo (Agent Note [the auth gate admits the privileged plane](../../.agents/notes/implemented/architecture/2026-09-05-auth-gate-admits-the-privileged-plane.md)): the pin additionally admits a request presenting a mounted gate's credential (`authPrincipal` from `dsh-host-auth-core`), refusal changed 403→401 + `WWW-Authenticate: Bearer realm="dsh"`, and the client mirror/scope follows the new `privatePlane` verdict (probe `GET /auth-state`, JSON `{authenticated:true}` only through the guard).

Deployment bake on 10.1.17.58: `docker/dsh-aio/dshhome/jwt-gate.cordis.patch.yml` is baked by every Dockerfile; `entrypoint.sh` appends `--patch /root/.dsh/jwt-gate.cordis.patch.yml` iff `DSH_AUTH_SECRET` is set (≥32 chars, else the container refuses to start). The web profile's `package.json` declares `@deepseek-ai/dsh-host-auth-jwt` (dependency, not `devDependencies`) so the profile-healed resolver finds it. The compose file references `DSH_AUTH_SECRET=${DSH_AUTH_SECRET_FILE}`, the value living in the compose-adjacent `.env` (generated on the host, `chmod 600`, never in the repo); the container env read is `${DSH_AUTH_SECRET}`. Login: `/login` accepts the secret, issues the `dsh_token` HS256 cookie (1 day), and both HTTP and the WebSocket uplinks ride that cookie through the guard.

Deployment gotchas found on the live box: the launcher stops parsing its own flags at the first token it does not know, so the `--patch` overlays must come **immediately after** the `web` subcommand (`dsh web --patch … --no-open …`); and `docker cp` of the entrypoint into the running container must land with mode 755 — `nohup` inside the host's exec-hook silently answers "Permission denied" and nothing supervises.

Deliberately NOT deployed: `DSH_IAM_GATE=1`. `iam.jereh.cn` is unreachable from 10.1.17.58 (curl rc28), and a mounted-but-unreachable OIDC gate 401s/redirects everything including login completion — total lockout.

## Cause B and verdict (litellm transport) — netops item, no in-repo fix

- `NR_API_KEY` is correct: the compose line matches the working dev-container key, and a chat completion through the dev container's litellm route returns 200 with the same key (checked inside the running dev container).
- Network from 17.58 to the provider is dead: `litellm.jereh.cn` resolves to `10.1.3.101`; **443 and 4000 both answer instant TCP RST from the host, from the `dsh-aio` container (dc_default), and from jenkins1**. Not a timeout, not a TLS problem: no SYN-ACK path exists. `curl` rc 7/35, node fetch `connect ECONNREFUSED 10.1.3.101:443`.
- Egress fallbacks are all dead too: host proxy 8888 (nothing listening), `squid` container (exited), `jr-proxy` container (Exited(143) ~4 weeks), Nexus `8081` CONNECT → rc56. Node 24's `NODE_USE_ENV_PROXY=1` works mechanically but has no working proxy to use; with it set the request hangs until cancelled instead of RST.
- Verdict: the fix is a firewall/route opening **10.1.17.58 (and its docker bridge) → 10.1.3.101:443/4000** — a netops ticket; or reviving an egress proxy both boxes can reach. No repository change can substitute.

## Reusable facts

- The privileged-method refusal answer is now 401 + `WWW-Authenticate: Bearer realm="dsh"` (was 403); a remote page whose probe `GET /auth-state` does not return JSON `{authenticated:true}` keeps every settings row process-local ("memory").
- Probe-vs-status matters: the SPA fallback answers HTML 200 on any unclaimed path, so an admission probe must parse the gate's JSON body, not trust the status.
- `ctx.get(name, false)` (lenient) is the only safe read of an optionally-mounted service from a hot path; strict `ctx.get`/`ctx.<name>` throws `cannot get property without inject` when the provider row is absent (cordis reflect.ts).
- auth-jwt password = the `secret` itself (deployment-level lock, no accounts); a token is stateless — logout clears only the calling browser's cookie.
- Fake `connection` handles in client specs must carry `privatePlane: { getSnapshot, subscribe }` now (the handle gained the member); specs that fake only `isLoopback` crash in `persistenceAllows`.

## Pending follow-ups

- DONE this session: compose entrypoint is now `sleep infinity` and admin's crontab runs `docker exec dsh-aio /usr/local/bin/supervise.sh` every 2 minutes (the supervise script is idempotent and exits when a supervisor is already running). `docker rm`/recreate re-triggers the PID1-freeze, so any entrypoint re-bake must repeat the 755-mode copy above.
- Dev-instance plugin churn: `DEV_WATCH=1` (the aio default) rewrites `lib/client.js` under the live carrier, and page loads racing a half-written bundle fail with "Failed to load plugins" on a rotating package name; the demo box now runs `DEV_WATCH=0` (baked bundles).
- `*.jereh-pe.cn` HTTPS certificate expired 2025-06-23 (jr-nginx-proxy serves it for dsh.jereh-pe.cn); renew or the https entry shows a browser warning.
- A stray "say hi" session and a stale smoke-job DSL remain on the deployed instance (cosmetic).
