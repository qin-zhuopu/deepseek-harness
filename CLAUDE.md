AGENTS.md

# Docker 构建规范

- 不做反复拉公网 docker 镜像；基础镜像用代理(mirror)拉取。
- 代理/本机拉到的基础镜像（chrome-base、dsh 中间层等）务必 push 到 `harbor.jereh.cn`，供后续构建复用。
- 本机不在 WSL 里构建 docker（一律禁止）；arm64 镜像只允许在 gb10（10.202.200.139，ssh 用户 jereh）上构建，amd64 在 amd64 构建机上用对应脚本。

## aio 镜像脚本速查（`docker/*.sh`，详见 docs/containerization/0006）

- `ci-dsh-aio-arm64.sh` —— **日常入口**。本地一条命令：同步 `.git` 到 gb10 → checkout → 在 gb10 上构建 arm64 镜像链。`-p` 构建并推 harbor；只构建已提交内容（先 commit）。
- `deploy-dsh-aio-arm64.sh` —— 在 gb10 部署 + HTTP 探活 + 打印可用 URL。默认镜像 = 当前 HEAD 的 `dev-arm64-<sha>`（内容确定 tag，避免滚动 tag 缓存）。`-d <域名>` 挂 nginx-proxy 反代；`--info` 查当前部署。
- `build-dsh-aio-dev-arm64.sh` / `-amd64.sh` —— 在构建机本地跑的底层构建脚本（ci 脚本会调 arm64 版）。两架构各推 `-arm64`/`-amd64` 后缀 tag，不合并 manifest。
- 构建/部署信息接口：`GET http://<host>/deploy-info` 返回 `{image, deployTs, commit, buildTs}`（在 `/api` 信任栅栏之外）。
- 已知坑：WebSocket/VNC 预览只在经域名访问时 1006 断开，多半是查看者浏览器的正向代理把明文 HTTP 降级成 1.0（WS 要 1.1）——环境层修，不是容器/nginx 问题。