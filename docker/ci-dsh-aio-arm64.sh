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

# 密钥处理：$HOME 下的密钥直接用（权限正常）；从别的路径（如 WSL 的
# /mnt/* drvfs，权限恒 0777 会被 ssh 以 "too open" 拒用）回退找到的密钥，
# 先拷到 mktemp 临时文件（git-bash 与 WSL 都落在原生 fs）收紧成 600 再用。
handle_ssh_key() {
  if [ -n "${SSH_KEY:-}" ]; then
    case "$SSH_KEY" in
      "$HOME"/*) : ;;
      *)
        SSH_KEY_COPY="$(mktemp 2>/dev/null || echo "/tmp/dsh-ci-id-$$")"
        if cp -f "$SSH_KEY" "$SSH_KEY_COPY" && chmod 600 "$SSH_KEY_COPY"; then
          SSH_KEY="$SSH_KEY_COPY"
        else
          log "警告: 密钥复制失败，按原路径使用 $SSH_KEY"
        fi ;;
    esac
  fi
  [ -n "${SSH_KEY:-}" ] && SSH_KEY_ARGS=(-i "$SSH_KEY" -o IdentitiesOnly=yes)
}
SSH_CMD="${USER_NAME}@${HOST}"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "请在仓库内运行。"
command -v tar >/dev/null || die "本地缺 tar。"

# 私钥探测：当前 shell 的 HOME 可能不是真实用户目录（如 WSL 下 HOME=/root
# 没有密钥），除 $HOME/.ssh 外，再试仓库向上 4 级（<home>/repo/<org>/<repo>/
# 本仓库）的用户 .ssh，并同时兼容 git-bash 的 /c/... 与 WSL 的 /mnt/c/...
# 两种盘符路径。找到就以 -i 显式指定，避免认证漂移。
if [ -z "${SSH_KEY:-}" ]; then
  GUESSED_HOME="$(cd "$REPO_ROOT/../../../.." 2>/dev/null && pwd || true)"
  TWIN_HOME=""
  case "$GUESSED_HOME" in
    /c/*)          TWIN_HOME="/mnt${GUESSED_HOME}" ;;
    /mnt/c/*)      TWIN_HOME="${GUESSED_HOME#/mnt}" ;;
  esac
  for k in "$HOME/.ssh/id_rsa" "$HOME/.ssh/id_ed25519" \
           "${GUESSED_HOME:-/nonexistent}/.ssh/id_rsa" "${GUESSED_HOME:-/nonexistent}/.ssh/id_ed25519" \
           "${TWIN_HOME:-/nonexistent}/.ssh/id_rsa"   "${TWIN_HOME:-/nonexistent}/.ssh/id_ed25519"; do
    if [ -f "$k" ]; then SSH_KEY="$k"; break; fi
  done
fi
handle_ssh_key   # 探测完成后处理复制/权限并生成 SSH_KEY_ARGS
# ssh 公共参数（不使用 ControlMaster：Windows OpenSSH 不支持连接复用）
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=10 "${SSH_KEY_ARGS[@]}")
log "ssh 私钥: ${SSH_KEY:-（未探测到，依赖默认）}  HOME=$HOME"

# 预检：ssh 可达才继续，偶发 Permission denied 重试 3 次
for attempt in 1 2 3; do
  if err="$(ssh "${SSH_OPTS[@]}" "$SSH_CMD" 'true' 2>&1)"; then break; fi
  if [ "$attempt" = 3 ]; then
    ssh -v "${SSH_OPTS[@]}" "$SSH_CMD" 'true' 2>&1 | grep -E 'Offering|accepts|denied|Authenticat|identity file|too open|Load key' || true
    die "ssh 连不上 $SSH_CMD：$err"
  fi
  log "ssh 预检失败（$err），${attempt}0 秒后重试($attempt/3)…"; sleep "${attempt}0"
done

COMMIT_SHORT="$(git rev-parse --short HEAD)"
SSH_CMD="${USER_NAME}@${HOST}"
PUSH_ARG=""
[ "$PUSH" = 1 ] && PUSH_ARG="--push"

log "目标: $SSH_CMD:$REMOTE_DIR  源码提交: $COMMIT_SHORT  推送: $([ "$PUSH" = 1 ] && echo 是 || echo 否)"

# ── 1. 同步 .git 到构建机并 checkout 工作树 ────────────────────────────
log "1/3 同步 .git 到 $SSH_CMD:$REMOTE_DIR（本地提交 $COMMIT_SHORT）"
if [ "$KEEP" = 0 ]; then
  ssh "${SSH_OPTS[@]}" "$SSH_CMD" "rm -rf '$REMOTE_DIR' && mkdir -p '$REMOTE_DIR'"
else
  ssh "${SSH_OPTS[@]}" "$SSH_CMD" "mkdir -p '$REMOTE_DIR'"
fi
COMMIT="$(git rev-parse HEAD)"
tar -cf - .git | ssh "${SSH_OPTS[@]}" "$SSH_CMD" "tar -xf - -C '$REMOTE_DIR'"
# checkout 出干净工作树：autocrlf 关掉（Windows 的 .git/config 可能带
# autocrlf=true，会让 Linux checkout 出 CRLF 文件烤进镜像）；-f 覆盖旧
# 树，clean -fdx 清掉上次构建的残留
ssh "${SSH_OPTS[@]}" "$SSH_CMD" \
  "cd '$REMOTE_DIR' && git config core.autocrlf false && git checkout -f '$COMMIT' && git clean -fdx"

# 归一 worktree 专属的 hooks 路径为容器内路径 /app/.git/dsh-hooks。
# 本机 .git 的 config.worktree（core.hooksPath）与 dsh-hooks/.dsh-lefthook-owned
# 记的是开发者工作副本的绝对路径（如 C:\\home\\...\\dsh-hooks），经 tar over ssh
# 原样同步到构建机后烤进镜像，dev 容器每次启动跑 pnpm install 的 postinstall
# （scripts/install-lefthook.mjs）在 Linux 下用 isAbsolute() 判定该 Windows 路径为无效
# ownership marker，导致容器崩溃循环 Restarting(1)。镜像内 .git 恒位于 /app/.git，
# 因此把这两处 hooks 路径统一重写为 /app/.git/dsh-hooks（文件缺失或已是容器路径则跳过）。
# 实现：本地把修复脚本 base64 后经 ssh 编码传输（heredoc 直接嵌 ssh 双引号会被本地
# bash 解析破坏反斜杠，base64 可规避转义地雷），构建机解码执行。
NORMALIZE_HOOKS_PY=$(cat <<'PY'
import json, os, re
changed = []
if os.path.isfile('config.worktree'):
    s = open('config.worktree', encoding='utf-8').read()
    n = re.sub(r'(hooksPath\s*=\s*).+', r'\1/app/.git/dsh-hooks', s)
    if n != s:
        open('config.worktree', 'w', encoding='utf-8').write(n)
        changed.append('config.worktree')
m = 'dsh-hooks/.dsh-lefthook-owned'
if os.path.isfile(m):
    try:
        d = json.load(open(m, encoding='utf-8'))
    except Exception:
        d = None
    if isinstance(d, dict) and 'hooksPath' in d:
        d['hooksPath'] = '/app/.git/dsh-hooks'
        json.dump(d, open(m, 'w', encoding='utf-8'))
        changed.append(m)
print('fixed: ' + (', '.join(changed) if changed else 'nothing to fix'))
PY
)
NORMALIZE_B64="$(printf '%s' "$NORMALIZE_HOOKS_PY" | base64 | tr -d '\n')"
ssh "${SSH_OPTS[@]}" "$SSH_CMD" \
  "cd '$REMOTE_DIR/.git' && echo '$NORMALIZE_B64' | base64 -d | python3 -"

# ── 2. 在构建机上构建（必要时推送） ─────────────────────────────────────
log "2/3 在 $SSH_CMD 上构建（输出原样透传）"
HARBOR_ENV=""
if [ -n "${HARBOR_USERNAME:-}" ] && [ -n "${HARBOR_PASSWORD:-}" ]; then
  HARBOR_ENV="HARBOR_USERNAME='$HARBOR_USERNAME' HARBOR_PASSWORD='$HARBOR_PASSWORD'"
fi

# shellcheck disable=SC2086
ssh "${SSH_OPTS[@]}" "$SSH_CMD" \
  "cd '$REMOTE_DIR' && HARBOR='$REGISTRY' $HARBOR_ENV bash docker/build-dsh-aio-dev-arm64.sh $PUSH_ARG"

log "3/3 完成"
