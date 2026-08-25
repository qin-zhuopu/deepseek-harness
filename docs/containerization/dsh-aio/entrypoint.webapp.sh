#!/bin/bash
# Supervisor for the webapp variant: everything the aio entrypoint does, plus
# the Vite dev server and a Chrome tab already pointed at it.
#
# A wrapper rather than a fork of entrypoint.aio.sh (the base image's
# entrypoint, kept under that name by Dockerfile.webapp). The base script owns
# the display stack, dsh web, and PID 1, and duplicating its ~200 lines here
# would leave two copies to keep in sync. So the extra work is queued in the
# background first and the base script is exec'd last, taking over PID 1
# exactly as it does in the plain image.
set -e

: "${APP_DIR:=/root/workspace}"
: "${VITE_PORT:=5173}"
: "${CDP_PORT:=9222}"
: "${BIND_ADDR:=127.0.0.1}"
# Set OPEN_APP=0 to leave Chrome on about:blank (the dev server still starts).
: "${OPEN_APP:=1}"

log() { echo "[webapp] $*"; }

# Vite's own --host default would bind every interface; keep it on BIND_ADDR so
# the dev server follows the same exposure rules as the rest of the image.
# --strictPort makes a port collision fail loudly instead of silently serving
# on another port that nothing else in the image knows about.
if [ -d "${APP_DIR}" ] && [ -f "${APP_DIR}/package.json" ]; then
  (
    cd "${APP_DIR}"
    log "vite dev server on ${BIND_ADDR}:${VITE_PORT}"
    npm run dev -- --host "${BIND_ADDR}" --port "${VITE_PORT}" --strictPort \
      >/tmp/vite.log 2>&1
  ) &
else
  log "no project at ${APP_DIR}; skipping dev server"
fi

# Hand the dev URL to the Chrome the base script launches. Both waits are
# required: Chrome's CDP endpoint appears a second or two after launch, and
# navigating before Vite answers would land on a connection error.
if [ "${OPEN_APP}" != "0" ]; then
  (
    APP_URL="http://${BIND_ADDR}:${VITE_PORT}/"
    for _ in $(seq 1 60); do
      curl -sf -o /dev/null "http://${BIND_ADDR}:${CDP_PORT}/json/version" && break
      sleep 0.5
    done
    for _ in $(seq 1 120); do
      curl -sf -o /dev/null "${APP_URL}" && break
      sleep 0.5
    done
    # Reuse the existing about:blank target instead of /json/new, which would
    # leave a stray blank tab. Page.navigate needs a WebSocket, so this speaks
    # CDP through node (already on PATH) rather than curl.
    if node /usr/local/bin/cdp-navigate.js "${APP_URL}" >/tmp/cdp-navigate.log 2>&1; then
      log "chrome navigated to ${APP_URL}"
    else
      log "chrome navigation failed (non-fatal); see /tmp/cdp-navigate.log"
    fi
  ) &
fi

# The base supervisor takes over as PID 1.
exec /usr/local/bin/entrypoint.aio.sh
