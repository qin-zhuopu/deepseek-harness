# 2026-09-06 IDE image build chain fixes + portal three-button rework + prod recovery

English | [中文](2026-09-06-ide-image-build-and-portal-ux.zh.md)

> Ops session log. No passwords, tokens, or key values live here; credentials stay in the Jenkins credential store and 0600 host files. The IAM password surfaced once in cleartext during the session and should be rotated.

## Resource inventory (URLs/paths, all durable)

| Resource | Location |
|---|---|
| Portal entry (production) | http://ide.jereh-pe.cn/ (container `ide-portal`, behind `jr-nginx-proxy`) |
| Portal dev | `node --experimental-strip-types apps/ide-portal/src/cli.ts --config /tmp/portal-dev.yaml --state /tmp/ide-portal-dev-state`, listening on 127.0.0.1:8188 |
| Jenkins | https://new-jenkins.jereh.cn (API responses wrap a `{"success":true,"data":{…}}` envelope; unwrap `data` before reading) |
| Image build job | `dsh-aio-dev-build` (parameter `PUSH_HARBOR`; must be form-encoded via `--data-urlencode` — a JSON body is silently ignored and falls back to 0) |
| Portal executor job | `ide-provision` (ACTION=probe/create/start/stop; probe is read-only) |
| Host exec channel | `dsh-aio-remote-exec` (params `TARGET_HOST=10.1.17.58`, `SCRIPT_B64`); single executor — one stuck build blocks later triggers; a stuck queue shows its reason at `/queue/item/<id>/api/json` `why`, terminate via `POST /job/<job>/<n>/term` |
| Host | 10.1.17.58 (ssh user admin; Docker network `dc_default`) |
| Per-user IDE | `http://ide-<uid>.jereh-pe.cn/`, container `ide-<uid>`, example: ide-14409 |
| Portal assets on host | `/opt/ide-provision/`: portal.yaml (mounted as /etc/ide-portal/portal.yaml), ide-portal.env (IDE_JENKINS_TOKEN), iam-trust.json, provision.sh, model-key.env/ (directory; the Jenkins credential lands here) |
| Portal source on host | `/opt/ide-portal-src` (shallow clone of bitbucket master; deploy does `git fetch --depth 1 && git checkout FETCH_HEAD`) |
| Images | `harbor.jereh.cn/base/dsh-aio:dev-amd64` (currently = build 37, commit b21968bef2), `ide-portal:dev` (host-local, built at deploy) |
| Volumes (ide-14409) | `ide-14409-workspace` → mounted at `/workspaces/system-admin` (user code persists); `ide-14409-dshome` → `/root/.dsh`; `ide-portal-state` → portal state |
| IAM | production iam.jereh.cn (the host cannot reach it; offline trust via trustFile; iam-test.jereh.cn is reachable but forbidden for production) |

## Image build chain: four stacked defects and their fixes

The build script `docker/build-dsh-aio-dev-amd64-internal.sh` (Jenkins runs it on the host) is two-stage: `docker/dsh/Dockerfile.internal` → `dsh:dev-amd64` → `docker/dsh-aio/Dockerfile.internal` → `dsh-aio:dev-amd64`.

1. **Cache invalidation (the slowness)**: `COPY . .` preceded the dependency-install layer, so every commit re-downloaded 939 packages from the slow Nexus. Fix: `COPY pnpm-lock.yaml pnpm-workspace.yaml ./` + `COPY patches/ patches/` + `RUN pnpm fetch` warms the store, then `COPY . .` + install. Install went from ~15 min to **1m40s** (commits 23b986dbd7, 7ff7220f73).
2. **`--offline` drops links**: after fetch, `pnpm install --offline` creates no node_modules links between workspace packages; the image builds (tsconfig paths) but runtime tsx source dispatch dies with `ERR_MODULE_NOT_FOUND` → gate 502. Dropping `--offline` does not help — **pnpm links only workspace packages the dependency graph references**; the root node_modules/@deepseek-ai has always held exactly one link (locally too).
3. **The real fix**: `docker/dsh/link-workspaces.mjs` explicitly symlinks every `@deepseek-ai` workspace package (247) into the root node_modules after install. **Symlink targets must be absolute** — a relative target resolves against the link's own directory and `test -d` shatters (commits 245d89478d, b21968bef2). Build-time assertions `test -d dsh-client-ui-vnc-preview && test -d cordis-plugin-hmr` catch this class at build time.
4. **web would not boot**: `pnpm dsh web` runs without `--expose-internals`; the new HMR service refuses to load and the cordis loader exits before listening → 502 at the front proxy. `--expose-internals` is **not allowed in NODE_OPTIONS**; it must be a real node argument. Fix: the entrypoint now runs `exec node --expose-internals --import tsx/esm apps/cli/src/bin.ts web …` (commit 8deff0c346).

Host hard constraints: **user containers must use the two-step boot** — `--entrypoint bash -c 'sleep 60000'` as PID1, then `docker exec -d <c> /usr/local/bin/entrypoint.sh`. A direct entrypoint stalls inside `autocutsel -fork` (a foreground child swallows the whole script). nginx-proxy (jr-nginx-proxy) honors only the `VIRTUAL_HOST`/`VIRTUAL_PORT` **environment variables**; labels are ignored. Health probes accept 200/302/401 (401 = the gate is protecting).

Disk: the 589G volume hit 100% (ENOSPC killed build 31; layers committed while the disk was full corrupt — the `ide-14409-fixed:v1` snapshot lost a working bash binary to this and is retired). Pruning builder/dangling freed ~21G. Two January vllm images (~40G total) await the user's delete decision: `98c6c84ac273` (vllm-glm4-flash:latest, double tag) and `e426f45eef5f` (vllm-openapi:nightly-*).

## Portal interaction rework (requester decisions, 2026-09-06)

1. **Instant open + SSE**: `GET /` used to `await reconcile()` inline — every page open blocked on a full Jenkins probe round-trip before the first HTML byte. Now the shell answers immediately, the arrival check runs behind the request, and its chain streams over `/api/events`; `StateEvent` carries a `checking` field so the page shows 正在检查 instead of a stale verdict the probe may overturn; a failed probe surfaces as a visible step instead of being swallowed (commit 2a7b697fd7).
2. **Three always-visible buttons**: 检查我的IDE (POST /api/check, read-only re-check), 启动我的IDE (POST /api/provision, idempotent: HEALTHY short-circuits, an in-flight run is joined, only absent/stopped triggers create/start; retry folds into it), 进入我的IDE (jumps only when ready; otherwise a hint line lands in the log area). Buttons are **never hidden or disabled**; unmet preconditions log a hint (commits 448a3b91cf, 4eecdebbc1, and following).
3. **Readable log**: probe marker details map to Chinese (`docker: running` → 容器运行中, `HTTP 401 from container` → 容器应答 HTTP 401(登录保护正常)); each check renders one chain (工号/域名/服务状态/Compose 位置/健康检查/结论) and a new chain (detected by the 工号 opener) replaces the previous one; `seq` stays monotonic across resets so SSE dedup holds.

Checking and starting **both go through Jenkins** (the same `ide-provision` job, distinguished by ACTION); the portal — dev included — is only a Jenkins API client and holds no Docker/SSH credentials (SR3). The dev and production portals differ only in portal.yaml (bindHost/port/jenkins.user/trustFile path). Dev talks to the real Jenkins and host; there is no mock.

## Production incident and recovery (lessons)

A portal deploy removed the running container with `docker rm -f` before capturing its config; the recreate guessed the `--env-file` path wrong and failed, leaving the production portal at 503 for ~10 minutes. **The exact command that restored it** (in use; do not guess again):

```
docker run -d --name ide-portal --restart unless-stopped --network dc_default \
  -v ide-portal-state:/var/lib/ide-portal \
  -v /opt/ide-provision/portal.yaml:/etc/ide-portal/portal.yaml:ro \
  -v /opt/ide-provision/iam-trust.json:/etc/ide-portal/iam-trust.json:ro \
  --env-file /opt/ide-provision/ide-portal.env \
  -e VIRTUAL_HOST=ide.jereh-pe.cn -e VIRTUAL_PORT=8080 -e HTTPS_METHOD=noredirect \
  ide-portal:dev
```

Lesson: `docker inspect` the live container and save its full Env/Mounts/Cmd before touching production. Other lessons: `pkill -f <pattern>` matches its own `bash -c` command line and self-kills — use the bracket trick (`pkill -f "dsh[ ]web"`); Jenkins API parameters must be form-encoded; never omit `curl -m`.

## Current state

Production portal = commit 2a7b697fd7 (instant-open version, 77 tests green); the three-button version (from 4eecdebbc1) is verified in local dev and awaiting release. ide-14409 is provisioned and healthy (created by clicking 启动我的IDE on the dev page through the real chain, build #125). The IDE image dsh-aio:dev-amd64 = build 37 and boots fully automatically.
