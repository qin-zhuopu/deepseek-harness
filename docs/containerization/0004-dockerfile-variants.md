# The Dockerfile variant matrix: public/internal × dev/prod

English | [中文](0004-dockerfile-variants.zh.md)

Status: in use (the production internal image runs on the 10.1.17.58 app server)

## Summary

The repo carries **6 Dockerfiles** for **2 logical images** (the `dsh` web
image and the `aio` all-in-one image), varied along two axes:

- **public vs internal** — whether the build host can reach the public npm /
  apt registries, or must go through the internal Jereh Nexus mirror.
- **dev vs prod** — whether dsh boots by transpiling TypeScript at runtime
  (`tsx`) or by running the compiled build output (`node .../lib/bin.js`).

| # | File | Image | Network | Mode |
|---|------|-------|---------|------|
| 1 | `Dockerfile` | dsh | public | dev |
| 2 | `Dockerfile.internal` | dsh | internal | dev |
| 3 | `dsh-aio/Dockerfile` | aio | public | dev |
| 4 | `dsh-aio/Dockerfile.internal` | aio | internal | dev |
| 5 | `dsh-aio/Dockerfile.prod` | aio | public | **prod** |
| 6 | `dsh-aio/Dockerfile.prod.internal` | aio | internal | **prod** |

The `dsh` image has no separate prod variant: its only dev/prod difference is
the launch command, which lives in the `aio` entrypoint. The `dsh` build stage
already emits the compiled output (`apps/cli/lib/`), so "prod-ness" is decided
entirely by the `aio` layer's entrypoint.

## The two logical images

### dsh (web only)
Just the dsh web server, no browser. The build runs `pnpm install` +
`pnpm run build`, producing the `lib/` compiled output of 228 workspace
packages plus the web frontend at `apps/web/dist`.

### aio (all-in-one)
dsh web + Chrome(CDP) + noVNC + chrome-devtools MCP, prewired. A two-stage
build: stage 1 `FROM dsh:dev` reuses the built app, stage 2 adds the VNC stack
(Xvfb / x11vnc / fluxbox / noVNC / websockify) on the Chrome base image. See
[0003](0003-all-in-one-chrome-novnc-mcp.md) for the all-in-one design.

## Axis 1 — public vs internal

The internal variants exist for hosts with **no public egress** (e.g. the
`10.1.17.58` app server). Everything is pulled through the internal Jereh Nexus
mirror. The specific changes:

**dsh internal (`Dockerfile.internal`):**
- `FROM harbor.jereh.cn/base/node:24` — node mirrored on harbor, not the public
  library image.
- `ENV COREPACK_NPM_REGISTRY=…/npm-public/` — corepack otherwise hardcodes
  `registry.npmjs.org` to fetch pnpm, which is unreachable air-gapped. This was
  the first wall hit: `pnpm install` succeeds through Nexus, but the earlier
  `corepack prepare pnpm` step failed first.
- `pnpm install --no-frozen-lockfile` so a locally-tweaked lockfile still
  resolves.

**aio internal (`Dockerfile.internal`, `Dockerfile.prod.internal`):**
- node copied from harbor rather than the public `node:24`.
- apt sources repointed to the internal Nexus apt mirror
  (`10.1.7.49:8081/repository/apt-aliyun`), with **serialized downloads +
  retries** (`Acquire::http::Pipeline-Depth=0`, `Queue-Mode=access`,
  `Retries=8`) — the mirror 502s under apt's default parallel connections.

> Note: on `10.1.17.58` the Nexus apt proxy serves metadata (Release/Packages)
> but 502s on the actual `.deb` bodies (broken upstream refetch). In practice we
> don't build the aio image there at all — we build elsewhere, push to harbor,
> and pull. See the deployment note below.

## Axis 2 — dev vs prod

Two entrypoints under `dsh-aio/`:

- `entrypoint.sh` (dev) — final line `exec pnpm dsh web …`, which is
  `node --import tsx/esm apps/cli/src/bin.ts`: it **transpiles TypeScript at
  runtime**, keeps an esbuild service resident, and takes ~60s to come up.
- `entrypoint.prod.sh` (prod) — final line `exec node apps/cli/lib/bin.js web …`:
  it **runs the tsdown build output directly**, with no tsx/esbuild resident,
  and comes up in ~1s.

Everything else (Xvfb → fluxbox → x11vnc → noVNC → Chrome → dsh) is identical.

### Why not `pnpm prune --prod`

This is a pnpm workspace (`workspace:^` internal deps) with many tsx runtime
scripts. `pnpm prune --prod` here:

1. runs the root `postinstall` (no lefthook in prod → fails), and
2. collapses the workspace symlink tree, shrinking `node_modules` from ~1.4G to
   ~144K, which breaks module resolution (`ERR_MODULE_NOT_FOUND`).

So the prod image intentionally keeps the full dependency tree and only swaps
the launch command from tsx to the compiled entry.

## Build & run

### dsh
```bash
docker build -t dsh:dev -f Dockerfile .            # public
docker build -t dsh:dev -f Dockerfile.internal .   # internal
docker run -d --name dsh-web --network host dsh:dev
```

### aio
Stage 1 is `FROM dsh:dev`, so **build `dsh:dev` first**.
```bash
cd docs/containerization/dsh-aio

docker build -t dsh-aio:dev  -f Dockerfile .                 # public dev
docker build -t dsh-aio:prod -f Dockerfile.prod .            # public prod
docker build -t dsh-aio:dev  -f Dockerfile.internal .        # internal dev
docker build -t dsh-aio:prod -f Dockerfile.prod.internal .   # internal prod

docker run -d --name dsh-aio --network host --shm-size=1g \
  -e NR_API_KEY=<your-key> dsh-aio:prod
```

Open:
- dsh Web UI  → http://127.0.0.1:3080/
- Chrome view → http://127.0.0.1:6080/vnc.html

> **`--network host` is required.** dsh web binds `127.0.0.1` only (it refuses
> `0.0.0.0` for RCE safety), so `-p 3080:3080` does not work — the mapping
> targets the container eth0, not its loopback. With host networking the
> server's `127.0.0.1:3080` lands on the host loopback. This also means other
> machines cannot reach `<host-ip>:3080` directly; access it on the host itself
> or via an SSH tunnel.

### Ports

| Port | Service |
|------|---------|
| 3080 | dsh web |
| 6080 | noVNC (websockify) |
| 5900 | raw VNC |
| 9222 | Chrome CDP |

## Deployment note (10.1.17.58, air-gapped)

The host reaches only the internal harbor / Nexus, and its Nexus apt proxy
502s on `.deb` bodies, so we do **not** build the aio image there. Instead:

1. build the images on a host with public egress;
2. push to `harbor.jereh.cn/base/` (`dsh:dev`, `dsh-aio:dev` / `:prod`, and the
   dependency `node:24`);
3. `docker pull` on 10.1.17.58 and run with `--network host`.

Access is via SSH local forward (3080/6080 bind loopback only):
```bash
ssh -N -L 13080:127.0.0.1:3080 -L 16080:127.0.0.1:6080 <10.1.17.58>
# then open http://127.0.0.1:13080/ on your machine
```
