#!/usr/bin/env bash
# Per-user IDE provisioning on the Docker host (docs/containerization/0008).
# argv: <uid> <action> <image> <request-id> <domain-suffix>
# ACTION=create additionally reads the platform model key as one stdin line
# (piped by the Jenkins create-stage build from the `ide-model-key` Secret
# text credential — never argv, never the console, never a build parameter,
# SR5). Every step prints one
# `[DSH_STEP] <seq> <step> <ok|fail|info> <detail>` line, which Jenkins
# forwards to the build console and the portal parses into live events.
set -euo pipefail

UID_ARG="${1:?uid}"
ACTION="${2:?action}"
IMAGE="${3:?image}"
REQUEST_ID="${4:?request-id}"
SUFFIX="${5:?domain-suffix}"

case "$UID_ARG" in
  '' | *[!0-9]*) echo "[DSH_STEP] 0 reconcile fail bad uid argument" >&2; exit 2 ;;
esac
case "$ACTION" in create | start | stop | probe) ;; *) exit 2 ;; esac
[[ "$IMAGE" =~ ^[A-Za-z0-9._/-]+(:[A-Za-z0-9._-]+)?$ ]] || exit 2
[[ "$SUFFIX" =~ ^[A-Za-z0-9.-]+$ ]] || exit 2

CONTAINER="ide-${UID_ARG}"
VHOST="${CONTAINER}.${SUFFIX}"
# Deployment knobs (hermetic tests and unusual hosts override; defaults match 0008).
ENV_DIR="${IDE_ENV_DIR:-/run}"       # directory for the transient model-key file
PROBE_INTERVAL="${IDE_PROBE_INTERVAL:-30}"   # seconds between attempts (0008 health block)
PROBE_TIMEOUT="${IDE_PROBE_TIMEOUT:-600}"    # hard cap per probe level (0007 C7)

ENV_FILE="${ENV_DIR}/${CONTAINER}.env"
ENTRY_HOOK="/usr/local/bin/entrypoint.sh"
FRONT_PORT=8080

seq=0
mark() { seq=$((seq + 1)); printf '[DSH_STEP] %s %s %s %s\n' "$seq" "$1" "$2" "${3-}"; }
die() { mark "$1" fail "$2"; exit 1; }

container_status() {
  # --format writes nothing (exit 0) when the field expands empty, so an
  # empty result — missing container, or a host whose docker renders this
  # template as empty — maps to absent for the state machine.
  local out
  out=$(docker inspect -f '{{.State.Status}}' "$CONTAINER" 2>/dev/null) || true
  [ -n "$out" ] && printf '%s\n' "$out" || echo absent
}

# One probe level: up to $1 attempts at $PROBE_INTERVAL apart against the
# command formed by "${@:2}" until it exits 0. Sets TRIES, CODE and ELAPSED
# for the marker detail. The internal level curls the container IP; the proxy
# level curls the host loopback with the user vhost as Host (0008 Health check).
probe() {
  local tries="$1"; shift
  local waited=0 attempt=0
  TRIES=0; ELAPSED=0
  while [ "$attempt" -lt "$tries" ]; do
    attempt=$((attempt + 1)); TRIES=$attempt
    if "$@" >/dev/null 2>&1; then ELAPSED=$waited; return 0; fi
    [ "$attempt" -lt "$tries" ] && { sleep "$PROBE_INTERVAL"; waited=$((waited + PROBE_INTERVAL)); }
    ELAPSED=$waited
  done
  return 1
}

# Health answer for the DSH_IAM_GATE=1 container (0008 container-side login):
# 200 before the gate composes, 302/401 once the IAM gate is live. All three
# prove the front-proxy and dsh web answer; anything else (502/000) means the
# hook has not run yet or the vhost rule is missing. CODE carries the verdict
# for the marker detail.
http_answered() {
  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$@") || CODE=000
  case "$CODE" in 200 | 302 | 401) return 0 ;; *) return 1 ;; esac
}

container_ip() {
  docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$CONTAINER" 2>/dev/null || true
}

probe_internal_once() {
  local ip; ip=$(container_ip)
  [ -n "$ip" ] || { CODE=000; return 1; }
  http_answered "http://${ip}:${FRONT_PORT}/"
}

fire_hook() {
  docker exec -d "$CONTAINER" "$ENTRY_HOOK" >>/dev/null 2>&1 \
    || die start-hook "docker exec -d ${ENTRY_HOOK} failed"
}

# Full start + two-level health path for an existing or just-created
# container, streaming step events (0008: internal proves the hook ran,
# proxy proves docker-gen installed the vhost).
start_and_probe() {
  fire_hook
  mark start-hook ok "fired ${ENTRY_HOOK} into ${CONTAINER}"
  local budget=$((PROBE_TIMEOUT / PROBE_INTERVAL)) refired=0
  while ! probe "$budget" probe_internal_once; do
    # C2's freeze signature: PID1 alive, front never answers. Re-fire the
    # hook exactly once at the first failure, then keep probing.
    if [ "$refired" -eq 0 ]; then
      refired=1
      mark start-hook info "no answer after ${ELAPSED}s, re-firing hook once"
      fire_hook
    else
      die probe-internal "no health answer within ${PROBE_TIMEOUT}s (PID1 freeze? front-proxy down?)"
    fi
  done
  mark probe-internal ok "HTTP ${CODE} after ${TRIES} tries, ${ELAPSED}s"
  if ! probe 6 http_answered -H "Host: ${VHOST}" http://127.0.0.1/; then
    die probe-proxy "no health answer through jr-nginx-proxy (last ${CODE}) after ${ELAPSED}s (docker-gen lag or wrong VIRTUAL_HOST)"
  fi
  mark probe-proxy ok "HTTP ${CODE} after ${TRIES} tries, ${ELAPSED}s"
  mark ready ok "request ${REQUEST_ID}"
}

case "$ACTION" in
  probe)
    # Reconcile (FR6): a fast verdict on host truth, never a mutation. The
    # portal reads the single `reconcile` marker line.
    status=$(container_status)
    case "$status" in
      absent) mark reconcile info absent; mark ready ok "nothing to reconcile" ;;
      running)
        if probe_internal_once; then mark reconcile info healthy
        else mark reconcile info running-unhealthy; fi
        mark ready ok "probe done"
        ;;
      exited | created | dead) mark reconcile info stopped; mark ready ok "probe done" ;;
      *) die reconcile "unexpected docker state ${status}" ;;
    esac
    ;;

  create)
    status=$(container_status)
    if [ "$status" != absent ]; then
      mark docker-run info "${CONTAINER} already exists (${status}); continuing as start"
      start_and_probe; exit 0
    fi
    if docker image inspect "$IMAGE" >/dev/null 2>&1; then
      mark image-pull ok "${IMAGE} already local"
    else
      mark image-pull info "pulling ${IMAGE}"
      docker pull "$IMAGE" >/dev/null || die image-pull "pull of ${IMAGE} failed"
      mark image-pull ok "pulled ${IMAGE}"
    fi
    IFS= read -r MODEL_KEY || true
    [ -n "${MODEL_KEY:-}" ] || die docker-run "no model key on stdin for create (FR10)"
    umask 077; printf 'NR_API_KEY=%s\n' "$MODEL_KEY" > "$ENV_FILE"
    trap 'rm -f "$ENV_FILE"' EXIT
    # The sleep-PID1 two-step is mandatory on this host (C2); the hook fired
    # by start_and_probe is the real entrypoint.
    if ! docker run -d --name "$CONTAINER" \
        --hostname "$CONTAINER" \
        --network dc_default \
        --restart unless-stopped \
        --shm-size 1g \
        --label "com.jereh.uid=${UID_ARG}" \
        -v "${CONTAINER}-workspace:/root/workspace" \
        -v "${CONTAINER}-dshome:/root/.dsh" \
        --env-file "$ENV_FILE" \
        -e "FRONT_PORT=${FRONT_PORT}" -e 'VNC_PUBLIC_URL=/vnc' -e 'RESIZE_ENDPOINT=/resize' \
        -e "TRUSTED_HOSTS=${VHOST}" \
        -e "VIRTUAL_HOST=${VHOST}" -e "VIRTUAL_PORT=${FRONT_PORT}" \
        -e 'HTTPS_METHOD=noredirect' \
        -e 'DSH_IAM_GATE=1' \
        --entrypoint bash \
        "$IMAGE" -c 'sleep 60000' >/dev/null 2> "/tmp/ide-run-err.${BASHPID}"; then
      if grep -qi 'conflict. the container name' "/tmp/ide-run-err.${BASHPID}"; then
        mark docker-run info "name conflict (concurrent create); treating as created"
      else
        die docker-run "$(tr '\n' ' ' < "/tmp/ide-run-err.${BASHPID}")"
      fi
    fi
    rm -f "/tmp/ide-run-err.${BASHPID}"
    mark docker-run ok "created ${CONTAINER} on ${VHOST}"
    start_and_probe
    ;;

  start)
    status=$(container_status)
    case "$status" in
      absent) die reconcile "no ${CONTAINER} to start" ;;
      exited | created | dead) docker start "$CONTAINER" >/dev/null || die start-hook "docker start failed" ;;
      running) ;;
      *) die reconcile "unexpected docker state ${status}" ;;
    esac
    start_and_probe
    ;;

  stop)
    status=$(container_status)
    if [ "$status" = absent ]; then mark ready ok "${CONTAINER} already gone"; exit 0; fi
    docker stop "$CONTAINER" >/dev/null || die docker-run "docker stop failed"
    mark ready ok "${CONTAINER} stopped"
    ;;
esac
