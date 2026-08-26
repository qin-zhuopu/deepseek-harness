#!/usr/bin/env bash
# =====================================================================
# 在 amd64 构建机上构建 dsh-aio:dev 镜像（arm64 用 build-dsh-aio-dev-arm64.sh，
# 两个脚本不做多架构 manifest 合并，各推各的 -amd64/-arm64 后缀 tag）
#
# 构建链（两步，chrome 运行底座直接用 harbor 已有的 amd64 版）：
#   1. docker/dsh/Dockerfile         -> dsh:dev（pnpm install + build）
#   2. docker/dsh-aio/Dockerfile     -> dsh-aio:dev（应用+Chrome+noVNC 一体）
#      CHROME_BASE_IMAGE 默认即 harbor.jereh.cn/base/ubuntu:24.04-node22-python312-chrome
#      （amd64 已发布；若拉不到，可先构建 docker/chrome-base/Dockerfile 传参替换）
#
# 基础镜像 node:24 等由构建机 daemon.json 里的镜像加速器代理拉取，
# 不直连 Docker Hub——不要反复拉公网镜像。
#
# 用法（在仓库根目录）：
#   ./docker/build-dsh-aio-dev-amd64.sh            # 只构建
#   ./docker/build-dsh-aio-dev-amd64.sh --push     # 构建后推 harbor（-amd64 后缀 tag）
#   前置：先 docker login harbor.jereh.cn（或提供 HARBOR_USERNAME/HARBOR_PASSWORD）。
# =====================================================================

set -euo pipefail

HARBOR="${HARBOR:-harbor.jereh.cn}"
HARBOR_BASE="${HARBOR}/base"
CHROME_BASE_IMAGE="${CHROME_BASE_IMAGE:-$HARBOR_BASE/ubuntu:24.04-node22-python312-chrome}"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

log()  { printf '\033[1;34m[aio-dev-amd64]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[aio-dev-amd64] ERROR\033[0m %s\n' "$*" >&2; exit 1; }

PUSH=0
[ "${1:-}" = --push ] && PUSH=1

# ── 环境检查 ────────────────────────────────────────────────────────────
[ "$(uname -m)" = x86_64 ] || die "本脚本只 amd64 原生构建（当前 $(uname -m)）。"
command -v docker >/dev/null || die "未找到 docker。"
command -v git >/dev/null || die "未找到 git（需要取 DSH_CLIENT_COMMIT_HASH）。"
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "请在仓库内运行（构建上下文需要源码树）。"

COMMIT="$(git rev-parse HEAD)"
COMMIT_SHORT="$(git rev-parse --short HEAD)"
BUILD_TS="$(date -u +%Y%m%dT%H%M%SZ)"

echo "----------------------------------------"
echo " 主机     : $(hostname) ($(uname -m))"
echo " 源码提交 : $COMMIT_SHORT"
echo " 底座     : $CHROME_BASE_IMAGE"
echo " 产物     : dsh-aio:dev-amd64 + dsh-aio:dev-amd64-${COMMIT_SHORT}"
[ "$PUSH" = 1 ] && echo " 推送     : $HARBOR_BASE（全部 -amd64 后缀 tag）" \
                 || echo " 推送     : 无（只构建）"
echo "----------------------------------------"

# ── 1) dsh:dev（源码全构建，最耗时） ────────────────────────────────────
log "1/2 构建 dsh:dev（源码提交 $COMMIT_SHORT）"
docker build \
  --build-arg "DSH_CLIENT_COMMIT_HASH=$COMMIT" \
  --build-arg "DSH_BUILD_TS=$BUILD_TS" \
  -t dsh:dev-amd64 \
  -f docker/dsh/Dockerfile .

# ── 2) dsh-aio:dev ─────────────────────────────────────────────────────
log "2/2 构建 dsh-aio:dev"
docker build \
  --build-arg "CHROME_BASE_IMAGE=$CHROME_BASE_IMAGE" \
  --build-arg "DSH_IMAGE=dsh:dev-amd64" \
  --build-arg "DSH_CLIENT_COMMIT_HASH=$COMMIT" \
  --build-arg "DSH_BUILD_TS=$BUILD_TS" \
  -t dsh-aio:dev-amd64 \
  -t "dsh-aio:dev-amd64-$COMMIT_SHORT" \
  -f docker/dsh-aio/Dockerfile \
  docker/dsh-aio

log "构建完成：dsh-aio:dev-amd64 / dsh-aio:dev-amd64-$COMMIT_SHORT"

# ── 推送（可选） ────────────────────────────────────────────────────────
push_as() {  # push_as <本地镜像> <harbor ref>（ref 自带 -amd64 后缀）
  log "推送 $2"
  docker tag "$1" "$2"
  docker push "$2"
}

if [ "$PUSH" = 1 ]; then
  # 登录：优先用环境变量，否则沿用构建机上已有的 docker login
  if [ -n "${HARBOR_USERNAME:-}" ] && [ -n "${HARBOR_PASSWORD:-}" ]; then
    echo "$HARBOR_PASSWORD" | docker login "$HARBOR" \
      --username "$HARBOR_USERNAME" --password-stdin \
      || die "harbor 登录失败。"
  elif ! grep -q "$HARBOR" ~/.docker/config.json 2>/dev/null; then
    die "未登录 harbor：请先 docker login $HARBOR，或提供 HARBOR_USERNAME/HARBOR_PASSWORD。"
  fi

  push_as dsh:dev-amd64           "$HARBOR_BASE/dsh:dev-amd64"
  push_as dsh-aio:dev-amd64       "$HARBOR_BASE/dsh-aio:dev-amd64"
  push_as "dsh-aio:dev-amd64-$COMMIT_SHORT" "$HARBOR_BASE/dsh-aio:dev-amd64-$COMMIT_SHORT"

  log "推送完成。"
fi
