# 容器化 dsh:基础镜像、git、commit hash 与 loopback 网络

[English](0001-dockerize-dsh-pitfalls.md) | 中文

状态:已解决

## 摘要

dsh 是一个 pnpm monorepo(Node `^22.19.0 || >=24.0.0`,锁定 `pnpm@11.7.0`),仓库里
没有现成的 Dockerfile。在受限内网环境(无公网 npm/registry)里容器化时,连续踩了
四个坑:内网基础镜像缺 corepack;`node:24-slim` 无法从外网 Debian 源 `apt-get`
且不带 `git`;构建会调用 `git rev-parse HEAD`,而构建上下文没有 `.git` 时它会失败;
`dsh web` 拒绝绑定 `0.0.0.0`,导致 `-p 3080:3080` 根本连不通。可用方案:基于完整版
`node:24`(自带 git + corepack),npm 指向内网 Nexus,通过 `DSH_CLIENT_COMMIT_HASH`
传入 commit,并用 `--network host` 运行。

## 环境

- 构建主机:Windows,Docker 跑在 WSL2(Ubuntu-24.04)里,内核
  `6.6.87.2-microsoft-standard-WSL2`。
- 内网镜像源:npm 走 Nexus(`https://nexus.jereh.cn/repository/npm-public/`),
  Docker 镜像走 Harbor(`harbor.jereh.cn`)。公网的 `registry.npmjs.org` 和
  `deb.debian.org` 在这里慢或不通。
- 在 WSL 的 ext4 文件系统上构建,不要在 `/mnt/c` 下:9P/drvfs 挂载慢,而且会处理不好
  pnpm monorepo 创建的符号链接。

## 踩坑与修复

### 1. 内网基础镜像没有 corepack

内网的 `harbor.jereh.cn/base/ubuntu:24.04-node22-python312[-chrome]` 镜像通过 nvm
在 `dev` 用户下安装 Node,以 root 运行容器时它的 node bin 布局不一致:`corepack`
解析为 `not found`,`node`/`npm` 只能通过 login shell 访问。基于它构建会在
`corepack enable` 处失败。

修复:改用官方 `node:24` 镜像,它把 `node`、`npm`、`corepack` 放在稳定的 PATH 上。
Node `24.19.0` 满足引擎版本下限。

### 2. `node:24-slim` 无法 apt-get,且不带 git

slim 镜像基于 Debian;`apt-get update` 会卡在 `deb.debian.org`(Fastly CDN),因为
外网访问受限,而 Nexus 只代理了 Ubuntu 的 apt 源(`apt-aliyun`),没有 Debian ——
发行版代号对不上,无法替 Debian 基础镜像用。slim 镜像还缺 `git`,而 install
(lefthook postinstall)和 build(`git rev-parse HEAD`)都要用到它。

修复:改用完整版 `node:24`(Debian bookworm),它自带 `git 2.39.5`,完全不需要
`apt-get`。绕开 apt 也就绕开了镜像源问题。

### 3. 构建调用 `git rev-parse HEAD`,但没有 `.git`

[`scripts/client-build-environment.ts`](../../scripts/client-build-environment.ts)
会把源码 commit 嵌入客户端产物。构建上下文没有 `.git`(被排除了,复制进来也浪费),
于是 `git rev-parse HEAD` 退出码 128,`pnpm run build` 直接挂掉。即便装了 git,也
没有仓库可读。

修复:该函数支持 `DSH_CLIENT_COMMIT_HASH` 环境变量,设置后会跳过 git 调用。
Dockerfile 通过 `ARG`/`ENV` 把源码 commit 传进去:

```dockerfile
ARG DSH_CLIENT_COMMIT_HASH=<源码 commit>
ENV DSH_CLIENT_COMMIT_HASH=${DSH_CLIENT_COMMIT_HASH}
```

把 `ENV` 放在 `RUN pnpm run build` 之前、install 层之后,这样改 commit 不会让缓存的
`pnpm install` 失效。

### 4. `dsh web` 只绑 loopback —— `-p` 不起作用

`dsh web` 出于安全考虑刻意拒绝 `--host 0.0.0.0`
([`packages/bundle/web-app/src/startup.ts`](../../packages/bundle/web-app/src/startup.ts)),
以避免把远程代码执行暴露到网络;它只绑定 `127.0.0.1`。发布端口(`-p 3080:3080`)
转发到容器的 eth0,而不是它的 loopback,所以映射永远连不通(容器内外都是 HTTP 000)。

修复:用 `--network host` 运行。服务器的 `127.0.0.1:3080` 就落在主机 loopback 上。
在 WSL2 上这个 loopback 可以从 Windows 通过 `http://127.0.0.1:3080/` 访问,同时保持
了只绑 loopback 的约束 —— UI 不会暴露到局域网。

```bash
docker run -d --name dsh-web --network host dsh:dev
# 然后打开 http://127.0.0.1:3080/
```

## 验证结果

`pnpm run build` 记录了 200 个客户端产物;容器提供 Web UI,Windows 访问
`http://127.0.0.1:3080/` 返回 HTTP 200,标题为 `DSH Local Build`。

## 经验

- 在受限网络后面做 CI 形态的构建时,优先用完整版 `node:<major>` 而非 `-slim`:它自带
  git,还省掉一次私有镜像源可能覆盖不到对应发行版的 apt 往返。
- 读取 VCS 状态的构建,应为无 VCS 的上下文提供显式的非 VCS 输入;dsh 已经为此暴露了
  `DSH_CLIENT_COMMIT_HASH`。
- 只绑 loopback 的服务与 Docker 发布端口在设计上不兼容;`--network host` 是正确的桥接
  方式,且能保住 loopback 保证。
- 在 Linux 原生文件系统上构建;pnpm monorepo 的符号链接和文件数量会让 `/mnt/c` 构建
  又慢又脆弱。
