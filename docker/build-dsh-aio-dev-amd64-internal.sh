#!/usr/bin/env bash
# =====================================================================
# 在内网气隙机（10.1.17.58, amd64）上构建 dsh-aio dev 镜像。
# 与 build-dsh-aio-dev-amd64.sh 的区别：全部外部源改走内网，构建上下文由
# Jenkins 通过 tar-over-ssh 同步到 /opt/dsh-aio-build（本机无 git、无公网）。
#
# 构建链（同 .internal Dockerfile 设计）：
#   1. docker/dsh/Dockerfile.internal      -> dsh:dev-amd64
#   2. docker/dsh-aio/Dockerfile.internal  -> dsh-aio:dev-amd64(-<sha>)
#
# 外部源（全部 env 可覆盖，默认值即 10.1.17.58 实测可用值）：
#   NODE_IMAGE / CHROME_BASE_IMAGE  harbor.jereh.cn 基础镜像
#   NPM_REGISTRY                    Nexus npm group（corepack/pnpm/npm 同源）
#   APT_MIRROR                      Nexus raw 代理 apt-ubuntu-amd64（清华源透传）。
#                                   不要用 apt-aliyun：Nexus 3.37 的 apt 格式代理
#                                   取 .deb 一律 502，raw 格式代理正常。
#   JCLI_DOWNLOAD_BASE              MinIO 公开桶里的 jcli v0.0.47 发布包
#
# 用法（在同步后的仓库目录内）：
#   bash docker/build-dsh-aio-dev-amd64-internal.sh
#   PUSH_HARBOR=1 bash docker/build-dsh-aio-dev-amd64-internal.sh   # 构建后推 harbor
# 前置：docker 已 docker login harbor.jereh.cn（构建推送时）。
# =====================================================================

set -euo pipefail

HARBOR="${HARBOR:-harbor.jereh.cn}"
HARBOR_BASE="${HARBOR}/base"
NODE_IMAGE="${NODE_IMAGE:-$HARBOR_BASE/node:24}"
CHROME_BASE_IMAGE="${CHROME_BASE_IMAGE:-$HARBOR_BASE/ubuntu:24.04-node22-python312-chrome}"
NPM_REGISTRY="${NPM_REGISTRY:-https://nexus.jereh.cn/repository/npm-public/}"
APT_MIRROR="${APT_MIRROR:-http://10.1.7.49:8081/repository/apt-ubuntu-amd64/}"
JCLI_DOWNLOAD_BASE="${JCLI_DOWNLOAD_BASE:-https://minio-api.jereh.cn/base/jcli/v0.0.47}"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

log() { printf '\033[1;34m[aio-dev-amd64-internal]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[aio-dev-amd64-internal] ERROR\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(uname -m)" = x86_64 ] || die "本脚本只 amd64 原生构建（当前 $(uname -m)）。"
command -v docker >/dev/null || die "未找到 docker。"

COMMIT="${DSH_CLIENT_COMMIT_HASH:-$(git rev-parse HEAD 2>/dev/null || echo unknown)}"
COMMIT_SHORT="$(printf '%.8s' "$COMMIT")"
BUILD_TS="$(date -u +%Y%m%dT%H%M%SZ)"

echo "----------------------------------------"
echo " 主机     : $(hostname) ($(uname -m))"
echo " 源码提交 : $COMMIT_SHORT"
echo " node     : $NODE_IMAGE"
echo " chrome底座: $CHROME_BASE_IMAGE"
echo " npm      : $NPM_REGISTRY"
echo " apt      : $APT_MIRROR"
echo " jcli     : $JCLI_DOWNLOAD_BASE"
echo " 产物     : dsh-aio:dev-amd64 + dsh-aio:dev-amd64-$COMMIT_SHORT"
echo "----------------------------------------"

# ── 0) 外部源预检：失败立即退出，不烧构建时长 ──────────────────────────
curl -fsS -m 30 -o /dev/null "${JCLI_DOWNLOAD_BASE}/jcli-linux-amd64.tar.gz" \
  || die "jcli 包不可达: ${JCLI_DOWNLOAD_BASE}/jcli-linux-amd64.tar.gz"
curl -fsS -m 60 -o /dev/null "${APT_MIRROR}dists/noble/main/binary-amd64/Packages.gz" \
  || die "apt 镜像索引不可达: ${APT_MIRROR}dists/noble/main/binary-amd64/Packages.gz"

docker pull "$NODE_IMAGE" >/dev/null
docker pull "$CHROME_BASE_IMAGE" >/dev/null

# ── 1) dsh:dev-amd64（源码全构建，最耗时） ─────────────────────────────
log "1/2 构建 dsh:dev-amd64（源码提交 $COMMIT_SHORT）"
docker build \
  --build-arg "NODE_IMAGE=$NODE_IMAGE" \
  --build-arg "NPM_REGISTRY=$NPM_REGISTRY" \
  --build-arg "DSH_CLIENT_COMMIT_HASH=$COMMIT" \
  --build-arg "DSH_BUILD_TS=$BUILD_TS" \
  -t dsh:dev-amd64 \
  -f docker/dsh/Dockerfile.internal .

# ── 2) dsh-aio:dev-amd64 ───────────────────────────────────────────────
log "2/2 构建 dsh-aio:dev-amd64"
docker build \
  --build-arg "DSH_IMAGE=dsh:dev-amd64" \
  --build-arg "NODE_IMAGE=$NODE_IMAGE" \
  --build-arg "CHROME_BASE_IMAGE=$CHROME_BASE_IMAGE" \
  --build-arg "NPM_REGISTRY=$NPM_REGISTRY" \
  --build-arg "APT_MIRROR=$APT_MIRROR" \
  --build-arg "JCLI_DOWNLOAD_BASE=$JCLI_DOWNLOAD_BASE" \
  -t dsh-aio:dev-amd64 \
  -t "dsh-aio:dev-amd64-$COMMIT_SHORT" \
  -f docker/dsh-aio/Dockerfile.internal \
  docker/dsh-aio

log "构建完成：dsh-aio:dev-amd64 / dsh-aio:dev-amd64-$COMMIT_SHORT"

# ── 推送（可选） ────────────────────────────────────────────────────────
push_as() {  # push_as <本地镜像> <harbor ref>
  log "推送 $2"
  docker tag "$1" "$2"
  docker push "$2"
}

if [ "${PUSH_HARBOR:-0}" = 1 ]; then
  grep -q "$HARBOR" ~/.docker/config.json 2>/dev/null \
    || die "未登录 harbor：先 docker login $HARBOR。"
  push_as dsh:dev-amd64           "$HARBOR_BASE/dsh:dev-amd64"
  push_as dsh-aio:dev-amd64       "$HARBOR_BASE/dsh-aio:dev-amd64"
  push_as "dsh-aio:dev-amd64-$COMMIT_SHORT" "$HARBOR_BASE/dsh-aio:dev-amd64-$COMMIT_SHORT"
  log "推送完成。"
fi
