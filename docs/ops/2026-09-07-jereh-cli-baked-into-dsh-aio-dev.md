# 2026-09-07 jereh-cli 烧进 dsh-aio dev 镜像

结论：给 `docker/dsh-aio/Dockerfile.internal`（IDE 用户容器 `harbor.jereh.cn/base/dsh-aio:dev-amd64` 的构建源）和公网对应 `Dockerfile.dev` 各加一层源码安装 jereh-cli。

## 背景事实

- IDE 用户容器由 Jenkins `ide-provision-whole-dir` job（new-jenkins.jereh.cn；2026-09-07 从 `ide-provision` 切换，见 [2026-09-07-ide-whole-dir-mount-poc.md](2026-09-07-ide-whole-dir-mount-poc.md)）跑 `docker/ide-provision/provision-whole-dir.sh` 创建，镜像 `harbor.jereh.cn/base/dsh-aio:dev-amd64`（portal.yaml `imageTag: dev-amd64`，上线 pin `dev-amd64-<sha>`）。该 job 只编排容器，不构建镜像。
- 镜像链：`docker/dsh/Dockerfile.internal` → `dsh:dev-amd64` → `docker/dsh-aio/Dockerfile.internal` → `dsh-aio:dev-amd64(-<sha>)`，由 `docker/build-dsh-aio-dev-amd64-internal.sh` 在气隙机 10.1.17.58 构建，Jenkins tar-over-ssh 同步仓库到 `/opt/dsh-aio-build`，`PUSH_HARBOR=1` 推 harbor。
- jereh-cli = `@jereh/jereh-cli`，仓库 https://bitbucket.jereh.cn/scm/jc/jereh-cli.git（默认分支 master）。Nexus npm-public 上只到 1.0.27，本地源码已是 1.0.33，故走源码安装。

## 安装层设计（已在两个 Dockerfile 落地）

- 装到镜像层 `/opt/jereh-cli`，bin 软链 `/usr/local/bin/{jc,jereh,jereh-cli}`。**不能装 /root**：whole-dir 布局把 `/data/ide/<uid>/root` 整目录 bind-mount 到容器 `/root`，镜像层内容被 shadow。
- `git clone --depth 1 --branch master` 后 `npm install` + `npm run build:cli`。两个坑：
  1. 仓库 gitignore 了 `package-lock.json` → `npm ci` 不可用，只能 `npm install`。
  2. 入口 `jereh-cli.js` 顶层 `require("@jereh/jc-cli")`（workspace 包）→ 必须全 workspace 安装并 `build:cli`（tsc 出 `packages/*/dist`），不能只装根包。`npm install --ignore-workspaces` 会装完但 `--version` 即崩。
- 运行时依赖（commander、playwright-core 等）大多在根 `devDependencies`，构建后不要 prune。
- apt 层追加了 `git`（追加进现有 RUN 层，保 build cache）。

验证：干净 clone 上 `npm install && npm run build:cli && node jereh-cli.js --version` → 1.0.33。

## 生效路径

触发 Jenkins job **`dsh-aio-dev-build`**（`https://new-jenkins.jereh.cn/job/dsh-aio-dev-build/`，参数 BRANCH / TARGET_HOST / PUSH_HARBOR，job 细节见 [2026-09-05-airgapped-dsh-aio-jenkins-build.md](2026-09-05-airgapped-dsh-aio-jenkins-build.md)）→ 推 harbor → portal 侧按 C6 pin 新 `dev-amd64-<sha>` → 重建的用户容器即带 `jc`。已有容器 `/opt` 不变，升级需重建或在旧容器内 `git -C /opt/jereh-cli pull && npm install && npm run build:cli`。
