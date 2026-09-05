# Per-user IDE service on demand: design

English | [中文](0008-per-user-ide-design.zh.md)

Status: design draft for [0007](0007-per-user-ide-requirements.md). Requester decisions already fixed: user containers are created with `docker run` (never by editing the proxy's compose file), and Jenkins is the only executor against the Docker host.

## Overview

Three moving parts, one source of truth:

```mermaid
flowchart LR
    B[Browser] -->|entry, login, SSE| P[Portal]
    P -->|JWKS fetch| I[IdP JWKS]
    P -->|buildWithParameters + progressive console| J[Jenkins ide-provision]
    J -->|ssh admin| H[Host 10.1.17.58]
    H -->|docker run, exec hook, probes| C[Container ide-uid]
    N[jr-nginx-proxy] -.->|VIRTUAL_HOST auto-pickup| C
    B -->|final redirect| C
```

- **Portal** owns identity, the per-uid state machine, the live log, and the redirect. It holds no Docker or SSH credential.
- **Jenkins job `ide-provision`** owns every host mutation: `docker run`, the two-step start hook, and both health probes. Progress returns as console marker lines.
- **Docker host state is the truth.** The portal keeps only a marker file per uid (last Jenkins build it triggered); container existence, health, and the nginx rule are always re-read, so a portal restart or replacement loses nothing (N3).

## Portal

A small Node service deployed as one long-running container on 10.1.17.58 behind the same proxy, entry vhost `ide.jereh-pe.cn` (deployed once by hand with the same `docker run` recipe below; it is not self-provisioned). Sign-in is the shipped gate mounted unchanged: [`dsh-host-auth-iam`](../../packages/host/auth-iam/README.md) (`issuer: https://iam.jereh.cn/idp`, `clientId: EnterpriseDingtalk`; the callback `redirect_uri` is composed from the deployment's own origin — the IAM does not validate it against a registration (C10)). It owns the whole OIDC round-trip — authorize redirect, the fragment-relay callback (the IAM delivers the `id_token` in the URL fragment, so only the browser can hand it over), JWKS verification of signature/`iss`/`aud`/`exp`, and the `HttpOnly SameSite=Lax` session cookie. The cookie is host-scoped to `ide.jereh-pe.cn`, so user vhosts can never receive or read it (SR4). The portal then derives the uid from the verified token's `sub` claim, cross-checked against `userId` and `^[0-9]{1,8}$`; everything below the gate is an ordinary guarded route:

| Route | Behavior |
|---|---|
| `GET /` | No session cookie → the gate's `/login` redirect. Session → reconcile; HEALTHY → `302` to the user IDE; otherwise render the start page (FR3, FR4). |
| `GET /api/state` | Current state snapshot: state, last steps, IDE url when ready. Page bootstrap and SSE-reconnect baseline. |
| `GET /api/events` | SSE: `state` and `step` events; replays the buffered step log on connect, then streams live (FR5, N2). |
| `POST /api/provision` | Kick reconcile→provision (idempotent; joins an in-flight run instead of starting a second one, FR7). |
| `POST /api/retry` | Re-reconcile, then retry the failed step (FR8). |

State machine transitions follow [0007](0007-per-user-ide-requirements.md). The portal is front/back separated: the start page is a static SPA built separately from the backend, every state crossing is JSON (`/api/state`, the POSTs) or SSE (`/api/events`), and the backend serves the built SPA statically without holding page logic. The portal maps state transitions onto Jenkins actions:

| Transition | Jenkins action |
|---|---|
| NO_SERVICE → PROVISIONING | `ACTION=create` |
| NO_SERVICE → STARTING (reconcile finds a stopped/frozen container) | `ACTION=start` |
| HEALTHY → UNHEALTHY | `ACTION=start` (restart with hook) |
| any → HEALTHY verification | `ACTION=probe` |

**Single flight (FR7)**: an in-process per-uid lock plus host-side idempotency. `docker run` with `--name ide-<uid>` fails on a name collision, and the job treats that collision as "already created — continue to start/probe", so even two racing Jenkins builds converge instead of forking state.

**Session lifetime**: the IAM token lives 24 h and there is no refresh path (C10), so a portal session ends at `exp`; re-navigation restarts the silent round-trip through the IAM `usk` session. A long provisioning run survives its session expiring only because the SSE stream re-reads the cookie per event: an expired session surfaces on the page as a silent re-login, and the run itself keeps going in Jenkins (the lock and marker file are session-independent).

## Model key flow (FR10, SR5)

The key has one human-managed home: the portal backend's `.env` (`NR_API_KEY=...`, next to the other secrets, never committed). Only `ACTION=create` moves it, and the path is chosen so the value never appears in an argv line, a console line, or a stored shell history:

1. The portal reads `.env` at trigger time and passes it as the masked `MODEL_KEY` build parameter.
2. On the host the job writes a one-shot env file — `umask 077; printf 'NR_API_KEY=%s\n' "$MODEL_KEY" > /run/ide-<uid>.env` — passes it to `docker run --env-file`, and removes it immediately after; the value reaches the daemon as file content, not as a visible argument (`docker run -e NR_API_KEY=$KEY` would expose it to every local user via `ps` and to `docker history`-style process inspection).
3. The container stores the env in its own configuration, so `start`/`probe`/`stop` runs never carry the key again, and the portal page, step markers, and Jenkins console never print it (the masked parameter covers the console).

Accepted residual risks (SR5): Jenkins build records persist build parameters, so anyone who can read the `ide-provision` build history can read the key — mitigated by restricting read access on that job; and every user container's own shell can read the key via `docker exec`/`env`, so the key is fleet-wide, revocable, and spend-capped. If parameter persistence ever becomes unacceptable, the alternative is pre-placing a 600 env file on the host (the `~/dsh-aio.env` pattern `docker/deploy-dsh-aio-arm64.sh` already uses) and dropping `MODEL_KEY` — the job recipe otherwise does not change.

## Jenkins executor

One parameterized pipeline job, defined by [`Jenkinsfile.ide-provision`](../../Jenkinsfile.ide-provision) (same Pipeline-from-SCM pattern as `dsh-aio-dev-build` in [docs/ops/2026-09-05-airgapped-dsh-aio-jenkins-build.md](../ops/2026-09-05-airgapped-dsh-aio-jenkins-build.md)), all host work inside `sshagent(credentials: ['ssh'])` as `admin`; the host actions live in [`docker/ide-provision/provision.sh`](../../docker/ide-provision/provision.sh), which the job ships to `/opt/ide-provision/` on every run and executes over `ssh ... bash -s` (the create key rides stdin, never argv):

| Parameter | Meaning |
|---|---|
| `UID` | Validated `^[0-9]{1,8}$`; job refuses anything else before composing a command (SR1). |
| `ACTION` | `create` / `start` / `probe` / `stop`. |
| `IMAGE_TAG` | Pinned tag (C6), e.g. `dev-amd64-<sha>`; never `latest`. |
| `MODEL_KEY` | `PasswordParameterDefinition`, masked; only `ACTION=create` reads it (FR10). |
| `REQUEST_ID` | Echoed into markers so the portal can attribute builds. |

Job config: `disableConcurrentBuilds()` plus a quiet period absorbs duplicate triggers; the portal authenticates with a scoped API token for `buildWithParameters` (SR3). The job takes seconds for `probe` and minutes for `create`.

**Progress channel**: the job prints one marker per step — `[DSH_STEP] <seq> <step> <ok|fail|info> <detail>` — and the portal tails the build with Jenkins' progressive console text API, parses markers into SSE events, and maps the final build result to `READY`/`FAILED`. Poll-based tailing was chosen over the job POSTing events to the portal so Jenkins needs no route back to the portal, and the console stays the complete audit record (N2: sub-second detection, 2–3 s typical delivery).

## Provisioning recipe

`ACTION=create` on the host, values interpolated only after the uid passes SR1 (the env file is the `MODEL_KEY` file from the Model key flow, so the key never enters this command line):

```bash
umask 077; printf 'NR_API_KEY=%s\n' "$MODEL_KEY" > /run/ide-14409.env
docker run -d --name ide-14409 \
  --hostname ide-14409 \
  --network dc_default \
  --restart unless-stopped \
  --shm-size 1g \
  --label com.jereh.uid=14409 \
  -v ide-14409-workspace:/root/workspace \
  -v ide-14409-dshome:/root/.dsh \
  --env-file /run/ide-14409.env \
  -e FRONT_PORT=8080 -e VNC_PUBLIC_URL=/vnc -e RESIZE_ENDPOINT=/resize \
  -e TRUSTED_HOSTS=ide-14409.jereh-pe.cn \
  -e VIRTUAL_HOST=ide-14409.jereh-pe.cn -e VIRTUAL_PORT=8080 \
  -e HTTPS_METHOD=noredirect \
  --entrypoint bash \
  harbor.jereh.cn/base/dsh-aio:dev-amd64 -c 'sleep 60000'
rm -f /run/ide-14409.env
```

The `--entrypoint bash -c 'sleep 60000'` override is not optional on this host (C2): the real entrypoint is then fired exactly once per start by `ACTION=start`/the create step's tail:

```bash
docker exec -d ide-14409 /usr/local/bin/entrypoint.sh >>/dev/null 2>&1
```

(The supervise-script variant from [docs/ops/2026-09-05](../ops/2026-09-05-airgapped-dsh-aio-jenkins-build.md) existed because compose could not exec; with `docker run` driven by Jenkins, the direct `docker exec -d` is the hook.)

Volumes carry all user data (FR9): `-workspace` roots `INIT_WORKSPACE`, `-dshome` keeps sessions and settings. Image stays pinned (C6); an upgrade is a `stop` + `docker rm` + `create` with a newer `IMAGE_TAG`, data untouched. Resource limits and the concurrent-user cap land here once O7 decides.

`docker-gen` inside `jr-nginx-proxy` watches the Docker socket and regenerates the vhost within seconds of the container appearing — no proxy file is ever edited (C3, C5, requester decision).

## Health check

`probe` runs on the host and must pass both levels before the portal may hand out the URL:

1. **Internal**: resolve the container IP with `docker inspect` and `curl -fsS http://<ip>:8080/` → `200`. Proves the entrypoint actually ran (catches C2's freeze) and front-proxy is up.
2. **Via proxy**: `curl -fsS -H 'Host: ide-<uid>.jereh-pe.cn' http://127.0.0.1/` on the host → `200`. Proves docker-gen already installed the rule, so the browser will not meet a default vhost; this probe absorbs the reload delay.

Both use the pinned 8080 front-proxy port (C1). Budget: 30 s interval, 10-minute cap (C7); each attempt emits a step event with the elapsed time (FR5, N1).

## Live log

SSE event payloads are append-only JSON objects:

```json
{"type":"state","state":"STARTING","ideUrl":"http://ide-14409.jereh-pe.cn/"}
{"type":"step","seq":7,"step":"probe-proxy","status":"ok","detail":"200 after 4 tries, 210s"}
{"type":"step","seq":8,"step":"ready","status":"ok","detail":"build #12 SUCCESS"}
```

Steps: `reconcile`, `lock`, `jenkins-queued`, `jenkins-running`, `image-pull`, `docker-run`, `start-hook`, `probe-internal`, `probe-proxy`, `ready`, `failed`. The portal buffers the current run's steps in memory and replays them on SSE (re)connect; after a portal restart the Jenkins build named in the marker file is re-attached and tailed again, so the log survives (N3).

When `ready` arrives the browser navigates via `location.href`; the page also shows a persistent "Open my IDE" button as the no-JS/popup-blocked fallback. The warm path never opens the SSE stream at all — it is the bare `302` (FR3).

## Container-side login (recommended, O2)

User vhosts are guessable (uid = employee number) and the proxy is HTTP-only (C4); 0005's own warning — reaching the proxy means reaching a dsh control plane — applies per user. Recommended: mount the same shipped gate ([`dsh-host-auth-iam`](../../packages/host/auth-iam/README.md)) inside each user container with `clientId: EnterpriseDingtalk`; the gate builds its `redirect_uri` from the request origin, so container `ide-<uid>` signs in at `http://ide-<uid>.jereh-pe.cn/auth/callback`, and the IAM accepts that unregistered callback (C10) — provisioning the gate is a cordis.yml row plus the IAM client config baked into the image, zero per-user coordination. After the portal's redirect the browser still holds the IAM `usk` session, so the second login is a silent fragment round-trip; the verified token then lands as that container's own host-scoped cookie. The gate's own cookie model is what stores the `id_token` (SR4): the user's token lives in the user's container, nowhere else. Until O2 lands, treat every user vhost as an open internal test box.

## Configuration

Portal config (one file, all values explicit — nothing tunable is hardcoded):

```yaml
domainSuffix: jereh-pe.cn
entryHost: ide.jereh-pe.cn
uid: {claim: sub, crossCheckClaim: userId, pattern: "^[0-9]{1,8}$"}
imageTag: dev-amd64-<sha>
modelKey: {envFile: .env, varName: NR_API_KEY}   # read at create only (FR10, SR5)
jenkins: {url: https://new-jenkins.jereh.cn, job: ide-provision, user: portal, tokenEnv: IDE_JENKINS_TOKEN}
# The auth-iam gate reads its own row; jwks_uri comes from its discovery document.
iam: {issuer: https://iam.jereh.cn/idp, clientId: EnterpriseDingtalk, redirectPath: /auth/callback}
health: {intervalSec: 30, timeoutSec: 600, pollMs: 1500}
```

The token carries no group or email claim (0007, Identity claims), so there is deliberately no `allowedGroups` here. If entry restriction is ever required it is a portal-maintained employee-number list checked after the gate, before provisioning.

## Failure modes

| Symptom | Cause | Handling |
|---|---|---|
| `docker-run` fails "name conflict" | racing build or leftover container | Treated as already-created; continue to start/probe (FR7) |
| `image-pull` fails | harbor unreachable/tag moved | `FAILED` at `image-pull`, retry re-triggers (FR8) |
| internal probe never passes | PID1 freeze — hook missed | `start` re-fires the hook once, then `TIMEOUT` with the console link (FR6, C2) |
| internal passes, proxy probe 404/502 | docker-gen reload lag, or wrong `VIRTUAL_HOST` | Keep probing within budget; on timeout `FAILED` names the nginx step |
| browser `POST /api/*` 403 on the IDE | `TRUSTED_HOSTS` mismatch (C8) | Recipe pins it from the same uid value; failure at create-time is loud |
| Jenkins queue jam | long create blocks probes | Probe uses a dedicated no-lock read path; queue position surfaces as a step event |

## Rollout and verification

1. Deploy the portal container by hand; verify the OIDC round-trip and a `probe` against the existing `dsh.jereh-pe.cn` service shape.
2. Cold-path dogfood as uid 14409: expect ≥45 s to first 200 (C7), markers streaming live, redirect landing on a working IDE.
3. Chaos passes: `docker stop ide-14409` → re-enter recovers via STARTING (US3); freeze the PID1 by re-creating without the hook → probe-internal catches it (FR6); two tabs at once → one build (US4).
4. Only after 1–3 pass on 10.1.17.58 revisit the parked items (O2 login, O4 reclamation, O5 TLS, O7 caps) with real usage data.

## Related

- [0007](0007-per-user-ide-requirements.md) — requirements, user stories, sequence diagrams, open items.
- [0005](0005-reverse-proxy-exposure.md) — front-proxy and trust-fence constraints the recipe pins.
- [docs/ops/2026-09-05-airgapped-dsh-aio-jenkins-build.md](../ops/2026-09-05-airgapped-dsh-aio-jenkins-build.md) — Jenkins/host mechanics this design reuses.
