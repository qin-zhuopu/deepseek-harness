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

# ---- Stage 1: reuse the already-built dsh app ----
FROM dsh:dev AS dshbuild
# /app is fully installed + built here.

# ---- Stage 2: runtime on the Chrome base ----
FROM harbor.jereh.cn/base/ubuntu:24.04-node22-python312-chrome

# Node 24 in an isolated prefix (base image ships an unusable nvm node).
COPY --from=node:24 /usr/local/bin/node /opt/node/bin/node
COPY --from=node:24 /usr/local/lib/node_modules/npm /opt/node/lib/node_modules/npm
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
RUN chmod +x /usr/local/bin/vnc-resize-sidecar.py \
 && python3 -c "\
html = open('/usr/share/novnc/vnc.html').read();\
insert = '<script src=\"fit-resize.js\"></script>';\
open('/usr/share/novnc/vnc.html', 'w').write(\
    html if 'fit-resize.js' in html\
    else html.replace('</body>', insert + '</body>'))"

# The built dsh application.
COPY --from=dshbuild /app /app

# Pre-wired DSH_HOME: web profile, nr provider, default model, chrome MCP patch.
# (no credentials, no sessions — NR_API_KEY comes from -e at runtime)
COPY dshhome/.dsh /root/.dsh

# Supervisor that launches the whole stack.
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENV DSH_HOME=/root/.dsh
# dsh web (3080), noVNC (6080), raw VNC (5900), Chrome CDP (9222)
EXPOSE 3080 6080 5900 9222

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]