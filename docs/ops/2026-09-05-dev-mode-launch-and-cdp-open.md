# Dev-mode launch of a second dsh web instance, opened through CDP

Session goal: run this workspace's checkout in DEV mode and open it in the container Chrome over CDP, without disturbing the live session GUI.

## Live container facts

- The session GUI runs from the image tree `/app` (a separate checkout at the same commit), built mode, launched as `pnpm dsh web --no-open --port 3080 --trusted-host dsh-dev.gb10.zhuopu.net` (PID 1 → tsx source launch of `apps/cli/src/bin.ts`).
- `/workspaces/qin-zhuopu__deepseek-harness` is an independent checkout on the same `master` commit with no `node_modules` and no build products.
- `front-proxy.js` fans one network port into `/resize` → 6081, `/vnc` → 6080, everything else → `DSH_PORT` 3080. A second instance on another loopback port is therefore reachable only from inside the container unless the proxy is re-pointed.
- `/app/.env` carries `IAM_ID_TOKEN` only; the workspace had no `.env`, so it was copied to keep the dev instance's credentials identical (`.env` is gitignored).
- The container Chrome listens for CDP on `127.0.0.1:9222` (`/json/version` responds); `chrome-devtools-mcp` is wired to it, so `new_page` opens a real CDP target.

## Procedure

1. `pnpm install --frozen-lockfile` in the workspace.
2. `pnpm run build` once — `scripts/dev-web.ts` documents that every watch stage is incremental and bootstraps nothing.
3. `pnpm run dev:web` (tsx watch over tsc -b, tsdown, vite build --watch; `--poll` because the mount delivers no inotify events).
4. `pnpm dsh web --no-open --port 3081` from the workspace — 3081 chosen to leave the session-owning 3080 untouched.
5. Open `http://127.0.0.1:3081/` via the chrome MCP (`new_page`), verify with the a11y snapshot and `curl http://127.0.0.1:9222/json` that the target belongs to the 9222 browser.

## Pitfalls

- `dev:web` MUST NOT run concurrently with `pnpm run build`: both write the same `lib/` and `apps/web/dist/` trees. The workspace build completed before the watcher started.
- The watcher set is 44 `dsh.client` plugin packages + 3 statically linked libraries; initial rebuild ~7s per package, vite watch ~1.5s per shell rebuild.
- Served-but-stale artifacts are silent: a missing stage shows the previous bundle, so verify content hashes when an edit appears to do nothing.
- `readlink /proc/<pid>/cwd` distinguishes which tree serves which port; 3080 belongs to `/app`, 3081 to the workspace.
