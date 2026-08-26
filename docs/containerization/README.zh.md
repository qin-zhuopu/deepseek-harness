# 容器化笔记

[English](README.md) | 中文

在容器里运行 dsh 的实战笔记:编写仓库根目录 [`Dockerfile`](../../docker/dsh/Dockerfile)
并让 Web UI 可访问过程中踩过的坑,以及每个修复背后的原因。与
[事故复盘](../postmortem/README.zh.md)(回溯记录逃逸出流程的 bug)不同,这里是
面向未来的构建/运行笔记:在受限环境(内网、无公网 registry)里容器化 dsh 会遇到
什么问题,以及如何绕过。

| # | 标题 |
|---|---|
| [0001](0001-dockerize-dsh-pitfalls.zh.md) | 容器化 dsh:基础镜像、git、commit hash 与 loopback 网络 |
| [0002](0002-configure-provider-over-api.zh.md) | 通过 HTTP API 在运行中的实例上配置自定义 LLM 提供方 |
| [0003](0003-all-in-one-chrome-novnc-mcp.zh.md) | 开箱即用镜像:dsh + Chrome(noVNC) + chrome-devtools MCP |
| [0004](0004-dockerfile-variants.zh.md) | Dockerfile 变体矩阵:公网/内网 × dev/生产 |
| [0005](0005-reverse-proxy-exposure.zh.md) | 把 aio 镜像暴露到反向代理后面:front-proxy、/api 信任栅栏,以及两个错误假设 |
| [0006](0006-aio-build-deploy-scripts.zh.md) | aio 的 build/ci/deploy 脚本:各干什么、何时用 |
