# Agent 笔记：基于 Jenkins、MinIO 与 Nexus raw apt 的气隙 dsh-aio 开发构建链

Status: implemented

[English](2026-09-05-airgapped-dsh-aio-build-chain.md) | 中文

## 问题

10.1.17.58 应用服务器没有公网出口，在该机上 `docker build` dsh-aio 开发镜像会在每一个外部下载点失败：Harbor 基础镜像需要可达的免认证拉取；Nexus 的 apt 格式代理对所有 `.deb` 一律 502（上游 mirrors.aliyun.com 现以 `application/vnd.debian.binary-package` 应答，Nexus 3.37 的 apt 格式处理器拒绝该类型；元数据是 `application/octet-stream` 所以能过，坏掉的只有安装层）；GitHub release 资产（jcli）与 Google 的 Chrome deb 通道均不可达。Jenkins 必须在这三条路都不通的前提下降级构建。

## 决策

所有外部构件改走内网镜像，并把每一项参数化为 Dockerfile 构建参数、默认值即内网地址（`docker/dsh/Dockerfile.internal` 与 `docker/dsh-aio/Dockerfile.internal` 的 `NODE_IMAGE`、`NPM_REGISTRY`、`APT_MIRROR`、`JCLI_DOWNLOAD_BASE`；`DSH_IMAGE`/`CHROME_BASE_IMAGE` 在 `Dockerfile.dev` 中已是参数）。Jenkins（`new-jenkins.jereh.cn`，job `dsh-aio-dev-build`）用 `bitbucket` 凭据检出内网镜像库 `AI/deepseek-harness`，经 tar-over-ssh 以 `admin` 用户同步到 10.1.17.58 的 `/opt/dsh-aio-build`（ssh 凭据 `ssh`；`root` 与大写 `Admin` 均被拒），随后远程执行 `docker/build-dsh-aio-dev-amd64-internal.sh`。

镜像源选择（每一项都已在构建机实测贯通）：基础镜像取 `harbor.jereh.cn/base`（node:24 与 chrome 底座均已发布 amd64）；npm 走 `nexus.jereh.cn/repository/npm-public/`；apt 走新建的 Nexus **raw 格式**代理仓库 `apt-ubuntu-amd64`（清华源 ubuntu）与 `apt-ubuntu-ports-arm64`（ubuntu-ports）——raw 处理器放行 apt 处理器 502 的响应；jcli 发布包（v0.0.47，sha256 记录在运维日志）与 Chrome deb（amd64/arm64）走 MinIO 公开可读桶 `minio-api.jereh.cn/base/`。`apt-aliyun` 的上游已改指清华源以保持元数据兼容，但不再作为安装路径。

## 曾考虑的替代方案

- **修复 Nexus apt 格式代理**——3.37 没有任何仓库级配置能放宽该 content-type 拒绝；且除 aliyun 外的国内镜像虽回 `application/octet-stream` 仍被 apt 处理器 502，说明缺陷在格式处理器层而非上游层。
- **在有公网的机器上预烘一个含 VNC 栈的底座镜像推到 Harbor**——可行，但为少数几个包多维护一条镜像流水线；MinIO/raw 代理路由让单一源码构建保持可复现。
- **直接在 Jenkins agent 上构建**——agent 有公网，但部署目标是 10.1.17.58 本机，在该机构建才能证明气隙路径可持续可构建。

## 后果

- 覆盖 ARG 后，`.internal` Dockerfile 在公网机器上同样可构建（apt 层接受任意以 `/` 结尾的镜像站基址）。
- 新内网主机需要 MinIO 读取、Nexus raw 代理仓库、以及 `admin` 的 `authorized_keys` 中的那把 key；Jenkins job 是这三者的可执行记录。
- 推 Harbor 需要 10.1.17.58 上先行 `docker login harbor.jereh.cn`（admin 的 docker 配置里已有）。
