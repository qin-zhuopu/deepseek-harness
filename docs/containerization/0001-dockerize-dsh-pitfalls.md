# Dockerizing dsh: base image, git, commit hash, and loopback networking

English | [中文](0001-dockerize-dsh-pitfalls.zh.md)

Status: resolved

## Executive summary

dsh is a pnpm monorepo (Node `^22.19.0 || >=24.0.0`, pinned `pnpm@11.7.0`) with
no shipped Dockerfile. Containerizing it in a restricted internal-network
environment (no public npm/registry access) hit four pitfalls in a row: the
in-house base image lacked corepack; `node:24-slim` cannot `apt-get` from the
outside Debian mirror and ships no `git`; the build calls `git rev-parse HEAD`
which fails when the build context carries no `.git`; and `dsh web` refuses to
bind `0.0.0.0`, so `-p 3080:3080` never connects. The working recipe: base on
full `node:24` (bundles git + corepack), point npm at the internal Nexus, feed
the commit through `DSH_CLIENT_COMMIT_HASH`, and run with `--network host`.

## Environment

- Build host: Windows, Docker running inside WSL2 (Ubuntu-24.04), kernel
  `6.6.87.2-microsoft-standard-WSL2`.
- Internal mirrors: npm via Nexus (`https://nexus.jereh.cn/repository/npm-public/`),
  Docker images via Harbor (`harbor.jereh.cn`). Public `registry.npmjs.org` and
  `deb.debian.org` are slow or unreachable from here.
- Build the image on the WSL ext4 filesystem, not under `/mnt/c`: the 9P/drvfs
  mount is slow and mishandles the symlinks a pnpm monorepo creates.

## Pitfalls and fixes

### 1. In-house base image has no corepack

The internal `harbor.jereh.cn/base/ubuntu:24.04-node22-python312[-chrome]` image
installs Node through nvm under a `dev` user, and its node bin layout is
inconsistent when the container runs as root: `corepack` resolves to
`not found`, and `node`/`npm` are reachable only through a login shell. Building
on it failed at `corepack enable`.

Fix: use the official `node:24` image, which puts `node`, `npm`, and `corepack`
on a stable PATH. Node `24.19.0` satisfies the engine floor.

### 2. `node:24-slim` cannot apt-get, and has no git

The slim image is Debian-based; `apt-get update` hangs on `deb.debian.org`
(Fastly CDN) because outbound access is restricted, and Nexus only proxies an
Ubuntu apt mirror (`apt-aliyun`), not Debian — the codenames do not match, so it
cannot substitute for a Debian base. The slim image also omits `git`, which the
install (lefthook postinstall) and the build (`git rev-parse HEAD`) both need.

Fix: use full `node:24` (Debian bookworm) — it bundles `git 2.39.5`, so no
`apt-get` is needed at all. Avoiding apt sidesteps the mirror problem entirely.

### 3. Build calls `git rev-parse HEAD` with no `.git` present

[`scripts/client-build-environment.ts`](../../scripts/client-build-environment.ts)
embeds the source commit in client artifacts. The build context has no `.git`
(it is excluded, and copying it is wasteful), so `git rev-parse HEAD` exits 128
and `pnpm run build` dies. Even with git installed, there is no repository to
read.

Fix: the same function honours the `DSH_CLIENT_COMMIT_HASH` environment variable
and skips the git call when it is set. The Dockerfile passes the source commit
through an `ARG`/`ENV`:

```dockerfile
ARG DSH_CLIENT_COMMIT_HASH=<source commit>
ENV DSH_CLIENT_COMMIT_HASH=${DSH_CLIENT_COMMIT_HASH}
```

Set the `ENV` right before `RUN pnpm run build`, after the install layer, so
changing the commit does not invalidate the cached `pnpm install`.

### 4. `dsh web` binds loopback only — `-p` does not work

`dsh web` intentionally refuses `--host 0.0.0.0`
([`packages/bundle/web-app/src/startup.ts`](../../packages/bundle/web-app/src/startup.ts))
to avoid exposing remote code execution to the network; it binds `127.0.0.1`
only. A published port (`-p 3080:3080`) forwards to the container's eth0, not its
loopback, so the mapping never connects (HTTP 000 from inside and outside).

Fix: run with `--network host`. The server's `127.0.0.1:3080` then lives on the
host loopback. On WSL2 that loopback is reachable from Windows at
`http://127.0.0.1:3080/`, and confinement to loopback is preserved — the UI is
not exposed to the LAN.

```bash
docker run -d --name dsh-web --network host dsh:dev
# then open http://127.0.0.1:3080/
```

## Verified result

`pnpm run build` records 200 client artifacts; the container serves the web UI,
and Windows reaches `http://127.0.0.1:3080/` returning HTTP 200 with title
`DSH Local Build`.

## Lessons

- Prefer the full `node:<major>` image over `-slim` for CI-shaped builds behind a
  restricted network: it bundles git and avoids an apt round-trip that a private
  mirror may not cover for the right distro.
- A build that reads VCS state needs an explicit non-VCS input for gitless
  contexts; dsh already exposes `DSH_CLIENT_COMMIT_HASH` for exactly this.
- A loopback-only server and Docker published ports are incompatible by design;
  `--network host` is the correct bridge, and it keeps the loopback guarantee.
- Build on the Linux-native filesystem; a pnpm monorepo's symlinks and file count
  make `/mnt/c` builds slow and fragile.
