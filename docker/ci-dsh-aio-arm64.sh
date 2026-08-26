#!/usr/bin/env bash
# =====================================================================
# 在本地（当前工作区）一条命令 -> 同步 .git 到 gb10 构建目录 ->
# gb10 上 git checkout -f 出干净工作树 -> 构建 dsh-aio:dev (arm64) ->
# 按参数推送 harbor。
#
# 代码同步方式：只传 .git（tar over ssh，~140MB 内网很快），构建机
# checkout 生成工作树。注意：未 commit 的本地改动不会带过去——
# 要构建未提交内容请先 commit。
# 所有命令输出原样透传，不吞任何输出。
#
# 用法示例（在仓库根目录）：
#   ./docker/ci-dsh-aio-arm64.sh -p                # 构建并推送（默认 gb10）
#   ./docker/ci-dsh-aio-arm64.sh                   # 只构建不推送
#   ./docker/ci-dsh-aio-arm64.sh -p -H 10.202.200.139 -u jereh -d build/dsh-aio-dev
#   ./docker/ci-dsh-aio-arm64.sh -h                # 查看全部参数
# =====================================================================
set -euo pipefail

usage() {
  cat <<'EOF'
用法: docker/ci-dsh-aio-arm64.sh [选项]

功能: 同步本地 .git 到 arm64 构建机 -> checkout 出工作树 -> 构建
      dsh-aio:dev (arm64 镜像链) 并按 -p 推送 harbor。
      （未 commit 的本地改动不会带过去，要构建请先 commit。）

选项:
  -H, --host HOST       构建机地址            (默认: 10.202.200.139)
  -u, --user USER       ssh 用户              (默认: jereh)
  -d, --dir REMOTE_DIR  构建机上的构建目录    (默认: build/dsh-aio-dev)
                        相对路径则位于用户家目录下；每次构建前会清空重建
  -r, --registry REG    harbor 地址            (默认: harbor.jereh.cn)
  -p, --push            构建后推送到 harbor（推 -arm64 后缀 tag；
                        需构建机已 docker login，或传 HARBOR_USERNAME/
                        HARBOR_PASSWORD 环境变量）
  -k, --keep            不清空构建目录，覆盖式同步 .git（默认每次清空重建）
  -h, --help            显示本帮助

环境变量:
  HARBOR_USERNAME / HARBOR_PASSWORD   传给构建机的构建脚本做 docker login
  SSH_KEY=...                         附加的 ssh -i 私钥参数（可选）

示例:
  # 最常用：构建并推送
  ./docker/ci-dsh-aio-arm64.sh -p

  # 指定构建机与目录
  ./docker/ci-dsh-aio-arm64.sh -p -H 10.202.200.139 -d build/dsh-aio-dev
EOF
}

HOST="10.202.200.139"
USER_NAME="jereh"
REMOTE_DIR="build/dsh-aio-dev"
REGISTRY="harbor.jereh.cn"
PUSH=0
KEEP=0
SSH_KEY_ARGS=()

while [ $# -gt 0 ]; do
  case "$1" in
    -H|--host)   HOST="$2"; shift 2 ;;
    -u|--user)   USER_NAME="$2"; shift 2 ;;
    -d|--dir)    REMOTE_DIR="$2"; shift 2 ;;
    -r|--registry) REGISTRY="$2"; shift 2 ;;
    -p|--push)   PUSH=1; shift ;;
    -k|--keep)   KEEP=1; shift ;;
    -h|--help)   usage; exit 0 ;;
    *) echo "未知参数: $1（-h 查看用法）" >&2; exit 2 ;;
  esac
done

log() { printf '\033[1;34m[ci-dsh-aio-arm64]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[ci-dsh-aio-arm64] ERROR\033[0m %s\n' "$*" >&2; exit 1; }

[ -n "${SSH_KEY:-}" ] && SSH_KEY_ARGS=(-i "$SSH_KEY")

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "请在仓库内运行。"
command -v tar >/dev/null || die "本地缺 tar。"

COMMIT_SHORT="$(git rev-parse --short HEAD)"
SSH_CMD="${USER_NAME}@${HOST}"
PUSH_ARG=""
[ "$PUSH" = 1 ] && PUSH_ARG="--push"

log "目标: $SSH_CMD:$REMOTE_DIR  源码提交: $COMMIT_SHORT  推送: $([ "$PUSH" = 1 ] && echo 是 || echo 否)"

# ── 1. 同步 .git 到构建机并 checkout 工作树 ────────────────────────────
log "1/3 同步 .git 到 $SSH_CMD:$REMOTE_DIR（本地提交 $COMMIT_SHORT）"
if [ "$KEEP" = 0 ]; then
  ssh -o BatchMode=yes "${SSH_KEY_ARGS[@]}" "$SSH_CMD" "rm -rf '$REMOTE_DIR' && mkdir -p '$REMOTE_DIR'"
else
  ssh -o BatchMode=yes "${SSH_KEY_ARGS[@]}" "$SSH_CMD" "mkdir -p '$REMOTE_DIR'"
fi
COMMIT="$(git rev-parse HEAD)"
tar -cf - .git | ssh -o BatchMode=yes "${SSH_KEY_ARGS[@]}" "$SSH_CMD" "tar -xf - -C '$REMOTE_DIR'"
# checkout 出干净工作树：autocrlf 关掉（Windows 的 .git/config 可能带
# autocrlf=true，会让 Linux checkout 出 CRLF 文件烤进镜像）；-f 覆盖旧
# 树，clean -fdx 清掉上次构建的残留
ssh -o BatchMode=yes "${SSH_KEY_ARGS[@]}" "$SSH_CMD" \
  "cd '$REMOTE_DIR' && git config core.autocrlf false && git checkout -f '$COMMIT' && git clean -fdx"

# ── 2. 在构建机上构建（必要时推送） ─────────────────────────────────────
log "2/3 在 $SSH_CMD 上构建（输出原样透传）"
HARBOR_ENV=""
if [ -n "${HARBOR_USERNAME:-}" ] && [ -n "${HARBOR_PASSWORD:-}" ]; then
  HARBOR_ENV="HARBOR_USERNAME='$HARBOR_USERNAME' HARBOR_PASSWORD='$HARBOR_PASSWORD'"
fi

# shellcheck disable=SC2086
ssh -o BatchMode=yes "${SSH_KEY_ARGS[@]}" "$SSH_CMD" \
  "cd '$REMOTE_DIR' && HARBOR='$REGISTRY' $HARBOR_ENV bash docker/build-dsh-aio-dev-arm64.sh $PUSH_ARG"

log "3/3 完成"
