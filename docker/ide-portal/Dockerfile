# ide-portal — the per-user IDE provisioning portal (docs/containerization/0008)
# Build:   docker build -t ide-portal:dev -f Dockerfile ../..   (context: repo root)
# Run:     see portal.example.yaml header and 0008 Portal (joins dc_default,
#          VIRTUAL_HOST=ide.jereh-pe.cn; deployed once by hand, not self-provisioned).
#
# Internal/air-gapped shape, same mirrors as docker/dsh/Dockerfile.internal:
# base from harbor, pnpm through Nexus; nothing reaches registry.npmjs.org.
# The portal runs from the checked-out sources via Node type stripping, so
# the image carries the workspace closure of apps/ide-portal only
# (dsh-host-auth-core, dsh-host-auth-iam, yaml) — never the whole agent build.

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
RUN pnpm install --no-frozen-lockfile --filter @deepseek-ai/dsh-ide-portal...

# State dir: last-triggered-build marker files (N3); mount a named volume here.
# Secrets are never baked: the Jenkins API token and the platform model key
# arrive via --env-file at run time (0008 Model key flow, SR5).
RUN mkdir -p /var/lib/ide-portal
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD ["node", "-e", "fetch('http://127.0.0.1:8080/login').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "--experimental-strip-types", "apps/ide-portal/src/cli.ts", "--config", "/etc/ide-portal/portal.yaml", "--state", "/var/lib/ide-portal"]
