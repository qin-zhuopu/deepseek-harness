# 2026-09-05 气隙 10.1.17.58 上经 Jenkins 构建 dsh-aio 开发镜像

[English](2026-09-05-airgapped-dsh-aio-jenkins-build.md) | 中文

> 本文件为运维会话记录；所有密码/token 一律不记录（凭据保存在 Jenkins 凭据库与 `~/.jereh-cli/.env` 的加密条目里）。

## 时间线（UTC）

1. `git pull` 同步 master；删除已合并的本地分支 `feature/dsh-aio-reverse-proxy`。
2. 本容器无 `jcli`（jenkins-zh），改用 npm link 的 `jc`（jereh-cli）：`jc jenkins jobs/build/script`；Jenkins 为 `new-jenkins.jereh.cn`（凭据在 `~/.jereh-cli/.env`）。
3. Jenkins 全量 616 个 job 盘点：无 dsh 相关 job；节点 `jenkins1`/`jenkins2` 在线；SSH 凭据 `id=ssh`（用户名 root）。
4. 在 Bitbucket `AI` 项目下创建 `deepseek-harness` 仓库（PAT 经 `jc env` 维护后用 REST 创建），推送 GitHub master（`276c5a9896c9`）。
5. MinIO（`jc minio upload`，4 项凭据写入 `jc env`）：
   - `base/jcli/v0.0.47/jcli-linux-{amd64,arm64}.tar.gz`（GitHub latest 下载，sha256 见下）
   - `base/chrome/google-chrome-stable_current_arm64.deb`（v152.0.7977.82-1；amd64 版桶里已有）
   - 匿名下载验证 200/206 且 sha256 一致
6. Nexus 排查与修复（admin 登录后走 REST）：
   - `apt-aliyun` 元数据 200、全部 `.deb` 100% 502；对照实验：同一 Nexus 的 **raw 格式代理**同上游取同一 .deb → 200；tuna/ustc/tencent/huawei 四个国内镜像经 apt 格式代理全部 502 → 定性为 **Nexus 3.37 apt 格式处理器对 .deb content-type 的拒绝**（aliyun 现回 `application/vnd.debian.binary-package`；其余国内镜像回 `application/octet-stream` 也照样 502），与网络/上游无关。
   - `apt-aliyun` 上游由 aliyun 改为 tuna（PUT，HTTP 204；原配置已留档可回滚）
   - 新建 raw 代理仓库（安装路径）：`apt-ubuntu-amd64` → `https://mirrors.tuna.tsinghua.edu.cn/ubuntu/`；`apt-ubuntu-ports-arm64` → 同主机 `ubuntu-ports/`。实测 Release/Packages/tigervnc deb 全部 200。
7. Jenkins 侧：
   - 先建 `ssh-admin-1758`（同 key、用户 `Admin`）无果；按历史文档改用**小写 `admin`**：诊断 job `dsh-aio-dev-build` #3 SUCCESS。
   - 10.1.17.58 实况：主机名 `jr.zhuopu.net`，**x86_64**，CentOS 内核，docker 20.10.8（admin 免 sudo），`/` 剩余 80G，`~/.docker/config.json` 已含 harbor 登录；minio/harbor（401=可达需认证）/nexus-npm/bitbucket 全通。
   - harbor 实测：`base/node:24`、`base/ubuntu:24.04-node22-python312-chrome` 均 **amd64 可用**；chrome-base 镜像 history 显示 Chrome/RIME 本就取自 MinIO。
8. 代码改动（同 PR）：`docker/dsh/Dockerfile.internal` 与 `docker/dsh-aio/Dockerfile.internal` 新增 `NODE_IMAGE/NPM_REGISTRY/APT_MIRROR/JCLI_DOWNLOAD_BASE` 构建参数（默认即内网值；apt 源重写兼容 deb822 `ubuntu.sources` 与旧 `sources.list` 及无斜杠形式）；新增 `docker/build-dsh-aio-dev-amd64-internal.sh`；Agent Note `implemented/process/2026-09-05-airgapped-dsh-aio-build-chain.{md,zh.md,i18n.yaml}`。

## 复用要点

- Jenkins→10.1.17.58 的 SSH：用户 **admin**（root 与 Admin 均被拒），凭据 `ssh`，pipeline 用 `sshagent(credentials:['ssh'])`。
- 17.58 无 git、无公网：源码经 tar-over-ssh 同步到 `/opt/dsh-aio-build`（`.git` 随包走，dev 镜像设计需要）。
- `jc` 域命令：`jc minio upload`、`jc jenkins script/build/jobs`；Bitbucket 用 `jc env` 的 `BITBUCKET_USERNAME/TOKEN/BASE_URL` 加 REST。
- Nexus REST 改仓库必须先 `GET /service/rest/v1/repositories/apt/proxy/<name>` 取全量再 PUT（v1 无 PATCH；PUT 是全量替换）。
- Nexus apt-format 代理在修复前不可作安装路径；一律走 raw 代理。

## 校验数据

- jcli v0.0.47 sha256：amd64 `2546eda3…6726d`（7,192,785B），arm64 `a3dea6e2…c79a`（6,649,688B）
- chrome arm64 deb sha256：`1dc04558…318e3`（133,196,256B）
- 匿名验证：`curl -r 0-0 https://minio-api.jereh.cn/base/jcli/v0.0.47/jcli-linux-amd64.tar.gz` → 206
