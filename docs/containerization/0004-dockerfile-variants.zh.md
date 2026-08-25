# Dockerfile 变体矩阵:哪种场景用哪个

[English](0004-dockerfile-variants.md) | 中文

状态:已在用(分层生产镜像运行在 10.1.17.58 应用服务器上)

## 摘要

仓库为 **2 个逻辑镜像** —— `dsh` web 镜像(仅应用)和 `aio` 全家桶镜像
(应用 + Chrome + noVNC)—— 共维护 **7 个 Dockerfile**,沿三个维度变化:

- **公网 vs 内网** —— 构建机能访问公网 npm / apt 源,还是必须走内网 Jereh Nexus 镜像。
- **dev vs 生产** —— dsh 用 tsx 源码派发启动(dev),还是编译入口
  `apps/cli/lib/bin.js` 启动(生产,约 1 秒起)。
- **完整构建 vs 分层** —— 从源码全部重建,还是在已构建好的 aio 镜像上叠生产栈。

## 快速选择

| 你的场景 | 用哪个 |
|---|---|
| 有公网,改 dsh 源码迭代 | 根目录 `Dockerfile` → `dsh:dev`,再 `dsh-aio/Dockerfile` |
| 内网无公网的构建机,从源码构建 | `Dockerfile.internal` → `dsh:dev`,再 `dsh-aio/Dockerfile.internal` |
| 生产,公网构建机,完整构建 | `dsh-aio/Dockerfile.prod`(基于 `dsh:dev`) |
| 生产,内网构建机,完整构建 | `dsh-aio/Dockerfile.prod.internal`(基于内网 `dsh:dev`) |
| 生产,但**无法重建 `dsh:dev`**(npm 源不通/太慢),手上已有 aio 镜像 | `dsh-aio/Dockerfile.prod.layered` ← *10.1.17.58 就是这么部署的* |

## 完整清单

| # | 文件 | 镜像 | 网络 | 模式 | 构建基底 |
|---|------|------|------|------|----------|
| 1 | `Dockerfile`(根) | dsh | 公网 | dev | `node:24` |
| 2 | `Dockerfile.internal`(根) | dsh | 内网 | dev | `harbor…/node:24` |
| 3 | `dsh-aio/Dockerfile` | aio | 公网 | dev | `dsh:dev` |
| 4 | `dsh-aio/Dockerfile.internal` | aio | 内网 | dev | `dsh:dev` |
| 5 | `dsh-aio/Dockerfile.prod` | aio | 公网 | **生产** | `dsh:dev` |
| 6 | `dsh-aio/Dockerfile.prod.internal` | aio | 内网 | **生产** | `dsh:dev` |
| 7 | `dsh-aio/Dockerfile.prod.layered` | aio | 公网* | **生产** | 现成 aio 镜像 |

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

`dsh-aio/` 下两个 entrypoint,只有 dsh 启动行不同:

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
```bash
docker build -t dsh:dev -f Dockerfile .            # 公网
docker build -t dsh:dev -f Dockerfile.internal .   # 内网
```

### aio
```bash
cd docs/containerization/dsh-aio

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
| `BIND_ADDR` | `127.0.0.1` | dsh web、websockify、CDP 的监听地址。 |
| `INIT_WORKSPACE` | `/root/workspace` | 启动时创建并注册为工作区的目录,新容器一打开就是就绪状态。留空 = 跳过。 |
| `VNC_PUBLIC_URL` | — | **浏览器**访问本容器 noVNC 的源(可带路径前缀),如 `https://dsh-vnc.example.org`。entrypoint 会追加 `/vnc.html?autoconnect=true&resize=scale`,并注入到下发的 `index.html` 里作为 `window.__DSH_VNC_PREVIEW_URL__`。留空 = 用插件的 `127.0.0.1:6080` 默认值。 |
| `RESIZE_ENDPOINT` | — | 浏览器访问 resize sidecar 的 URL 或同源路径,渲染进 `vnc-config.js`。留空 = `fit-resize.js` 回退到 `<noVNC 主机>:6081`。 |
| `SIDECAR_BIND` | `= BIND_ADDR` | sidecar 监听地址。 |
| `SIDECAR_PORT` | `6081` | sidecar 端口。 |
| `DSH_PORT` / `NOVNC_PORT` / `CDP_PORT` / `VNC_PORT` / `DISPLAY_NUM` | `3080` / `6080` / `9222` / `5900` / `99` | 端口与显示号覆盖(同一台跑第二个容器时有用)。 |

### 反向代理后面(nginx-proxy)

端口直接发布到宿主机时,两个面向浏览器的 URL 默认都是 `127.0.0.1` —— 只有浏览器
跑在 Docker 宿主机上才对。走代理时浏览器到不了这些端口,所以要设
`VNC_PUBLIC_URL` 和 `RESIZE_ENDPOINT`,这正是它们存在的理由。

用两个子域名而不是一个域名加路径前缀:`vnc.html` 是按相对路径加载 `core/`、
`app/` 这些资源的,若把 noVNC 挂在子路径下,这些请求会落到域名根、被路由到另一个
服务。

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
      # nginx-proxy 是通过容器的 bridge IP 访问的,只听 loopback 就连不上。
      # 这会把 dsh 的管控面暴露给所有能访问代理的人 —— 该 vhost 必须挂在
      # 代理自己的鉴权(htpasswd/JWT)后面。
      BIND_ADDR: 0.0.0.0
      VNC_PUBLIC_URL: https://dsh-vnc.example.org
      RESIZE_ENDPOINT: https://dsh-vnc.example.org/resize
      HTTPS_METHOD: noredirect
      VIRTUAL_HOST_MULTIPORTS: |-
        dsh.example.org:
          "/":
            port: 3080
        dsh-vnc.example.org:
          "/":
            port: 6080
          "/resize":
            port: 6081
    networks:
      - proxy-net
```

每个 path 都要显式写 `port`:nginx-proxy 的「默认端口」取自容器唯一暴露的端口,
而本镜像暴露了五个,省略 `port` 会回退到 80 —— 那上面没有服务。WebSocket 升级
不用额外配置,nginx-proxy 的模板已经转发了 `Upgrade`/`Connection`。

## 部署备注(10.1.17.58,无公网)

1. 在有公网的机器(WSL 开发盒)上:`docker build -f Dockerfile.prod.layered
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
