# 开箱即用镜像:dsh + Chrome(noVNC) + chrome-devtools MCP

[English](0003-all-in-one-chrome-novnc-mcp.md) | 中文

状态:已解决(端到端验证通过 —— 容器内 agent 经 MCP 打开了百度)

## 摘要

一条 `docker run` 就拉起一整套:dsh web UI、一个跑在虚拟显示器上并通过 noVNC 暴露的
真实 Chrome(能在浏览器标签页里看到它)、Chrome DevTools Protocol(CDP)端点,以及一个
预装好、并已作为 `mcp__chrome__*` 工具桥接进 dsh 的
[`chrome-devtools-mcp`](https://github.com/ChromeDevTools/chrome-devtools-mcp)
服务。让容器里的 agent "用 chrome 工具打开百度",导航动作就发生在你能从 noVNC 标签页
看到的那个 Chrome 里。

镜像用两阶段构建:先复用已构建好的 `dsh:dev` 镜像拿到 `/app` 目录树,再在内网 Chrome
基础镜像(Ubuntu 24.04 + Google Chrome)上搭运行环境。一个 supervisor entrypoint 按序
启动每个服务,并在启动 dsh 前等待 CDP 就绪,这样 MCP 客户端第一次连接就能成功。API
密钥在运行时用 `-e` 注入,绝不烘焙进镜像层。

## 镜像里有什么

| 层 | 提供 |
|---|---|
| `dsh:dev`(阶段一) | 完整安装并构建好的 dsh `/app` |
| Chrome 基础镜像 | Google Chrome + 系统库 |
| `/opt/node` | 隔离的 Node 24 + pnpm(见下) |
| apt 包 | `xvfb x11vnc fluxbox novnc websockify x11-utils curl` |
| 全局 npm | `chrome-devtools-mcp@1.7.0`,位于 `/opt/node/bin/chrome-devtools-mcp` |
| 烘焙的 `DSH_HOME` | web profile、`nr` 提供方、默认模型、chrome MCP patch |
| `entrypoint.sh` | 拉起整套栈的 supervisor |

## 多阶段 Dockerfile 以及为何这样设计

```dockerfile
# ---- 阶段一:复用已构建好的 dsh app ----
FROM dsh:dev AS dshbuild

# ---- 阶段二:在 Chrome 基础镜像上搭运行环境 ----
FROM harbor.jereh.cn/base/ubuntu:24.04-node22-python312-chrome

COPY --from=node:24 /usr/local/bin/node /opt/node/bin/node
COPY --from=node:24 /usr/local/lib/node_modules/npm /opt/node/lib/node_modules/npm
ENV PATH=/opt/node/bin:$PATH
RUN ln -sf /opt/node/lib/node_modules/npm/bin/npm-cli.js /opt/node/bin/npm \
 && npm config set registry https://nexus.jereh.cn/repository/npm-public/ \
 && npm install -g pnpm@11.7.0 chrome-devtools-mcp@1.7.0

RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      xvfb x11vnc fluxbox novnc websockify x11-utils curl \
 && rm -rf /var/lib/apt/lists/*

COPY --from=dshbuild /app /app
COPY dshhome/.dsh /root/.dsh
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENV DSH_HOME=/root/.dsh
EXPOSE 3080 6080 5900 9222
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
```

**复用 `dsh:dev` 而非重新构建。** dsh 必须在 Debian(`node:24`)上构建;而 Chrome
基础镜像是 Ubuntu、自带的 Node 又不可用。与其在运行镜像里再跑一遍
`pnpm install && pnpm run build`(约 5 分钟),不如让阶段一直接 `FROM dsh:dev`,阶段二
把它构建完成的 `/app` 拷过来。构建就简化成拷一个产物。

**Node 隔离在 `/opt/node`,不碰系统前缀。** Chrome 基础镜像的 Node 只以 nvm 形式装在
`/home/dev/.nvm/...` 下,属于 `dev` 用户、不在 root 的 PATH 里 —— 作为容器运行时不可用。
第一直觉 `COPY --from=node:24 /usr/local /usr/local` 会**覆盖**基础镜像原有的软链,
corepack 随后就以 `ENOENT ... realpath '/usr/local/bin/yarn'` 崩溃。正确做法是把 Node 24
落到**独立**前缀 `/opt/node`、让它在 PATH 里优先,系统前缀原封不动。

**跳过 corepack,改用 `npm i -g pnpm`。** corepack 的 `enable`/`prepare` 会尝试为
yarn/pnpm 生成 posix 软链,在这种拷贝出来的目录布局里失败(`generatePosixLink … ENOENT`)。
直接用 `npm install -g pnpm@11.7.0` 装 pnpm,绕开整条 corepack 路径。

**预装 `chrome-devtools-mcp`,不在运行时 `npx`。** 在同一条 `npm i -g` 里全局安装,
落在 `/opt/node/bin/chrome-devtools-mcp`。烘焙的 MCP patch 指向这个绝对路径(而不是
`npx -y chrome-devtools-mcp`),于是首次使用无需下载,镜像真正离线开箱即用。

**烘焙 `DSH_HOME`,但绝不烘焙密钥。** 拷进去的 `dshhome/.dsh` 是从一个运行中实例
提取的、验证过可用的 profile:带 `mcp-client` node_modules 的 `web` profile、`nr`
提供方、默认模型,以及 chrome MCP patch。打包时**排除**了 `sessions/`、`storages/` 和
`.credentials.yaml` —— 镜像里不带任何密钥,也不带此前的会话状态。`NR_API_KEY` 在运行时
经 `-e` 注入,提供方通过其 `apiKeyEnv` 读取。

## 烘焙的 MCP patch

`/root/.dsh/profiles/web/cordis.patch.yml` 插入一个 `mcp-client` 实例,通过 stdio 拉起
预装的服务并桥接到本地 Chrome:

```yaml
- insert:
    - id: chrome-devtools-mcp
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: chrome
        transport: stdio
        command: /opt/node/bin/chrome-devtools-mcp
        args:
          - --browserUrl
          - http://127.0.0.1:9222
        cwd: !!js process.cwd()
        env:
          CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: "1"
        toolCallTimeoutMs: 120000
        failOnStartupError: false
```

`serverName: chrome` 决定了桥接出的工具以 `mcp__chrome__*` 形式出现(例如
`mcp__chrome__new_page`、`mcp__chrome__list_pages`)。`failOnStartupError: false`
让 dsh 即使在 Chrome 短暂未就绪时也能正常启动;客户端会自动重连。

## supervisor entrypoint

`entrypoint.sh` 按依赖顺序启动各服务,每个端口都绑 `127.0.0.1`:

1. **Xvfb** 在显示 `:99`(虚拟帧缓冲),然后轮询 `xdpyinfo` 直到显示响应。
2. **fluxbox** —— 轻量窗口管理器,让 Chrome 有一个被管理的根窗口。
3. **x11vnc** —— 把 X 显示以 VNC 暴露在 `127.0.0.1:5900`,`-nopw`(无密码)。
4. **websockify / noVNC** —— 位于 `127.0.0.1:6080` 的 HTML 桥,代理到 VNC。
5. **Google Chrome** —— 带 `--remote-debugging-port=9222`、`--no-sandbox`、
   `--disable-dev-shm-usage`,跑在虚拟显示上。
6. **等待 CDP** —— 继续之前先轮询 `http://127.0.0.1:9222/json/version`,这样 dsh 启动
   期间 MCP 客户端首次连接时 Chrome 已就绪。
7. **dsh web** —— `exec pnpm dsh web --no-open`(交接 PID 1,信号处理干净)。

## 运行

```bash
docker run -d --name dsh-aio --network host --shm-size=1g \
    -e NR_API_KEY=<你的key> dsh-aio:dev
```

然后打开:

- dsh Web UI —— `http://127.0.0.1:3080/`
- Chrome 画面 —— `http://127.0.0.1:6080/vnc.html`

在 Web UI 里对 agent 说:"用 chrome 工具打开 https://www.baidu.com"。页面会在 noVNC
标签页里可见的那个 Chrome 中加载。

**`--network host` 是必需的。** 三条原因叠加:

- dsh web 只绑 `127.0.0.1`(出于 RCE 安全,它拒绝 `--host 0.0.0.0`),因此 `-p 3080:3080`
  映射打到的是容器的 eth0 而非其 loopback,永远到不了服务。用 host 网络后,服务的
  `127.0.0.1:3080` 就落在宿主 loopback 上(在 WSL2 上,Windows 侧可用
  `http://127.0.0.1:3080/` 访问)。
- 烘焙的 MCP 客户端通过同一个共享 loopback 上的 `http://127.0.0.1:9222` 连 Chrome。
- `nr` 提供方的上游是 `http://localhost:20128/v1`,一个跑在 WSL 宿主上的网关;只有在
  host 网络下,它才能从容器内部解析。

**`--shm-size=1g`** 给 Chrome 足够的共享内存用于渲染;`--disable-dev-shm-usage` 是进一步
的兜底。

## 安全说明

- **仅绑 loopback、VNC 无密码。** x11vnc 与 noVNC 都绑 `127.0.0.1` 且 `-nopw`。配合 WSL2
  上的 `--network host`,只有本机能访问,不暴露到局域网。若日后把它移出单用户 loopback
  场景,在暴露 6080 之前请加 VNC 密码,和/或带鉴权的反向代理。
- **CDP 是一个无鉴权的控制通道。** 任何能访问 `127.0.0.1:9222` 的人都能操纵浏览器。与上
  同理 —— 保持本地。
- **密钥只在运行时。** `NR_API_KEY` 从不进入任何镜像层,烘焙的 `DSH_HOME` 不含
  `.credentials.yaml`,也不烘焙任何会话历史。
- **Chrome 以 `--no-sandbox` 运行。** 这是容器化 Chrome 的常规做法,但意味着浏览器进程
  隔离性较弱;只在其中浏览可信内容。

## 踩过的坑

- **`COPY --from=node:24 /usr/local /usr/local` 会搞坏基础镜像。** 它覆盖已有软链,
  corepack 随后因找不到 `yarn` 的 realpath 而崩溃。改为把 Node 拷进独立前缀 `/opt/node`。
- **corepack `generatePosixLink` 失败**,发生在这种拷贝出来的布局里。改用
  `npm install -g pnpm`,完全跳过 corepack。
- **CDP `/json/new` 现在要求用 PUT。** `GET /json/new?<url>` 会返回
  "Using unsafe HTTP verb GET … supports only PUT verb"。直接经 CDP 开页面时用
  `curl -X PUT`(MCP 服务本身已经用的是正确方式)。
- **`No handler registered for issue code PerformanceIssue`** 会刷屏 dsh 日志。这是
  chrome-devtools-mcp 从 CDP 收到性能事件时的无害噪音 —— 实际上恰好说明 MCP↔Chrome 通道
  是活的。读日志时把它过滤掉。
- **重启时的 `ELIFECYCLE`** 是容器重启期间旧 dsh 进程被杀,不是启动失败;新进程紧接着
  就起来了。
- **被删除的来源容器会带走它的密钥。** `.credentials.yaml` 只存在于容器的可写层。一旦
  持有 `NR_API_KEY` 的那个容器被 `docker rm -f`,密钥就从镜像、宿主、卷和历史里彻底消失。
  用 `-e` 重新注入即可(这是刻意设计 —— 密钥从不烘焙)。

## 端到端验证(附日志)

完整路径已验证通过:用真实 `NR_API_KEY` 经 `docker run -e` 注入,容器内 agent 随后
自主调用 `mcp__chrome__*` 工具打开百度,全程记录日志,并从日志判定跑通。

镜像源文件与验证脚本都放在 [`docker/dsh-aio/`](../../docker/dsh-aio/) 目录:
[`Dockerfile`](../../docker/dsh-aio/Dockerfile)、supervisor
[`entrypoint.sh`](../../docker/dsh-aio/entrypoint.sh)、
烘焙的 [`cordis.patch.yml`](../../docker/dsh-aio/cordis.patch.yml)、以及
[`verify-e2e.sh`](../../docker/dsh-aio/verify-e2e.sh)。脚本流程:(1) 用 `-e NR_API_KEY`
重启 `dsh-aio`;(2) 创建 dsh 会话,提示 agent 打开百度;(3) 抓取三路日志 —— 容器
supervisor 日志(dsh + chrome-devtools-mcp + CDP)、dsh 会话事件流
(`session.history`:`tool/call`、`tool/result`、`turn/end`)、以及 CDP 页面列表;
(4) 从这些日志判定是否跑通。判定逻辑精确解析事件,区分真实的 `tool/call` 事件与事件流里
同样会出现的工具*清单*(schema),并要求**同时满足**:出现真实的 `mcp__chrome__` 工具
调用、`turn/end` 的 `reason=completed`、且 Chrome 确实打开了百度。

一次跑通的日志证据:

```
容器内 NR_API_KEY 长度: 35                       # -e 注入已到达容器
tool/call -> mcp__chrome__new_page  | args: {"url":"https://www.baidu.com"}
tool/call -> mcp__chrome__list_pages | args: {}   # agent 真实调用了 MCP 工具
turn/end  -> completed                          # 会话正常结束(非 error)
Chrome 当前页面 (CDP): 百度一下,你就知道 -> https://www.baidu.com/
判定: ✅ 跑通 —— agent 通过 MCP 工具打开了百度, 日志证据齐全
```

agent 自己的最终回复:

> 百度首页已成功打开。`list_pages` 确认页面 2 处于选中状态,页面标题为:百度一下,你就知道(URL: https://www.baidu.com/)。

判定逻辑还做了反向测试:用假 key 跑,脚本正确报**未跑通**(`turn/end=error`、无真实
工具调用、百度未打开),因此这个「跑通」是有意义的。

### 复现

```bash
docker run -d --name dsh-aio --network host --shm-size=1g \
    -e NR_API_KEY=<真实key> dsh-aio:dev
```

然后打开 `http://127.0.0.1:3080/` 的 Web UI,让 agent 打开百度;在
`http://127.0.0.1:6080/vnc.html` 的 noVNC 标签页里实时看它发生。提供方通过其
`apiKeyEnv: NR_API_KEY` 读取密钥,上游 `http://127.0.0.1:20128/v1` 会校验它 —— 无效
密钥会让会话以 `invalid_api_key` 失败,这正是反向测试所覆盖的。

## 经验

- 多阶段构建把"在别扭的运行环境里重建 app"变成"拷一个成品" —— 把一个已知可用的镜像
  当作一个阶段来复用。
- 当基础镜像的工具链不可用时,在独立前缀里装自己的一套,而不是覆盖系统那套。
- 把本该运行时 `npx` 的东西预装进去;这就是"离线、瞬时可用"与"首次使用才下载"的区别。
- 烘焙配置、注入密钥。profile 是可复现的;密钥不是,且绝不能进入任何镜像层。
- 一个*等待就绪*的 supervisor(启动客户端前先轮询 CDP)消除了一整类启动顺序竞态。
