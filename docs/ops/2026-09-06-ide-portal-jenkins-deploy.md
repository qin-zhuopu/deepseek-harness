# 2026-09-06 ide-portal deployed to 10.1.17.58 through Jenkins

English | [中文](2026-09-06-ide-portal-jenkins-deploy.zh.md)

> Ops session journal. No passwords or tokens are recorded here; credentials live in the Jenkins credential store and encrypted `~/.jereh-cli/.env` entries.

## What was deployed

`ide-portal:manual-<utc-stamp>` (commit `9ab415a936`, the autoCheck dual-mode portal) runs as container `ide-portal` on 10.1.17.58: `dc_default`, `VIRTUAL_HOST=ide.jereh-pe.cn`, host-mounted `/opt/ide-provision/{portal.yaml,ide-portal.env,model-key.env}` (0600), named volume `ide-portal-state`. Entry `http://ide.jereh-pe.cn/` serves through `jr-nginx-proxy`; unauthenticated HTML gets `302 → /login → IAM`.

## Jenkins jobs created (new-jenkins.jereh.cn)

- `ide-provision` (0008 executor): Pipeline script from SCM, `*/master` of `bitbucket.jereh.cn/scm/ai/deepseek-harness.git`, credential `bitbucket`, script path `Jenkinsfile.ide-provision`. Created via `POST /createItem` with config.xml cloned from `dsh-aio-dev-build` (the Script Console Groovy path fails on this git plugin's constructor overloads).
- `ide-portal-deploy`: inline pipeline (params `BRANCH`), stages Checkout (`git` step) → Ship tree to host (`git ls-files -z | tar --null -cf - --no-recursion -T -` → ssh tar, tracked files only) → Build and run on host (heredoc `bash -s -- <domain> <dir>`) → Health check (host loopback curl with `Host:` header). Created the same way; config updates via `POST /job/ide-portal-deploy/config.xml`.
- Jenkins user `portal` + project role `ide-provision-runner` (pattern `^ide-provision$`, Item.Build/Read/Cancel) + fixed API token. Verified: `portal` token reads `ide-provision` and 404s everything else. Token written to `/opt/ide-provision/ide-portal.env` on the host.

## Build fixes found by building for real

1. Inline Jenkinsfile in XML: escape `&<>` and nothing else — Groovy string interpolation was the old journal's trap, XML is not that trap.
2. Ship tracked files only: `git ls-files -z | tar --null --create --no-recursion --files-from=-`. A plain `tar -cf - .` carried the Jenkins agent's `.git` (and `core.hooksPath = /dev/null`) into the build context.
3. The portal Dockerfile now deletes the root `postinstall` (lefthook) from the copied `package.json` before `pnpm install` (dev-worktree tooling, fails outside a git checkout), installs the full workspace, and runs `pnpm run build:lib:host`: `@deepseek-ai/dsh-host-auth-core`'s package main entry is built `lib/`, which git does not ship. Without it the container restarts in a loop with `ERR_MODULE_NOT_FOUND`; the proxy answers 502 for its vhost meanwhile.
4. Heredoc `$(...)` inside a Jenkins `sh '''…'''` runs on the agent, not the host — pass values in as `bash -s --` arguments instead.

## Egress finding

10.1.17.58 cannot reach **production** `iam.jereh.cn` (10.1.13.181): ping/443/80 all dead from the host itself (not a docker/iptables problem — `--network host` and the bridge behave the same). Jenkins and Nexus from the same host are fine. The **test** env `iam-test.jereh.cn` (10.1.17.35, same subnet) answers from both the host and 17.58's containers: pointing `portal.yaml` at `https://iam-test.jereh.cn/idp` rendered the real IAM login page end-to-end through Chrome. Production `portal.yaml` is restored; when the network side opens 17.58 → 10.1.13.181, no portal change is needed.

## Verification

- Chrome (CDP, this container): `http://ide.jereh-pe.cn/` → `302 /login?next=/` → IAM authCenter page renders (test env; screenshot taken). Unreachable prod IAM renders the gate's `identity provider unreachable` page — the fail-loud path works.
- Container health: `GET /` (HTML) 302→/login; `/api/state` 401 (API contract); direct container-IP probe 302/401; nginx-proxy vhost live within seconds of `docker run`.
- Wildcard DNS: `ide-<uid>.jereh-pe.cn` already resolves (probed `ide-14409`), so per-user vhosts will need nothing extra.
- `10.1.13.181` (production IAM) answers from this agent container (200) but not from 10.1.17.58; `10.1.17.35` (IAM test, same subnet as 17.58) answers from both. Real sign-in on 17.58 needs a server-side reachability plan for prod (route/firewall from the app subnet, or an in-subnet issuer alias) — the portal's fail-loud page covers the gap meanwhile.
- The implicit flow needs no client secret by design: the browser completes the round-trip and the portal verifies the `id_token` against published JWKS, so no `usk` cookie is forgeable or obtainable headlessly. Scripted clients keep using the shared-secret JWT gate; the portal browser session is the browser's own.
- `/opt/ide-provision/model-key.env` is a placeholder: create-action provisioning needs the requester's `NR_API_KEY` written there; probe/start/health run without it (verified).

## Recurring ops recipes

- Trigger + follow any Jenkins job: `curl -u user:token POST /job/<job>/buildWithParameters`, follow the `Location:` queue item to `executable.number`, poll `…/<n>/api/json` `result`, read `consoleText`.
- Jenkins API tokens are version-prefixed 34 chars (`~` + 32 hex); Script Console `ApiTokenStore.addFixedNewToken(name, token)` registers a chosen value; `generateNewToken` returns a TokenInfo whose plaintext reads through a token-value property.
