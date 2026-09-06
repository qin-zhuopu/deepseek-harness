# Deploying the JWT login gate on a hosted aio instance

English | [中文](0009-jwt-login-gate-deployment.zh.md)

Status: in use (deployed on `10.1.17.58`, entry `https://dsh.jereh-pe.cn/`)

## Executive summary

The aio image ships the login gate dormant: the Cordis overlay [`docker/dsh-aio/dshhome/jwt-gate.cordis.patch.yml`](../../docker/dsh-aio/dshhome/jwt-gate.cordis.patch.yml) is baked into every image, but nothing mounts it unless the container sees `DSH_AUTH_SECRET` (≥ 32 chars). One env line in the host compose activates the whole chain — guard, login page, `/auth-state` probe, and the privileged settings plane for signed-in remote browsers ([the admission design](../../.agents/notes/implemented/architecture/2026-09-05-auth-gate-admits-the-privileged-plane.md)). This chapter is the operational procedure: what to set, in what order, how to verify, and the failure modes around a recreate.

## What the gate changes about the deployment

| Surface | Unauthenticated | Authenticated (cookie `dsh_token`) |
|---|---|---|
| `/`, SPA, assets | `401` + `WWW-Authenticate: Bearer realm="dsh"` | normal |
| `/login` | `200` (the page), `303` on correct password | — |
| `/auth-state` | `401` | `{"authenticated":true}` |
| privileged RPCs (`/api/settings.describe`, `llm.providers`, …) | `401` | `200` |

The password is the secret itself (`dsh-host-auth-jwt`: one deployment-level password, no accounts). The cookie is HS256, 1-day lifetime, HttpOnly. `/logout` clears only the calling browser's cookie; rotating `DSH_AUTH_SECRET` invalidates every token at once.

## Deployment procedure (compose on 10.1.17.58)

1. Generate the secret once, on the host: `openssl rand -base64 48 > /home/admin/.dsh_auth_secret`, then `chmod 600` it. It never enters the repo, the Jenkins job, or any log.
2. In the compose directory (`/home/admin/git/dc`), put `DSH_AUTH_SECRET_FILE=<secret>` into `.env` (`chmod 600`) and reference it from the service env: `- DSH_AUTH_SECRET=${DSH_AUTH_SECRET_FILE}`. The compose file itself stays secret-free.
3. Recreate: `docker-compose up -d dsh-aio`. The entrypoint appends `--patch /root/.dsh/jwt-gate.cordis.patch.yml` iff `DSH_AUTH_SECRET` is set, and refuses to start when the value is shorter than 32 characters.
4. Keepalive: admin's crontab runs `docker exec dsh-aio /usr/local/bin/supervise.sh` every 2 minutes (the compose entrypoint is `sleep infinity` to dodge the PID1-freeze described in [0001](0001-dockerize-dsh-pitfalls.md); `supervise.sh` exits immediately when a supervisor already runs).

## Verify (inside the container, port 8080 front-proxy)

```sh
docker exec dsh-aio curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8080/       # 401
docker exec dsh-aio curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8080/login  # 200
docker exec dsh-aio curl -s -w " [%{http_code}]" http://127.0.0.1:8080/auth-state         # 401
docker exec dsh-aio sh -c "grep -m1 'JWT gate' /tmp/entrypoint.log"  # gate mounted
```

A full signed-in roundtrip: `POST /login` with `password=<secret>` (form body) → `303` + `dsh_token` cookie → `/auth-state` answers JSON → privileged RPCs return `200`. In the browser, the Settings → Models provider directory renders only after that probe succeeds; before login the client keeps every settings row process-local by design.

## Pitfalls

- **Launcher flag order.** The `dsh web` launcher stops parsing its own flags at the first token it does not recognize. `--patch` must come immediately after the `web` subcommand: `dsh web --patch X --no-open …` parses, `dsh web --no-open … --patch X` dies with `unknown option '--patch'`. The entrypoints place the gate overlays accordingly.
- **`docker cp` and the exec bit.** Copying an entrypoint into the running container must land with mode `755`; the supervisor starts it via `nohup`, which answers only "Permission denied" on a non-executable file, and the dead process has nothing watching it.
- **`DEV_WATCH=1` churn under a live gate.** The aio default rewrites `lib/client.js` under the serving carrier; page loads racing a half-written bundle fail with "Failed to load plugins" on a rotating package name. A hosted instance sets `DEV_WATCH=0` and serves baked bundles.

## Rollback and the IAM variant

Rollback is one compose edit: remove the `DSH_AUTH_SECRET` env line and recreate — with no secret the overlay is never mounted and the instance behaves as a plain loopback/trust-boundary deployment ([0005](0005-reverse-proxy-exposure.md)). Do not set `DSH_IAM_GATE=1` on a host that cannot reach `iam.jereh.cn`: a mounted-but-unreachable OIDC gate redirects every request including login completion, which locks everyone out. The IAM gate requires proven issuer reachability from the container.
