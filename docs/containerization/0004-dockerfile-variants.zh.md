# Dockerfile 变体矩阵:哪种场景用哪个

[English](0004-dockerfile-variants.md) | 中文

状态:已在用(分层生产镜像运行在 10.1.17.58 应用服务器上)

## 摘要

仓库为 **2 个逻辑镜像** —— `dsh` web 镜像(仅应用)和 `aio` 全家桶镜像
(应用 + Chrome + noVNC)—— 共维护 **8 个 Dockerfile**,沿三个维度变化:

- **公网 vs 内网** —— 构建机能访问公网 npm / apt 源,还是必须走内网 Jereh Nexus 镜像。
- **dev vs 生产** —— dsh 用 tsx 源码派发启动(dev),还是编译入口
  `apps/cli/lib/bin.js` 启动(生产,约 1 秒起)。
- **完整构建 vs 分层** —— 从源码全部重建,还是在已构建好的 aio 镜像上叠生产栈。

第 9 个文件 `docker/chrome-base/Dockerfile` 不属于这两个镜像的任何变体:它为 Harbor 未发布的平台重建 aio 运行基底(见[在 arm64 主机上](#在-arm64-主机上))。

## 快速选择

| 你的场景 | 用哪个 |
|---|---|
| 有公网,改 dsh 源码迭代 | `docker/dsh/Dockerfile` → `dsh:dev`,再 `docker/dsh-aio/Dockerfile` |
| **arm64** 主机 | 同样用公网那套文件,外加 `docker/chrome-base/Dockerfile` 构建运行基底 —— 见[在 arm64 主机上](#在-arm64-主机上) |
| 内网无公网的构建机,从源码构建 | `docker/dsh/Dockerfile.internal` → `dsh:dev`,再 `docker/dsh-aio/Dockerfile.internal` |
| 生产,公网构建机,完整构建 | `docker/dsh-aio/Dockerfile.prod`(基于 `dsh:dev`) |
| 生产,内网构建机,完整构建 | `docker/dsh-aio/Dockerfile.prod.internal`(基于内网 `dsh:dev`) |
| 生产,但**无法重建 `dsh:dev`**(npm 源不通/太慢),手上已有 aio 镜像 | `docker/dsh-aio/Dockerfile.prod.layered` ← *10.1.17.58 就是这么部署的* |
| 想要一个**上来就能写代码**的容器:React 项目已脚手架、dev server 已起、Chrome 已打开页面 | `docker/dsh-aio/Dockerfile.webapp` |

## 完整清单

| # | 文件 | 镜像 | 网络 | 模式 | 构建基底 | Harbor 镜像 |
|---|------|------|------|------|----------|-------------|
| 1 | `docker/dsh/Dockerfile` | dsh | 公网 | dev | `node:24` | —(仅作 re-base 源) |
| 2 | `docker/dsh/Dockerfile.internal` | dsh | 内网 | dev | `harbor…/node:24` | —(仅作 re-base 源) |
| 3 | `docker/dsh-aio/Dockerfile` | aio | 公网 | dev | `dsh:dev` | `harbor.jereh.cn/base/dsh-aio:dev` |
| 4 | `docker/dsh-aio/Dockerfile.internal` | aio | 内网 | dev | `dsh:dev` | `harbor.jereh.cn/base/dsh-aio:dev` |
| 5 | `docker/dsh-aio/Dockerfile.prod` | aio | 公网 | **生产** | `dsh:dev` | `harbor.jereh.cn/base/dsh-aio:prod` |
| 6 | `docker/dsh-aio/Dockerfile.prod.internal` | aio | 内网 | **生产** | `dsh:dev` | `harbor.jereh.cn/base/dsh-aio:prod` |
| 7 | `docker/dsh-aio/Dockerfile.prod.layered` | aio | 公网* | **生产** | 现成 aio 镜像 | `harbor.jereh.cn/base/dsh-aio:prod` |
| 8 | `docker/dsh-aio/Dockerfile.webapp` | aio + 内置项目 | 公网 | **生产** | 现成 aio 镜像 | `harbor.jereh.cn/base/dsh-aio:webapp` |

\* 分层版的 apt 走公网源;内网构建机请换成 `.prod.internal` 里的内网 Nexus `sed` 行。

`dsh` 镜像没有单独的生产版:它 dev / 生产的唯一区别是启动命令,而启动命令在
`aio` 的 entrypoint 里(`entrypoint.sh` dev / `entrypoint.prod.sh` 生产)。
`dsh` 构建阶段本身已产出编译产物(`apps/cli/lib/`)。

## 维度一 —— 公网 vs 内网

内网变体给**无公网出口**的机器用(如 `10.1.17.58`),一切走内网 Jereh Nexus:

**dsh 内网版:** `FROM harbor.jereh.cn/base/node:24`;
`COREPACK_NPM_REGISTRY` 指向 Nexus(否则 corepack 硬编码从公网 npmjs.org 拉
pnpm —— 内网撞的第一堵墙);`pnpm install --no-frozen-lockfile`。

**aio 内网版:** node 从 harbor 拷贝;apt 改到内网 Nexus apt 镜像,串行下载 +
重试(该镜像在 apt 默认并发下会 502)。

> 10.1.17.58 上 Nexus apt 代理能拿元数据、但取 `.deb` 包体 502(上游回源坏
> 了),所以那台机什么都不构建 —— 镜像在有公网的机器上构建,推到
> `harbor.jereh.cn/base/`,再拉取。分层版(#7)就是这个流程的具体配方。

## 维度二 —— dev vs 生产

`docker/dsh-aio/` 下两个 entrypoint,只有 dsh 启动行不同:

- `entrypoint.sh`(dev)—— `exec pnpm dsh web …`,即
  `node --import tsx/esm apps/cli/src/bin.ts`:运行时转译 TS、esbuild 常驻、
  冷启动约 60 秒。给改源码迭代用。
- `entrypoint.prod.sh`(生产)—— `exec node apps/cli/lib/bin.js web …`:
  直接跑 tsdown 编译产物,约 1 秒起。

两者都保留完整 workspace `node_modules`。不能用 `pnpm prune --prod`:它会跑根
`postinstall`(生产没有 lefthook)并折叠 workspace 软链树(1.4G→144K),
模块解析直接崩。

## 显示栈(Xvnc 重构后的所有 aio 变体统一)

所有 aio 镜像现在用同一套显示栈,目标是预览列里的 Chrome **铺满画框、
跟随观看者的宽高比、且不闪**:

- **Xvnc**(TigerVNC)替代 Xvfb+x11vnc —— 自带 VNC server 的 X server,
  RandR 支持任意桌面尺寸。Xvfb 的 RandR 只能切预设模式,这正是之前 noVNC
  `resize=remote` 又闪又卡的根因。
- **vnc-resize-sidecar.py**(`127.0.0.1:6081`)—— 持久 RFB 客户端;
  `GET /resize?w&h` 向 Xvnc 发 `SetDesktopSize`。必须持久会话:客户端发完
  SetDesktopSize 立即断开会让 Xvnc 段错误。
- **fit-resize.js** —— 与 `vnc.html` 同目录并被其引用;防抖 250ms 监听
  viewport,请 sidecar 把桌面设成观看者的尺寸。noVNC 本身跑
  `resize=scale`(平滑、永不闪),桌面始终与 viewport 等比例,画面铺满无留白。
- **Chrome 窗口贴合** —— 用从 `SCREEN_GEOMETRY` 推导的显式 `--window-size`
  启动(裸 WM 下 `--start-maximized` 只会得到 ~10×10 小窗);watchdog 在桌面
  几何变化时用 `wmctrl -ir … -e` 重新贴合(fluxbox 不理 EWMH maximize 提示)。
- **静默 resize** —— 空操作 `fbsetbg` 垫片;fluxbox 每次 RandR 变化都重新设
  壁纸,没装壁纸后端就弹 xmessage 报错。
- **重启安全** —— Xvnc 启动前清理残留 `/tmp/.Xn-lock`,否则重启必死在
  "Server is already active"。

**同一时间只开一个观看者。** 每个 noVNC 观看者都跑 fit-resize,两个同时开会
抢桌面尺寸(共享 X 振荡)。

## 构建与运行

### dsh(所有完整构建的 aio 变体都需要)
`COPY . .` 需要**仓库根**作为构建上下文,所以在根目录构建(不是进
`docker/dsh/`),显式写 Dockerfile 路径:
```bash
docker build -t dsh:dev -f docker/dsh/Dockerfile .            # 公网
docker build -t dsh:dev -f docker/dsh/Dockerfile.internal .   # 内网
```

### aio
aio 的 Dockerfile 只 `COPY` 同目录的配套文件(entrypoint、sidecar 等),所以
它的构建上下文就是 `docker/dsh-aio/` 这个目录本身:
```bash
cd docker/dsh-aio

docker build -t dsh-aio:dev  -f Dockerfile .                 # 公网 dev
docker build -t dsh-aio:prod -f Dockerfile.prod .            # 公网 生产(完整)
docker build -t dsh-aio:prod -f Dockerfile.prod.layered .    # 生产,免重建 dsh
docker build -t dsh-aio:dev  -f Dockerfile.internal .        # 内网 dev
docker build -t dsh-aio:prod -f Dockerfile.prod.internal .   # 内网 生产

docker run -d --name dsh-aio --network host --shm-size=1g \
  -e NR_API_KEY=<your-key> -e SCREEN_GEOMETRY=576x1440x24 dsh-aio:prod
```

打开:
- dsh Web UI  → http://127.0.0.1:3080/
- Chrome 画面 → http://127.0.0.1:6080/vnc.html

> **必须 `--network host`。** dsh web 出于 RCE 安全只绑 `127.0.0.1`、拒绝
> `0.0.0.0`,因此 `-p 3080:3080` 不生效。其他机器无法直连 `<宿主IP>:3080`,
> 要么在宿主本机访问,要么走 SSH 隧道。

### 在 arm64 主机上

两个镜像都能在 linux/arm64 上按主机自身 CPU 构建,无需交叉编译,也不用模拟。与 amd64 主机相比只有两处不同,而且都通过构建参数解决,不必改文件。

**运行基底。** `harbor.jereh.cn/base/ubuntu:24.04-node22-python312-chrome` 只发布了 linux/amd64,arm64 拉取会报 `no matching manifest for linux/arm64/v8`。`docker/chrome-base/Dockerfile` 用 `ubuntu:24.04` 加 Google apt 源重建一个等价基底,该源的 `stable main` 组件为 arm64 提供 `google-chrome-stable`。构建最后跑一次 headless `--dump-dom`,让跑不动 Chrome 的基底在构建阶段就失败,而不是等到容器启动。

**基础镜像可达性。** `NODE_IMAGE`(两个镜像)、`UBUNTU_IMAGE`(chrome 基底)、`CHROME_BASE_IMAGE` 和 `DSH_IMAGE`(aio)可把每个 `FROM` 重定向到镜像源,供访问不到 Docker Hub 的主机使用。BuildKit 不支持在 `COPY --from=` 里做变量展开,因此 `NODE_IMAGE` 由一个命名阶段 `noderuntime` 解析,再由 COPY 引用该阶段名。

```bash
MIRROR=docker.1ms.run/library   # 任何提供 arm64 manifest 的镜像源

docker build --build-arg UBUNTU_IMAGE=$MIRROR/ubuntu:24.04 \
  -t dsh-chrome-base:24.04 -f docker/chrome-base/Dockerfile .

docker build --build-arg NODE_IMAGE=$MIRROR/node:24 \
  --build-arg DSH_CLIENT_COMMIT_HASH=$(git rev-parse HEAD) \
  -t dsh:dev -f docker/dsh/Dockerfile .

docker build --build-arg CHROME_BASE_IMAGE=dsh-chrome-base:24.04 \
  --build-arg NODE_IMAGE=$MIRROR/node:24 \
  -t dsh-aio:dev -f docker/dsh-aio/Dockerfile docker/dsh-aio
```

应用本身不需要任何 arm64 适配:`pnpm install` 会从同一份 lockfile 解析出每个原生包的 arm64 可选依赖(esbuild、sharp、node-pty、`@vscode/ripgrep`、lightningcss、oxc-resolver、rolldown、oxlint)。这也正是构建不能接收宿主 `node_modules` 的原因 —— `.dockerignore` 已将其排除,因为拷进来的 amd64 目录树会让 `pnpm install` 去调和一堆加载不了的二进制。

唯一的行为差异在[Landlock 启动器](../../native/landlock-run/README.zh.md):它的预编译二进制属于发布产物而非仓库内容,所以源码构建在两种架构上都没有,沙箱探测按设计失败关闭。`dsh web` 不受影响,受影响的是沙箱化的 shell 执行。

### 端口

| 端口 | 服务 |
|------|------|
| 3080 | dsh web |
| 6080 | noVNC(websockify) |
| 6081 | vnc-resize-sidecar |
| 5900 | 原始 VNC(Xvnc) |
| 9222 | Chrome CDP |

### 环境变量

| 变量 | 默认值 | 用途 |
|------|--------|------|
| `NR_API_KEY` | — | LLM 凭据;唯一必填项。 |
| `SCREEN_GEOMETRY` | `576x1440x24` | 初始桌面尺寸(之后 sidecar 会把它跟视口对齐)。 |
| `BIND_ADDR` | `127.0.0.1` | websockify 与 CDP 的监听地址。**移不动 dsh web** —— 它拒绝任何非回环绑定（见下），那种场景请用 `FRONT_PORT`。 |
| `FRONT_PORT` | — | 启用 `front-proxy.js`：一个可路由端口按路径分发到三个 loopback 服务。走反向代理时必须设置。留空 = 关闭。 |
| `FRONT_BIND` | `0.0.0.0` | front-proxy 监听地址。 |
| `VNC_PREFIX` | `/vnc` | front-proxy 下 noVNC 的路径前缀。 |
| `TRUSTED_HOSTS` | — | 逗号/空格分隔的公网 authority，传给 `dsh web --trusted-host`。只要浏览器用公网域名访问容器就必须设，否则所有 `/api` 调用返回 403。 |
| `INIT_WORKSPACE` | `/root/workspace` | 启动时创建并注册为工作区的目录,新容器一打开就是就绪状态。留空 = 跳过。 |
| `VNC_PUBLIC_URL` | — | **浏览器**访问本容器 noVNC 的源(可带路径前缀),如 `https://dsh-vnc.example.org`。entrypoint 会追加 `/vnc.html?autoconnect=true&resize=scale`,并注入到下发的 `index.html` 里作为 `window.__DSH_VNC_PREVIEW_URL__`。留空 = 用插件的 `127.0.0.1:6080` 默认值。 |
| `RESIZE_ENDPOINT` | — | 浏览器访问 resize sidecar 的 URL 或同源路径,渲染进 `vnc-config.js`。留空 = `fit-resize.js` 回退到 `<noVNC 主机>:6081`。 |
| `SIDECAR_BIND` | `= BIND_ADDR` | sidecar 监听地址。 |
| `SIDECAR_PORT` | `6081` | sidecar 端口。 |
| `DSH_PORT` / `NOVNC_PORT` / `CDP_PORT` / `VNC_PORT` / `DISPLAY_NUM` | `3080` / `6080` / `9222` / `5900` / `99` | 端口与显示号覆盖(同一台跑第二个容器时有用)。 |

### webapp 变体:上来就能写代码的容器

其余每个变体注册的都是**空的**工作区:选择器里有条目,但目录里什么都没有。
`Dockerfile.webapp` 改为把一个可用项目烧进镜像,于是打开容器就能直接开工:

- `/root/workspace` 下一个 Vite + React + TypeScript 应用,依赖已装好,一条初始
  提交、工作树干净;
- `CLAUDE.md`,说明项目本身与它所处的环境;
- entrypoint 已在 `127.0.0.1:5173` 启动 Vite dev server;
- 容器内的 Chrome 已经导航到该地址。

```bash
cd docker/dsh-aio
docker build -t dsh-aio:webapp -f Dockerfile.webapp .

docker run -d --name dsh-webapp --network host --shm-size=1g \
  -e NR_API_KEY=<你的 key> dsh-aio:webapp
```

它分层在已发布的 aio 镜像之上,所以不会重建 dsh。项目是在构建时用固定版本的
`create-vite` 现场生成的,而不是把模板抄进本仓库 —— 抄一份副本会悄悄与上游漂移。
代价是体积:约 6.2GB 对约 5.8GB,差的几乎全是 `node_modules`。

额外变量:`VITE_PORT`(默认 `5173`);`OPEN_APP=0` 可让 Chrome 停在 `about:blank`,
但 dev server 照常启动。

这个 entrypoint 是包装基础 entrypoint 而非替换它 —— 基础脚本被移到
`entrypoint.aio.sh` 并在最后 `exec`,所以它依然成为 PID 1,显示栈、dsh web、工作区
注册的行为与原来完全一致。`cdp-navigate.js` 通过 CDP 驱动那个已存在的 Chrome 标签
页;它复用 `about:blank` 目标而不是 `/json/new`,后者会多留一个空白页。

### 反向代理后面

反向代理是通过容器的 bridge IP 连过来的,而 `dsh web` 有意只肯绑回环地址
(`--host 0.0.0.0` 会直接以用法错误退出:那样「会把远程代码执行暴露到网络」),
所以代理根本连不上它 —— `BIND_ADDR=0.0.0.0` 也解决不了,它只挪得动 websockify
和 CDP。

正解是 `FRONT_PORT`。它启动 `front-proxy.js` —— 唯一监听可路由地址的进程,按路径
分发给仍留在 loopback 上的三个服务:

| 路径 | 上游 |
|------|------|
| `/resize` | resize sidecar |
| `/vnc`、`/vnc/*` | noVNC |
| `/websockify` | noVNC 的 RFB socket(noVNC 会在源站根路径请求它) |
| 其余 | dsh web |

单端口同时意味着单 vhost、单源站,于是 `VNC_PUBLIC_URL` 和 `RESIZE_ENDPOINT` 变成
同源路径,镜像根本不需要知道自己的公网域名:

```yaml
services:
  dsh-aio:
    image: harbor.jereh.cn/base/dsh-aio:prod
    container_name: dsh-aio
    restart: unless-stopped
    shm_size: 1g
    environment:
      NR_API_KEY: <你的 key>
      SCREEN_GEOMETRY: 576x1440x24
      FRONT_PORT: 8080
      VNC_PUBLIC_URL: /vnc
      RESIZE_ENDPOINT: /resize
      # 不设这个,所有 /api 调用都会 403:front-proxy 原样转发 Host,而浏览器
      # 信任栅栏只接受回环地址或已声明的 authority。这会把 dsh 管控面暴露给
      # 所有能访问代理的人 —— 该 vhost 必须挂在代理自己的鉴权后面。
      TRUSTED_HOSTS: dsh.example.org
      VIRTUAL_HOST: dsh.example.org
      VIRTUAL_PORT: 8080
      HTTPS_METHOD: noredirect
```

只需路由一个端口,所以普通的 `VIRTUAL_HOST`/`VIRTUAL_PORT` 就够。这也让它在老版本
代理上照样能用:`VIRTUAL_HOST_MULTIPORTS` 在 nginx-proxy 1.7 之前并不存在,1.3.0
会直接静默忽略。WebSocket 升级不用额外配置,nginx-proxy 的模板已经转发了
`Upgrade`/`Connection`。

自己在前面再加一层代理时**不要改写 `Host`**。`dsh web` 的 `/api` 栅栏要求随请求
附带的 `Origin` 必须等于 `Host` authority,把 `Host` 改写成回环地址会让所有浏览器
POST 以 403 失败。应该改用 `TRUSTED_HOSTS` 声明公网 authority;既非回环、也未声明
的 `Host` 仍会被拒 —— 那正是 DNS rebinding 防御在起作用。

## 部署备注(10.1.17.58,无公网)

1. 在有公网的机器(WSL 开发盒)上:`cd docker/dsh-aio && docker build -f Dockerfile.prod.layered
   -t dsh-aio:prod .`(或完整的 `Dockerfile.prod`),推到
   `harbor.jereh.cn/base/dsh-aio:prod`。
2. 10.1.17.58 上 `docker pull`,以 `--network host` 运行。
3. 远程观看者经 SSH 本地转发访问。预览 iframe 默认 `127.0.0.1:6080`,在走隧道
   的浏览器里会指向观看者自己的机器,所以要把 noVNC 和 sidecar 端口转发出来,
   并把转发后的端口写进环境变量:

   ```bash
   ssh -L 13080:127.0.0.1:3080 -L 16080:127.0.0.1:6080 -L 16081:127.0.0.1:6081 <host>
   ```

   ```bash
   docker run -d --name dsh-aio --network host --shm-size=1g \
     -e NR_API_KEY=<你的 key> \
     -e VNC_PUBLIC_URL=http://127.0.0.1:16080 \
     -e RESIZE_ENDPOINT=http://127.0.0.1:16081/resize \
     dsh-aio:prod
   ```

   观看者随后打开 `http://127.0.0.1:13080/`。(早期版本是用运行时 `sed` 去改编译
   后的插件产物;这两个变量取代了那种做法。)
