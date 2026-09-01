# 2026-09-01 dsh-aio noVNC clipboard round-trip verification

Goal: prove, with real end-to-end evidence, that the clipboard actually syncs both directions between the container's X/Chrome side and the noVNC browser side in the `dsh-aio` image. The prior claim rested on autocutsel processes merely being alive and the canvas painting; that is explicitly rejected as proof. This session RAN the mandatory bidirectional round-trip and captured the marker strings observed on each side.

Result up front: clipboard sync is PROVEN working in both directions through the actual noVNC/RFB browser session. The final verifier line was `RESULT: ✅ PASS`. No entrypoint or Dockerfile clipboard fix was required — the existing `autocutsel` CLIPBOARD+PRIMARY forks plus `xsel` (added in FEAT-001) already bridge the selections correctly. The only extra step needed to drive the verifier was installing Playwright's headless chromium inside the container (the image does not bake it); details below.

## Public build chain (commands actually run)

Images were wiped by a sandbox reset, so all three were rebuilt from the current tree. The default build args point at unreachable internal registries (`harbor.jereh.cn`, `nexus.jereh.cn`); the public override chain was used. All commands run from the repo root except the aio build whose context is `docker/dsh-aio`.

```sh
# 1) public chrome base (FROM ubuntu:24.04 stand-in for the internal chrome base)
docker build -t dsh-chrome-base:24.04 -f docker/chrome-base/Dockerfile .

# 2) dsh app image
docker build \
  --build-arg NPM_REGISTRY=https://registry.npmjs.org/ \
  --build-arg DSH_CLIENT_COMMIT_HASH=$(git rev-parse HEAD) \
  --build-arg DSH_BUILD_TS=$(date -u +%Y%m%dT%H%M%SZ) \
  -t dsh:dev -f docker/dsh/Dockerfile .

# 3) all-in-one image (context docker/dsh-aio)
docker build \
  --build-arg NPM_REGISTRY=https://registry.npmjs.org/ \
  --build-arg CHROME_BASE_IMAGE=dsh-chrome-base:24.04 \
  --build-arg DSH_IMAGE=dsh:dev \
  --build-arg DSH_CLIENT_COMMIT_HASH=$(git rev-parse HEAD) \
  --build-arg DSH_BUILD_TS=$(date -u +%Y%m%dT%H%M%SZ) \
  -t dsh-aio:dev -f docker/dsh-aio/Dockerfile docker/dsh-aio
```

`xsel` (and `autocutsel`) are confirmed installed in the aio image's existing apt layer:

```
$ docker run --rm --entrypoint bash dsh-aio:dev -lc 'dpkg -l | grep -E "^ii\s+(xsel|autocutsel)"'
ii  autocutsel  0.10.1-1build2  amd64  Keep the X clipboard and the cutbuffer in sync
ii  xsel        1.2.1-1         amd64  command-line tool to access X clipboard and selection buffers
```

## Run / exec procedure and the rootless-podman pitfalls

Two sandbox constraints shaped the procedure:

1. **Host loopback is invisible.** Under rootless-podman `--network host` does not expose the container's loopback ports to the host, so the verifier cannot reach `127.0.0.1:3080`/`:6080` from the host. The verifier therefore runs INSIDE the container with its `CONTAINER=__inproc__` sentinel, which makes its container-side commands (`xsel`, `pgrep`) run locally and its HTTP checks target `127.0.0.1` from within the container.

2. **Idle teardown of ENTRYPOINT-as-PID1.** A plain `docker run -d dsh-aio:dev` container gets partially reaped/frozen between separate shell sessions: `docker ps` reports `Up`, yet a later `docker exec` fails with `crun: the container ... is not running`. Observed directly — a detached PID1 container booted only as far as `Xvnc + fluxbox + websockify + autocutsel(CLIPBOARD)` and then stalled, with Chrome, the resize sidecar, the PRIMARY autocutsel, and `dsh web` never starting; the last entrypoint log line was `autocutsel clipboard sync (CLIPBOARD + PRIMARY)`.

   Root cause is the sandbox lifecycle, not the entrypoint: when `entrypoint.sh` is launched as a normal child process (PID1 kept alive by a `sleep`), the identical stack comes up fully — both autocutsel instances, Chrome, and `dsh web` answering 200 on `:3080`.

   Handling: start the container with a keep-alive PID1 and launch the real stack as a child, then run the whole verification in ONE `bash` invocation so nothing is reaped between sessions:

   ```sh
   docker run -d --replace --name dsh-aio --shm-size=1g --entrypoint bash dsh-aio:dev -lc 'sleep 6000'
   docker exec -d dsh-aio bash -lc '/usr/local/bin/entrypoint.sh > /tmp/entrypoint.log 2>&1'
   # poll until 127.0.0.1:3080 and :6080 both answer 200 (dsh web tsx boot ~22s), then run the verifier
   ```

3. **Playwright browser + module resolution.** The verifier `import`s `playwright`, whose package lives under `apps/web` (`/app/apps/web/node_modules/playwright`, plus `/app/node_modules/.pnpm/playwright@1.61.1/...`), not at `/app/node_modules/playwright`. Node ESM resolves a bare specifier from the importing module's directory, so running the script from `/app` fails with `ERR_MODULE_NOT_FOUND`. Fix used: copy the verifier into `/app/apps/web/` and run it there. Separately, the image does not bake Playwright's browser binary, so the canvas leg first failed with `Executable doesn't exist at .../chromium_headless_shell-1228`; installing it inside the container (network is open) resolved it:

   ```sh
   docker exec dsh-aio bash -lc 'cd /app/apps/web && node node_modules/playwright/cli.js install chromium'
   # -> Chrome Headless Shell 149.0.7827.55 (playwright chromium-headless-shell v1228) downloaded
   ```

## Exact verifier command

```sh
docker exec dsh-aio bash -lc '
  cp /app/docker/dsh-aio/verify-novnc-playwright.mjs /app/apps/web/verify-novnc-playwright.mjs
  cd /app/apps/web && CONTAINER=__inproc__ \
    NOVNC_URL=http://127.0.0.1:6080 DSH_URL=http://127.0.0.1:3080 \
    node verify-novnc-playwright.mjs
'
```

## Clipboard verification result (real markers observed on each side)

Full verifier output of the passing run:

```
=== dsh-aio noVNC + clipboard verification ===
DSH_URL=http://127.0.0.1:3080  NOVNC_URL=http://127.0.0.1:6080  CONTAINER=__inproc__

[PASS] dsh web HTTP 200 — http://127.0.0.1:3080/ -> HTTP 200
[PASS] noVNC vnc.html HTTP 200 — http://127.0.0.1:6080/vnc.html -> HTTP 200
[PASS] autocutsel CLIPBOARD + PRIMARY running — both instances found
[PASS] noVNC canvas painted — canvas 1280x720; screenshot -> /app/apps/web/logs/novnc-verify.png
[PASS] clipboard round-trip (bidirectional) — both directions proven; evidence:
       X CLIPBOARD set to "dsh-aio-remote-1788255692860"
       | noVNC #noVNC_clipboard_text observed "dsh-aio-remote-1788255692860"
       | noVNC clipboard panel pushed "dsh-aio-local-1788255692860"
       | container xsel -o -b read "dsh-aio-local-1788255692860"

----------------------------------------
RESULT: ✅ PASS — dsh web + noVNC serve, both autocutsel instances run, noVNC canvas painted, clipboard syncs both ways.
----------------------------------------
```

### Which legs were exercised end-to-end vs assumed

- **REMOTE -> LOCAL (container X CLIPBOARD -> noVNC browser): PROVEN end-to-end via the real RFB browser leg.** `printf %s dsh-aio-remote-1788255692860 | DISPLAY=:99 xsel -i -b` set the container CLIPBOARD; the live noVNC page's clipboard-panel textarea `#noVNC_clipboard_text`, which is fed by the RFB `clipboard` event, then showed the exact same string. Text crossed the RFB channel from the container into the browser.
- **LOCAL -> REMOTE (noVNC browser -> container X CLIPBOARD): PROVEN end-to-end via the real RFB browser leg.** The verifier drove the noVNC clipboard panel (`RFB.clipboardPasteFrom`) with `dsh-aio-local-1788255692860`; `DISPLAY=:99 xsel -o -b` inside the container then read back that exact string. Text crossed the RFB channel from the browser into the container X CLIPBOARD.
- **autocutsel X-layer bridge: also independently PROVEN** in the run made before the Playwright browser was installed (canvas leg unavailable). With the browser page absent, the verifier's mandatory X-layer fallback set X CLIPBOARD to `dsh-aio-remote-1788255643997` and observed `autocutsel` mirror it into PRIMARY and the raw cut buffer (`PRIMARY=... CUT=...` both equal the marker), then seeded PRIMARY with `dsh-aio-local-1788255643997` and read it back off CLIPBOARD — text actually moved between the X selections and the VNC cut buffer, not merely a process being present.
- **noVNC canvas paint: PROVEN.** The RFB session connected and drew a 1280x720 canvas; screenshot saved to `docker/dsh-aio/logs/novnc-verify.png` (gitignored).

Nothing here rests on process-presence alone: every clipboard claim is backed by a unique marker string observed moving to the far side.

## Entrypoint / Dockerfile fixes made

None were needed for the clipboard bridge. The FEAT-001 change (append `xsel` to the existing apt `autocutsel` line across all four apt-owning dsh-aio Dockerfiles, and make the verifier's round-trip mandatory) is sufficient: `entrypoint.sh` already forks `autocutsel -selection CLIPBOARD -fork` and `autocutsel -selection PRIMARY -fork` before Chrome, and both instances run and bridge correctly. The PID1 stall observed under `docker run -d` is a rootless-podman idle-teardown artifact of this sandbox, not an image defect — the same `entrypoint.sh` brings the full stack up when run as a child process.

Known gap for reproducibility (not a clipboard-bridge issue): the image does not bundle Playwright's chromium browser, so the canvas leg of the verifier requires a one-time `playwright install chromium` inside the container (or running against a host with the browser cached). The clipboard X-layer bridge itself does not depend on Playwright and was proven with `xsel` alone in the pre-install run.

## Bottom line

Clipboard sync between the container's Chrome/X side and the noVNC browser is PROVEN working in BOTH directions, with unique marker strings observed crossing the RFB channel each way. This is real end-to-end evidence, not process presence.
