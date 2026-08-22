# 容器化笔记

[English](README.md) | 中文

在容器里运行 dsh 的实战笔记:编写仓库根目录 [`Dockerfile`](../../Dockerfile)
并让 Web UI 可访问过程中踩过的坑,以及每个修复背后的原因。与
[事故复盘](../postmortem/README.zh.md)(回溯记录逃逸出流程的 bug)不同,这里是
面向未来的构建/运行笔记:在受限环境(内网、无公网 registry)里容器化 dsh 会遇到
什么问题,以及如何绕过。

| # | 标题 |
|---|---|
| [0001](0001-dockerize-dsh-pitfalls.zh.md) | 容器化 dsh:基础镜像、git、commit hash 与 loopback 网络 |
| [0002](0002-configure-provider-over-api.zh.md) | 通过 HTTP API 在运行中的实例上配置自定义 LLM 提供方 |
