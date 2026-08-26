# aio 的 build/ci/deploy 脚本:各干什么、何时用

[English](0006-aio-build-deploy-scripts.md) | 中文

状态:使用中(arm64 流程跑在 gb10 = `10.202.200.139`)

## 摘要

`docker/` 下的四个 shell 脚本封装了 aio dev 镜像的构建与部署,免去手敲
`docker build`/`push`/`run`。arm64 路径是主线,因为
[arm64 镜像只允许在 gb10 上构建](0004-dockerfile-variants.zh.md)
(`10.202.200.139`,ssh 用户 `jereh`)——绝不在 WSL 里构建。脚本内置了
harbor 的 tag 约定、"代理拉取后推 harbor"规则,以及 deploy-info 打戳,
一条命令就把该做的都做对。

## 四个脚本

| 脚本 | 在哪运行 | 干什么 |
|---|---|---|
| [`build-dsh-aio-dev-arm64.sh`](../../docker/build-dsh-aio-dev-arm64.sh) | arm64 构建机(gb10)上 | 原生构建三步链;`--push` 推 `-arm64` 后缀 tag 到 harbor |
| [`build-dsh-aio-dev-amd64.sh`](../../docker/build-dsh-aio-dev-amd64.sh) | amd64 构建机上 | 构建两步链(复用 harbor 的 amd64 chrome base);`--push` 推 `-amd64` 后缀 tag |
| [`ci-dsh-aio-arm64.sh`](../../docker/ci-dsh-aio-arm64.sh) | **本地**(经 ssh 驱动 gb10) | 把本地 `.git` 同步到 gb10,checkout 干净工作树,再在 gb10 上跑 arm64 构建 |
| [`deploy-dsh-aio-arm64.sh`](../../docker/deploy-dsh-aio-arm64.sh) | **本地**(经 ssh 驱动 gb10) | 在 gb10 上 pull 镜像、替换容器、HTTP 探活、打印可用 URL |

### build-dsh-aio-dev-arm64.sh — 原生 arm64 构建

在 arm64 构建机上运行(`uname -m = aarch64` 守卫)。三步,全原生(不用 buildx/QEMU):

1. `docker/chrome-base/Dockerfile` → `dsh-chrome-base:24.04` —— harbor 的
   `ubuntu:24.04-…-chrome` 只发 amd64,arm64 必须自建 base。
2. `docker/dsh/Dockerfile` → `dsh:dev` —— `pnpm install` + `pnpm run build`,最耗时。
3. `docker/dsh-aio/Dockerfile` → `dsh-aio:dev-arm64`(+ `dev-arm64-<sha>`)。

基础镜像(`ubuntu:24.04`、`node:24`)走构建机 `daemon.json` 的镜像加速器,
不直连 Docker Hub。`--push` 把所有层加基础镜像以 `-arm64` 后缀推 harbor,
不碰 amd64 的 `:dev` tag。构建时把 `DSH_CLIENT_COMMIT_HASH` 和
`DSH_BUILD_TS` 传进 dsh 和 aio 两步,供 `/deploy-info` 使用。

### build-dsh-aio-dev-amd64.sh — amd64 对应版

同理在 amd64 构建机上,两步(chrome base 已在 harbor 有 amd64 版,经
`CHROME_BASE_IMAGE` 引用)。推 `-amd64` 后缀 tag。两个架构脚本**刻意不合并**
多架构 manifest——各推各的后缀 tag,两边互不干扰。

### ci-dsh-aio-arm64.sh — 把本地工作树拿到 gb10 构建

日常用的就是这个。它不在本地构建(禁止 WSL 构建)。而是把本地 `.git` 经
ssh tar 到 gb10,在那 `git checkout -f` 出干净工作树,再调
`build-dsh-aio-dev-arm64.sh`。只构建已提交内容——先 commit。默认目标是 gb10,
`-h` 看全部参数。

```bash
./docker/ci-dsh-aio-arm64.sh -p      # 在 gb10 构建当前 HEAD 并推送
./docker/ci-dsh-aio-arm64.sh         # 只构建不推送
```

### deploy-dsh-aio-arm64.sh — 在 gb10 部署并验证

在 gb10 上 pull 镜像、替换 `dsh-aio` 容器(`--network host`、
`--restart=unless-stopped`)、HTTP 探活 web 入口(dev tsx 冷启动约 60s),
并打印可访问 URL。默认镜像 tag 由**当前 git HEAD** 推导(`dev-arm64-<sha>`)
——内容确定的 tag,不用会被覆盖的滚动 tag `dev-arm64`,避免 `docker pull`
命中同名旧 digest 缓存。

```bash
./docker/deploy-dsh-aio-arm64.sh -d dsh.gb10.zhuopu.net   # 部署 + 绑域名
./docker/deploy-dsh-aio-arm64.sh --info                    # 查询当前部署
```

## 暴露模式(deploy 脚本)

- **局域网直连(默认):** 注入 `FRONT_PORT=8080` + `TRUSTED_HOSTS`,局域网任意
  机器 `http://<host>:8080/` 直达,无需 ssh 隧道。
- **域名(`-d <fqdn>`):** 额外注入 `VIRTUAL_HOST`/`VIRTUAL_PORT` 供 nginx-proxy
  vhost 使用,并把 fqdn 加进 `TRUSTED_HOSTS`(`*.gb10.zhuopu.net` 解析到 gb10)。
  需要 gb10 上有运行中的 `nginx-proxy` 容器——见
  [`docker/nginx-proxy/`](../../docker/nginx-proxy/):一个 compose 文件,把
  nginx-proxy + dsh-aio 一起跑在 `webproxy` bridge 网络上,用 `*.gb10.zhuopu.net`
  通配证书走 HTTPS。该 compose 是 gb10 的常驻部署方式;`deploy-*.sh` 脚本是
  快速的单容器路径。证书和 `.env` 都被 gitignore。
- **回环(`LAN_MODE=0`):** 不绑任何可路由地址;经 ssh 隧道访问。

`NR_API_KEY`(LLM 凭据)按序解析:本地环境变量 → gb10 的 `~/dsh-aio.env`
(`--env-file`)→ 两者皆无则告警。

## 部署信息:构建 tag + 部署时间

构建 tag 与部署时间以 `DEPLOY_IMAGE`/`DEPLOY_TS` 注入容器,构建 commit/时间以
`DSH_CLIENT_COMMIT_HASH`/`DSH_BUILD_TS` 注入。两种读法:

- HTTP:`GET http://<host>/deploy-info` → JSON `{image, deployTs, commit, buildTs}`。
  该路由挂在 webserver 上(由 client-connection 插件注册),在 `/api` 浏览器信任
  栅栏**之外**,故无 Origin 也可读。
- CLI:`./docker/deploy-dsh-aio-arm64.sh --info`,或
  `ssh jereh@10.202.200.139 docker exec dsh-aio printenv DEPLOY_IMAGE DEPLOY_TS`。

## 坑:WebSocket 经正向代理会断

若 VNC 预览(或任何 dsh WebSocket)**只在经域名访问时**以 close code 1006 失败,
而 `http://<host>:8080/` 正常,通常是公司正向代理(如 `172.24.0.5:3128`)把明文
HTTP 的 `.zhuopu.net` 降级为 HTTP/1.0——而 WebSocket 要求 HTTP/1.1。这不是
容器/nginx/dsh 的 bug(raw socket 经 nginx 握手完全正常)。在环境层修:把
`*.zhuopu.net` 加进查看者的代理旁路,或给域名上 HTTPS,让浏览器经代理时用
CONNECT 隧道透传、不降级。
