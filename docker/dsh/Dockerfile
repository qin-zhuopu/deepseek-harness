# DeepSeek Harness (dsh) — container image
# Build:   docker build -t dsh:dev .
# Run:     docker run -d --name dsh-web --network host dsh:dev
#
# NOTE: dsh web binds 127.0.0.1 only (it refuses --host 0.0.0.0 for RCE safety),
# so `-p 3080:3080` does NOT work — the mapping targets the container's eth0, not
# its loopback. Use `--network host`: the server's 127.0.0.1:3080 then lands on
# the host loopback (on WSL2, reachable from Windows at http://127.0.0.1:3080/).
#
# Builds for the host's own CPU; linux/amd64 and linux/arm64 both work, because
# every native dependency (esbuild, sharp, node-pty, @vscode/ripgrep,
# node-addon-landlock-run) publishes both and `pnpm install` resolves the
# optional dependency matching the build platform. The build therefore must NOT
# receive a node_modules from the host — see .dockerignore.
#
# NODE_IMAGE redirects the base image at a registry mirror on hosts that cannot
# reach Docker Hub, e.g. --build-arg NODE_IMAGE=docker.1ms.run/library/node:24.

ARG NODE_IMAGE=node:24
FROM ${NODE_IMAGE}

# ── corepack + pnpm (pinned by repo) ──
RUN corepack enable && corepack prepare pnpm@11.7.0 --activate

# ── npm through the internal Nexus ──
RUN npm config set registry https://nexus.jereh.cn/repository/npm-public/

# ── app ──
WORKDIR /app

COPY . .

# Install (immutable). CI=true makes scripts/install-lefthook.mjs no-op: git
# hooks are a developer-local concern, and with .git now in the context the
# hook installer would otherwise fail on /app/.git/dsh-hooks during build.
RUN CI=true pnpm install --frozen-lockfile

# .git now ships in the image (see .dockerignore) so the dev container can
# git pull/diff. The build still takes the commit as an explicit arg rather
# than calling `git rev-parse`, so build output does not depend on .git.
ARG DSH_CLIENT_COMMIT_HASH=b150a551b8d465e31e418e1b2eaf5e79bbb7d28e
ENV DSH_CLIENT_COMMIT_HASH=${DSH_CLIENT_COMMIT_HASH}
# Bake time of the docker build (passed by docker/build-dsh-aio-dev-*.sh).
ARG DSH_BUILD_TS=unknown
ENV DSH_BUILD_TS=${DSH_BUILD_TS}

# Build library + web artifacts
RUN pnpm run build

# dsh web listens on 3080 by default
EXPOSE 3080

# Container has no browser: --no-open keeps it headless.
CMD ["pnpm", "dsh", "web", "--no-open"]
