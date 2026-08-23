#!/bin/bash
# All-in-one supervisor (PRODUCTION): virtual display + Chrome(CDP) + noVNC +
# dsh web, booted from the COMPILED CLI entry (apps/cli/lib/bin.js) instead of
# transpiling TypeScript at runtime through tsx.
#
# The only difference from entrypoint.sh is the final dsh launch line: it runs
# `node apps/cli/lib/bin.js` (the tsdown build output) rather than `pnpm dsh`
# (which is `node --import tsx/esm apps/cli/src/bin.ts` — dev/JIT transpile).
set -e

: "${DISPLAY_NUM:=99}"
: "${SCREEN_GEOMETRY:=1440x900x24}"
: "${VNC_PORT:=5900}"
: "${NOVNC_PORT:=6080}"
: "${CDP_PORT:=9222}"
: "${DSH_PORT:=3080}"
: "${BIND_ADDR:=127.0.0.1}"
export DISPLAY=":${DISPLAY_NUM}"
export PATH=/opt/node/bin:$PATH
export DSH_HOME=/root/.dsh

log() { echo "[aio] $*"; }
cleanup() { pkill -P $$ 2>/dev/null || true; }
trap cleanup EXIT INT TERM

log "Xvfb ${DISPLAY} (${SCREEN_GEOMETRY})"
Xvfb "${DISPLAY}" -screen 0 "${SCREEN_GEOMETRY}" -nolisten tcp &
for i in $(seq 1 40); do xdpyinfo -display "${DISPLAY}" >/dev/null 2>&1 && break; sleep 0.3; done

log "fluxbox window manager"
fluxbox >/dev/null 2>&1 &

log "x11vnc ${BIND_ADDR}:${VNC_PORT} (no password)"
x11vnc -display "${DISPLAY}" -listen "${BIND_ADDR}" -rfbport "${VNC_PORT}" \
       -forever -shared -nopw -quiet -xkb -noxrecord -noxfixes -noxdamage &

log "noVNC (websockify) ${BIND_ADDR}:${NOVNC_PORT}"
websockify --web=/usr/share/novnc "${BIND_ADDR}:${NOVNC_PORT}" "localhost:${VNC_PORT}" &

log "Google Chrome (CDP ${BIND_ADDR}:${CDP_PORT})"
google-chrome \
  --no-sandbox --disable-gpu --disable-dev-shm-usage \
  --no-first-run --no-default-browser-check \
  --remote-debugging-port="${CDP_PORT}" \
  --remote-debugging-address="${BIND_ADDR}" \
  --window-position=0,0 --start-maximized \
  --user-data-dir=/tmp/chrome-profile \
  "about:blank" >/tmp/chrome.log 2>&1 &

# wait for CDP so the MCP client's first connect succeeds
for i in $(seq 1 40); do curl -sf "http://${BIND_ADDR}:${CDP_PORT}/json/version" >/dev/null 2>&1 && break; sleep 0.5; done
log "CDP ready: $(curl -s http://${BIND_ADDR}:${CDP_PORT}/json/version | head -c 80)"

# PRODUCTION: run the compiled entry, not the tsx source dispatch.
log "dsh web on ${BIND_ADDR}:${DSH_PORT} (compiled entry)"
cd /app
exec node apps/cli/lib/bin.js web --no-open --port "${DSH_PORT}"
