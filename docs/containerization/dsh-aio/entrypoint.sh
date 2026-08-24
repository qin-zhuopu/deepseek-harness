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

log "vnc-resize-sidecar on 127.0.0.1:6081"
python3 /usr/local/bin/vnc-resize-sidecar.py &

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

# DEV: run the tsx source dispatch (transpiles TypeScript at runtime).
log "dsh web on ${BIND_ADDR}:${DSH_PORT} (tsx source dispatch)"
cd /app
exec pnpm dsh web --no-open --port "${DSH_PORT}"
