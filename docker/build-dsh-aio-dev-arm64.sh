#!/usr/bin/env bash
# =====================================================================
# 在 arm64 构建机（如 gb10, 10.202.200.139）上构建 dsh-aio:dev 镜像
#
# 构建链（三步，全部原生 arm64，不需要 buildx/QEMU）：
#   1. docker/chrome-base/Dockerfile   -> dsh-chrome-base:24.04
#      （harbor 的 ubuntu:24.04-…-chrome 只发 amd64，arm64 必须自建）
#   2. docker/dsh/Dockerfile           -> dsh:dev（pnpm install + build）
#   3. docker/dsh-aio/Dockerfile       -> dsh-aio:dev（应用+Chrome+noVNC 一体）
#
# 基础镜像 ubuntu:24.04 / node:24 由构建机 daemon.json 里的镜像加速器
# （docker.1ms.run 等）代理拉取，不直连 Docker Hub——不要反复拉公网镜像。
#
# 用法（在仓库根目录）：
#   ./docker/build-dsh-aio-dev-arm64.sh            # 只构建
#   ./docker/build-dsh-aio-dev-arm64.sh --push     # 构建后推 harbor
#
# --push 规则（不分架构合并 manifest，arm64/amd64 各用各的脚本与 tag）：
#   • 推送一律带 -arm64 后缀 tag（如 dsh-aio:dev-arm64），不碰 harbor 上
#     已有的 amd64 tag（:dev 等），两边互不干扰；
#   • 前置：先 docker login harbor.jereh.cn（或提供 HARBOR_USERNAME/PASSWORD）。
# =====================================================================

set -euo pipefail

HARBOR="${HARBOR:-harbor.jereh.cn}"
HARBOR_BASE="${HARBOR}/base"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

log()  { printf '\033[1;34m[aio-dev-arm64]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[aio-dev-arm64] ERROR\033[0m %s\n' "$*" >&2; exit 1; }

PUSH=0
[ "${1:-}" = --push ] && PUSH=1

# ── 环境检查 ────────────────────────────────────────────────────────────
[ "$(uname -m)" = aarch64 ] || die "本脚本只 arm64 原生构建（当前 $(uname -m)）。"
command -v docker >/dev/null || die "未找到 docker。"
command -v git >/dev/null || die "未找到 git（需要取 DSH_CLIENT_COMMIT_HASH）。"
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "请在仓库内运行（构建上下文需要源码树）。"

COMMIT="$(git rev-parse HEAD)"
COMMIT_SHORT="$(git rev-parse --short HEAD)"
BUILD_TS="$(date -u +%Y%m%dT%H%M%SZ)"

echo "----------------------------------------"
echo " 主机     : $(hostname) ($(uname -m))"
echo " 源码提交 : $COMMIT_SHORT"
echo " 产物     : dsh-aio:dev-arm64 + dsh-aio:dev-arm64-${COMMIT_SHORT}"
[ "$PUSH" = 1 ] && echo " 推送     : $HARBOR_BASE（全部 -arm64 后缀 tag）" \
                 || echo " 推送     : 无（只构建）"
echo "----------------------------------------"

# ── 1) chrome-base ─────────────────────────────────────────────────────
log "1/3 构建 dsh-chrome-base:24.04"
docker build -t dsh-chrome-base:24.04 -f docker/chrome-base/Dockerfile .

# ── 2) dsh:dev（源码全构建，最耗时） ────────────────────────────────────
log "2/3 构建 dsh:dev（源码提交 $COMMIT_SHORT）"
docker build \
  --build-arg "DSH_CLIENT_COMMIT_HASH=$COMMIT" \
  --build-arg "DSH_BUILD_TS=$BUILD_TS" \
  -t dsh:dev \
  -f docker/dsh/Dockerfile .

# ── 3) dsh-aio:dev ─────────────────────────────────────────────────────
log "3/3 构建 dsh-aio:dev"
docker build \
  --build-arg "CHROME_BASE_IMAGE=dsh-chrome-base:24.04" \
  --build-arg "DSH_IMAGE=dsh:dev" \
  -t dsh-aio:dev-arm64 \
  -t "dsh-aio:dev-arm64-$COMMIT_SHORT" \
  -f docker/dsh-aio/Dockerfile \
  docker/dsh-aio

log "构建完成：dsh-aio:dev-arm64 / dsh-aio:dev-arm64-$COMMIT_SHORT"

# ── 推送（可选） ────────────────────────────────────────────────────────
push_as() {  # push_as <本地镜像> <harbor ref>（ref 自带 -arm64 后缀）
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

  # 自产三层：按规范务必推 harbor 复用
  push_as dsh-chrome-base:24.04 "$HARBOR_BASE/dsh-chrome-base:24.04-arm64"
  push_as dsh:dev                "$HARBOR_BASE/dsh:dev-arm64"
  push_as dsh-aio:dev-arm64      "$HARBOR_BASE/dsh-aio:dev-arm64"
  push_as "dsh-aio:dev-arm64-$COMMIT_SHORT" "$HARBOR_BASE/dsh-aio:dev-arm64-$COMMIT_SHORT"

  # 基础镜像（代理拉到的 arm64 版）同步回 harbor，供其他 arm64 机构建直接引用
  push_as ubuntu:24.04 "$HARBOR_BASE/ubuntu:24.04-arm64"
  push_as node:24      "$HARBOR_BASE/node:24-arm64"

  log "推送完成。"
fi
