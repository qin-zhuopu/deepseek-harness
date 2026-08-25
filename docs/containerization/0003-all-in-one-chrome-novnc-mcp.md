# An all-in-one image: dsh + Chrome (noVNC) + chrome-devtools MCP

English | [中文](0003-all-in-one-chrome-novnc-mcp.zh.md)

Status: resolved (verified end to end — the in-container agent opened Baidu over MCP)

## Executive summary

A single `docker run` brings up a whole stack: the dsh web UI, a real Chrome
running on a virtual display and exposed through noVNC (so you watch it in a
browser tab), the Chrome DevTools Protocol (CDP) endpoint, and a pre-installed
[`chrome-devtools-mcp`](https://github.com/ChromeDevTools/chrome-devtools-mcp)
server already bridged into dsh as `mcp__chrome__*` tools. Ask the in-container
agent to "open Baidu with the chrome tools" and the navigation happens in the
Chrome you can see in the noVNC tab.

The image is built in two stages: reuse the already-built `dsh:dev` image for
the `/app` tree, then assemble the runtime on the internal Chrome base image
(Ubuntu 24.04 + Google Chrome). A supervisor entrypoint starts every service in
order and waits for CDP before launching dsh, so the MCP client's first connect
succeeds. The API key is injected at runtime with `-e`, never baked into a layer.

## What the image contains

| Layer | Provides |
|---|---|
| `dsh:dev` (stage 1) | the fully installed + built dsh `/app` |
| Chrome base image | Google Chrome + system libs |
| `/opt/node` | an isolated Node 24 + pnpm (see below) |
| apt packages | `xvfb x11vnc fluxbox novnc websockify x11-utils curl` |
| global npm | `chrome-devtools-mcp@1.7.0` at `/opt/node/bin/chrome-devtools-mcp` |
| baked `DSH_HOME` | web profile, `nr` provider, default model, chrome MCP patch |
| `entrypoint.sh` | the supervisor that launches the stack |

## The multi-stage Dockerfile and why it is shaped this way

```dockerfile
# ---- Stage 1: reuse the already-built dsh app ----
FROM dsh:dev AS dshbuild

# ---- Stage 2: runtime on the Chrome base ----
FROM harbor.jereh.cn/base/ubuntu:24.04-node22-python312-chrome

COPY --from=node:24 /usr/local/bin/node /opt/node/bin/node
COPY --from=node:24 /usr/local/lib/node_modules/npm /opt/node/lib/node_modules/npm
ENV PATH=/opt/node/bin:$PATH
RUN ln -sf /opt/node/lib/node_modules/npm/bin/npm-cli.js /opt/node/bin/npm \
 && npm config set registry https://nexus.jereh.cn/repository/npm-public/ \
 && npm install -g pnpm@11.7.0 chrome-devtools-mcp@1.7.0

RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      xvfb x11vnc fluxbox novnc websockify x11-utils curl \
 && rm -rf /var/lib/apt/lists/*

COPY --from=dshbuild /app /app
COPY dshhome/.dsh /root/.dsh
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENV DSH_HOME=/root/.dsh
EXPOSE 3080 6080 5900 9222
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
```

**Reuse `dsh:dev` instead of rebuilding.** dsh must be built on Debian
(`node:24`); the Chrome base is Ubuntu with an unusable Node. Rather than run
`pnpm install && pnpm run build` again in the runtime image (~5 min), stage 1 is
just `FROM dsh:dev` and stage 2 copies its finished `/app`. The build reduces to
copying an artifact.

**Node isolated in `/opt/node`, not the system prefix.** The Chrome base ships
Node only via nvm under `/home/dev/.nvm/...`, owned by the `dev` user and absent
from root's PATH — unusable as the container's runtime. The first instinct,
`COPY --from=node:24 /usr/local /usr/local`, **clobbers** the base image's
existing symlinks (corepack then dies with `ENOENT ... realpath '/usr/local/bin/yarn'`).
The fix is to land Node 24 in a *separate* prefix `/opt/node`, put it first on
PATH, and leave the system prefix untouched.

**Skip corepack; use `npm i -g pnpm`.** corepack's `enable`/`prepare` tries to
generate posix symlinks for yarn/pnpm and fails in this copied layout
(`generatePosixLink … ENOENT`). Installing pnpm directly with
`npm install -g pnpm@11.7.0` sidesteps the whole corepack path.

**Pre-install `chrome-devtools-mcp`, don't `npx` at runtime.** Installed globally
in the same `npm i -g`, it lands at `/opt/node/bin/chrome-devtools-mcp`. The
baked MCP patch points at that absolute path (not `npx -y chrome-devtools-mcp`),
so first use has no download and the image is genuinely offline-ready.

**Bake `DSH_HOME`, but never the key.** The `dshhome/.dsh` copied in is a
proven-good profile pulled from a running instance: the `web` profile with its
`mcp-client` node_modules, the `nr` provider, the default model, and the chrome
MCP patch. It is packed **excluding** `sessions/`, `storages/`, and
`.credentials.yaml` — no secret and no prior conversation state ride in the
image. `NR_API_KEY` arrives at runtime via `-e`; the provider reads it through
its `apiKeyEnv`.

## The baked MCP patch

`/root/.dsh/profiles/web/cordis.patch.yml` inserts one `mcp-client` instance that
spawns the pre-installed server over stdio and bridges to the local Chrome:

```yaml
- insert:
    - id: chrome-devtools-mcp
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: chrome
        transport: stdio
        command: /opt/node/bin/chrome-devtools-mcp
        args:
          - --browserUrl
          - http://127.0.0.1:9222
        cwd: !!js process.cwd()
        env:
          CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: "1"
        toolCallTimeoutMs: 120000
        failOnStartupError: false
```

`serverName: chrome` is what makes the bridged tools appear as `mcp__chrome__*`
(e.g. `mcp__chrome__new_page`, `mcp__chrome__list_pages`).
`failOnStartupError: false` keeps dsh booting even if Chrome is momentarily not
ready; the client reconnects.

## The supervisor entrypoint

`entrypoint.sh` starts services in dependency order, every port on `127.0.0.1`:

1. **Xvfb** on display `:99` (a virtual framebuffer), then poll `xdpyinfo` until
   the display answers.
2. **fluxbox** — a light window manager so Chrome has a managed root window.
3. **x11vnc** — exports the X display as VNC on `127.0.0.1:5900`, `-nopw`.
4. **websockify / noVNC** — the HTML bridge on `127.0.0.1:6080` proxying to VNC.
5. **Google Chrome** — `--remote-debugging-port=9222`, `--no-sandbox`,
   `--disable-dev-shm-usage`, on the virtual display.
6. **Wait for CDP** — poll `http://127.0.0.1:9222/json/version` before continuing,
   so the MCP client's initial connect during dsh boot finds Chrome up.
7. **dsh web** — `exec pnpm dsh web --no-open` (PID 1 hand-off, clean signals).

## Running it

```bash
docker run -d --name dsh-aio --network host --shm-size=1g \
    -e NR_API_KEY=<your-key> dsh-aio:dev
```

Then open:

- dsh Web UI — `http://127.0.0.1:3080/`
- Chrome view — `http://127.0.0.1:6080/vnc.html`

In the Web UI, tell the agent: "use the chrome tools to open https://www.baidu.com".
The page loads in the Chrome visible in the noVNC tab.

**`--network host` is required.** Three reasons compound:

- dsh web binds `127.0.0.1` only (it refuses `--host 0.0.0.0` for RCE safety), so
  a `-p 3080:3080` mapping targets the container's eth0, not its loopback, and
  never reaches the server. Host networking puts the server's `127.0.0.1:3080` on
  the host loopback (on WSL2, reachable from Windows at `http://127.0.0.1:3080/`).
- The baked MCP client reaches Chrome at `http://127.0.0.1:9222` over that same
  shared loopback.
- The `nr` provider's upstream is `http://localhost:20128/v1`, a gateway on the
  WSL host; it resolves from inside the container only under host networking.

**`--shm-size=1g`** gives Chrome enough shared memory for rendering; the
`--disable-dev-shm-usage` flag is a further safety net.

## Security notes

- **Loopback-only, no VNC password.** x11vnc and noVNC both bind `127.0.0.1` and
  run `-nopw`. Combined with `--network host` on WSL2, only the local machine
  reaches them; nothing is exposed to the LAN. If you ever move this off a
  single-user loopback, add a VNC password and/or a reverse proxy with auth
  before exposing 6080.
- **CDP is an unauthenticated control channel.** Anyone who can reach
  `127.0.0.1:9222` can drive the browser. Same loopback caveat as above — keep it
  local.
- **The key is runtime-only.** `NR_API_KEY` is never in a layer, the baked
  `DSH_HOME` carries no `.credentials.yaml`, and no session history is baked in.
- **Chrome runs `--no-sandbox`.** Standard for containerized Chrome, but it means
  the browser process is less isolated; only browse trusted content in it.

## Pitfalls hit

- **`COPY --from=node:24 /usr/local /usr/local` breaks the base image.** It
  overwrites existing symlinks and corepack dies on a missing `yarn` realpath.
  Copy Node into an isolated `/opt/node` prefix instead.
- **corepack `generatePosixLink` fails** in the copied layout. Use
  `npm install -g pnpm` and skip corepack entirely.
- **CDP `/json/new` now requires PUT.** A `GET /json/new?<url>` returns
  "Using unsafe HTTP verb GET … supports only PUT verb". Use
  `curl -X PUT` when opening a page directly over CDP (the MCP server already
  does the right thing).
- **`No handler registered for issue code PerformanceIssue`** floods the dsh log.
  It is harmless noise from chrome-devtools-mcp receiving CDP performance events —
  in fact a sign the MCP↔Chrome channel is live. Filter it out when reading logs.
- **`ELIFECYCLE` on restart** is the old dsh process being killed during a
  container restart, not a boot failure; the new process comes up right after.
- **A deleted source container takes its secret with it.** `.credentials.yaml`
  lives only in a container's writable layer. Once the container that held
  `NR_API_KEY` is `docker rm -f`'d, the key is gone from the image, host, volumes,
  and history. Re-inject it with `-e` (this is by design — the key is never baked).

## End-to-end verification (with logs)

The full path was verified: a real `NR_API_KEY` injected via `docker run -e`, the
in-container agent then autonomously calling the `mcp__chrome__*` tools to open
Baidu, with logs captured throughout and the verdict read back from those logs.

The image sources and the verification harness live in
[`docker/dsh-aio/`](../../docker/dsh-aio/): the
[`Dockerfile`](../../docker/dsh-aio/Dockerfile), the supervisor
[`entrypoint.sh`](../../docker/dsh-aio/entrypoint.sh), the baked
[`cordis.patch.yml`](../../docker/dsh-aio/cordis.patch.yml), and
[`verify-e2e.sh`](../../docker/dsh-aio/verify-e2e.sh). The harness: (1) restarts `dsh-aio` with `-e
NR_API_KEY`, (2) creates a dsh session and prompts the agent to open Baidu, (3)
captures three log streams — the container supervisor log (dsh + chrome-devtools-mcp
+ CDP), the dsh session event stream (`session.history`: `tool/call`,
`tool/result`, `turn/end`), and the CDP page list — and (4) judges success from
those logs. The judgment parses events precisely, distinguishing a real
`tool/call` event from the tool *catalog* (schema) that also appears in the
stream, and requires **all** of: a real `mcp__chrome__` tool call, `turn/end`
with `reason=completed`, and Chrome actually showing Baidu.

Evidence from a passing run:

```
container NR_API_KEY length: 35                 # -e injection reached the container
tool/call -> mcp__chrome__new_page  | args: {"url":"https://www.baidu.com"}
tool/call -> mcp__chrome__list_pages | args: {}   # the agent really called the MCP tools
turn/end  -> completed                          # the turn finished cleanly (not error)
Chrome current page (CDP): 百度一下，你就知道 -> https://www.baidu.com/
verdict: PASS — the agent opened Baidu through the MCP tools, logs corroborate
```

The agent's own closing message:

> 百度首页已成功打开。`list_pages` 确认页面 2 处于选中状态，页面标题为：百度一下，你就知道（URL: https://www.baidu.com/）。

The judgment logic was also negative-tested: run with a dummy key, the harness
correctly reports **not passed** (`turn/end=error`, no real tool call, Baidu not
open), so a PASS is meaningful.

### Reproduce

```bash
docker run -d --name dsh-aio --network host --shm-size=1g \
    -e NR_API_KEY=<real-key> dsh-aio:dev
```

Then open the Web UI at `http://127.0.0.1:3080/` and ask the agent to open Baidu;
watch it happen live in the noVNC tab at `http://127.0.0.1:6080/vnc.html`. The
provider reads the key through its `apiKeyEnv: NR_API_KEY`, and the upstream at
`http://127.0.0.1:20128/v1` validates it — an invalid key fails the turn with
`invalid_api_key`, which is exactly what the negative test exercises.

## Lessons

- Multi-stage builds turn "rebuild the app in an awkward runtime" into "copy a
  finished artifact" — reuse a known-good image as a stage.
- When a base image's toolchain is unusable, add your own in an isolated prefix
  rather than overwriting the system one.
- Pre-install what you would otherwise `npx` at runtime; it is the difference
  between "works offline, instantly" and "downloads on first use".
- Bake configuration, inject secrets. A profile is reproducible; a key is not,
  and must never enter a layer.
- A supervisor that *waits on readiness* (poll CDP before starting the client)
  removes a whole class of start-order races.
