#!/bin/bash
# All-in-one supervisor: Xvnc + Chrome(CDP) + noVNC + dsh web.
#
# Same display stack as entrypoint.prod.sh (Xvnc, resize sidecar, Chrome
# window fit watchdog — see that file for the rationale); the only difference
# is the dsh launch line: this DEV variant runs the tsx source dispatch
# (`pnpm dsh web`) instead of the compiled entry, for iterating on source.
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
# --- Reverse-proxy support (see entrypoint.prod.sh for the full rationale) --
# By default every browser-facing URL points at 127.0.0.1 (ports published
# straight to the host). Behind a reverse proxy the browser cannot reach those
# ports, so both URLs are configurable:
#
#   VNC_PUBLIC_URL   Origin (optionally with a path prefix) where the browser
#                    reaches this container's noVNC. The entrypoint appends
#                    /vnc.html plus noVNC's query and injects the result as
#                    window.__DSH_VNC_PREVIEW_URL__. Empty = the plugin's
#                    127.0.0.1:6080 default.
#   RESIZE_ENDPOINT  URL or same-origin path for the resize sidecar.
#                    Empty = fit-resize.js falls back to <novnc host>:6081.
#   SIDECAR_BIND     Sidecar listen address; defaults to BIND_ADDR.
: "${VNC_PUBLIC_URL:=}"
: "${RESIZE_ENDPOINT:=}"
: "${SIDECAR_BIND:=${BIND_ADDR}}"
: "${SIDECAR_PORT:=6081}"
export SIDECAR_BIND SIDECAR_PORT VNC_PORT
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
rm -f "/tmp/.X${DISPLAY_NUM}-lock" "/tmp/.X11-unix/X${DISPLAY_NUM}"
Xvnc "${DISPLAY}" -geometry "${SCREEN_W}x${SCREEN_H}" -depth 24 \
     -rfbport "${VNC_PORT}" -SecurityTypes None -localhost \
     -dpi 96 >/tmp/xvnc.log 2>&1 &
for i in $(seq 1 40); do xdpyinfo -display "${DISPLAY}" >/dev/null 2>&1 && break; sleep 0.3; done

log "fluxbox window manager"
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

log "Google Chrome (CDP ${BIND_ADDR}:${CDP_PORT}, window ${SCREEN_W}x${SCREEN_H})"
google-chrome \
  --no-sandbox --disable-gpu --disable-dev-shm-usage \
  --no-first-run --no-default-browser-check \
  --remote-debugging-port="${CDP_PORT}" \
  --remote-debugging-address="${BIND_ADDR}" \
  --window-position=0,0 --window-size="${SCREEN_W},${SCREEN_H}" \
  --user-data-dir=/tmp/chrome-profile \
  "about:blank" >/tmp/chrome.log 2>&1 &

for i in $(seq 1 40); do curl -sf "http://${BIND_ADDR}:${CDP_PORT}/json/version" >/dev/null 2>&1 && break; sleep 0.5; done
log "CDP ready: $(curl -s http://${BIND_ADDR}:${CDP_PORT}/json/version | head -c 80)"

# Watchdog: re-fit the Chrome window whenever the desktop geometry changes.
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

# DEV: run the tsx source dispatch (transpiles TypeScript at runtime).
log "dsh web on ${BIND_ADDR}:${DSH_PORT} (tsx source dispatch)"
cd /app
exec pnpm dsh web --no-open --port "${DSH_PORT}"
