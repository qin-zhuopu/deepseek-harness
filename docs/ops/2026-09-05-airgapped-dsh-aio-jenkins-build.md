# 2026-09-05 Air-gapped dsh-aio dev image build on 10.1.17.58 via Jenkins

English | [中文](2026-09-05-airgapped-dsh-aio-jenkins-build.zh.md)

> Ops session journal. No passwords or tokens are recorded here; credentials live in the Jenkins credential store and encrypted `~/.jereh-cli/.env` entries.

## Timeline (UTC)

1. `git pull` synced master; deleted the merged local branch `feature/dsh-aio-reverse-proxy`.
2. This container has no `jcli` (jenkins-zh); used the npm-linked `jc` (jereh-cli) instead: `jc jenkins jobs/build/script` against `new-jenkins.jereh.cn` (credentials in `~/.jereh-cli/.env`).
3. Enumerated all 616 Jenkins jobs: no dsh-related job; nodes `jenkins1`/`jenkins2` online; SSH credential `id=ssh` (username root).
4. Created the Bitbucket repo `deepseek-harness` under project `AI` (PAT maintained via `jc env`, repo created over REST) and pushed GitHub master (`276c5a9896c9`).
5. MinIO uploads via `jc minio upload` (4 credential entries written to `jc env`):
   - `base/jcli/v0.0.47/jcli-linux-{amd64,arm64}.tar.gz` (downloaded from GitHub latest; sha256 below)
   - `base/chrome/google-chrome-stable_current_arm64.deb` (v152.0.7977.82-1; the amd64 deb already existed in the bucket)
   - Anonymous download verified (200/206) with matching sha256
6. Nexus diagnosis and fix (admin login, REST):
   - `apt-aliyun`: metadata 200, every `.deb` 100% 502. Controlled experiments: a **raw-format** proxy on the same Nexus and same upstream fetches the same `.deb` with 200; four domestic mirrors (tuna/ustc/tencent/huawei) all 502 through the apt-format handler → root cause is the **Nexus 3.37 apt-format handler rejecting the `.deb` content-type** (aliyun now answers `application/vnd.debian.binary-package`; the other mirrors answer `application/octet-stream` and still 502). Not a network or upstream problem.
   - Repointed `apt-aliyun` upstream from aliyun to tuna (PUT, HTTP 204; previous config archived for rollback)
   - Created raw proxy repositories as the install path: `apt-ubuntu-amd64` → `https://mirrors.tuna.tsinghua.edu.cn/ubuntu/` and `apt-ubuntu-ports-arm64` → same host, `ubuntu-ports/`. Verified Release/Packages/tigervnc deb all 200.
7. Jenkins side:
   - First created `ssh-admin-1758` (same key, username `Admin`) to no avail; historical ops docs say lowercase **`admin`**: diag job `dsh-aio-dev-build` #3 SUCCESS.
   - 10.1.17.58 facts: hostname `jr.zhuopu.net`, **x86_64**, CentOS kernel, docker 20.10.8 (admin needs no sudo), 80G free on `/`, `~/.docker/config.json` already carries a harbor login; minio/harbor (401 = reachable, auth required)/nexus-npm/bitbucket all reachable.
   - Harbor facts: `base/node:24` and `base/ubuntu:24.04-node22-python312-chrome` are both available for **amd64**; the chrome-base image history shows Chrome/RIME already came from MinIO.
8. Code changes (same PR): `docker/dsh/Dockerfile.internal` and `docker/dsh-aio/Dockerfile.internal` gained `NODE_IMAGE/NPM_REGISTRY/APT_MIRROR/JCLI_DOWNLOAD_BASE` build arguments (internal values as defaults; the apt rewrite covers deb822 `ubuntu.sources`, legacy `sources.list`, and slash-less URI forms); added `docker/build-dsh-aio-dev-amd64-internal.sh`; Agent Note `implemented/process/2026-09-05-airgapped-dsh-aio-build-chain.{md,zh.md,i18n.yaml}`.

## Reusable facts

- Jenkins→10.1.17.58 SSH: user **admin** (root and Admin are both rejected), credential `ssh`, pipeline wraps steps in `sshagent(credentials:['ssh'])`.
- 17.58 has no git and no internet: sync the tree with tar-over-ssh to `/opt/dsh-aio-build` (keep `.git`; the dev image design ships it).
- `jc` domain commands: `jc minio upload`, `jc jenkins script/build/jobs`; Bitbucket via `jc env` entries `BITBUCKET_USERNAME/TOKEN/BASE_URL` plus REST.
- Nexus REST repository edits require `GET /service/rest/v1/repositories/apt/proxy/<name>` first, then a full PUT (v1 has no PATCH; PUT replaces the whole record).
- The Nexus apt-format proxy is unusable as an install path until fixed; use raw proxies instead.

## Verification data

- jcli v0.0.47 sha256: amd64 `2546eda3…6726d` (7,192,785B), arm64 `a3dea6e2…c79a` (6,649,688B)
- chrome arm64 deb sha256: `1dc04558…318e3` (133,196,256B)
- Anonymous check: `curl -r 0-0 https://minio-api.jereh.cn/base/jcli/v0.0.47/jcli-linux-amd64.tar.gz` → 206
