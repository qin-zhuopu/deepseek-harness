#!/bin/bash
# All-in-one supervisor (PRODUCTION): Xvnc + Chrome(CDP) + noVNC + dsh web.
#
# Display stack: Xvnc (TigerVNC) replaces the Xvfb+x11vnc pair — an X server
# with a built-in VNC server whose RandR implementation supports resizing to
# arbitrary dimensions. Desktop-size control lives entirely on the X-server
# side: noVNC runs in smooth resize=scale mode, fit-resize.js (referenced by
# vnc.html) debounces viewport changes and asks vnc-resize-sidecar (this
# image, port 6081) to RFB SetDesktopSize the desktop to match, and the
# watchdog below re-fits the Chrome window. This avoids both the resize
# storm and the multi-viewer fights of noVNC's resize=remote.
#
# The dsh web app itself boots from the COMPILED CLI entry
# (apps/cli/lib/bin.js) — no runtime tsx transpile, ~1s startup.
set -e

: "${DISPLAY_NUM:=99}"
: "${SCREEN_GEOMETRY:=576x1440x24}"
: "${VNC_PORT:=5900}"
: "${NOVNC_PORT:=6080}"
: "${CDP_PORT:=9222}"
: "${DSH_PORT:=3080}"
: "${BIND_ADDR:=127.0.0.1}"
# Directory pre-registered as a workspace once dsh web is up, so a fresh
# container opens with a ready workspace instead of an empty picker. Set
# INIT_WORKSPACE= (empty) to skip.
: "${INIT_WORKSPACE:=/root/workspace}"
# --- Reverse-proxy support -------------------------------------------------
# By default every URL the browser uses points at 127.0.0.1 (ports published
# straight to the host). Behind a reverse proxy (nginx-proxy et al) the
# browser cannot reach those ports, so both browser-facing URLs are
# configurable:
#
#   VNC_PUBLIC_URL   Origin (optionally with a path prefix) where the browser
#                    reaches this container's noVNC, e.g.
#                    https://dsh-vnc.example.org — the entrypoint appends
#                    /vnc.html plus the query noVNC needs and injects the
#                    result as window.__DSH_VNC_PREVIEW_URL__ (the override
#                    the VNC-preview plugin already reads). Empty = use the
#                    plugin's 127.0.0.1:6080 default.
#   RESIZE_ENDPOINT  URL or same-origin path where the browser reaches the
#                    resize sidecar, e.g. https://dsh-vnc.example.org/resize.
#                    Empty = fit-resize.js falls back to <novnc host>:6081.
#   SIDECAR_BIND     Sidecar listen address; defaults to BIND_ADDR so a
#                    proxied deployment (BIND_ADDR=0.0.0.0) is reachable by
#                    container IP without a second variable.
: "${VNC_PUBLIC_URL:=}"
: "${RESIZE_ENDPOINT:=}"
: "${SIDECAR_BIND:=${BIND_ADDR}}"
: "${SIDECAR_PORT:=6081}"
# front-proxy: one network-facing port fanning out to the three loopback
# services (see front-proxy.js). Required behind a reverse proxy, because
# `dsh web` refuses to bind 0.0.0.0 and a proxy reaches this container by its
# bridge IP. With it running, everything else can stay on loopback and both
# browser-facing URLs become same-origin paths:
#   -e FRONT_PORT=8080 -e VNC_PUBLIC_URL=/vnc -e RESIZE_ENDPOINT=/resize
# Empty FRONT_PORT (the default) leaves the proxy off and the direct
# port-publishing behaviour unchanged.
: "${FRONT_PORT:=}"
: "${FRONT_BIND:=0.0.0.0}"
: "${VNC_PREFIX:=/vnc}"
# Public authorities dsh web accepts on /api, space- or comma-separated
# (e.g. "dsh.example.org"). front-proxy forwards Host verbatim, and the /api
# browser-trust fence refuses any Host that is neither loopback nor declared
# here — a DNS-rebinding defense, so this must be set, not worked around,
# whenever the browser addresses this container by a public hostname.
: "${TRUSTED_HOSTS:=}"
export SIDECAR_BIND SIDECAR_PORT VNC_PORT
export FRONT_PORT FRONT_BIND VNC_PREFIX DSH_PORT NOVNC_PORT
# The GUI's "文件" file browser (ui-vnc-preview /files tab) is served same-origin
# through front-proxy at /files and backed by files-server; see entrypoint.sh.
: "${FILES_SERVER_ROOT:=${INIT_WORKSPACE:-/root/workspace}}"
: "${FILES_SERVER_PORT:=6099}"
export FILES_SERVER_ROOT FILES_SERVER_PORT
export DISPLAY=":${DISPLAY_NUM}"
export PATH=/opt/node/bin:$PATH
export DSH_HOME=/root/.dsh

log() { echo "[aio] $*"; }
cleanup() { pkill -P $$ 2>/dev/null || true; }
trap cleanup EXIT INT TERM

SCREEN_W="${SCREEN_GEOMETRY%%x*}"
SCREEN_REST="${SCREEN_GEOMETRY#*x}"
SCREEN_H="${SCREEN_REST%%x*}"

log "Xvnc ${DISPLAY} (${SCREEN_W}x${SCREEN_H}, RandR dynamic resize)"
# Clear stale locks from an unclean previous run, or Xvnc aborts with
# "Server is already active for display 99".
rm -f "/tmp/.X${DISPLAY_NUM}-lock" "/tmp/.X11-unix/X${DISPLAY_NUM}"
# -SecurityTypes None + -localhost: no VNC auth, loopback only (websockify is
# the only network-facing hop). RandR stays enabled so clients can resize.
Xvnc "${DISPLAY}" -geometry "${SCREEN_W}x${SCREEN_H}" -depth 24 \
     -rfbport "${VNC_PORT}" -SecurityTypes None -localhost \
     -dpi 96 >/tmp/xvnc.log 2>&1 &
for i in $(seq 1 40); do xdpyinfo -display "${DISPLAY}" >/dev/null 2>&1 && break; sleep 0.3; done

log "fluxbox window manager"
# Neutralize fbsetbg: fluxbox re-applies the wallpaper on every RandR resize
# and fbsetbg pops an xmessage error when no backend (feh, etc.) is installed.
# A no-op shim keeps dynamic resize silent without pulling in extra packages.
printf '#!/bin/sh\nexit 0\n' > /usr/local/bin/fbsetbg && chmod +x /usr/local/bin/fbsetbg
fluxbox >/dev/null 2>&1 &

log "noVNC (websockify) ${BIND_ADDR}:${NOVNC_PORT}"
websockify --web=/usr/share/novnc "${BIND_ADDR}:${NOVNC_PORT}" "localhost:${VNC_PORT}" &

log "vnc-resize-sidecar on ${SIDECAR_BIND}:${SIDECAR_PORT}"
python3 /usr/local/bin/vnc-resize-sidecar.py &

# Render the two browser-facing URLs (see the variable block at the top).
# vnc-config.js is always (re)written so a restart with changed variables
# never serves a stale config; vnc.html loads it just before fit-resize.js.
if [ -n "${RESIZE_ENDPOINT}" ]; then
  printf 'window.__DSH_RESIZE_ENDPOINT__=%s;\n' "$(printf '%s' "${RESIZE_ENDPOINT}" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')" \
    > /usr/share/novnc/vnc-config.js
  log "resize endpoint: ${RESIZE_ENDPOINT}"
else
  : > /usr/share/novnc/vnc-config.js
fi

# The VNC-preview plugin reads window.__DSH_VNC_PREVIEW_URL__; setting it in
# the served index.html is the container-baked-script path that plugin
# documents. Idempotent: the marker comment keeps a restart from stacking
# injections, and the whole block is skipped when VNC_PUBLIC_URL is empty.
WEB_INDEX=/app/apps/web/dist/index.html
if [ -n "${VNC_PUBLIC_URL}" ] && [ -f "${WEB_INDEX}" ]; then
  VNC_PUBLIC_URL="${VNC_PUBLIC_URL%/}" \
  python3 - "${WEB_INDEX}" <<'PY'
import json, os, re, sys

path = sys.argv[1]
url = os.environ['VNC_PUBLIC_URL'] + '/vnc.html?autoconnect=true&resize=scale'
marker = '<!--dsh-vnc-preview-url-->'
tag = f'{marker}<script>window.__DSH_VNC_PREVIEW_URL__={json.dumps(url)};</script>'

html = open(path, encoding='utf-8').read()
# Drop any previous injection before adding the current one.
html = re.sub(re.escape(marker) + r'<script>.*?</script>', '', html, flags=re.S)
open(path, 'w', encoding='utf-8').write(html.replace('</head>', tag + '</head>', 1))
PY
  log "vnc preview url: ${VNC_PUBLIC_URL}/vnc.html"
fi

# The only listener on a routable address when enabled; everything it fronts
# stays on loopback.
if [ -n "${FRONT_PORT}" ]; then
  node /usr/local/bin/front-proxy.js &
fi

# files-server backs the GUI's "文件" tab: a read-only web file browser on
# loopback. front-proxy routes /files here; on a raw localhost:3080 the GUI
# points at http://<host>:8080/files/ which also reaches it through front-proxy.
node /usr/local/bin/files-server/server.mjs &

# Size the Chrome window to the actual desktop. --start-maximized is
# unreliable under a bare WM (Chrome comes up as a ~10x10 window). Deriving
# --window-size from SCREEN_GEOMETRY makes Chrome fill the desktop.
log "Google Chrome (CDP ${BIND_ADDR}:${CDP_PORT}, window ${SCREEN_W}x${SCREEN_H})"
google-chrome \
  --no-sandbox --disable-gpu --disable-dev-shm-usage \
  --no-first-run --no-default-browser-check \
  --remote-debugging-port="${CDP_PORT}" \
  --remote-debugging-address="${BIND_ADDR}" \
  --window-position=0,0 --window-size="${SCREEN_W},${SCREEN_H}" \
  --user-data-dir=/tmp/chrome-profile \
  "about:blank" >/tmp/chrome.log 2>&1 &

# wait for CDP so the MCP client's first connect succeeds
for i in $(seq 1 40); do curl -sf "http://${BIND_ADDR}:${CDP_PORT}/json/version" >/dev/null 2>&1 && break; sleep 0.5; done
log "CDP ready: $(curl -s http://${BIND_ADDR}:${CDP_PORT}/json/version | head -c 80)"

# Watchdog: when the sidecar changes the desktop geometry, re-fit the Chrome
# window so it keeps filling the desktop. fluxbox ignores EWMH maximize hints
# from wmctrl, so set the geometry directly by window ID (top 22px is the
# fluxbox titlebar offset Chrome is placed at).
(
  CUR=""
  CHROME_WID=""
  while true; do
    GEO=$(xdpyinfo -display "${DISPLAY}" 2>/dev/null | awk '/dimensions:/{print $2; exit}')
    if [ -n "$GEO" ] && [ "$GEO" != "$CUR" ]; then
      CUR="$GEO"
      W="${GEO%%x*}"; H="${GEO#*x}"
      if [ -z "$CHROME_WID" ]; then
        CHROME_WID=$(wmctrl -l 2>/dev/null | grep -i "google chrome" | awk '{print $1}' | head -1)
      fi
      if [ -n "$CHROME_WID" ]; then
        H2=$((H - 22))
        wmctrl -ir "$CHROME_WID" -e "0,0,22,${W},${H2}" 2>/dev/null || true
      fi
    fi
    sleep 0.5
  done
) &

# Pre-register a workspace once dsh web answers, so a fresh container opens
# with a ready workspace directory. Idempotent: workspace.create returns the
# existing record (created:false) if the path is already registered. The
# workspace registry only auto-discovers workspaces from prior sessions' cwd,
# so without this a brand-new container shows an empty workspace picker.
if [ -n "${INIT_WORKSPACE}" ]; then
  (
    mkdir -p "${INIT_WORKSPACE}"
    for i in $(seq 1 60); do
      curl -sf -o /dev/null "http://${BIND_ADDR}:${DSH_PORT}/" && break
      sleep 1
    done
    UUID=$(cat /proc/sys/kernel/random/uuid)
    body="{\"type\":\"client-request\",\"rpcId\":\"${UUID}\",\"method\":\"workspace.create\",\"payload\":{\"path\":\"${INIT_WORKSPACE}\"}}"
    if curl -sf -X POST "http://${BIND_ADDR}:${DSH_PORT}/api/workspace.create" \
         -H 'content-type: application/json' -d "${body}" >/dev/null 2>&1; then
      log "workspace registered: ${INIT_WORKSPACE}"
    else
      log "workspace registration for ${INIT_WORKSPACE} failed (non-fatal)"
    fi
  ) &
fi

# One repeatable --trusted-host per declared authority. Built as an array so
# the flags stay separate arguments under `set -u`-safe expansion.
TRUST_ARGS=()
if [ -n "${TRUSTED_HOSTS}" ]; then
  for authority in $(printf '%s' "${TRUSTED_HOSTS}" | tr ',' ' '); do
    TRUST_ARGS+=(--trusted-host "${authority}")
  done
  log "trusted hosts: ${TRUSTED_HOSTS}"
fi

# PRODUCTION: run the compiled entry, not the tsx source dispatch.
log "dsh web on ${BIND_ADDR}:${DSH_PORT} (compiled entry)"
cd /app
exec node apps/cli/lib/bin.js web --no-open --port "${DSH_PORT}" "${TRUST_ARGS[@]}"
