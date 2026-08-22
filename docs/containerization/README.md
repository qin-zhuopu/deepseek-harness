# Containerization notes

English | [中文](README.zh.md)

Field notes for running dsh inside a container: the pitfalls hit while writing
the repo-root [`Dockerfile`](../../Dockerfile) and getting the web UI reachable,
plus the reasoning behind each fix. Unlike a [post-mortem](../postmortem/README.md)
(a backward-looking record of a bug that escaped process), these are
forward-looking build/run notes: what breaks when you containerize dsh in a
restricted (internal-network, no public registry) environment, and how to get
past it.

| # | Title |
|---|---|
| [0001](0001-dockerize-dsh-pitfalls.md) | Dockerizing dsh: base image, git, commit hash, and loopback networking |
| [0002](0002-configure-provider-over-api.md) | Configuring a custom LLM provider on a running instance over its HTTP API |
