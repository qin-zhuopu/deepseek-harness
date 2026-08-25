# The Dockerfile variant matrix: which one to use when

English | [中文](0004-dockerfile-variants.zh.md)

Status: in use (the layered prod image runs on the 10.1.17.58 app server)

## Summary

The repo carries **7 Dockerfiles** for **2 logical images** — the `dsh` web
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
| Public egress, iterating on dsh source | `Dockerfile` (repo root) → `dsh:dev`, then `dsh-aio/Dockerfile` |
| Air-gapped build host, building from source | `Dockerfile.internal` → `dsh:dev`, then `dsh-aio/Dockerfile.internal` |
| Production, public build host, full build | `dsh-aio/Dockerfile.prod` (on top of `dsh:dev`) |
| Production, air-gapped build host, full build | `dsh-aio/Dockerfile.prod.internal` (on top of an internal `dsh:dev`) |
| Production, but **cannot rebuild `dsh:dev`** (npm registry unreachable / too slow) — you already have an aio image | `dsh-aio/Dockerfile.prod.layered` ← *this is how 10.1.17.58 is deployed* |

## The full inventory

| # | File | Image | Network | Mode | Build base |
|---|------|-------|---------|------|------------|
| 1 | `Dockerfile` (root) | dsh | public | dev | `node:24` |
| 2 | `Dockerfile.internal` (root) | dsh | internal | dev | `harbor…/node:24` |
| 3 | `dsh-aio/Dockerfile` | aio | public | dev | `dsh:dev` |
| 4 | `dsh-aio/Dockerfile.internal` | aio | internal | dev | `dsh:dev` |
| 5 | `dsh-aio/Dockerfile.prod` | aio | public | **prod** | `dsh:dev` |
| 6 | `dsh-aio/Dockerfile.prod.internal` | aio | internal | **prod** | `dsh:dev` |
| 7 | `dsh-aio/Dockerfile.prod.layered` | aio | public* | **prod** | existing aio image |

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

Two entrypoints under `dsh-aio/`, differing only in the dsh launch line:

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
```bash
docker build -t dsh:dev -f Dockerfile .            # public
docker build -t dsh:dev -f Dockerfile.internal .   # internal
```

### aio
```bash
cd docs/containerization/dsh-aio

docker build -t dsh-aio:dev  -f Dockerfile .                 # public dev
docker build -t dsh-aio:prod -f Dockerfile.prod .            # public prod (full)
docker build -t dsh-aio:prod -f Dockerfile.prod.layered .    # prod, no dsh rebuild
docker build -t dsh-aio:dev  -f Dockerfile.internal .        # internal dev
docker build -t dsh-aio:prod -f Dockerfile.prod.internal .   # internal prod

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
| `BIND_ADDR` | `127.0.0.1` | Listen address for dsh web, websockify and CDP. |
| `INIT_WORKSPACE` | `/root/workspace` | Directory created and registered as a workspace at startup so a fresh container opens ready. Empty = skip. |
| `VNC_PUBLIC_URL` | — | Origin (optionally with a path prefix) where the **browser** reaches this container's noVNC, e.g. `https://dsh-vnc.example.org`. The entrypoint appends `/vnc.html?autoconnect=true&resize=scale` and injects it into the served `index.html` as `window.__DSH_VNC_PREVIEW_URL__`. Empty = the plugin's `127.0.0.1:6080` default. |
| `RESIZE_ENDPOINT` | — | URL or same-origin path where the browser reaches the resize sidecar. Rendered into `vnc-config.js`. Empty = `fit-resize.js` falls back to `<noVNC host>:6081`. |
| `SIDECAR_BIND` | `= BIND_ADDR` | Sidecar listen address. |
| `SIDECAR_PORT` | `6081` | Sidecar port. |
| `DSH_PORT` / `NOVNC_PORT` / `CDP_PORT` / `VNC_PORT` / `DISPLAY_NUM` | `3080` / `6080` / `9222` / `5900` / `99` | Port and display overrides (useful for a second container on one host). |

### Behind a reverse proxy (nginx-proxy)

With ports published straight to the host, both browser-facing URLs default to
`127.0.0.1`, which is correct only when the browser runs on the Docker host.
Behind a proxy the browser cannot reach those ports, so set `VNC_PUBLIC_URL`
and `RESIZE_ENDPOINT` — that is what they exist for.

Two hostnames rather than one host with path prefixes: `vnc.html` loads
`core/`, `app/` and friends by relative path, so mounting noVNC under a
sub-path would send those requests to the other service at the domain root.

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
      # nginx-proxy reaches the container by its bridge IP, so loopback-only
      # listeners are unreachable. This opens the dsh control plane to
      # anything that can reach the proxy — keep the vhost behind the proxy's
      # own auth (htpasswd/JWT).
      BIND_ADDR: 0.0.0.0
      VNC_PUBLIC_URL: https://dsh-vnc.example.org
      RESIZE_ENDPOINT: https://dsh-vnc.example.org/resize
      HTTPS_METHOD: noredirect
      VIRTUAL_HOST_MULTIPORTS: |-
        dsh.example.org:
          "/":
            port: 3080
        dsh-vnc.example.org:
          "/":
            port: 6080
          "/resize":
            port: 6081
    networks:
      - proxy-net
```

Spell out `port` on every path: nginx-proxy's "default port" is the container's
single exposed port, and this image exposes five, so an omitted `port` falls
back to 80 where nothing listens. WebSocket upgrade needs no extra
configuration — nginx-proxy's template forwards `Upgrade`/`Connection` already.

## Deployment note (10.1.17.58, air-gapped)

1. On an egress-capable host (WSL dev box): `docker build -f
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
