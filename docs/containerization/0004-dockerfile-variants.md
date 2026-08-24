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

## Deployment note (10.1.17.58, air-gapped)

1. On an egress-capable host (WSL dev box): `docker build -f
   Dockerfile.prod.layered -t dsh-aio:prod .` (or the full
   `Dockerfile.prod`), push to `harbor.jereh.cn/base/dsh-aio:prod`.
2. On 10.1.17.58: `docker pull`, then run with `--network host`.
3. Remote viewers reach it through SSH local forwards — but note the preview
   iframe defaults to `127.0.0.1:6080`, which in a tunneled browser points
   at the viewer's own machine. For tunneled access, forward the noVNC and
   sidecar ports to matching local numbers (e.g. `-L 16080:127.0.0.1:6080
   -L 6081:127.0.0.1:6081`) and patch the served plugin bundle's URL from
   `:6080` to `:16080` (a runtime sed on
   `/app/packages/extensions/ui-vnc-preview/lib/client.js`; deployment
   detail, not in the repo).
