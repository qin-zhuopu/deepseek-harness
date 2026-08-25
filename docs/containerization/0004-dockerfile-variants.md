# The Dockerfile variant matrix: which one to use when

English | [中文](0004-dockerfile-variants.zh.md)

Status: in use (the layered prod image runs on the 10.1.17.58 app server)

## Summary

The repo carries **8 Dockerfiles** for **2 logical images** — the `dsh` web
image (app only) and the `aio` all-in-one image (app + Chrome + noVNC) —
varied along three axes:

- **public vs internal** — whether the build host can reach the public npm /
  apt registries or must go through the internal Jereh Nexus mirror.
- **dev vs prod** — dsh boots via the tsx source dispatch (dev) or the
  compiled entry `apps/cli/lib/bin.js` (prod, ~1s startup).
- **full build vs layered** — rebuild everything from source, or layer the
  prod display stack onto an already-built aio image.

## Quick picker

| Your situation | Use |
|---|---|
| Public egress, iterating on dsh source | `docker/dsh/Dockerfile` → `dsh:dev`, then `docker/dsh-aio/Dockerfile` |
| Air-gapped build host, building from source | `docker/dsh/Dockerfile.internal` → `dsh:dev`, then `docker/dsh-aio/Dockerfile.internal` |
| Production, public build host, full build | `docker/dsh-aio/Dockerfile.prod` (on top of `dsh:dev`) |
| Production, air-gapped build host, full build | `docker/dsh-aio/Dockerfile.prod.internal` (on top of an internal `dsh:dev`) |
| Production, but **cannot rebuild `dsh:dev`** (npm registry unreachable / too slow) — you already have an aio image | `docker/dsh-aio/Dockerfile.prod.layered` ← *this is how 10.1.17.58 is deployed* |
| You want a container that is **already coding**: a React app scaffolded, dev server up, Chrome on the page | `docker/dsh-aio/Dockerfile.webapp` |

## The full inventory

| # | File | Image | Network | Mode | Build base | Harbor |
|---|------|-------|---------|------|------------|--------|
| 1 | `docker/dsh/Dockerfile` | dsh | public | dev | `node:24` | — (rebase source only) |
| 2 | `docker/dsh/Dockerfile.internal` | dsh | internal | dev | `harbor…/node:24` | — (rebase source only) |
| 3 | `docker/dsh-aio/Dockerfile` | aio | public | dev | `dsh:dev` | `harbor.jereh.cn/base/dsh-aio:dev` |
| 4 | `docker/dsh-aio/Dockerfile.internal` | aio | internal | dev | `dsh:dev` | `harbor.jereh.cn/base/dsh-aio:dev` |
| 5 | `docker/dsh-aio/Dockerfile.prod` | aio | public | **prod** | `dsh:dev` | `harbor.jereh.cn/base/dsh-aio:prod` |
| 6 | `docker/dsh-aio/Dockerfile.prod.internal` | aio | internal | **prod** | `dsh:dev` | `harbor.jereh.cn/base/dsh-aio:prod` |
| 7 | `docker/dsh-aio/Dockerfile.prod.layered` | aio | public* | **prod** | existing aio image | `harbor.jereh.cn/base/dsh-aio:prod` |
| 8 | `docker/dsh-aio/Dockerfile.webapp` | aio + baked app | public | **prod** | existing aio image | `harbor.jereh.cn/base/dsh-aio:webapp` |

\* the layered file's apt step pulls from the public mirror; on an air-gapped
build host swap in the internal Nexus `sed` line from `.prod.internal`.

The `dsh` image has no separate prod variant: its only dev/prod difference is
the launch command, which lives in the `aio` entrypoint (`entrypoint.sh` dev /
`entrypoint.prod.sh` prod). The `dsh` build already emits the compiled output
(`apps/cli/lib/`).

## Axis 1 — public vs internal

Internal variants are for hosts with **no public egress** (e.g. `10.1.17.58`).
Everything routes through the internal Jereh Nexus mirror:

**dsh internal:** `FROM harbor.jereh.cn/base/node:24`;
`COREPACK_NPM_REGISTRY` pointed at Nexus (corepack otherwise hardcodes
`registry.npmjs.org` for pnpm — the first wall hit air-gapped);
`pnpm install --no-frozen-lockfile`.

**aio internal:** node copied from harbor; apt repointed to the internal
Nexus apt mirror with serialized downloads + retries (the mirror 502s under
apt's default parallel fetches).

> On 10.1.17.58 the Nexus apt proxy serves metadata but 502s on `.deb` bodies
> (broken upstream refetch), so nothing is built there at all — images are
> built on an egress-capable host, pushed to `harbor.jereh.cn/base/`, and
> pulled. The layered Dockerfile (#7) is the concrete recipe for that flow.

## Axis 2 — dev vs prod

Two entrypoints under `docker/dsh-aio/`, differing only in the dsh launch line:

- `entrypoint.sh` (dev) — `exec pnpm dsh web …` =
  `node --import tsx/esm apps/cli/src/bin.ts`: runtime TypeScript transpile,
  resident esbuild, ~60s cold start. For iterating on source.
- `entrypoint.prod.sh` (prod) — `exec node apps/cli/lib/bin.js web …`: the
  tsdown build output directly, ~1s startup.

The full workspace `node_modules` is kept in both. `pnpm prune --prod` cannot
be used: it runs the root `postinstall` (no lefthook in prod) and collapses
the workspace symlink tree (1.4G → 144K), breaking module resolution.

## The display stack (all aio variants since the Xvnc rework)

Every aio image now uses the same display stack, designed so the preview
column shows a Chrome that **fills the frame and follows the viewer's
aspect ratio without flickering**:

- **Xvnc** (TigerVNC) instead of Xvfb+x11vnc — an X server with a built-in
  VNC server whose RandR supports arbitrary desktop sizes. Xvfb's RandR only
  switches preset modes, which is why noVNC's `resize=remote` flickered and
  stalled there.
- **vnc-resize-sidecar.py** (`127.0.0.1:6081`) — a persistent RFB client;
  `GET /resize?w&h` sends `SetDesktopSize` to Xvnc. Persistent session
  required: Xvnc segfaults if a client sends SetDesktopSize and disconnects
  immediately.
- **fit-resize.js** — served next to `vnc.html` and referenced from it;
  debounces viewport changes (250ms) and asks the sidecar to match the
  desktop to the viewer. noVNC itself runs `resize=scale` (smooth, never
  flickers) and the desktop always matches the viewport's aspect ratio, so
  the picture fills the frame with no letterboxing.
- **Chrome window fit** — launched with an explicit `--window-size` derived
  from `SCREEN_GEOMETRY` (`--start-maximized` yields a ~10×10 window under a
  bare WM); a watchdog re-fits it via `wmctrl -ir … -e` whenever the desktop
  geometry changes (fluxbox ignores EWMH maximize hints).
- **Quiet resizes** — a no-op `fbsetbg` shim; fluxbox re-applies the
  wallpaper on every RandR change and pops xmessage errors without a
  wallpaper backend installed.
- **Restart safety** — stale `/tmp/.Xn-lock` files are removed before Xvnc
  starts, or restarts die with "Server is already active".

**One viewer at a time.** Every noVNC viewer runs fit-resize; two open
viewers fight over the desktop size (shared-X oscillation).

## Build & run

### dsh (needed by all full-build aio variants)
`COPY . .` needs the **repo root** as the build context, so build from here
(not from inside `docker/dsh/`), naming the Dockerfile explicitly:
```bash
docker build -t dsh:dev -f docker/dsh/Dockerfile .            # public
docker build -t dsh:dev -f docker/dsh/Dockerfile.internal .   # internal
```

### aio
aio's Dockerfiles only `COPY` their sibling files (entrypoints, sidecar, …),
so their context is the `docker/dsh-aio/` directory itself:
```bash
cd docker/dsh-aio

docker build -t dsh-aio:dev  -f Dockerfile .                 # public dev
docker build -t dsh-aio:prod -f Dockerfile.prod .            # public prod (full)
docker build -t dsh-aio:prod -f Dockerfile.prod.layered .    # prod, no dsh rebuild
docker build -t dsh-aio:dev  -f Dockerfile.internal .        # internal dev
docker build -t dsh-aio:prod -f Dockerfile.prod.internal .   # internal prod

docker build -t dsh-aio:webapp -f Dockerfile.webapp .        # webapp variant

# Push to Harbor under the tag that /deploys consume (see the table above).
docker tag dsh-aio:dev    harbor.jereh.cn/base/dsh-aio:dev
docker tag dsh-aio:prod   harbor.jereh.cn/base/dsh-aio:prod
docker tag dsh-aio:webapp harbor.jereh.cn/base/dsh-aio:webapp
docker push harbor.jereh.cn/base/dsh-aio:dev
docker push harbor.jereh.cn/base/dsh-aio:prod
docker push harbor.jereh.cn/base/dsh-aio:webapp

docker run -d --name dsh-aio --network host --shm-size=1g \
  -e NR_API_KEY=<your-key> -e SCREEN_GEOMETRY=576x1440x24 dsh-aio:prod
```

Open:
- dsh Web UI  → http://127.0.0.1:3080/
- Chrome view → http://127.0.0.1:6080/vnc.html

> **`--network host` is required.** dsh web binds `127.0.0.1` only (refuses
> `0.0.0.0` for RCE safety), so `-p 3080:3080` does not work. Other machines
> cannot reach `<host-ip>:3080` directly; access on the host itself or via
> an SSH tunnel.

### Ports

| Port | Service |
|------|---------|
| 3080 | dsh web |
| 6080 | noVNC (websockify) |
| 6081 | vnc-resize-sidecar |
| 5900 | raw VNC (Xvnc) |
| 9222 | Chrome CDP |

### Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `NR_API_KEY` | — | LLM credential; the only required one. |
| `SCREEN_GEOMETRY` | `576x1440x24` | Initial desktop size (the sidecar resizes it to the viewport afterwards). |
| `BIND_ADDR` | `127.0.0.1` | Listen address for websockify and CDP. **Does not move dsh web**, which refuses any non-loopback bind (see below); use `FRONT_PORT` for that. |
| `FRONT_PORT` | — | Enables `front-proxy.js`: one routable port that fans out to all three loopback services. Required behind a reverse proxy. Empty = off. |
| `FRONT_BIND` | `0.0.0.0` | front-proxy listen address. |
| `VNC_PREFIX` | `/vnc` | Path prefix under which front-proxy serves noVNC. |
| `TRUSTED_HOSTS` | — | Comma/space-separated public authorities passed to `dsh web --trusted-host`. Required whenever a browser addresses the container by a public hostname, or every `/api` call answers 403. |
| `INIT_WORKSPACE` | `/root/workspace` | Directory created and registered as a workspace at startup so a fresh container opens ready. Empty = skip. |
| `VNC_PUBLIC_URL` | — | Origin (optionally with a path prefix) where the **browser** reaches this container's noVNC, e.g. `https://dsh-vnc.example.org`. The entrypoint appends `/vnc.html?autoconnect=true&resize=scale` and injects it into the served `index.html` as `window.__DSH_VNC_PREVIEW_URL__`. Empty = the plugin's `127.0.0.1:6080` default. |
| `RESIZE_ENDPOINT` | — | URL or same-origin path where the browser reaches the resize sidecar. Rendered into `vnc-config.js`. Empty = `fit-resize.js` falls back to `<noVNC host>:6081`. |
| `SIDECAR_BIND` | `= BIND_ADDR` | Sidecar listen address. |
| `SIDECAR_PORT` | `6081` | Sidecar port. |
| `DSH_PORT` / `NOVNC_PORT` / `CDP_PORT` / `VNC_PORT` / `DISPLAY_NUM` | `3080` / `6080` / `9222` / `5900` / `99` | Port and display overrides (useful for a second container on one host). |

### The webapp variant: a container that is already coding

Every other variant registers an **empty** workspace: the picker is populated
but the directory has nothing in it. `Dockerfile.webapp` bakes a working project
into the image instead, so opening the container is enough to start:

- a Vite + React + TypeScript app at `/root/workspace`, dependencies installed,
  on one initial commit with a clean tree;
- `CLAUDE.md` describing the project and its environment;
- the Vite dev server started on `127.0.0.1:5173` by the entrypoint;
- the container Chrome already navigated to that URL.

```bash
cd docker/dsh-aio
docker build -t dsh-aio:webapp -f Dockerfile.webapp .
docker tag dsh-aio:webapp harbor.jereh.cn/base/dsh-aio:webapp
docker push harbor.jereh.cn/base/dsh-aio:webapp

docker run -d --name dsh-webapp --network host --shm-size=1g \
  -e NR_API_KEY=<your-key> dsh-aio:webapp
```

It layers on the published aio image, so it never rebuilds dsh. The project is
scaffolded during the build with a pinned `create-vite` rather than vendored
into this repo, which keeps a copied template from drifting from upstream. Cost
is size: ~6.2GB versus ~5.8GB, almost all of it `node_modules`.

Extra variables: `VITE_PORT` (default `5173`) and `OPEN_APP=0` to leave Chrome
on `about:blank` while still starting the dev server.

The entrypoint wraps the base one rather than replacing it — the base script is
moved to `entrypoint.aio.sh` and `exec`'d last, so it still becomes PID 1 and
the display stack, dsh web, and workspace registration behave identically.
`cdp-navigate.js` drives the existing Chrome tab over CDP; it reuses the
`about:blank` target instead of `/json/new`, which would leave a stray tab.

### Behind a reverse proxy

A reverse proxy connects to the container's bridge IP, and `dsh web`
deliberately refuses to bind anything but loopback (`--host 0.0.0.0` exits with
a usage error: it "would expose remote code execution to the network"), so the
proxy cannot reach it directly — and `BIND_ADDR=0.0.0.0` does not change that,
it only moves websockify and CDP.

`FRONT_PORT` is the answer. It starts `front-proxy.js`, the one process that
listens on a routable address, and routes by path to the three services that
stay on loopback:

| Path | Upstream |
|------|----------|
| `/resize` | resize sidecar |
| `/vnc`, `/vnc/*` | noVNC |
| `/websockify` | noVNC (its RFB socket, which noVNC requests at the origin root) |
| everything else | dsh web |

One port also means one vhost and one origin, so `VNC_PUBLIC_URL` and
`RESIZE_ENDPOINT` become same-origin paths and the image never needs to know
its own public hostname:

```yaml
services:
  dsh-aio:
    image: harbor.jereh.cn/base/dsh-aio:prod
    container_name: dsh-aio
    restart: unless-stopped
    shm_size: 1g
    environment:
      NR_API_KEY: <your-key>
      SCREEN_GEOMETRY: 576x1440x24
      FRONT_PORT: 8080
      VNC_PUBLIC_URL: /vnc
      RESIZE_ENDPOINT: /resize
      # Without this every /api call answers 403: front-proxy forwards Host
      # verbatim, and the browser-trust fence accepts only loopback or a
      # declared authority. This exposes the dsh control plane to anything
      # that reaches the proxy — keep the vhost behind the proxy's own auth.
      TRUSTED_HOSTS: dsh.example.org
      VIRTUAL_HOST: dsh.example.org
      VIRTUAL_PORT: 8080
      HTTPS_METHOD: noredirect
```

Plain `VIRTUAL_HOST`/`VIRTUAL_PORT` is enough because there is one port to
route. That also keeps this working on older proxies: `VIRTUAL_HOST_MULTIPORTS`
does not exist before nginx-proxy 1.7, and 1.3.0 ignores it silently. Nothing
extra is needed for the WebSocket upgrade — nginx-proxy's template already
forwards `Upgrade`/`Connection`.

Do not rewrite `Host` when putting your own proxy in front. `dsh web`'s `/api`
fence requires an attached `Origin` to equal the `Host` authority, so a
loopback-rewritten `Host` fails every browser POST with 403. Declare the public
authority in `TRUSTED_HOSTS` instead; a `Host` that is neither loopback nor
declared is still refused, which is the DNS-rebinding defense doing its job.

## Deployment note (10.1.17.58, air-gapped)

1. On an egress-capable host (WSL dev box): `cd docker/dsh-aio && docker build -f
   Dockerfile.prod.layered -t dsh-aio:prod .` (or the full
   `Dockerfile.prod`), push to `harbor.jereh.cn/base/dsh-aio:prod`.
2. On 10.1.17.58: `docker pull`, then run with `--network host`.
3. Remote viewers reach it through SSH local forwards. The preview iframe
   defaults to `127.0.0.1:6080`, which in a tunneled browser points at the
   viewer's own machine, so forward the noVNC and sidecar ports and name the
   forwarded ports in the environment:

   ```bash
   ssh -L 13080:127.0.0.1:3080 -L 16080:127.0.0.1:6080 -L 16081:127.0.0.1:6081 <host>
   ```

   ```bash
   docker run -d --name dsh-aio --network host --shm-size=1g \
     -e NR_API_KEY=<your-key> \
     -e VNC_PUBLIC_URL=http://127.0.0.1:16080 \
     -e RESIZE_ENDPOINT=http://127.0.0.1:16081/resize \
     dsh-aio:prod
   ```

   The viewer then opens `http://127.0.0.1:13080/`. (Earlier revisions patched
   the compiled plugin bundle with a runtime `sed`; these two variables
   replace that.)
