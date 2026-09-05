# Agent Note: Air-gapped dsh-aio dev build chain over Jenkins, MinIO, and Nexus raw apt

Status: implemented

English | [中文](2026-09-05-airgapped-dsh-aio-build-chain.zh.md)

## Problem

The 10.1.17.58 application server has no public egress, so `docker build` of the dsh-aio dev image there fails at every external download: Harbor base images need auth-free reachability, Nexus's apt-format proxy rejects every `.deb` with 502 (upstream mirrors.aliyun.com now answers `application/vnd.debian.binary-package`, which the Nexus 3.37 apt format handler refuses; metadata with `application/octet-stream` passes, so only the install layer breaks), GitHub release assets (jcli) are unreachable, and Google's Chrome deb channel is unreachable. Jenkins must drive the build without any of those paths being reachable from the build host.

## Decision

Route every external artifact through internal mirrors and parameterize each one as a Dockerfile build argument with the internal default baked in (`NODE_IMAGE`, `NPM_REGISTRY`, `APT_MIRROR`, `JCLI_DOWNLOAD_BASE` in `docker/dsh/Dockerfile.internal` and `docker/dsh-aio/Dockerfile.internal`; `DSH_IMAGE`/`CHROME_BASE_IMAGE` were already arguments in `Dockerfile.dev`). Jenkins (`new-jenkins.jereh.cn`, job `dsh-aio-dev-build`) checks out the internal Bitbucket mirror `AI/deepseek-harness` with the `bitbucket` credential, swaps the workspace `.git/config` for a clean one (the Jenkins git plugin writes `core.hooksPath=/dev/null`, which the repo's install-lefthook postinstall rejects inside the image), syncs the tree over ssh with tar-over-ssh to `/opt/dsh-aio-build` on 10.1.17.58 as user `admin` (ssh credential `ssh`; `root` and capitalized `Admin` are rejected), and restores the workspace config after the tar, then runs `docker/build-dsh-aio-dev-amd64-internal.sh` remotely.

Mirror choices, each verified end-to-end from the build host: base images from `harbor.jereh.cn/base` (node:24 and the chrome base are published amd64); npm through `nexus.jereh.cn/repository/npm-public/`; apt through new Nexus **raw-format** proxy repositories `apt-ubuntu-amd64` (mirrors.tuna.tsinghua.edu.cn/ubuntu/) and `apt-ubuntu-ports-arm64` (ubuntu-ports/) because the raw handler passes what the apt handler 502s on; jcli release tarballs (v0.0.47, sha256 recorded in the ops journal) and Chrome debs (amd64 and arm64) through the public-read MinIO bucket at `minio-api.jereh.cn/base/`. `apt-aliyun` stays pointed at tuna for metadata compatibility but is not the install path.

## Alternatives considered

- **Fix the Nexus apt-format proxy** — no Nexus 3.37 repository field relaxes the content-type refusal, and every domestic mirror except aliyun returns `application/octet-stream` yet still 502s through the apt handler, so the defect is format-level, not upstream-level.
- **Prebake a VNC-stack base image on a public machine and ship it to Harbor** — works, but adds a second image pipeline to maintain for a handful of packages; the MinIO/raw-proxy routing keeps the single-source build reproducible.
- **Build in the Jenkins agent instead of the app server** — the agents have public egress, but the deployment target is 10.1.17.58 itself, and building there proves the air-gapped path stays buildable.

## Consequences

- The `.internal` Dockerfiles now build on public machines too when the ARGs are overridden (apt layer accepts any mirror base URL ending in `/`).
- New internal hosts need the MinIO keys, the Nexus raw-proxy repositories, and the ssh key in `admin`'s `authorized_keys`; the Jenkins job is the executable record of all three.
- Harbor pushes require a prior `docker login harbor.jereh.cn` on 10.1.17.58 (already present in the admin docker config).
