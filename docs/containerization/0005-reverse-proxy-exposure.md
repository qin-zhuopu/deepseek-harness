# Exposing the aio image through a reverse proxy: front-proxy, the /api trust fence, and two wrong assumptions

English | [中文](0005-reverse-proxy-exposure.zh.md)

Status: resolved

## Executive summary

Publishing the all-in-one image's ports straight to the host works only when
the browser runs on the Docker host itself. Putting it behind nginx-proxy
instead broke in ways the existing notes predicted wrongly. Two documented
assumptions turned out to be false: `BIND_ADDR=0.0.0.0` does not make `dsh web`
reachable (it refuses any non-loopback bind by design, so the variable only
moves websockify and CDP), and the `VIRTUAL_HOST_MULTIPORTS` recipe cannot work
on nginx-proxy 1.3.0, which has no such directive and ignores it silently.

The fix is `front-proxy.js`: one process listening on a routable address,
fanning out by path to the three services that stay on loopback. That yields
one vhost (so plain `VIRTUAL_HOST`/`VIRTUAL_PORT` suffices on old proxies) and
one origin (so both browser-facing URLs collapse to same-origin paths).
Verifying it surfaced two more failures: sporadic 502s from keep-alive socket
reuse against python's `http.server`, and a blanket 403 on every browser POST
because rewriting `Host` to loopback breaks the `/api` browser-trust fence.

## Environment

- Test server 10.1.17.58 (CentOS 7, Docker 20.10.8), reachable over an SSH
  local forward. Non-production, so deployment experiments are allowed.
- `jr-nginx-proxy`, image `nginx-proxy:1.3.0`, on the compose default network
  `dc_default`. Wildcard DNS `*.jr.zhuopu.net` resolves to the host.
- Compose file `/home/admin/git/dc/docker-compose.yml`, docker-compose v1
  (1.29.2); `docker compose` v2 is not installed. The file declares no
  `networks:` section, so every service lands on `dc_default` — the same
  network the proxy is on, which is why no extra wiring was needed.

## What was wrong in the previous notes

### 1. `BIND_ADDR=0.0.0.0` does not expose dsh web

The earlier reverse-proxy guidance said to set `BIND_ADDR=0.0.0.0` because
"a proxy reaches the container by its bridge IP". The variable exists, but it
does not do that job. Inside a container started with it:

```
tcp  0  0 127.0.0.1:3080  0.0.0.0:*  LISTEN  1/node       <- dsh web, still loopback
tcp  0  0 0.0.0.0:6080    0.0.0.0:*  LISTEN  18/python3   <- websockify
tcp  0  0 0.0.0.0:6081    0.0.0.0:*  LISTEN  19/python3   <- resize sidecar
```

From another container on the same network: noVNC `200`, sidecar `204`, dsh web
`000` — never reachable. The cause is deliberate, asserted by the repo's own
end-to-end test (`apps/cli/tests/built-bin.e2e.ts`): `dsh web --host 0.0.0.0`
exits with a usage error stating it "would expose remote code execution to the
network". The entrypoint never passed `BIND_ADDR` to the web command at all,
and could not have usefully done so.

Take the refusal as a fixed constraint, not an obstacle to route around. It is
the reason a separate fronting process is the right shape.

### 2. `VIRTUAL_HOST_MULTIPORTS` is not available on every nginx-proxy

The earlier notes recommended two subdomains driven by
`VIRTUAL_HOST_MULTIPORTS`, on the reasoning that noVNC cannot live under a path
prefix. The directive is real but recent; the deployed proxy is 1.3.0:

```
$ docker exec jr-nginx-proxy grep -c VIRTUAL_HOST_MULTIPORTS /app/nginx.tmpl
0
$ docker exec jr-nginx-proxy grep -c VIRTUAL_PATH /app/nginx.tmpl
1
```

Zero matches means the variable is not read — it is ignored silently, with no
error to notice, so the recipe would have failed confusingly. `VIRTUAL_PATH`
and the WebSocket `Upgrade` plumbing are both present.

Check the deployed template for the directive before writing a config around
it. Version-gated features in a config file that tolerates unknown keys fail
quietly.

## front-proxy: one port, one origin

`front-proxy.js` (in `dsh-aio/`) is the only process bound to a routable
address; everything it fronts stays on loopback, which is a smaller exposure
than moving each service to `0.0.0.0` would have been.

| Path | Upstream |
|------|----------|
| `/resize` | resize sidecar (`SIDECAR_PORT`) |
| `/vnc`, `/vnc/*` | noVNC, prefix stripped (`NOVNC_PORT`) |
| `/websockify` | noVNC's RFB socket |
| everything else | dsh web (`DSH_PORT`) |

`/websockify` needs its own rule. noVNC builds the RFB WebSocket URL from the
page's host plus its `path` setting, which defaults to a bare `websockify` at
the origin root — the `/vnc` prefix is not carried over, so without this rule
the handshake lands on dsh web.

Two consequences make this better than multiple vhosts, independent of the
1.3.0 limitation:

- **One vhost.** Plain `VIRTUAL_HOST` + `VIRTUAL_PORT` is enough, so the setup
  is portable to older proxies.
- **One origin.** `VNC_PUBLIC_URL=/vnc` and `RESIZE_ENDPOINT=/resize` become
  same-origin paths, so the image never needs to know its own public hostname
  and the two URLs stop being deployment-specific.

The proxy is off unless `FRONT_PORT` is set; direct port publishing is
unchanged.

## Two failures found while verifying

### 3. Sporadic 502s on noVNC assets, only under concurrency

Loading the preview produced one `502` among otherwise-`200` asset requests.
It reproduced only through the proxy and only concurrently:

| Case | Result |
|------|--------|
| Serial, 10x same asset, via nginx-proxy | 10x 200 |
| 20 concurrent, via nginx-proxy | 15x 200, **5x 502** |
| 20 concurrent, direct to front-proxy | 20x 200 |

Not a routing bug — a connection-lifetime bug. Node's default global agent
keeps upstream sockets alive, but websockify serves noVNC's static files from
python's `http.server`, which closes connections on its own schedule. A pooled
socket already being closed gets reset mid-flight, and the proxy's error
handler turned that into a 502. Fixed with `agent: false` plus
`Connection: close`: one fresh upstream socket per request. Recheck: 20/20 and
250 mixed concurrent requests all 200.

The shape is worth remembering — an error that only appears under concurrency
and disappears when you bypass one hop is usually about connection reuse, not
about the request being routed wrongly.

### 4. Every browser POST to /api answered 403

GETs succeeded while every `POST /api/...` failed with 403, breaking the Cordis
inventory calls. The cause is in `packages/client/connection/src/api-request-trust.ts`:
the fence requires an attached `Origin` to equal the `Host` authority, and to
accept only a loopback or explicitly-declared `Host`. front-proxy was rewriting
`Host` to `127.0.0.1:3080` while the browser still sent
`Origin: http://dsh.jr.zhuopu.net` — mismatch, refused.

This fence is the DNS-rebinding and cross-site defense, and `Host` is the one
header rebinding cannot forge. Forging `Origin` to match the rewritten `Host`
would have silenced the 403 by disabling the defense, so it was rejected as a
fix. The supported path already existed: forward `Host` verbatim and declare
the public authority through the CLI's repeatable `--trusted-host`, surfaced
here as `TRUSTED_HOSTS`.

The fence still works afterwards:

| Request | Result |
|---------|--------|
| `POST /api/workspace.list`, Host+Origin `dsh.jr.zhuopu.net` (declared) | `200` |
| same POST, Host+Origin `evil.example.org` (undeclared) | `403` |

When a security check blocks a deployment, look for the mechanism it provides
for legitimate deployments before touching the check.

## Working configuration

```yaml
  dsh-aio:
    container_name: dsh-aio-dc
    image: harbor.jereh.cn/base/dsh-aio:prod
    restart: unless-stopped
    shm_size: 1g
    environment:
      - NR_API_KEY=<your-key>
      - SCREEN_GEOMETRY=576x1440x24
      - FRONT_PORT=8080
      - VNC_PUBLIC_URL=/vnc
      - RESIZE_ENDPOINT=/resize
      - TRUSTED_HOSTS=dsh.jr.zhuopu.net
      - VIRTUAL_HOST=dsh.jr.zhuopu.net
      - VIRTUAL_PORT=8080
      - HTTPS_METHOD=noredirect
```

No `networks:` entry because this compose file has no `networks:` section and
its default network already carries the proxy. `container_name` is
`dsh-aio-dc` only to avoid colliding with an unrelated hand-run `dsh-aio`
container on the same host.

**This vhost has no authentication.** Anyone who can reach the proxy gets a dsh
control plane that runs commands. Acceptable on an internal test box; put the
vhost behind the proxy's own htpasswd/JWT for anything longer-lived.

## Verification

Routing and protocol, through nginx-proxy:

| Check | Result |
|-------|--------|
| `GET /` | `200` |
| `GET /vnc/vnc.html`, `/vnc/vnc-config.js`, `/vnc/fit-resize.js` | `200` |
| `GET /resize?w=800&h=600` | `204` |
| WebSocket upgrade on `/websockify` | `101` |
| `POST /api/workspace.list` (declared authority) | `200` |
| same POST with an undeclared `Host` | `403` |
| 250 mixed concurrent requests | all `200` |

End-to-end, in a real browser: the preview iframe loaded
`http://dsh.jr.zhuopu.net/vnc/vnc.html?autoconnect=true&resize=scale` and
`xdpyinfo` inside the container then reported the desktop at `319x855`,
matching the iframe's measured `clientWidth` of 319. Matching numbers from two
independent observations is what shows the whole chain works — HTTP routing,
the WebSocket transport, and the resize sidecar — rather than just that
requests are being routed.

A `404` on `/vnc/package.json` remains in the console. It is noVNC probing for
its own metadata and is pre-existing: the same probe returns `404` on the
direct noVNC port and in an untouched container.

## What the image does and does not ship

Worth stating because it was misremembered mid-session: the image pre-creates
and registers an **empty** workspace directory (`INIT_WORKSPACE`, default
`/root/workspace`) so a fresh container opens with a usable workspace instead
of an empty picker. It does not ship a scaffolded project, does not run a dev
server, and does not drive Chrome to any page.

A container observed doing those things had them done by hand afterwards. In a
fresh container from this image, `/root/workspace` has zero entries, is not a
git repository, and nothing listens on 5173. `docker diff` on the hand-built
container showed the project as `A /root/workspace/...` — added in the container
layer, gone with the container.

That gap is what `Dockerfile.webapp` now closes: a separate variant that bakes
the scaffolded app, its `node_modules`, and a first commit into the image and
starts the dev server plus a Chrome tab on it. See
[0004](0004-dockerfile-variants.md#the-webapp-variant-a-container-that-is-already-coding).
The statement above still describes every other variant.

## Related

- [0004](0004-dockerfile-variants.md) — the Dockerfile variant matrix, the
  environment-variable reference, and the tunneled-access recipe.
- [0003](0003-all-in-one-chrome-novnc-mcp.md) — the display stack this image
  builds on.
