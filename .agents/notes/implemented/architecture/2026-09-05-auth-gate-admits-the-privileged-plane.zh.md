# Agent Note: the auth gate admits the privileged plane

Status: implemented

English | [中文](2026-09-05-auth-gate-admits-the-privileged-plane.md)

> 范围：已挂载的认证闸门与两块禁止远程浏览器配置的回环专属面——connection node 半侧的特权方法钉位、浏览器侧设置镜像／作用域持久化——之间的接缝。随 `dsh-aio` 共享口令闸门（`DSH_AUTH_SECRET`）一起交付；闸门插件本身见 [auth-core](../../../../packages/host/auth-core/README.zh.md)、[auth-jwt](../../../../packages/host/auth-jwt/README.zh.md)、[auth-iam](../../../../packages/host/auth-iam/README.zh.md)。

## Problem

反向代理暴露在公网权威上的 dsh web，GUI 本身访问无碍——`/api` 权威栅栏接纳部署声明的 `trustedHosts`——但配置面一片漆黑：每次 `settings.*`/`credentials.*`/`llm.discoverModels` 调用都得到 403（特权方法钉位仅限回环，见 [api 浏览器信任边界 Note](2026-07-28-api-browser-trust-boundary.zh.md)），浏览器侧镜像更是连试都不试，在模型提供方弹窗里显示「当前浏览器不可用设置」。[web 配置面 Note](2026-07-30-web-config-plane.zh.md) 在同一规则上钉了两侧。在认证层尚不存在时这是对的；闸门一旦交付，它就成了已登录的远程操作员与设置页之间唯一的障碍。两半必须一起动：服务端的特权方法准入，以及知道自己已被准入的客户端（否则浏览器仍会拒发它现在有权发出的调用）。

## Decision

**认证恰好在特权方法钉位处替代回环证据。**connection node 半侧的钉位以空信任表过信任栅栏；当可选的 `authPrincipal` 服务（由 `dsh-host-auth-core` 的 `mountAuthSurface` 提供）报告请求出示了凭据时，钉位额外放行。`/api` 前缀栅栏与 WebSocket upgrade 栅栏从不咨询该 principal：认证替代的是「回环曾是判定依据」的地方的回环证据，不是部署自己的 `trustedHosts` 列表。被拒的特权调用以 `401 unauthorized` 加 `WWW-Authenticate: Bearer realm="dsh"`——登录信号——应答，而非旧的 403；未挂载闸门时 `authPrincipal` 缺席（`readAuthPrincipal` 经由 `ctx.get(name, false)` 宽容读取），因此今天的回环专属部署行为除拒绝状态码外完全不变。`isPrivate` 报告的是凭据被出示，而非已验签；这之所以安全，恰恰因为闸门的守卫在任何路由之前就已拒绝未验签凭据，而无凭据请求的宽容读取在钉位处失败关闭。

**浏览器从闸门自己的面获知判定。**`mountAuthSurface` 注册 `GET /auth-state`，只有穿过守卫才可达，应答 `{"authenticated":true}`；抵达处理函数本身就是判定。客户端 connection handle 发布一个可观察的 `privatePlane` 源：回环（及非浏览器）页面同步获准；远程页面在加载时探测 `/auth-state` 一次。起作用的是探测体——不是 HTTP 状态——因为 SPA 兜底对任何未认领路径应答 HTML `200`，靠 JSON 解析把它拒掉。

**设置持久化跟随实时判定。**`SettingsDescribeMirror` 与 `SettingsScopeController` 接收 `SettingsPersistence`——`'host'`、`'memory'` 或一个 `PrivatePlaneSource`。binder 对非回环页面传入 connection handle 的 `privatePlane`；每个读取门（`load`/`ensure`）、写队列（`enqueue`）与 derive 现在每次调用都咨询 `persistenceAllows()`，而不再是构造期常量。插件把镜像订阅到 plane 源上，`refreshPermission()` 把 `unavailable` 翻成 `idle` 并发起准入读取；作用域沿其既有的镜像订阅重新推导，因此会话中途的闸门接纳无需刷新就打开每一张已绑定的行。客户端探测是一次性的（页面本就送达已登录浏览器，会话中途不会指望重新加载），而镜像／作用域机制刻意读取实时源，这也让 fixture 传输可以传普通的 `'memory'`/`'host'` 常量。

**aio 部署烘焙一个由环境变量开关的 HS256 闸门。**`dsh-aio` 交付 `jwt-gate.cordis.patch.yml`（每个 Dockerfile 都烘焙）；entrypoint 仅在 `DSH_AUTH_SECRET` 已设置时追加 `--patch`，并对低于 32 字符下限的密钥拒绝启动。web profile 的 `package.json` 声明 `@deepseek-ai/dsh-host-auth-jwt`，让 profile 自愈解析器能找到它。密钥只活在宿主机的 compose 环境里；仓库永不携带。

## Alternatives considered

- **钉位保持回环专属，配置从宿主机上管理。**被拒：这恰好让反向代理工作所服务的那类远程部署够不到已部署产品的核心闭环（「存钥匙、再提问」），而弹窗的死胡同文案让产品看起来是坏了而不是被锁住。
- **在 `/api` 前缀栅栏也咨询 `authPrincipal`。**被拒：前缀栅栏回答的是部署声明了哪些权威；让任意闸门出示绕过 `trustedHosts`，会悄悄放宽可达性策略，并让已准入浏览器的 Host 伪造探测悄悄通过。两套策略保持正交，测试把前缀／upgrade 栅栏钉在纯 Host/Origin 比较上。
- **把准入探测路径上的任意 HTTP `200` 当作已准入。**被拒：SPA 兜底持有每个未匹配路径并应答 HTML `200`（包括未挂载闸门时的 `GET /auth-state`），纯状态探测会为每个匿名页面打开特权面。JSON 判定 `{authenticated:true}` 只有穿过守卫才可达。
- **在 binder 构造期一次性决定持久化。**被拒：探测在插件激活之后才落定，构造期常量会把远程页面永久钉死在 `memory`，哪怕已经获准；实时 `PrivatePlaneSource` 加 `refreshPermission()` 反应式地打开该面，并让既有镜像订阅 derive 路径保持为唯一发布点。
- **在局域网机器上部署 IAM（OIDC）闸门。**当前部署被拒：从 10.1.17.58 到 `iam.jereh.cn` 不可达，而挂载但不可达的闸门会锁死所有面（守卫对一切 401/重定向，包括登录完成）。HS256 闸门无外部依赖；IAM overlay 照旧保持 opt-in。

## Consequences

- 已登录的远程浏览器获得完整配置面（设置、凭据、模型发现、preset 创作、原生对话框）且无需刷新；匿名局域网页面在钉位处仍得到 401 + Bearer 挑战、`privatePlane` 永久关闭，每一行保持进程本地。
- 特权方法的拒绝状态码从 403 变为 401。把 403 当作拒绝应答的客户端必须改读 401（或 `WWW-Authenticate` 头）；仓库内没有这样的消费者。
- 配置面现在由两套互相独立的策略守护——可达性（`trustedHosts`）与身份（闸门）——且各自可单独审计：撤掉闸门即恢复旧行为（状态码除外），放宽 `trustedHosts` 也永不打开钉位。
- `dsh-aio` 多出第三种启动形态（开放／IAM／JWT），其配置错误在 entrypoint 日志里大声失败；共享口令闸门的安全性完全取决于密钥强度与代理的 TLS；HTTPS 证书缺口记录在 ops 日志而非此处。
