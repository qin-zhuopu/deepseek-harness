AGENTS.md

# Docker 构建规范

- 不做反复拉公网 docker 镜像；基础镜像用代理(mirror)拉取。
- 代理/本机拉到的基础镜像（chrome-base、dsh 中间层等）务必 push 到 `harbor.jereh.cn`，供后续构建复用。
- 本机不在 WSL 里构建 docker，构建在合适的构建机/CI runner（如 gb10）上进行。