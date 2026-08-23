# Dockerfile 变体矩阵:公网/内网 × dev/生产

[English](0004-dockerfile-variants.md) | 中文

状态:已在用(生产内网镜像运行在 10.1.17.58 应用服务器上)

## 摘要

仓库为 **2 个逻辑镜像**(`dsh` web 镜像、`aio` 全家桶镜像)共维护 **6 个 Dockerfile**,
沿两个维度变化:

- **公网 vs 内网** —— 构建机能否访问公网 npm / apt 源,还是必须走内网 Jereh Nexus 镜像。
- **dev vs 生产** —— dsh 启动时是用 `tsx` 即时转译 TypeScript,还是直接跑编译产物
  (`node .../lib/bin.js`)。

| # | 文件 | 镜像 | 网络 | 模式 |
|---|------|------|------|------|
| 1 | `Dockerfile` | dsh | 公网 | dev |
| 2 | `Dockerfile.internal` | dsh | 内网 | dev |
| 3 | `dsh-aio/Dockerfile` | aio | 公网 | dev |
| 4 | `dsh-aio/Dockerfile.internal` | aio | 内网 | dev |
| 5 | `dsh-aio/Dockerfile.prod` | aio | 公网 | **生产** |
| 6 | `dsh-aio/Dockerfile.prod.internal` | aio | 内网 | **生产** |

`dsh` 镜像没有单独的生产版:它 dev / 生产的唯一区别是启动命令,而启动命令位于 `aio`
的 entrypoint 里。`dsh` 构建阶段已经产出了编译产物(`apps/cli/lib/`),所以"是否生产"
完全由 `aio` 层的 entrypoint 决定。

## 两个逻辑镜像

### dsh(仅 web)
只有 dsh web 服务,无浏览器。构建时跑 `pnpm install` + `pnpm run build`,产出 228 个
workspace 包的 `lib/` 编译产物,以及 web 前端 `apps/web/dist`。

### aio(全家桶)
dsh web + Chrome(CDP) + noVNC + chrome-devtools MCP,一体化预装。两阶段构建:
阶段一 `FROM dsh:dev` 复用已构建好的 app,阶段二在 Chrome 基础镜像上装 VNC 栈
(Xvfb / x11vnc / fluxbox / noVNC / websockify)。全家桶设计详见
[0003](0003-all-in-one-chrome-novnc-mcp.zh.md)。

## 维度一 —— 公网 vs 内网

内网变体是给**无公网出口**的机器用的(如 `10.1.17.58` 应用服务器),一切都走内网
Jereh Nexus 镜像。具体改动:

**dsh 内网版(`Dockerfile.internal`):**
- `FROM harbor.jereh.cn/base/node:24` —— node 用 harbor 上的镜像,不是公网 library 镜像。
- `ENV COREPACK_NPM_REGISTRY=…/npm-public/` —— 否则 corepack 硬编码从 `registry.npmjs.org`
  拉 pnpm,air-gapped 环境不可达。这是撞到的第一堵墙:`pnpm install` 能走 Nexus 成功,
  但更早的 `corepack prepare pnpm` 一步先失败了。
- `pnpm install --no-frozen-lockfile`,让本地微调过的 lockfile 仍能解析。

**aio 内网版(`Dockerfile.internal`、`Dockerfile.prod.internal`):**
- node 从 harbor 拷贝,而非公网 `node:24`。
- apt 源改到内网 Nexus apt 镜像(`10.1.7.49:8081/repository/apt-aliyun`),并**串行下载 + 重试**
  (`Acquire::http::Pipeline-Depth=0`、`Queue-Mode=access`、`Retries=8`)—— 该镜像在 apt
  默认并发连接下会返回 502。

> 注:10.1.17.58 上 Nexus apt 代理能返回元数据(Release/Packages),但取实际 `.deb` 包体时
> 502(上游回源坏了)。所以实践中我们根本不在该机构建 aio 镜像 —— 在别处构建、推 harbor、
> 再拉取。见文末部署备注。

## 维度二 —— dev vs 生产

`dsh-aio/` 下有两个 entrypoint:

- `entrypoint.sh`(dev)—— 末行 `exec pnpm dsh web …`,即
  `node --import tsx/esm apps/cli/src/bin.ts`:**运行时转译 TypeScript**,挂着 esbuild
  常驻进程,冷启动约 60 秒。
- `entrypoint.prod.sh`(生产)—— 末行 `exec node apps/cli/lib/bin.js web …`:
  **直接跑 tsdown 编译产物**,无 tsx/esbuild 常驻,启动约 1 秒。

其余流程(Xvfb → fluxbox → x11vnc → noVNC → Chrome → dsh)完全相同。

### 为什么不用 `pnpm prune --prod` 瘦身

这是一个 pnpm workspace(`workspace:^` 内部依赖)+ 大量 tsx 运行时脚本的 monorepo。
在这里 `pnpm prune --prod` 会:

1. 触发根 `postinstall`(生产没有 lefthook → 失败);
2. 折叠 workspace 软链树,把 `node_modules` 从 ~1.4G 砍到 ~144K,导致
   `ERR_MODULE_NOT_FOUND`,模块解析崩溃。

所以生产镜像**有意保留完整依赖树**,只把启动命令从 tsx 换成编译入口。

## 构建与运行

### dsh
```bash
docker build -t dsh:dev -f Dockerfile .            # 公网
docker build -t dsh:dev -f Dockerfile.internal .   # 内网
docker run -d --name dsh-web --network host dsh:dev
```

### aio
阶段一是 `FROM dsh:dev`,所以**必须先构建出 `dsh:dev`**。
```bash
cd docs/containerization/dsh-aio

docker build -t dsh-aio:dev  -f Dockerfile .                 # 公网 dev
docker build -t dsh-aio:prod -f Dockerfile.prod .            # 公网 生产
docker build -t dsh-aio:dev  -f Dockerfile.internal .        # 内网 dev
docker build -t dsh-aio:prod -f Dockerfile.prod.internal .   # 内网 生产

docker run -d --name dsh-aio --network host --shm-size=1g \
  -e NR_API_KEY=<your-key> dsh-aio:prod
```

打开:
- dsh Web UI  → http://127.0.0.1:3080/
- Chrome 画面 → http://127.0.0.1:6080/vnc.html

> **必须 `--network host`。** dsh web 出于 RCE 安全只绑定 `127.0.0.1`、拒绝绑 `0.0.0.0`,
> 因此 `-p 3080:3080` 不生效(映射打到容器 eth0,而非 loopback)。用 host 网络后,服务的
> `127.0.0.1:3080` 直接落在宿主机 loopback。这也意味着**其他机器无法直连 `<宿主IP>:3080`**,
> 需在宿主本机访问,或用 SSH 端口转发。

### 端口

| 端口 | 服务 |
|------|------|
| 3080 | dsh web |
| 6080 | noVNC(websockify) |
| 5900 | 原始 VNC |
| 9222 | Chrome CDP |

## 部署备注(10.1.17.58,无公网出口)

该机只能访问内网 harbor / Nexus,且其 Nexus apt 代理取 `.deb` 包体时 502,所以我们
**不**在该机构建 aio 镜像,而是:

1. 在有公网出口的机器上构建镜像;
2. 推到 `harbor.jereh.cn/base/`(`dsh:dev`、`dsh-aio:dev` / `:prod`,以及依赖的 `node:24`);
3. 在 10.1.17.58 上 `docker pull` 后以 `--network host` 运行。

访问用 SSH 本地转发(3080/6080 只绑 loopback):
```bash
ssh -N -L 13080:127.0.0.1:3080 -L 16080:127.0.0.1:6080 <10.1.17.58>
# 然后本机打开 http://127.0.0.1:13080/
```
