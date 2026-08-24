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

log "vnc-resize-sidecar on 127.0.0.1:6081"
python3 /usr/local/bin/vnc-resize-sidecar.py &

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

# PRODUCTION: run the compiled entry, not the tsx source dispatch.
log "dsh web on ${BIND_ADDR}:${DSH_PORT} (compiled entry)"
cd /app
exec node apps/cli/lib/bin.js web --no-open --port "${DSH_PORT}"
