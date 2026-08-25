# =====================================================================
# DeepSeek Harness — ALL-IN-ONE image
# dsh web + Chrome (CDP) + noVNC + chrome-devtools MCP, pre-wired.
#
# Build:  docker build -t dsh-aio:dev -f Dockerfile .
# Run:    docker run -d --name dsh-aio --network host --shm-size=1g \
#             -e NR_API_KEY=<your-key> dsh-aio:dev
# Open:   dsh Web UI  -> http://127.0.0.1:3080/
#         Chrome view -> http://127.0.0.1:6080/vnc.html
#
# Ask the agent to "use the chrome tools to open baidu"; the browser
# action is visible live in the noVNC tab.
#
# NOTE: --network host is required. dsh web binds 127.0.0.1 only (refuses
# 0.0.0.0 for RCE safety), and the baked MCP client reaches Chrome over the
# shared host loopback (127.0.0.1:9222). NR_API_KEY is injected at runtime,
# never baked into the image.
# =====================================================================

# Build arguments, all defaulted to the amd64 images this file was written for:
#   DSH_IMAGE          stage-1 source of the built /app
#   CHROME_BASE_IMAGE  runtime base. The harbor default is linux/amd64 only; on
#                      arm64 build docker/chrome-base/Dockerfile and pass it here.
#   NODE_IMAGE         source of the /opt/node runtime, mirror-redirectable
ARG DSH_IMAGE=dsh:dev
ARG CHROME_BASE_IMAGE=harbor.jereh.cn/base/ubuntu:24.04-node22-python312-chrome
ARG NODE_IMAGE=node:24

# ---- Stage 1: reuse the already-built dsh app ----
FROM ${DSH_IMAGE} AS dshbuild
# /app is fully installed + built here.

# ---- Stage 1b: the Node 24 runtime, as a named stage ----
# BuildKit rejects variable expansion in `COPY --from=`, so the argument is
# resolved by this FROM and the copies below reference the stage name.
FROM ${NODE_IMAGE} AS noderuntime

# ---- Stage 2: runtime on the Chrome base ----
FROM ${CHROME_BASE_IMAGE}

# Node 24 in an isolated prefix (base image ships an unusable nvm node).
COPY --from=noderuntime /usr/local/bin/node /opt/node/bin/node
COPY --from=noderuntime /usr/local/lib/node_modules/npm /opt/node/lib/node_modules/npm
ENV PATH=/opt/node/bin:$PATH
RUN ln -sf /opt/node/lib/node_modules/npm/bin/npm-cli.js /opt/node/bin/npm \
 && npm config set registry https://nexus.jereh.cn/repository/npm-public/ \
 && npm install -g pnpm@11.7.0 chrome-devtools-mcp@1.7.0

# Display/VNC stack: Xvnc (X server + VNC server with dynamic RandR sizes),
# noVNC web bridge, a light WM, plus wmctrl for the Chrome re-fit watchdog.
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      tigervnc-standalone-server wmctrl fluxbox novnc websockify x11-utils curl \
 && rm -rf /var/lib/apt/lists/*

# Desktop-fit helpers (see Dockerfile.prod for the rationale).
COPY vnc-resize-sidecar.py /usr/local/bin/vnc-resize-sidecar.py
COPY fit-resize.js /usr/share/novnc/fit-resize.js
COPY patch-vnc-html.py /usr/local/bin/patch-vnc-html.py
COPY front-proxy.js /usr/local/bin/front-proxy.js
RUN chmod +x /usr/local/bin/vnc-resize-sidecar.py \
 && python3 /usr/local/bin/patch-vnc-html.py /usr/share/novnc/vnc.html

# The built dsh application.
COPY --from=dshbuild /app /app

# Pre-wired DSH_HOME: web profile, nr provider, default model, chrome MCP patch.
# (no credentials, no sessions — NR_API_KEY comes from -e at runtime)
COPY dshhome/.dsh /root/.dsh

# Supervisor that launches the whole stack.
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENV DSH_HOME=/root/.dsh
# dsh web (3080), noVNC (6080), resize sidecar (6081), raw VNC (5900),
# CDP (9222), front-proxy (8080, only when FRONT_PORT is set)
EXPOSE 3080 6080 6081 5900 9222 8080

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]