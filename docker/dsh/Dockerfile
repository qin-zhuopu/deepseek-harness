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
# NPM_REGISTRY mirrors the NODE_IMAGE redirect philosophy: it defaults to the
# internal nexus mirror (so internal builds are byte-for-byte unchanged) but is
# overridable for builds that cannot reach nexus, e.g.
# --build-arg NPM_REGISTRY=https://registry.npmjs.org/.
ARG NPM_REGISTRY=https://nexus.jereh.cn/repository/npm-public/
RUN npm config set registry ${NPM_REGISTRY}

# ── app ──
WORKDIR /workspaces/deepseek-harness

# CI=true makes scripts/install-lefthook.mjs a no-op for the whole build. With
# .git now in the context the hook installer would fail on
# /workspaces/deepseek-harness/.git/dsh-hooks; git hooks are a developer-local
# concern the image never needs. Set as ENV (not a per-RUN prefix) because
# `pnpm run build` re-triggers install via its deps check, which must also see
# CI=true.
ENV CI=true

# Warm the pnpm store from the lockfile alone: this layer only invalidates
# when dependencies change, so source-only commits keep the ~900-package
# download cached.
# pnpm fetch also needs every file the lockfile's patchedDependencies point at.
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches/ patches/
RUN pnpm fetch

COPY . .

# Install (immutable) from the warmed store.
# fetch leaves node_modules/.pnpm marked as done, which makes install skip
# workspace linking entirely; drop it so install relinks from the warm store.
RUN rm -rf node_modules && pnpm install --frozen-lockfile
# The loader resolves @deepseek-ai plugin packages by name from the loader's
# own location; pnpm only links what the dependency graph references, so link
# every workspace package explicitly and prove the gate's imports resolve.
COPY docker/dsh/link-workspaces.mjs ./
RUN node docker/dsh/link-workspaces.mjs  && test -d node_modules/@deepseek-ai/dsh-client-ui-vnc-preview  && test -d node_modules/@deepseek-ai/cordis-plugin-hmr


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
