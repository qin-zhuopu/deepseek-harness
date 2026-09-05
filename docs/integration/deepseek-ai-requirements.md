# deepseek-ai upstream integration: reverse-engineered fork requirements

## What this document is

This is an integration audit dossier, not a durable subsystem reference. Its job is to recover the business intent behind every fork change that collides with upstream in the `vendor/deepseek-ai -> develop` merge, so each requirement can be re-implemented deliberately on the restructured upstream host architecture rather than resolved by mechanical "keep ours / keep theirs" conflict picking. Because that is its purpose, it cites commit hashes and diffs as evidence, the way an Agent Note or postmortem does.

Every requirement below is grounded in real commit messages and diffs reachable in this repository. No intent is inferred without a cited commit.

## Background and divergence point

| Fact | Value |
|---|---|
| Fork remote | `origin` = `qin-zhuopu/deepseek-harness` |
| Upstream remote | `upstream` = `deepseek-ai/deepseek-harness` (mirrored to branch `vendor/deepseek-ai`) |
| Merge base (divergence point) | `b150a551b8` (`dsh-0.1.1-rc.2`) |
| Fork tip | `develop` = `b45945fe1b` |
| Upstream tip | `vendor/deepseek-ai` = `d347e70390` (`dsh-0.1.3-alpha.1`) |
| Fork commits since divergence | 82 non-merge business commits (92 including merges) |

Reproduce the conflict survey with:

```sh
git checkout develop
git merge --no-commit --no-ff vendor/deepseek-ai
git status --porcelain=v1 | grep -E '^(UU|UD|DU)'   # 59 files
git merge --abort
```

The survey yields 59 conflicting files: 33 `UU` (both sides changed the same content), 19 `UD` (fork changed, upstream deleted), 7 `DU` (fork deleted, upstream changed).

## The structural fact that dominates the migration: ApiProxy is gone upstream

At the divergence point, `packages/host/` contained both the legacy `apiproxy` package and the newer `directory-picker*` packages. The fork continued to extend `apiproxy`. Upstream took the opposite path: it migrated `apiproxy`'s unary RPC domains to a new "Remote" transport and then deleted the whole package.

Upstream evidence (reachable via `git log b150a551b8..vendor/deepseek-ai`):

- `306419cc84 refactor(agent-presets): expose browser operations through Remote`
- `377f3b4f1d feat(subagent): migrate browser control to Remote`
- `6e4087626d refactor(apiproxy)!: remove directory-picker RPCs`
- `fd7f2065b2 refactor(apiproxy)!: remove settings and credentials RPCs`
- `ce3391e280 refactor(apiproxy): retire migrated unary routes`
- `4f00a8b82a refactor(api): remove ApiProxy package` (deletes the entire `packages/host/apiproxy` tree)

Confirmed by inspection: `packages/host/apiproxy/src/index.ts` exists on `develop` and at the merge base, but is absent in `vendor/deepseek-ai`. Upstream `packages/host/` is now `directory-picker-auto`, `directory-picker-browse`, `directory-picker-native`, `directory-picker`, `frontend-static`, `plugin-inventory`, `webserver`.

Consequence: every fork feature that hangs off `apiproxy` (restricted workspace, create-from-prompt, and the original `/deploy-info` location) cannot be carried over by keeping the fork's files. Each must be re-landed against the Remote transport / new host packages. This is the primary redo risk and is called out per requirement below.

The same delete-vs-extend inversion appears client-side: upstream removed `packages/client/runtime/src/client/workspaces/{service,manager}.ts` and `contract/workspaces.ts` (the workspace runtime the fork extended for create-from-prompt), and removed the settings/credentials RPC path that made the fork's remote-access relaxation necessary.

## Requirements by theme

Each entry records: intent (why the fork changed this, from the commit message + diff), source commits, files touched that appear in the conflict set, conflict type, upstream disposition, and redo notes for re-implementing on the upstream architecture.

### R1. Restricted workspace: fixed root, disk->registry mirror, no manual add entry

- **Intent.** Turn the workspace model into a locked-down container deployment: a single fixed root directory (`/workspaces`, configurable via `apiProxy.workspaceRoot`) is the only place workspaces live. The gateway `mkdir`s the root, seeds one `daily` workspace when empty so the sidebar is never blank, mirrors the root's direct child directories into the registry one-way (disk -> registry) with a debounced `fs.watch` reconcile, and rejects `workspace.create` for any path that is not a direct child of the root. The frontend removes both the "add from directory" and prompt entry points, so a user can only get a workspace by having the agent `mkdir` one under the root.
- **Source commits.** `1781c3b299` (core), `2442cd9e52` (seed directory name `system-admin` decoupled from the Chinese display title `系统管理`, via an optional `title` on `ensureWorkspace`), `ab84cf2b1d` (default permission set to `danger-full-access` + hide `/model` slash command).
- **Conflict files.** `packages/host/apiproxy/src/api-proxy.ts` (UD), `packages/host/apiproxy/src/api/index.ts` (UD), `packages/host/apiproxy/src/index.ts` (UD), `packages/host/apiproxy/tests/api-proxy-workspace.spec.ts` (UD), `packages/host/apiproxy/tests/client-handler.spec.ts` (UD), `packages/host/apiproxy/tests/fetch-carrier.spec.ts` (UD), `packages/client/connection/src/client/fixture.ts` (UU), `packages/client/ui-workspace/src/client/rows/WorkspaceBrowser.tsx` (UU; fork file lives at `src/client/WorkspaceBrowser.tsx`, upstream moved it under `rows/`).
- **Upstream disposition.** `apiproxy` deleted. `WorkspaceBrowser.tsx` relocated to `rows/` and independently changed. The `initWorkspaceRoot` service hook, the `workspaceRoot` config, and the `workspace-invalid-path` prefix guard have no upstream home.
- **Redo notes.** The `mkdir` + seed + `fs.watch` debounce + one-way reconcile + `realpathNormalize` prefix guard is self-contained logic that must be re-hosted wherever workspace registration now lives after the Remote migration. `ab84cf2b1d` also edits `packages/bundle/web-app/cordis.patch.yml` and `packages/client/ui-model-selection/src/client/index.ts` (not in the conflict set) for full-access default + `/model` hiding; re-verify those still apply against the upstream profile schema.

### R2. Create a workspace from a natural-language prompt

- **Intent.** Let an operator describe a workspace in free text; the Host asks its default model to derive a short, filesystem-safe directory name, mints the directory under the fixed root (deduplicating collisions with a numeric counter), and adopts it. Errors map to stable wire codes by stage (`workspace-prompt-unavailable`, `workspace-prompt-rejected`, `workspace-invalid-path`). A sparkle-button + modal in the workspace browser drives it, with busy/disabled state, inline Host error surfacing, and zh/en locales. The `llm` `GenerateOptions` purpose set expands with `workspace-create-from-prompt`.
- **Source commits.** `3b284a82c6` (apiproxy RPC `workspace.createFromPrompt` + schema/rpc-map/fetch carrier), `14e1a77959` (thread through connection contract, `WorkspaceManager`, `WorkspaceRuntime` service, fakes/fixtures/test-support), `12499c3fc6` (create-from-description modal in the browser).
- **Conflict files.** `packages/host/apiproxy/src/api/rpc-map.ts` (UD), `.../api/rpc.schema.ts` (UD), `.../api/rpc.ts` (UD), `.../api/workspace.schema.ts` (UD), `.../api/workspace.ts` (UD), `.../fetch/client.ts` (UD), `.../fetch/handler.ts` (UD), `packages/client/runtime/src/client/contract/workspaces.ts` (UD), `.../workspaces/manager.ts` (UD), `.../workspaces/service.ts` (UD), `packages/client/runtime/tests/fake-api.client.ts` (UD), `packages/client/runtime/tests/workspaces-service.client.spec.ts` (UD), `packages/client/connection/tests/fake-api.client.ts` (UD), `packages/client/connection/src/client/fixture.ts` (UU), `packages/client/ui-workspace/src/client/index.ts` (UU), `packages/client/ui-workspace/src/client/rows/WorkspaceBrowser.tsx` (UU), `packages/client/ui-workspace/tests/workspace-picker.client.spec.tsx` (UU), `packages/test-support/client-runtime/src/workspaces.ts` (UU).
- **Upstream disposition.** The entire apiproxy RPC surface and the `client/runtime` workspaces service/manager/contract were deleted upstream as part of the Remote migration. The UI browser was relocated and independently reworked.
- **Redo notes.** This is the deepest cross-cutting feature: it spans Host RPC schema, the client transport contract, the runtime manager/service, test doubles, and UI. Re-implementing requires expressing `createFromPrompt` as a Remote operation (not an apiproxy unary route) and re-threading the client runtime equivalent. The model-naming prompt logic and the three staged error codes are reusable as-is; the transport wiring is a full rewrite.

### R3. JWT authentication guard for host HTTP endpoints

- **Intent.** Gate the Host HTTP endpoints behind JWT auth. A new package `@deepseek-ai/dsh-host-auth-jwt` provides compact HS256 sign/verify over `node:crypto` (algorithm allow-list, strict base64url re-encode, timing-safe compare, expiry enforced) plus a `WebGuard` provider that admits authorized requests through the webserver guard seam and rejects the rest, with an invariant installer. The webserver exposes the `WebGuard` / `WebGuardSurface` / `UpgradeGuard` seam the package registers against.
- **Source commits.** `5c2daf0f57` (feature), `0d5266561f` (Agent Note recording the decision), `9513a2ac37` (catalog regeneration for the new guard types), `43814ab7da` (declare auth-jwt model-experience as none).
- **Conflict files.** `packages/host/webserver/src/index.ts` (UU), `packages/host/webserver/README.md` / `.i18n.yaml` / `.zh.md` (UU x3), `packages/host/apiproxy/src/api/index.ts` (UD; JSDoc-only touch stating the watcher disposer contract).
- **Upstream disposition.** `webserver` survives upstream and was independently changed (hence UU on `src/index.ts` and its READMEs). The new `auth-jwt` package itself is fork-only and does not conflict (it is an addition), but it depends on the webserver guard seam that the fork added to `webserver/src/index.ts`.
- **Redo notes.** The guard seam the fork added to `webserver/src/index.ts` must be reconciled with upstream's own edits to the same file; confirm upstream still exposes an equivalent request/upgrade guard extension point, and re-anchor the `WebGuard` registration to it. The `auth-jwt` package logic is transport-agnostic and portable.

### R4. `/deploy-info` build/deploy metadata endpoint

- **Intent.** Expose a read-only JSON endpoint outside the `/api` fence for ops checks and the deploy script's verification: image tag and deploy timestamp from `DEPLOY_IMAGE` / `DEPLOY_TS`, source commit from the baked `DSH_CLIENT_COMMIT_HASH`, and a new `DSH_BUILD_TS` build arg baked by both dsh Dockerfiles.
- **Source commits.** `4ed1a97b81` (serve metadata; originally placed in `apiproxy` `toFetchHandler`), `804814d1f0` (fix: register `/deploy-info` as a real public exact webserver route, because `toFetchHandler` was only reached for `/api`-prefixed paths so the endpoint 404'd against the static fallback).
- **Conflict files.** `packages/client/connection/src/index.ts` (UU), `packages/client/connection/tests/node-half.host.spec.ts` (UU). (The `4ed1a97b81` apiproxy handler code was moved out again by `804814d1f0`, so the live route now sits in `connection`.)
- **Upstream disposition.** `connection/src/index.ts` survives and was independently changed upstream (UU). The route registration must be reconciled with upstream's route table shape.
- **Redo notes.** The endpoint's final home is the webserver public-route registration in `connection`, not apiproxy, so the apiproxy deletion does not strand it. Re-apply the exact public-route registration against upstream's current route API, keeping it outside `/api` and the browser-trust fence (read-only, read without an `Origin`).

### R5. Non-secure-context id minting (http-by-hostname deployments)

- **Intent.** Fix a hard failure on deployments reached over plain `http://<hostname>` (not localhost, not a tunnel): `crypto.randomUUID` is a secure-context-only browser API, so RPC id minting, the conversation composer's draft attachment id, and client-side message id creation all threw `crypto.randomUUID is not a function`, breaking every RPC. Both browser-side call sites fall back to a v4 assembled from `crypto.getRandomValues` (which insecure origins do expose), matching the existing fallback already present in `client/connection` (`random-uuid.ts`).
- **Source commits.** `e800a19113` (rpc id + composer draft attachment id), `9997c0175a` (client-side message id in `llm`, found by scanning all 54 built `client.js` bundles).
- **Conflict files.** `packages/client/ui-conversation/src/client/service.ts` (UU), `packages/llm/llm/src/message.ts` (UU), `packages/host/apiproxy/src/fetch/client.ts` (UD; the rpc-id mint site inside apiproxy's fetch client).
- **Upstream disposition.** `ui-conversation/service.ts` and `llm/message.ts` survive and were independently changed (UU). The apiproxy `fetch/client.ts` mint site was deleted with apiproxy.
- **Redo notes.** Re-apply the `getRandomValues` v4 fallback at whatever call sites survive in `ui-conversation` and `llm` after merge. The apiproxy `fetch/client.ts` fallback moves to whatever mints rpc ids under the Remote transport. Check whether upstream already centralized id minting (the fork noted `connection/random-uuid.ts` already has this shape) so the fix may consolidate rather than duplicate.

### R6. VNC preview column, right icon rail, files tab, noVNC scaling

- **Intent.** Give the web UI an embedded remote-desktop preview. `ui-layout` gains a resizable fourth grid track (`preview`) so the right-edge preview participates in width distribution (true three-column sidebar | conversation | preview), plus a fifth fixed-width right icon rail (`RAIL_RIGHT=44`) hosting an extensible `rail.right.action` icon stack; the VNC preview toggle moves off the sidebar footer onto that rail. The `ui-vnc-preview` extension registers into the `preview` column, adds a files tab (served same-origin through the front proxy), and defaults the noVNC URL to `?autoconnect=true&resize=scale` so the desktop scales to the column width.
- **Source commits.** `9e9e45c4ef` (resizable preview column + plugin), `745c2c1a64` (right icon rail + move toggle), `71999de837` (noVNC scale-to-column), `fdf2fb0469` (files tab), `470aaa73ca` (serve files tab same-origin through front proxy).
- **Conflict files.** `packages/client/ui-layout/src/client/AppFrame.tsx` (UU), `packages/client/ui-layout/src/client/AppFrame.module.css` (UU).
- **Upstream disposition.** `AppFrame.tsx` / `.module.css` survive and were independently changed upstream (UU on the layout grid). The `ui-vnc-preview` extension is fork-only (not in the conflict set).
- **Redo notes.** The grid-track additions (`preview` + `RAIL_RIGHT`) must be re-expressed against upstream's current `computeColumns` / concession-solve layout; upstream's independent AppFrame edits may have changed track math. The extension side (`ui-vnc-preview`) ports cleanly once the layout slots (`preview`, `rail.right.action`) exist.

### R7. De-beta the onboarding: remove welcome-notice, relax remote access, remove VNC new-tab button

- **Intent.** Strip the internal-beta onboarding modal (`welcome-notice`), its component/store/copy/tests, and the VNC "open in new tab" icon button; add company deployment hosts to the loopback-equivalent allow-list so remote domain access stops reporting "settings are unavailable in this browser"; switch the preset model to `litellm.jereh.cn`'s `Jereh-DeepSeek-V4-Flash-0731`; and hide settings + footer actions from the sidebar.
- **Source commits.** `30bee82f2e` (remove welcome-notice + VNC new-tab button + `dsh.gb10.zhuopu.net` in `TRUSTED_HOSTNAMES` of `loopback-hostname.ts` + preset model), `06ee3b0d35` (hide sidebar settings/footer actions), `b1e081e538` (clean up residual `WELCOME_NOTICE` / `welcomeNoticePending` references in scaffold + e2e that broke the host tsc build), plus later `4bef5ca619` / `276c5a9896` on the same sidebar theme (not in the conflict set).
- **Conflict files.** `packages/client/ui-settings-models/src/client/WelcomeNotice.tsx` (DU), `.../src/client/welcome-store.ts` (DU), `.../src/onboarding-copy.ts` (DU), `.../tests/welcome-notice.client.spec.tsx` (DU), `.../tests/welcome-store.client.spec.ts` (DU), `apps/web/tests/remote-welcome.e2e.ts` (DU), `apps/web/tests/expected/onboarding-deepseek-config/welcome.expected.md` (DU), `packages/client/ui-settings-models/src/client/locales.ts` (UU), `packages/client/ui-settings-models/tests/apply.client.spec.ts` (UU), `apps/web/tests/onboarding-deepseek-config.e2e.ts` (UU), `apps/web/tests/scaffold.ts` (UU).
- **Upstream disposition.** These are the 7 `DU` conflicts: the fork DELETED the welcome-notice files while upstream KEPT and MODIFIED them (upstream still ships the onboarding notice). Confirmed: `welcome-store.ts` is absent on `develop` but present in `vendor/deepseek-ai`. The `locales.ts` / `apply.client.spec.ts` / e2e / scaffold files are UU because both sides edited surviving files.
- **Redo notes.** This is an intentional removal, so the redo is "re-delete or neutralize upstream's welcome-notice again" rather than merge its content. Decide per file whether to keep deleting (product intent: no beta modal) or to accept upstream's version and gate it off. The `TRUSTED_HOSTNAMES` allow-list in `loopback-hostname.ts` (not itself in the conflict set) hard-codes company hosts; confirm the value list (`dsh.gb10.zhuopu.net`) still matches deployment reality on redo.

### R8. Generated catalogs and documentation regeneration

- **Intent.** Keep the generated reference catalogs and subsystem pages in sync after the auth-jwt guard types were added.
- **Source commits.** `9513a2ac37` (regenerate catalogs for the auth-jwt guard types).
- **Conflict files.** `docs/config-catalog.md` / `.i18n.yaml` / `.zh.md` (UU x3), `docs/subsystems/typert.md` / `.i18n.yaml` / `.zh.md` (UU x3), `docs/subsystems/web-server.md` / `.i18n.yaml` / `.zh.md` (UU x3), `packages/host/README.md` / `.i18n.yaml` / `.zh.md` (UU x3), `packages/extensions/tool-cordis/src/api-catalog.ts` (UU).
- **Upstream disposition.** All survive and were independently regenerated upstream (both sides regenerated the same generated files -> UU). `tool-cordis/src/api-catalog.ts` was also edited by upstream in the apiproxy-removal commit `4f00a8b82a` (it dropped 60 lines of apiproxy catalog entries).
- **Redo notes.** Do NOT hand-merge generated files. After the source-level requirements (R1-R7) are re-implemented on upstream, regenerate these catalogs with the project's generator and take the generated output. `config-catalog`, `typert`, `web-server`, `host/README`, and `api-catalog.ts` are all generator outputs; the i18n `.zh.md` counterparts follow the pairing workflow.

### R9. Internal npm registry lockfile pinning

- **Intent.** Pin dependency tarball URLs to the internal npm registry for air-gapped builds, and record the fork-only `ui-vnc-preview` extension in the lockfile.
- **Source commits.** `945d615def` (pin tarball URLs for the internal npm registry), `c1a8302736` (record `ui-vnc-preview` in the lockfile).
- **Conflict files.** `pnpm-lock.yaml` (UU).
- **Upstream disposition.** Both sides changed the lockfile (dependency graph moved on both sides, notably upstream's apiproxy removal dropped 88 lockfile lines).
- **Redo notes.** Do NOT hand-merge `pnpm-lock.yaml`. After reconciling `package.json` manifests on the upstream base, regenerate the lockfile with `pnpm install`, then re-apply the internal-registry tarball URL pinning as a deterministic post-step (the pin is a mechanical rewrite over the regenerated file).

## Complete conflict-file to requirement mapping (all 59)

Conflict types: `UU` both changed same file, `UD` fork changed / upstream deleted, `DU` fork deleted / upstream changed.

| # | File | Type | Requirement | Source commit(s) |
|---|---|---|---|---|
| 1 | apps/web/tests/expected/onboarding-deepseek-config/welcome.expected.md | DU | R7 | 30bee82f2e |
| 2 | apps/web/tests/onboarding-deepseek-config.e2e.ts | UU | R7 | 30bee82f2e, b1e081e538 |
| 3 | apps/web/tests/remote-welcome.e2e.ts | DU | R7 | 30bee82f2e |
| 4 | apps/web/tests/scaffold.ts | UU | R7 | 30bee82f2e, b1e081e538 |
| 5 | docs/config-catalog.i18n.yaml | UU | R8 | 9513a2ac37 |
| 6 | docs/config-catalog.md | UU | R8 | 9513a2ac37 |
| 7 | docs/config-catalog.zh.md | UU | R8 | 9513a2ac37 |
| 8 | docs/subsystems/typert.i18n.yaml | UU | R8 | 9513a2ac37 |
| 9 | docs/subsystems/typert.md | UU | R8 | 9513a2ac37 |
| 10 | docs/subsystems/typert.zh.md | UU | R8 | 9513a2ac37 |
| 11 | docs/subsystems/web-server.i18n.yaml | UU | R8 (guard types from R3) | 9513a2ac37 |
| 12 | docs/subsystems/web-server.md | UU | R8 (guard types from R3) | 9513a2ac37 |
| 13 | docs/subsystems/web-server.zh.md | UU | R8 (guard types from R3) | 9513a2ac37 |
| 14 | packages/client/connection/src/client/fixture.ts | UU | R1 + R2 | 1781c3b299, 14e1a77959 |
| 15 | packages/client/connection/src/index.ts | UU | R4 | 804814d1f0 |
| 16 | packages/client/connection/tests/fake-api.client.ts | UD | R2 | 14e1a77959 |
| 17 | packages/client/connection/tests/node-half.host.spec.ts | UU | R4 | 804814d1f0 |
| 18 | packages/client/runtime/src/client/contract/workspaces.ts | UD | R2 | 14e1a77959 |
| 19 | packages/client/runtime/src/client/workspaces/manager.ts | UD | R2 | 14e1a77959 |
| 20 | packages/client/runtime/src/client/workspaces/service.ts | UD | R2 | 14e1a77959 |
| 21 | packages/client/runtime/tests/fake-api.client.ts | UD | R2 | 14e1a77959 |
| 22 | packages/client/runtime/tests/workspaces-service.client.spec.ts | UD | R2 | 14e1a77959 |
| 23 | packages/client/ui-conversation/src/client/service.ts | UU | R5 | e800a19113 |
| 24 | packages/client/ui-layout/src/client/AppFrame.module.css | UU | R6 | 9e9e45c4ef, 745c2c1a64 |
| 25 | packages/client/ui-layout/src/client/AppFrame.tsx | UU | R6 | 9e9e45c4ef, 745c2c1a64 |
| 26 | packages/client/ui-settings-models/src/client/WelcomeNotice.tsx | DU | R7 | 30bee82f2e |
| 27 | packages/client/ui-settings-models/src/client/locales.ts | UU | R7 | 30bee82f2e |
| 28 | packages/client/ui-settings-models/src/client/welcome-store.ts | DU | R7 | 30bee82f2e |
| 29 | packages/client/ui-settings-models/src/onboarding-copy.ts | DU | R7 | 30bee82f2e |
| 30 | packages/client/ui-settings-models/tests/apply.client.spec.ts | UU | R7 | 30bee82f2e |
| 31 | packages/client/ui-settings-models/tests/welcome-notice.client.spec.tsx | DU | R7 | 30bee82f2e |
| 32 | packages/client/ui-settings-models/tests/welcome-store.client.spec.ts | DU | R7 | 30bee82f2e |
| 33 | packages/client/ui-workspace/src/client/index.ts | UU | R2 | 12499c3fc6 |
| 34 | packages/client/ui-workspace/src/client/rows/WorkspaceBrowser.tsx | UU | R1 + R2 | 1781c3b299, 12499c3fc6 |
| 35 | packages/client/ui-workspace/tests/workspace-picker.client.spec.tsx | UU | R2 | 12499c3fc6 |
| 36 | packages/extensions/tool-cordis/src/api-catalog.ts | UU | R8 | 9513a2ac37 |
| 37 | packages/host/README.i18n.yaml | UU | R8 | 9513a2ac37 |
| 38 | packages/host/README.md | UU | R8 | 9513a2ac37 |
| 39 | packages/host/README.zh.md | UU | R8 | 9513a2ac37 |
| 40 | packages/host/apiproxy/src/api-proxy.ts | UD | R1 (+ R2) | 1781c3b299, 2442cd9e52, 3b284a82c6 |
| 41 | packages/host/apiproxy/src/api/index.ts | UD | R1 + R3 | 1781c3b299, 5c2daf0f57 |
| 42 | packages/host/apiproxy/src/api/rpc-map.ts | UD | R2 | 3b284a82c6 |
| 43 | packages/host/apiproxy/src/api/rpc.schema.ts | UD | R2 | 3b284a82c6 |
| 44 | packages/host/apiproxy/src/api/rpc.ts | UD | R2 | 3b284a82c6 |
| 45 | packages/host/apiproxy/src/api/workspace.schema.ts | UD | R2 | 3b284a82c6 |
| 46 | packages/host/apiproxy/src/api/workspace.ts | UD | R2 | 3b284a82c6 |
| 47 | packages/host/apiproxy/src/fetch/client.ts | UD | R2 + R5 | 3b284a82c6, e800a19113 |
| 48 | packages/host/apiproxy/src/fetch/handler.ts | UD | R2 (+ R4 origin) | 3b284a82c6, 4ed1a97b81 |
| 49 | packages/host/apiproxy/src/index.ts | UD | R1 | 1781c3b299 |
| 50 | packages/host/apiproxy/tests/api-proxy-workspace.spec.ts | UD | R1 | 1781c3b299 |
| 51 | packages/host/apiproxy/tests/client-handler.spec.ts | UD | R1 + R2 | 1781c3b299, 3b284a82c6 |
| 52 | packages/host/apiproxy/tests/fetch-carrier.spec.ts | UD | R1 + R2 | 1781c3b299, 3b284a82c6 |
| 53 | packages/host/webserver/README.i18n.yaml | UU | R3 | 5c2daf0f57 |
| 54 | packages/host/webserver/README.md | UU | R3 | 5c2daf0f57 |
| 55 | packages/host/webserver/README.zh.md | UU | R3 | 5c2daf0f57 |
| 56 | packages/host/webserver/src/index.ts | UU | R3 | 5c2daf0f57 |
| 57 | packages/llm/llm/src/message.ts | UU | R5 | 9997c0175a |
| 58 | packages/test-support/client-runtime/src/workspaces.ts | UU | R2 | 14e1a77959 |
| 59 | pnpm-lock.yaml | UU | R9 | 945d615def, c1a8302736 |

Type totals: 33 `UU`, 19 `UD`, 7 `DU` = 59.

The 19 `UD` files are rows 16, 18-22, 40-52 (the apiproxy package plus the client-runtime workspaces surface the fork extended and upstream deleted). The 7 `DU` files are rows 1, 3, 26, 28, 29, 31, 32 (the welcome-notice surface the fork deleted and upstream kept).

## Migration-difficulty summary

| Requirement | Difficulty | Why |
|---|---|---|
| R1 restricted workspace | High | Host logic sits in deleted `apiproxy`; must re-host on the Remote transport / new workspace registration path. |
| R2 create-from-prompt | Highest | Spans deleted `apiproxy` RPC surface AND deleted `client/runtime` workspaces service/manager/contract; full transport rewrite plus UI re-anchor. |
| R3 JWT guard | Medium | `auth-jwt` package is portable, but its guard seam in `webserver/src/index.ts` collides with upstream's own edits (UU). |
| R4 /deploy-info | Low-Medium | Final home is `connection` public route, not apiproxy; reconcile against upstream's route table (UU). |
| R5 non-secure-context ids | Low-Medium | Surviving `ui-conversation`/`llm` sites re-apply cleanly; the apiproxy mint site moves to the Remote client. |
| R6 preview column + rail | Medium | Re-express grid tracks against upstream's changed AppFrame layout math; extension ports once slots exist. |
| R7 de-beta / remote access | Medium | 7 DU conflicts: decide keep-deleting vs accept-and-gate for each welcome-notice file; re-confirm hostname allow-list. |
| R8 generated catalogs | Low (mechanical) | Regenerate from source after R1-R7 land; never hand-merge. |
| R9 lockfile pinning | Low (mechanical) | Regenerate with `pnpm install`, then re-apply internal-registry pin. |

## Open questions for the maintainer

1. **Welcome-notice (R7):** on redo, keep deleting upstream's onboarding modal entirely, or accept upstream's newer version and disable it behind a flag? This decides all 7 DU conflicts.
2. **Create-from-prompt on Remote (R2):** should `createFromPrompt` be modeled as a Remote operation mirroring upstream's migrated unary routes, or re-added as a bespoke host endpoint? Preferred direction affects how much of R1/R2 can share plumbing.
3. **Hostname allow-list (R7):** is `dsh.gb10.zhuopu.net` (and the R1/R4 references to `dsh.jr.zhuopu.net` / `dsh.jereh-pe.cn`) still the live deployment set, or should the loopback-equivalent allow-list be reworked (e.g. config-driven) rather than hard-coded on redo?
4. **Scope boundary:** the 82 fork commits also include substantial Docker / dsh-aio / Jenkins air-gapped-build work that does not appear in the 59-file conflict set (those files do not collide). This dossier covers only the conflict-implicated requirements per the task scope; confirm whether the containerization/CI requirements should get a companion dossier.
