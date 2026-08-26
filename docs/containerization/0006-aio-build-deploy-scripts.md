# The aio build/ci/deploy scripts: what each one does and when to use it

English | [中文](0006-aio-build-deploy-scripts.zh.md)

Status: in use (arm64 flow running on gb10 = `10.202.200.139`)

## Executive summary

Four shell scripts under `docker/` cover building and deploying the aio dev
image without hand-typing `docker build`/`push`/`run` incantations. The arm64
path is the primary one, because [arm64 images may only be built on
gb10](0004-dockerfile-variants.md) (`10.202.200.139`, ssh user `jereh`) — never
in WSL. The scripts encode the harbor-tag conventions, the mirror-then-push
rule, and the deploy-info stamping so a single command does the right thing.

## The four scripts

| Script | Runs where | Does what |
|---|---|---|
| [`build-dsh-aio-dev-arm64.sh`](../../docker/build-dsh-aio-dev-arm64.sh) | on an arm64 builder (gb10) | Builds the 3-step chain natively; `--push` sends `-arm64`-suffixed tags to harbor |
| [`build-dsh-aio-dev-amd64.sh`](../../docker/build-dsh-aio-dev-amd64.sh) | on an amd64 builder | Builds the 2-step chain (reuses harbor's amd64 chrome base); `--push` sends `-amd64`-suffixed tags |
| [`ci-dsh-aio-arm64.sh`](../../docker/ci-dsh-aio-arm64.sh) | **locally** (drives gb10 over ssh) | Syncs local `.git` to gb10, checks out a clean tree, then runs the arm64 build there |
| [`deploy-dsh-aio-arm64.sh`](../../docker/deploy-dsh-aio-arm64.sh) | **locally** (drives gb10 over ssh) | Pulls the image on gb10, replaces the container, HTTP-probes it, prints the URLs |

### build-dsh-aio-dev-arm64.sh — the native arm64 build

Runs *on* an arm64 builder (guards on `uname -m = aarch64`). Three steps, all
native (no buildx/QEMU):

1. `docker/chrome-base/Dockerfile` → `dsh-chrome-base:24.04` — harbor's
   `ubuntu:24.04-…-chrome` is amd64-only, so arm64 must build its own base.
2. `docker/dsh/Dockerfile` → `dsh:dev` — `pnpm install` + `pnpm run build`, the
   slow step.
3. `docker/dsh-aio/Dockerfile` → `dsh-aio:dev-arm64` (+ `dev-arm64-<sha>`).

Base images (`ubuntu:24.04`, `node:24`) come through the builder's
`daemon.json` mirror accelerators, never Docker Hub directly. `--push` sends
all layers plus the base images to harbor with `-arm64` suffixes, so it never
touches the amd64 `:dev` tags. Passes `DSH_CLIENT_COMMIT_HASH` and
`DSH_BUILD_TS` into both the dsh and aio builds for `/deploy-info`.

### build-dsh-aio-dev-amd64.sh — the amd64 counterpart

Same idea on an amd64 builder, two steps (the chrome base already exists as
amd64 in harbor, used via `CHROME_BASE_IMAGE`). Pushes `-amd64`-suffixed tags.
The two arch scripts deliberately do **not** merge a multi-arch manifest — each
publishes its own suffixed tags so the two sides never collide.

### ci-dsh-aio-arm64.sh — build the local tree on gb10

The one you run day-to-day. It does not build locally (WSL builds are
forbidden). Instead it tars the local `.git` over ssh to gb10, `git checkout -f`
s a clean worktree there, and invokes `build-dsh-aio-dev-arm64.sh` on the
builder. Only committed content is built — commit first. Defaults target gb10;
`-h` lists all flags.

```bash
./docker/ci-dsh-aio-arm64.sh -p      # build the current HEAD on gb10 and push
./docker/ci-dsh-aio-arm64.sh         # build only, no push
```

### deploy-dsh-aio-arm64.sh — deploy + verify on gb10

Pulls the image on gb10, replaces the `dsh-aio` container (`--network host`,
`--restart=unless-stopped`), HTTP-probes the web entry (dev tsx cold start
~60s), and prints the reachable URLs. The default image tag is derived from the
**current git HEAD** (`dev-arm64-<sha>`) — a content-addressed tag, not the
rolling `dev-arm64`, to avoid `docker pull` hitting a stale same-name digest.

```bash
./docker/deploy-dsh-aio-arm64.sh -d dsh.gb10.zhuopu.net   # deploy + bind domain
./docker/deploy-dsh-aio-arm64.sh --info                    # query current deploy
```

## Exposure modes (deploy script)

- **LAN direct (default):** injects `FRONT_PORT=8080` + `TRUSTED_HOSTS`, so any
  LAN machine reaches `http://<host>:8080/` with no ssh tunnel.
- **Domain (`-d <fqdn>`):** additionally injects `VIRTUAL_HOST`/`VIRTUAL_PORT`
  for an nginx-proxy vhost and adds the fqdn to `TRUSTED_HOSTS`
  (`*.gb10.zhuopu.net` resolves to gb10). Requires a running `nginx-proxy`
  container on gb10 — see [`docker/nginx-proxy/`](../../docker/nginx-proxy/),
  a compose file that runs nginx-proxy + dsh-aio together on a `webproxy`
  bridge network with the `*.gb10.zhuopu.net` wildcard cert (HTTPS). That
  compose is the standing gb10 deployment; the `deploy-*.sh` script is the
  quick single-container path. Certs and `.env` are gitignored.
- **Loopback (`LAN_MODE=0`):** binds nothing routable; reach it via ssh tunnel.

`NR_API_KEY` (LLM credential) resolves in order: local env var → gb10's
`~/dsh-aio.env` (`--env-file`) → warn if neither.

## Deploy info: build tag + deploy time

Build tag and deploy timestamp are injected into the container as
`DEPLOY_IMAGE`/`DEPLOY_TS`, and the build commit/time as
`DSH_CLIENT_COMMIT_HASH`/`DSH_BUILD_TS`. Two ways to read them:

- HTTP: `GET http://<host>/deploy-info` → JSON `{image, deployTs, commit, buildTs}`.
  This route lives on the webserver (registered by the client-connection plugin)
  **outside** the `/api` browser-trust fence, so it's readable without an Origin.
- CLI: `./docker/deploy-dsh-aio-arm64.sh --info`, or
  `ssh jereh@10.202.200.139 docker exec dsh-aio printenv DEPLOY_IMAGE DEPLOY_TS`.

## Gotcha: WebSocket dies behind a forward proxy

If the VNC preview (or any dsh WebSocket) fails with close code 1006 **only via
the domain** while `http://<host>:8080/` works, the cause is usually a corporate
forward proxy (e.g. `172.24.0.5:3128`) downgrading plain-HTTP `.zhuopu.net` to
HTTP/1.0 — and WebSocket requires HTTP/1.1. It is not a container/nginx/dsh bug
(raw sockets through nginx complete the handshake fine). Fix at the environment
layer: add `*.zhuopu.net` to the viewer's proxy bypass, or put the domain behind
HTTPS so the browser CONNECT-tunnels through the proxy without a downgrade.
