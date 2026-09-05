# Agent Note: 用 JWT bearer 认证为 Web 服务器设闸

Status: implemented

[English](2026-09-05-jwt-web-server-auth.md) | 中文

## Problem

webserver 的每一个请求面——`/api` RPC 桥、下行 WebSocket、插件 bundle、HMR（热模块替换）事件流以及 SPA 外壳——都不做认证。`dsh-client-connection` 中的 DNS 重绑定／Host 围栏是一道来源防线，其特权方法规则被记录为仅限回环生效，"直到真正的认证层出现"。任何能到达绑定宿主的对端都可以驱动会话。替代方案必须覆盖认证插件之后注册的路由、无法从浏览器代码注入请求头的 upgrade，并且保持可选，使随附的默认组合保持不变。

## Decision

`@deepseek-ai/dsh-host-auth-jwt` 是一个注入 `webServer` 的函数插件。它的 fiber 激活期间，每条具名路由、回退处理器与每次 HTTP upgrade 都要求一个紧凑的 HS256 JWT，经 `Authorization: Bearer` 或 `dsh_token` cookie 呈现；dispose（资源释放）会移除这一切（HMR 安全）。webserver 补上了它自己持有的席位：`registerGuard(guard)` 按 surface（`'route'` | `'fallback'`）按注册顺序为 HTTP 设闸——第一个拒绝终结链条并拥有其响应，未写响应的拒绝得到空的 401，回退席位空置时的裸 404 不经过闸门——`registerUpgradeGuard(guard)` 在 upgrade 路由表之前运行，被拒连接（`{status, headers?}` 裁决）因此不会泄露该 pathname 是否有所有者。闸门是可叠加的；没有任何注册时，服务器行为与之前完全一致。

该包自带登录面：`GET /login` 渲染口令表单，`POST /login` 用哈希比较把口令与配置的 `secret` 对照，并把 `{sub, iat, exp}` 作为 `HttpOnly` `SameSite=Lax` cookie 签发（JSON 客户端拿到 `{token}` 而不是 HTML），`GET /logout` 清除 cookie。这两个路径按路径名豁免于闸门。导航请求（`Sec-Fetch-Mode: navigate`，或 GET／HEAD 上的 `Accept: text/html`）得到 `302` 跳转 `/login?next=…`；其余请求得到带 `WWW-Authenticate: Bearer realm="dsh"` 的 `401`。`next` 必须是根相对且不含反斜杠的，登录页因此不能充当开放重定向。

本笔记中的闸门、cookie 与挑战机制现居 [`@deepseek-ai/dsh-host-auth-core`](../../../../packages/host/auth-core/README.zh.md)，与 Jereh IAM OIDC 闸门（[笔记](2026-09-05-jereh-iam-oidc-integration.zh.md)）共享；登录表单、口令校验与 HS256 编解码仍在本包。

配置的 `secret`（必填，至少 32 字符）既是 HMAC 密钥也是共享口令。token 是基于 `node:crypto` 的无状态 HS256：`alg` 必须恰为 `HS256`（`alg: none` 与算法替换都验不过），各段必须能通过 base64url 规范化（带 padding 或宽敏形式在解析前即被拒绝），签名比较是常数时间的，数值型 `exp` 到期即拒。`jose` 在 lockfile 里只是传递依赖；把它升为直接依赖会用约 60 行被钉死、测试齐全的加密胶水换来一个自带审计面的依赖，仓库"依赖优先于手搓"的规则在这个 seam 上不成立。

## Consequences

浏览器无法给 `WebSocket` 或 `EventSource` 设置请求头，所以让原版客户端 bundle 不经修改即可过闸的正是 cookie 通道；Electron 保持通路，因为它经 `file://` 加载 dist，根本不经过 webserver。登录页作为一段内联 HTML 字符串随插件发布，不是构建产物，因此闸门不占用回退席位，frontend-static 仍是 dist 的唯一所有者。`auth-jwt` 不在任何随附 bundle 里：启用它意味着在 cordis.yml 添加一行，`secret` 由部署经 `!!js process.env.DSH_AUTH_SECRET` 提供。测试覆盖单元级的 JWT 编解码、经手搭 context 的闸门表面边缘情形，以及 `packages/host/auth-jwt/tests/` 中完整的 Loader 组合（双通道、upgrade、登录流程、开放重定向拒绝、dispose／重挂载）。

## Alternatives considered

客户端注入请求头被否决，因为 `WebSocket` 与 `EventSource` 不暴露请求头钩子，这等于强迫每个消费者分叉客户端传输。把反向代理前置作为仓库要求被否决，因为 harness 已经拥有监听器、绑定宿主与来源围栏，而代理看不到它不终止的 upgrade 路径语义。只给 `/api` 设闸被否决，因为未认证的壳会泄露应用面，且未来的路由会悄悄绕开闸门；在 webserver 席位设闸意味着认证 fiber 之后注册的路由仍在覆盖之内。把口令与签名密钥拆成两个字段被推迟到 v1 之外：单 secret 部署就是随附形态，README 里写明了轮换后果。
