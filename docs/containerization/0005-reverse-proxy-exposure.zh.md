# 把 aio 镜像暴露到反向代理后面:front-proxy、/api 信任栅栏,以及两个错误假设

[English](0005-reverse-proxy-exposure.md) | 中文

状态:已解决

## 摘要

把 all-in-one 镜像的端口直接发布到宿主机,只在浏览器就跑在 Docker 宿主机上时才
成立。换成挂在 nginx-proxy 后面,失败方式跟既有笔记的预测完全不同 —— 有两条已经
写进文档的假设是错的:`BIND_ADDR=0.0.0.0` 并不能让 `dsh web` 可达(它有意拒绝任何
非回环绑定,这个变量只挪得动 websockify 和 CDP),而 `VIRTUAL_HOST_MULTIPORTS` 那套
配方在 nginx-proxy 1.3.0 上根本不可能生效 —— 该版本没有这个指令,且会静默忽略。

正解是 `front-proxy.js`:唯一监听可路由地址的进程,按路径分发给仍留在 loopback 上的
三个服务。由此得到单 vhost(所以老版本代理上普通的 `VIRTUAL_HOST`/`VIRTUAL_PORT`
就够)和单源站(所以两个面向浏览器的 URL 都收敛成同源路径)。验证过程中又暴露出两个
故障:keep-alive 连接复用撞上 python `http.server` 导致的偶发 502,以及把 `Host`
改写成回环地址破坏 `/api` 浏览器信任栅栏导致的全量 403。

## 环境

- 测试服务器 10.1.17.58(CentOS 7,Docker 20.10.8),经 SSH 本地转发访问。非生产,
  所以可以做部署实验。
- `jr-nginx-proxy`,镜像 `nginx-proxy:1.3.0`,位于 compose 默认网络 `dc_default`
  上。通配 DNS `*.jr.zhuopu.net` 解析到该宿主机。
- compose 文件 `/home/admin/git/dc/docker-compose.yml`,用的是 docker-compose v1
  (1.29.2);`docker compose` v2 没装。该文件没有 `networks:` 段,所以每个服务都落在
  `dc_default` —— 正是代理所在的网络,这也是为什么不需要额外配网。

## 既有笔记里错在哪

### 1. `BIND_ADDR=0.0.0.0` 暴露不了 dsh web

早先的反向代理指引说要设 `BIND_ADDR=0.0.0.0`,理由是「代理是通过容器 bridge IP 访问
的」。这个变量确实存在,但它干不了这件事。带上它启动的容器内部:

```
tcp  0  0 127.0.0.1:3080  0.0.0.0:*  LISTEN  1/node       <- dsh web,仍是回环
tcp  0  0 0.0.0.0:6080    0.0.0.0:*  LISTEN  18/python3   <- websockify
tcp  0  0 0.0.0.0:6081    0.0.0.0:*  LISTEN  19/python3   <- resize sidecar
```

从同网另一个容器测:noVNC `200`、sidecar `204`、dsh web `000` —— 完全不可达。这是
有意为之,仓库自己的端到端测试(`apps/cli/tests/built-bin.e2e.ts`)就断言了这一点:
`dsh web --host 0.0.0.0` 会以用法错误退出,并说明那样「会把远程代码执行暴露到
网络」。entrypoint 压根没把 `BIND_ADDR` 传给 web 命令,而且传了也没用。

把这个拒绝当成固定约束,而不是需要绕开的障碍。它正是「另起一个前置进程」这个形状
成立的理由。

### 2. `VIRTUAL_HOST_MULTIPORTS` 不是每个 nginx-proxy 都有

早先的笔记推荐用 `VIRTUAL_HOST_MULTIPORTS` 配两个子域名,理由是 noVNC 没法挂在路径
前缀下。这个指令确实存在,但比较新;而部署着的代理是 1.3.0:

```
$ docker exec jr-nginx-proxy grep -c VIRTUAL_HOST_MULTIPORTS /app/nginx.tmpl
0
$ docker exec jr-nginx-proxy grep -c VIRTUAL_PATH /app/nginx.tmpl
1
```

零匹配意味着这个变量根本不会被读取 —— 它被静默忽略,不报任何错,所以那套配方会以
非常费解的方式失败。`VIRTUAL_PATH` 和 WebSocket `Upgrade` 的转发则都在。

围绕某个指令写配置之前,先在部署着的模板里确认它存在。在一个容忍未知键的配置文件
里,受版本限制的特性会静默失败。

## front-proxy:单端口、单源站

`front-proxy.js`(在 `dsh-aio/` 下)是唯一绑定可路由地址的进程;它前置的一切都留在
loopback 上,这比把每个服务都挪到 `0.0.0.0` 暴露面更小。

| 路径 | 上游 |
|------|------|
| `/resize` | resize sidecar(`SIDECAR_PORT`) |
| `/vnc`、`/vnc/*` | noVNC,剥掉前缀(`NOVNC_PORT`) |
| `/websockify` | noVNC 的 RFB socket |
| 其余 | dsh web(`DSH_PORT`) |

`/websockify` 需要单独一条规则。noVNC 是用页面的 host 加上它的 `path` 设置来拼 RFB
WebSocket URL 的,而该设置默认就是源站根路径下一个裸的 `websockify` —— `/vnc` 前缀
不会被带上,所以少了这条规则,握手会落到 dsh web 上。

有两个后果让这个方案优于多 vhost,与 1.3.0 的限制无关:

- **单 vhost。** 普通的 `VIRTUAL_HOST` + `VIRTUAL_PORT` 就够,于是这套配置可以移植
  到老版本代理。
- **单源站。** `VNC_PUBLIC_URL=/vnc` 和 `RESIZE_ENDPOINT=/resize` 变成同源路径,镜像
  再也不需要知道自己的公网域名,这两个 URL 也不再与具体部署绑定。

不设 `FRONT_PORT` 时代理不启动;直接发布端口的行为完全不变。

## 验证时发现的两个故障

### 3. noVNC 静态资源偶发 502,只在并发时出现

加载预览时,一批本该全 `200` 的资源请求里冒出一个 `502`。它只在经过代理且并发时
复现:

| 场景 | 结果 |
|------|------|
| 串行,同一资源 10 次,经 nginx-proxy | 10x 200 |
| 20 并发,经 nginx-proxy | 15x 200,**5x 502** |
| 20 并发,直连 front-proxy | 20x 200 |

这不是路由 bug,是连接生命周期 bug。Node 默认的 global agent 会保持上游 socket
keep-alive,而 websockify 是用 python 的 `http.server` 提供 noVNC 静态文件的,它会
按自己的节奏关闭连接。复用到一个已在关闭中的池化 socket 就会中途被 reset,代理的
错误处理把它变成了 502。修法是 `agent: false` 加 `Connection: close`:每个请求一条
新的上游连接。复测:20/20 以及 250 次混合并发请求全部 200。

这个形状值得记住 —— 只在并发下出现、绕过某一跳就消失的错误,通常关乎连接复用,而
不是请求被路由错了。

### 4. 浏览器发往 /api 的 POST 全部 403

GET 都成功,而每个 `POST /api/...` 都 403,导致 Cordis inventory 调用失败。根因在
`packages/client/connection/src/api-request-trust.ts`:该栅栏要求随请求附带的
`Origin` 必须等于 `Host` authority,且只接受回环或显式声明过的 `Host`。而
front-proxy 当时把 `Host` 改写成了 `127.0.0.1:3080`,浏览器发来的却仍是
`Origin: http://dsh.jr.zhuopu.net` —— 不匹配,拒绝。

这道栅栏正是 DNS rebinding 与跨站防御,而 `Host` 是重绑唯一伪造不了的请求头。把
`Origin` 伪造成与改写后的 `Host` 一致,等于关掉防御来消灭 403,所以被否掉了。受支持
的路径本来就有:原样转发 `Host`,并通过 CLI 可重复的 `--trusted-host` 声明公网
authority —— 在这里表现为 `TRUSTED_HOSTS`。

改完之后栅栏依然有效:

| 请求 | 结果 |
|------|------|
| `POST /api/workspace.list`,Host+Origin 为 `dsh.jr.zhuopu.net`(已声明) | `200` |
| 同一 POST,Host+Origin 为 `evil.example.org`(未声明) | `403` |

当一个安全检查挡住部署时,先去找它为正当部署提供的机制,再考虑动这个检查。

## 可用配置

```yaml
  dsh-aio:
    container_name: dsh-aio-dc
    image: harbor.jereh.cn/base/dsh-aio:prod
    restart: unless-stopped
    shm_size: 1g
    environment:
      - NR_API_KEY=<你的 key>
      - SCREEN_GEOMETRY=576x1440x24
      - FRONT_PORT=8080
      - VNC_PUBLIC_URL=/vnc
      - RESIZE_ENDPOINT=/resize
      - TRUSTED_HOSTS=dsh.jr.zhuopu.net
      - VIRTUAL_HOST=dsh.jr.zhuopu.net
      - VIRTUAL_PORT=8080
      - HTTPS_METHOD=noredirect
```

没有 `networks:` 项,因为这份 compose 文件本身没有 `networks:` 段,而它的默认网络
已经带着代理。`container_name` 写成 `dsh-aio-dc` 仅仅是为了避开同一宿主机上一个
无关的手工运行容器 `dsh-aio`。

**这个 vhost 没有任何鉴权。** 任何能访问到该代理的人都会拿到一个能跑命令的 dsh
控制面。内网测试机上可以接受;要长期留着,请把该 vhost 挂到代理自己的
htpasswd/JWT 后面。

## 验证

路由与协议,经 nginx-proxy:

| 检查项 | 结果 |
|--------|------|
| `GET /` | `200` |
| `GET /vnc/vnc.html`、`/vnc/vnc-config.js`、`/vnc/fit-resize.js` | `200` |
| `GET /resize?w=800&h=600` | `204` |
| `/websockify` 上的 WebSocket 升级 | `101` |
| `POST /api/workspace.list`(已声明 authority) | `200` |
| 同一 POST 但 `Host` 未声明 | `403` |
| 250 次混合并发请求 | 全部 `200` |

端到端,在真实浏览器里:预览 iframe 加载了
`http://dsh.jr.zhuopu.net/vnc/vnc.html?autoconnect=true&resize=scale`,随后容器内
`xdpyinfo` 报告桌面为 `319x855`,与 iframe 实测的 `clientWidth` 319 一致。两个彼此
独立的观测给出吻合的数字,才足以说明整条链路在工作 —— HTTP 路由、WebSocket 传输、
resize sidecar —— 而不只是请求被路由到了。

控制台里还留着一个 `/vnc/package.json` 的 `404`。那是 noVNC 在探自己的元数据,属于
既有行为:直连 noVNC 端口、以及未改动过的容器里,同样的探测同样返回 `404`。

## 镜像里有什么、没有什么

之所以要写明,是因为会话中途曾把这件事记错:镜像会预先创建并注册一个**空的**工作区
目录(`INIT_WORKSPACE`,默认 `/root/workspace`),好让新容器打开时就有个可用工作区,
而不是空的选择器。它不携带任何脚手架项目,不启动 dev server,也不会驱动 Chrome 打开
任何页面。

曾观察到在做这些事的那个容器,是之后手工搭起来的。用这个镜像起的全新容器里,
`/root/workspace` 条目数为零、不是 git 仓库,5173 上也没有任何监听。对那个手工搭的
容器执行 `docker diff`,项目显示为 `A /root/workspace/...` —— 属于容器层的新增,容器
一删就没了。

`Dockerfile.webapp` 补上的正是这个缺口:一个独立变体,把脚手架应用、它的
`node_modules` 和一条初始提交烧进镜像,并启动 dev server 以及一个已打开该页面的
Chrome 标签页。参见
[0004](0004-dockerfile-variants.zh.md#webapp-变体上来就能写代码的容器)。上面那段
描述对其余每个变体依然成立。

## 相关

- [0004](0004-dockerfile-variants.zh.md) —— Dockerfile 变体矩阵、环境变量参考,以及
  隧道访问配方。
- [0003](0003-all-in-one-chrome-novnc-mcp.zh.md) —— 本镜像所基于的显示栈。
