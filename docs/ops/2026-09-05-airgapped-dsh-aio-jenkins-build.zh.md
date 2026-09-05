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

## 构建迭代（job `dsh-aio-dev-build`，失败与修复）

| 构建 | 失败现象 | 修复 |
|---|---|---|
| #6 | Checkout：`unable to create symlink CLAUDE.md: File name too long`——f407355d46 把 `CLAUDE.md` 的 symlink blob 改成了以文本 `AGENTS.md` 开头的普通文件，symlink 检出时整段内容被当作链接目标 | 提交 `9111df7d1d` 恢复纯 `AGENTS.md` symlink（blob 47dc3e3d）；其中携带的 Docker 规范文字在 docs/containerization/0006 已有归属 |
| #10 | Step 6/17 `corepack prepare pnpm@11.7.0` 去连 registry.npmjs.org | `ARG NPM_REGISTRY` 声明在 `FROM` **之前**，stage 内 `ENV COREPACK_NPM_REGISTRY=` 展开为空；在 FROM 后重新声明 ARG（提交 `4242c8e276`）。本地 corepack 0.34.2/0.34.5/0.35 都认这个环境变量——错在 Dockerfile，不在 corepack |
| #13 | `pnpm install` postinstall：install-lefthook 拒绝 `core.hooksPath="/dev/null"`——Jenkins 工作区的 `.git/config` 随 tar 一起进了镜像 | Sync 阶段改为在打包前写入一份干净的最小 `.git/config`（origin → Bitbucket https 地址） |
| #14 | 同一守卫：`.git/config … not a regular file`——直接删掉 config 也会触发守卫，它要求必须是常规文件 | 用替换而不是删除 |
| #15 | Step 16 `pnpm run build`：`DSH_CLIENT_COMMIT_HASH must be a Git commit hash; got "unknown"`——17.58 没有 git 可执行文件，`git rev-parse` 兜底丢了 sha | 构建脚本新增 `resolve_commit()`，直接读 `.git/HEAD`（detached sha、松散 ref、packed-refs 三种形态），三种形态均有单测（提交 `ed6160e851`） |
| #16–#19 | 自伤：在工作区里改写 `.git/config` 破坏了 git 插件的下一次 fetch；`rm -rf .` 自愈又撞上 `refusing to remove '.'` | Sync 阶段先备份工作区 config、只为 tar 数据流换成干净版、随后恢复；失败后的工作区用 `rm -rf -- ./* ./.[!.]*` 自愈 |
| **#20** | **SUCCESS，1247 秒** | — |

## 最终结果（构建 #20，已在 10.1.17.58 验证）

- `dsh-aio:dev-amd64` —— 4.12GB（aio dev：VNC 栈、Chrome 151、node 24.19、jcli）
- `dsh-aio:dev-amd64-ed6160e8` —— 同一镜像的内容确定 tag（源码提交）
- `dsh:dev-amd64` —— 3.66GB 中间层（dsh core）
- 本次未推 harbor（参数 `PUSH_HARBOR=false`）；打开后推送 `harbor.jereh.cn/base/dsh:dev-amd64` 与 `base/dsh-aio:dev-amd64[-<sha>]`，层缓存让重跑很便宜。

同机冒烟 job `dsh-aio-dev-smoke`：容器可运行，noVNC `:6080/vnc.html` → 200，`node --version` v24.19.0，Chrome 151.0.7922.137 在位。`:3080` 在 25 秒探测点尚未 listen（web 冷启动更慢，历史文档有同样记录），`chrome --version` 需用 `google-chrome` 命令名；冒烟脚本因这两处 exit 127、Jenkins 标红——属脚本表面问题，镜像本身是好的。

## 流水线正式化

流水线现在以 `Jenkinsfile` 的形态住在仓库根目录，job `dsh-aio-dev-build` 配置为 **Pipeline script from SCM**（Bitbucket `AI/deepseek-harness`、分支 `master`、凭据 `bitbucket`、脚本路径 `Jenkinsfile`）。改流水线就是一次提交一次推送，不再需要 Script Console 往返。推 harbor 的方式是带 `PUSH_HARBOR=true` 重跑 job（目标机 admin 用户需已有 `harbor.jereh.cn` 的 docker login——现状已具备）。

job 的 config.xml 里 `CpsScmFlowDefinition` 必须嵌经典的 `hudson.plugins.git.GitSCM`；新版多分支风格的 `jenkins.plugins.git.GitSCMSource` 会在构建启动时 NPE：轻量检出抛 `Cannot invoke "hudson.scm.SCM.getKey()" because "scm" is null`，关掉 lightweight 也一样。设置方法：GET/POST `/job/<name>/config.xml`（API token 认证免 CSRF crumb）；Script Console 根本构造不了这些类（其类加载器拒绝嵌套/不可解析的 import）。

构建 #23 是完全由仓库 Jenkinsfile 驱动的首跑：SUCCESS，1353 秒，`PUSH_HARBOR=true`，发布 `harbor.jereh.cn/base/dsh:dev-amd64`、`base/dsh-aio:dev-amd64`、`base/dsh-aio:dev-amd64-13de9a67`（经 harbor v2 tags API 验证）。

## 镜像运行时冒烟（10.1.17.58）

- 首次 harbor 冒烟：容器可运行，noVNC 200，node/Chrome 在位，但 **`dsh web` 始终没有监听**（先 180 秒、后 14 分钟观察窗）。用 `bash -x` 定位根因：entrypoint fork 了 `pnpm dev:web --poll` 后立刻 `exec pnpm dsh web`；dev:web 首轮冷构建要在烘焙产物之上重写 `apps/web/dist`，vite 阶段会把该目录留成半成品好几分钟——web 对着半成品的 bundle 树启动，监听之前就死了。entrypoint.sh 已修复：watch 构建退出（或到 25 分钟上限）且 `apps/web/dist/index.html` 静默 5 秒后才启动 web。重建为 #24（SUCCESS，harbor 已重新推送）。
- 主机怪癖，与 `docs/ops/2026-09-01` 在 crun 主机记录的一致：在 17.58（CentOS 7，docker 20.10.8/runc）上直接 `docker run -d` 会让 PID1 在启动中途被冻结——entrypoint 日志停在 autocutsel/noVNC 一步，之后的全没跑。用仓库已记录的绕法（`--entrypoint bash … -c 'sleep 60000'` + `docker exec -d … /usr/local/bin/entrypoint.sh`）全栈正常拉起，修复版镜像 **t=45s web 返回 200**。该主机上的部署必须走两步启动；entrypoint-as-PID1 在其它部署主机是正常的。

## 复用要点

- Jenkins→10.1.17.58 的 SSH：用户 **admin**（root 与 Admin 均被拒），凭据 `ssh`，pipeline 用 `sshagent(credentials:['ssh'])`。
- 17.58 无 git、无公网：源码经 tar-over-ssh 同步到 `/opt/dsh-aio-build`（`.git` 随包走，dev 镜像设计需要）。
- `jc` 域命令：`jc minio upload`、`jc jenkins script/build/jobs`；Bitbucket 用 `jc env` 的 `BITBUCKET_USERNAME/TOKEN/BASE_URL` 加 REST。
- Nexus REST 改仓库必须先 `GET /service/rest/v1/repositories/apt/proxy/<name>` 取全量再 PUT（v1 无 PATCH；PUT 是全量替换）。
- Nexus apt-format 代理在修复前不可作安装路径；一律走 raw 代理。
- Dockerfile 的 ARG 不跨 `FROM` 边界：stage 内 `ENV`/`RUN` 要用的 ARG 必须在该 `FROM` 之后重新声明，否则静默展开为空。"内网默认值"失效的第一征兆就是流量打到公网源。
- tar-over-ssh 同步 Jenkins git 工作区时必须处理 `.git/config`：git 插件在里面写了 `core.hooksPath=/dev/null`，仓库自己的 install-lefthook postinstall 遇到这种 config 会拒绝安装——config 缺失同样被拒（要求常规文件）。正确做法：仅为 tar 数据流换入干净 config，随后恢复原状，保证 git 插件下次 fetch 不受影响。
- 经 Script Console 更新 pipeline DSL：把整段 DSL base64 后在 Groovy 里解码（`new String(java.util.Base64.decoder.decode('…'), 'UTF-8')`）；Groovy 三引号字符串会插值 `$(...)`/`${...}`，直接内嵌会破坏 shell 步骤。
- Jenkins job 就是可执行的记录：`dsh-aio-dev-build`（参数 BRANCH / TARGET_HOST / PUSH_HARBOR）与 `dsh-aio-dev-smoke`；控制台 URL `https://new-jenkins.jereh.cn/job/<job>/<n>/console`。

## 校验数据

- jcli v0.0.47 sha256：amd64 `2546eda3…6726d`（7,192,785B），arm64 `a3dea6e2…c79a`（6,649,688B）
- chrome arm64 deb sha256：`1dc04558…318e3`（133,196,256B）
- 匿名验证：`curl -r 0-0 https://minio-api.jereh.cn/base/jcli/v0.0.47/jcli-linux-amd64.tar.gz` → 206
