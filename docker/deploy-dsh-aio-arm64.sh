#!/usr/bin/env bash
# =====================================================================
# 部署 dsh-aio (arm64) 到 gb10 并验证部署成功。
#
# 用法（在仓库根目录，需在 git 仓库内以推导镜像 tag）：
#   ./docker/deploy-dsh-aio-arm64.sh                       # 部署当前 HEAD 对应的 dev-arm64-<sha>
#   ./docker/deploy-dsh-aio-arm64.sh -i harbor.jereh.cn/base/dsh-aio:dev-arm64-9ff7bd92c0
#   ./docker/deploy-dsh-aio-arm64.sh --info                # 查询当前部署的构建tag+部署时间
#   ./docker/deploy-dsh-aio-arm64.sh -h                    # 全部参数
#
# 默认镜像用当前 git HEAD 的短哈希拼成内容确定的 tag（dev-arm64-<sha>），
# 不用会被覆盖的滚动 tag dev-arm64——避免 docker pull 命中同名旧 digest 缓存。
#
# 部署信息接口：构建 tag 与部署时间以环境变量 DEPLOY_IMAGE / DEPLOY_TS
# 注入容器，随时可在构建机上读取：
#   ssh jereh@10.202.200.139 docker exec dsh-aio printenv DEPLOY_IMAGE DEPLOY_TS
# （dsh web 无 HTTP 元信息接口；如需 HTTP 暴露需给 dsh web 加路由，暂未做。）
# =====================================================================
set -euo pipefail

usage() {
  cat <<'EOF'
用法: docker/deploy-dsh-aio-arm64.sh [选项]

功能: 在构建机上 pull 镜像 -> 替换运行中的容器 -> HTTP 探活验证 ->
      打印本次部署的构建 tag 与部署时间戳。

选项:
  -H, --host HOST       部署目标机            (默认: 10.202.200.139)
  -u, --user USER       ssh 用户              (默认: jereh)
  -i, --image REF       部署的镜像            (默认: dev-arm64-<当前HEAD短哈希>)
  -n, --name NAME       容器名                (默认: dsh-aio)
  -p, --port PORT       dsh web 端口          (默认: 3080)
  -d, --domain DOMAIN   绑定域名（*.gb10.zhuopu.net 已解析到本机），
                        自动挂 nginx-proxy 反代并注入 VIRTUAL_HOST/TRUSTED_HOSTS，
                        部署完通过 http://DOMAIN/ 访问；不传则只按 IP 直连
      --info            不部署，只查询当前部署的构建 tag / 部署时间 / 镜像 digest
  -h, --help            显示本帮助

环境变量: NR_API_KEY 本地提供则本次透传；否则用构建机上的 ~/dsh-aio.env
        （--env-file，可放任意容器变量，chmod 600）；两者皆无则告警。
EOF
}

HOST="10.202.200.139"
USER_NAME="jereh"
IMAGE=""   # 默认由当前 git HEAD 推导 dev-arm64-<sha>（见下），-i 可覆盖
NAME="dsh-aio"
PORT="3080"
INFO_ONLY=0

while [ $# -gt 0 ]; do
  case "$1" in
    -H|--host)   HOST="$2"; shift 2 ;;
    -u|--user)   USER_NAME="$2"; shift 2 ;;
    -i|--image)  IMAGE="$2"; shift 2 ;;
    -n|--name)   NAME="$2"; shift 2 ;;
    -p|--port)   PORT="$2"; shift 2 ;;
    -d|--domain) DEPLOY_DOMAIN="$2"; shift 2 ;;
    --info)      INFO_ONLY=1; shift ;;
    -h|--help)   usage; exit 0 ;;
    *) echo "未知参数: $1（-h 查看用法）" >&2; exit 2 ;;
  esac
done

log() { printf '\033[1;34m[deploy-aio]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[deploy-aio] ERROR\033[0m %s\n' "$*" >&2; exit 1; }

# 未显式 -i 时，用当前 git HEAD 的短哈希拼出内容确定的 tag（dev-arm64-<sha>），
# 而不是会被覆盖的滚动 tag dev-arm64——避免 docker pull 命中同名旧 digest 缓存。
if [ -z "$IMAGE" ]; then
  SHA="$(git rev-parse --short HEAD 2>/dev/null)" || die "不在 git 仓库内，无法推导镜像 tag；请用 -i 指定。"
  IMAGE="harbor.jereh.cn/base/dsh-aio:dev-arm64-$SHA"
fi

SSH_CMD="${USER_NAME}@${HOST}"
# 密钥探测/处理与 ci-dsh-aio-arm64.sh 相同（兼容 git-bash 与 WSL 执行环境）
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ -z "${SSH_KEY:-}" ]; then
  GUESSED_HOME="$(cd "$REPO_ROOT/../../../.." 2>/dev/null && pwd || true)"
  TWIN_HOME=""
  case "$GUESSED_HOME" in
    /c/*)     TWIN_HOME="/mnt${GUESSED_HOME}" ;;
    /mnt/c/*) TWIN_HOME="${GUESSED_HOME#/mnt}" ;;
  esac
  for k in "$HOME/.ssh/id_rsa" "$HOME/.ssh/id_ed25519" \
           "${GUESSED_HOME:-/nonexistent}/.ssh/id_rsa" "${GUESSED_HOME:-/nonexistent}/.ssh/id_ed25519" \
           "${TWIN_HOME:-/nonexistent}/.ssh/id_rsa"   "${TWIN_HOME:-/nonexistent}/.ssh/id_ed25519"; do
    if [ -f "$k" ]; then SSH_KEY="$k"; break; fi
  done
fi
SSH_KEY_ARGS=()
if [ -n "${SSH_KEY:-}" ]; then
  case "$SSH_KEY" in
    "$HOME"/*) : ;;
    *)
      COPY="$(mktemp 2>/dev/null || echo "/tmp/deploy-id-$$")"
      cp -f "$SSH_KEY" "$COPY" && chmod 600 "$COPY" && SSH_KEY="$COPY" ;;
  esac
  SSH_KEY_ARGS=(-i "$SSH_KEY" -o IdentitiesOnly=yes)
fi
SSHC() { ssh -o BatchMode=yes -o ConnectTimeout=10 "${SSH_KEY_ARGS[@]}" "$SSH_CMD" "$@"; }

# ── --info：查询当前部署 ────────────────────────────────────────────────
if [ "$INFO_ONLY" = 1 ]; then
  log "查询 $SSH_CMD 上的当前部署（容器 $NAME）"
  SSHC "docker inspect '$NAME' --format 'container: {{.Name}} state={{.State.Status}} started={{.State.StartedAt}}' 2>/dev/null" \
    || die "容器 $NAME 不存在。"
  SSHC "docker exec '$NAME' printenv DEPLOY_IMAGE DEPLOY_TS 2>/dev/null" \
    || die "容器里没有 DEPLOY_IMAGE/DEPLOY_TS（可能由旧版脚本部署）。"
  SSHC "docker inspect '$NAME' --format 'image digest: {{index .Config.Labels \"org.opencontainers.image.ref.name\"}}{{.Image}}'"
  exit 0
fi

DEPLOY_TS="$(date -u +%Y%m%dT%H%M%SZ)"

# NR_API_KEY 三级来源：
#   1) 本地环境变量 NR_API_KEY（临时覆盖，本次部署生效）
#   2) gb10 上的 ~/dsh-aio.env 文件（推荐：密钥常驻构建机，本地不落地；
#      用 --env-file 整体注入，文件里可放任意容器环境变量）
#   3) 都没有 → 告警（容器能起，agent 调不了 LLM）
# 在 gb10 上一次性创建：
#   cat > ~/dsh-aio.env <<'EOF'
#   NR_API_KEY=sk-...
#   EOF   && chmod 600 ~/dsh-aio.env
ENV_FILE_ARGS=()
NR_ARGS=()
if [ -n "${NR_API_KEY:-}" ]; then
  NR_ARGS=(-e "NR_API_KEY=$NR_API_KEY")
  log "NR_API_KEY: 本地环境变量（本次覆盖）"
elif SSHC "test -f ~/dsh-aio.env" 2>/dev/null; then
  ENV_FILE_ARGS=(--env-file "~/dsh-aio.env")
  log "NR_API_KEY: 使用 gb10 的 ~/dsh-aio.env（--env-file）"
else
  log "警告: 未提供 NR_API_KEY（本地环境变量与 gb10 ~/dsh-aio.env 均无），容器会启动但 agent 无法调用 LLM。"
fi

log "目标: $SSH_CMD  容器: $NAME  镜像: $IMAGE"
log "部署时间戳: $DEPLOY_TS"

# ── 1. 拉镜像（harbor，不走公网） ───────────────────────────────────────
log "1/5 拉取 $IMAGE"
SSHC "docker pull '$IMAGE'" || die "拉取失败（harbor 登录/网络？）。"

# ── 2. 替换容器（默认开 FRONT_PORT 局域网直连模式） ─────────────────────
# dsh web 只绑 127.0.0.1（RCE 安全设计）；FRONT_PORT 让 front-proxy 绑
# 0.0.0.0:8080 单端口路由全部服务，TRUSTED_HOSTS 放行浏览器 Origin 栅栏。
# 局域网任意机器可直接访问 http://$HOST:8080/ 。设 LAN_MODE=0 回到纯回环模式。
FRONT_PORT="${FRONT_PORT:-8080}"
LAN_ENV=()
if [ "${LAN_MODE:-1}" = 1 ]; then
  TRUSTED="$HOST,$HOST:$FRONT_PORT"
  LAN_ENV=(-e "FRONT_PORT=$FRONT_PORT" -e "VNC_PUBLIC_URL=/vnc" -e "RESIZE_ENDPOINT=/resize")
  # DEPLOY_DOMAIN=dsh.gb10.zhuopu.net 时自动挂 nginx-proxy 反代（VIRTUAL_HOST）
  if [ -n "${DEPLOY_DOMAIN:-}" ]; then
    LAN_ENV+=(-e "VIRTUAL_HOST=$DEPLOY_DOMAIN" -e "VIRTUAL_PORT=$FRONT_PORT" -e "HTTPS_METHOD=noredirect")
    TRUSTED="$TRUSTED,$DEPLOY_DOMAIN"
  fi
  LAN_ENV+=(-e "TRUSTED_HOSTS=$TRUSTED")
  if [ -n "${DEPLOY_DOMAIN:-}" ]; then
    log "2/5 替换容器 $NAME（域名反代: http://$DEPLOY_DOMAIN/ → :$FRONT_PORT；直连: http://$HOST:$FRONT_PORT/）"
  else
    log "2/5 替换容器 $NAME（局域网直连: http://$HOST:$FRONT_PORT/）"
  fi
else
  log "2/5 替换容器 $NAME（纯回环模式 LAN_MODE=0，仅 gb10 本机/SSH 隧道可访问）"
fi
SSHC "docker rm -f '$NAME' >/dev/null 2>&1 || true"
SSHC "docker run -d --name '$NAME' --network host --shm-size=1g --restart=unless-stopped \
  ${NR_ARGS[*]+"${NR_ARGS[*]}"} ${ENV_FILE_ARGS[*]+"${ENV_FILE_ARGS[*]}"} ${LAN_ENV[*]+"${LAN_ENV[*]}"} \
  -e 'DEPLOY_IMAGE=$IMAGE' \
  -e 'DEPLOY_TS=$DEPLOY_TS' \
  -e 'SCREEN_GEOMETRY=${SCREEN_GEOMETRY:-576x1440x24}' \
  '$IMAGE'" || die "docker run 失败。"

# ── 3. 探活验证（dev 镜像 tsx 冷启动 ~60s，最多等 150s） ────────────────
if [ "${LAN_MODE:-1}" = 1 ]; then
  log "3/5 探活: http://127.0.0.1:$FRONT_PORT/（front-proxy，最多 150s）"
  PROBE_URL="http://127.0.0.1:$FRONT_PORT/"
else
  log "3/5 探活: http://127.0.0.1:$PORT/ 与 noVNC :6080（最多 150s）"
  PROBE_URL="http://127.0.0.1:$PORT/"
fi
SSHC "
ok=0
for i in \$(seq 1 50); do
  code=\$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 \"$PROBE_URL\" || true)
  [ \"\$code\" = 200 ] && ok=1 && break
  sleep 3
done
[ \"\$ok\" = 1 ] || { echo 'web 探活失败（最后状态码 '\$code'）'; docker logs --tail 40 '$NAME'; exit 1; }
echo '探活通过: 主入口 200'
" || die "部署后验证失败，见上方容器日志。"

# ── 4. 汇总部署信息 ─────────────────────────────────────────────────────
log "4/5 部署信息（可用 docker exec 随时查询）"
SSHC "docker exec '$NAME' printenv DEPLOY_IMAGE DEPLOY_TS"
SSHC "docker inspect '$NAME' --format 'image: {{.Config.Image}}  digest: {{.Image}}'"

# ── 5. 打印可用入口 ─────────────────────────────────────────────────────
log "5/5 可用入口"
if [ "${LAN_MODE:-1}" = 1 ]; then
cat <<EOF

  ─────────────────────────────────────────────────────────
  构建tag : $IMAGE
  部署时间: $DEPLOY_TS
  容器    : $NAME@$HOST（--network host, FRONT_PORT=$FRONT_PORT）
EOF
if [ -n "${DEPLOY_DOMAIN:-}" ]; then
cat <<EOF

  ★ 域名访问（nginx-proxy 反代，http://$DEPLOY_DOMAIN/）
EOF
fi
cat <<EOF
  ★ 局域网直连（无需 SSH 隧道）：
      dsh Web UI : http://$HOST:$FRONT_PORT/
      Chrome 预览: 同页右侧预览列（/vnc 同源代理，已自动配置）

  安全提示：$FRONT_PORT 把 dsh 控制面暴露给了整个局域网，
  网络不可信时用 LAN_MODE=0 ./docker/deploy-dsh-aio-arm64.sh 回到回环模式。
  ─────────────────────────────────────────────────────────
EOF
else
cat <<EOF

  ─────────────────────────────────────────────────────────
  构建tag : $IMAGE
  部署时间: $DEPLOY_TS
  容器    : $NAME@$HOST（--network host, 回环模式）

  [在 $HOST 本机] http://127.0.0.1:$PORT/  与  http://127.0.0.1:6080/vnc.html
  [从其他电脑]   ssh -L 13080:127.0.0.1:$PORT -L 16080:127.0.0.1:6080 $SSH_CMD
                 然后打开 http://127.0.0.1:13080/
  ─────────────────────────────────────────────────────────
EOF
fi

log "部署完成 ✅  $IMAGE  @ $DEPLOY_TS"
log "查询部署信息: ./docker/deploy-dsh-aio-arm64.sh --info"
