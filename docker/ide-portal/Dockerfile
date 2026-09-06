# ide-portal — the per-user IDE provisioning portal (docs/containerization/0008)
# Build:   docker build -t ide-portal:dev -f Dockerfile ../..   (context: repo root)
# Run:     see portal.example.yaml header and 0008 Portal (joins dc_default,
#          VIRTUAL_HOST=ide.jereh-pe.cn; deployed once by hand, not self-provisioned).
#
# Internal/air-gapped shape, same mirrors as docker/dsh/Dockerfile.internal:
# base from harbor, pnpm through Nexus; nothing reaches registry.npmjs.org.
# The portal runs from the checked-out sources via Node type stripping; the
# `build:lib:host` pass emits the lib/ runtimes its dependencies expose
# through their main entries (dsh-host-auth-core, dsh-host-auth-iam).
# The web frontend and client face stay unbuilt.

ARG NODE_IMAGE=harbor.jereh.cn/base/node:24
ARG NPM_REGISTRY=https://nexus.jereh.cn/repository/npm-public/

FROM ${NODE_IMAGE}

ARG NPM_REGISTRY

ENV COREPACK_NPM_REGISTRY=${NPM_REGISTRY}
ENV COREPACK_INTEGRITY_KEYS=0
RUN corepack enable && corepack prepare pnpm@11.7.0 --activate
RUN npm config set registry ${NPM_REGISTRY}

WORKDIR /workspaces/deepseek-harness
COPY . .
# The lefthook git-hook installer is development-worktree tooling: the image is
# not a checkout, and its postinstall fails when the build inherits a
# core.hooksPath (the Jenkins agent's is /dev/null).
RUN node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json','utf8'));delete p.scripts.postinstall;fs.writeFileSync('package.json',JSON.stringify(p,null,2))"
RUN pnpm install --no-frozen-lockfile

# Host-face lib/ artifacts: the portal runs its own sources through Node type
# stripping, but @deepseek-ai/dsh-host-auth-core resolves through its package
# main entry, which is built lib/ (gitignored). Same pass the dsh internal
# image runs, minus the client face and the web frontend.
RUN pnpm run build:lib:host

# State dir: last-triggered-build marker files (N3); mount a named volume here.
# Secrets are never baked: the Jenkins API token arrives via --env-file at
# run time; the model key never reaches the portal (Jenkins credential
# binding at create, 0008 Model key flow, SR5).
RUN mkdir -p /var/lib/ide-portal
EXPOSE 8080
# /login is always public; the authenticated / 401s without a session, so the
# probe must not treat sign-in as failure (0008 Rollout).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD ["node", "-e", "fetch('http://127.0.0.1:8080/login').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "--experimental-strip-types", "apps/ide-portal/src/cli.ts", "--config", "/etc/ide-portal/portal.yaml", "--state", "/var/lib/ide-portal"]
