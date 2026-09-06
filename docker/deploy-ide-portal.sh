#!/usr/bin/env bash
# Deploy the ide-portal container on the app host (0008 Portal). One-time
# manual deploy, same air-gapped shape as deploy-dsh-aio-arm64.sh reversed:
# the portal builds ON the target host because it needs the repo tree.
#
#   ./docker/deploy-ide-portal.sh [-h host] [-d domain]
#
# Prerequisites on the host (all already true for ide-provision):
#   - /opt/ide-provision/ide-portal.env with IDE_JENKINS_TOKEN=<api token>, and
#     /opt/ide-provision/model-key.env with NR_API_KEY=<platform key> (both 0600,
#     admin-owned) — never baked; the key file reaches the portal only as the
#     read-only mount portal.yaml names, never as a portal process env var;
#   - /opt/ide-provision/portal.yaml (start from docker/ide-portal/portal.example.yaml);
#   - when the host cannot reach the IAM, /opt/ide-provision/iam-trust.json
#     (0600, admin-owned) with the IAM's two published documents captured from a
#     network that can reach it:
#       node -e 'const f=async(u)=>JSON.parse(await (await fetch(u)).text());
#         (async()=>{const d=await f("https://iam.jereh.cn/idp/.well-known/openid-configuration");
#           process.stdout.write(JSON.stringify({discovery:d,jwks:await f(d.jwks_uri)))})()
#         ' > /opt/ide-provision/iam-trust.json
#     and point portal.yaml's iam.trustFile at /etc/ide-portal/iam-trust.json;
#   - harbor.jereh.cn/base/node:24 pullable (Nexus/harbor mirrors).
# The container joins dc_default and declares VIRTUAL_HOST, so nginx-proxy
# serves it like every other vhost (C3/C5: the proxy is never edited).
set -euo pipefail

HOST="${IDE_PORTAL_HOST:-10.1.17.58}"
SSH_USER="${SSH_USER:-admin}"
DOMAIN="${IDE_PORTAL_DOMAIN:-ide.jereh-pe.cn}"
REPO_DIR="/opt/ide-portal-build"
IMAGE_TAG="ide-portal:$(git -C "$(dirname "$0")/.." rev-parse --short HEAD)"

# Mount the offline trust file only when the operator seeded it; the portal
# fetches IAM discovery and JWKS live when it is absent.
TRUST_MOUNT=""
if [ "${IDE_PORTAL_TRUST:-auto}" != "off" ] && ssh -o StrictHostKeyChecking=no "$SSH_USER@$HOST" "test -f /opt/ide-provision/iam-trust.json"; then
  TRUST_MOUNT="-v /opt/ide-provision/iam-trust.json:/etc/ide-portal/iam-trust.json:ro"
fi

ssh -o StrictHostKeyChecking=no "$SSH_USER@$HOST" "mkdir -p $REPO_DIR"
git -C "$(dirname "$0")/.." ls-files -z |
  rsync -0 -a --files-from=- --from0 "$(dirname "$0")/.."/ "$SSH_USER@$HOST:$REPO_DIR/" 2>/dev/null ||
  { echo "rsync of tracked files failed; falling back to full-tree tar"
    tar -C "$(dirname "$0")/.." -cf - . | ssh -o StrictHostKeyChecking=no "$SSH_USER@$HOST" "tar -xf - -C $REPO_DIR"; }

ssh -o StrictHostKeyChecking=no "$SSH_USER@$HOST" "
set -e
cd $REPO_DIR
docker build -t $IMAGE_TAG -f docker/ide-portal/Dockerfile .
docker image tag $IMAGE_TAG ide-portal:latest
if docker ps -a --format '{{.Names}}' | grep -qx ide-portal; then docker rm -f ide-portal; fi
docker run -d --name ide-portal \
  --hostname ide-portal \
  --network dc_default \
  --restart unless-stopped \
  -v ide-portal-state:/var/lib/ide-portal \
  -v /opt/ide-provision/portal.yaml:/etc/ide-portal/portal.yaml:ro \
  $TRUST_MOUNT \
  -v /opt/ide-provision/model-key.env:/run/secrets/ide-model.env:ro \
  --env-file /opt/ide-provision/ide-portal.env \
  -e VIRTUAL_HOST=$DOMAIN -e VIRTUAL_PORT=8080 -e HTTPS_METHOD=noredirect \
  $IMAGE_TAG
sleep 5
docker ps --filter name=ide-portal --format '{{.Status}}'
"
echo "deployed $IMAGE_TAG; entry: http://$DOMAIN/"
