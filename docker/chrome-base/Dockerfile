# =====================================================================
# Ubuntu 24.04 + Python 3.12 + Google Chrome — multi-architecture base
#
# Build:  docker build -t dsh-chrome-base:24.04 -f docker/chrome-base/Dockerfile .
#
# Stands in for harbor.jereh.cn/base/ubuntu:24.04-node22-python312-chrome, which
# is published for linux/amd64 only. The dsh-aio images take their runtime base
# through a build argument, so an arm64 host builds this locally and passes it as
# CHROME_BASE_IMAGE.
#
# Node is deliberately absent: every dsh-aio variant installs Node 24 into
# /opt/node and puts it first on PATH, so a distribution Node in this base would
# only shadow it.
#
# Chrome comes from Google's apt repository rather than a fixed .deb URL, so the
# same instruction resolves google-chrome-stable for amd64 and arm64 and apt
# pulls the shared library dependencies with it.
#
# UBUNTU_IMAGE redirects the base at a registry mirror on hosts that cannot
# reach Docker Hub, e.g.
#   --build-arg UBUNTU_IMAGE=docker.1ms.run/library/ubuntu:24.04
# =====================================================================

ARG UBUNTU_IMAGE=ubuntu:24.04
FROM ${UBUNTU_IMAGE}

SHELL ["/bin/bash", "-o", "pipefail", "-c"]
ENV DEBIAN_FRONTEND=noninteractive

# python3 is 3.12 on noble. git and the rest are the baseline tools an agent
# working inside the container expects to find.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg \
      python3 python3-venv \
      git tmux less procps unzip \
 && rm -rf /var/lib/apt/lists/*

# Google's signing key and repository. `dpkg --print-architecture` keeps the
# entry correct for whichever platform is being built.
RUN curl -fsSL https://dl.google.com/linux/linux_signing_key.pub \
      | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" \
      > /etc/apt/sources.list.d/google-chrome.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends google-chrome-stable \
 && rm -rf /var/lib/apt/lists/*

# Fail the build here rather than at container start if Chrome cannot execute on
# this platform. --no-sandbox is required because the build runs as root.
RUN google-chrome --version \
 && google-chrome --headless --no-sandbox --disable-gpu --dump-dom about:blank > /dev/null

CMD ["/bin/bash"]
