AGENTS.md

# Docker 构建规范

- 不做反复拉公网 docker 镜像；基础镜像用代理(mirror)拉取。
- 代理/本机拉到的基础镜像（chrome-base、dsh 中间层等）务必 push 到 `harbor.jereh.cn`，供后续构建复用。
- 本机不在 WSL 里构建 docker（一律禁止）；arm64 镜像只允许在 gb10（10.202.200.139）上构建，amd64 在 amd64 构建机上用对应脚本。