# `@deepseek-ai/dsh-host-auth-jwt`

[English](README.md) | 中文

Web 服务器的 JWT bearer 认证：一个函数插件（`name`／`inject`／`Config`／`apply`，依赖 `webServer`）。其 fiber 挂载期间，每条具名 HTTP 路由、回退（SPA dist）面、以及每次 WebSocket upgrade 都要求一个紧凑的 HS256 JWT；未认证请求根本到不了路由处理器。该 row 是自选的：没有 `auth-jwt` row（或 row 被禁用）时，服务器与此前一样保持无认证；dispose 该 fiber 即恢复开放面（HMR 安全）。

token 是用配置的 `secret` 签名的紧凑 JWT（HMAC-SHA256，常数时间验签；只接受 `alg: HS256`，因此 `alg: none` 与算法替换永远验不过；数值型 `exp` 会被强制执行）。它走两条通道之一：

- `Authorization: Bearer <token>` —— 非浏览器客户端、curl、脚本。
- `dsh_token` cookie（配置 `cookie`）—— 浏览器通道：`fetch`、`EventSource` 与同源 `WebSocket` 都会自动携带，因此被守护的 GUI 用原版客户端 bundle 即可工作。

包自带签发面：`GET /login`（配置 `loginPath`）渲染口令表单；`POST /login` 用哈希比较校验口令是否等于 `secret`，并签发 `{sub, iat, exp}` token 作为 `HttpOnly` `SameSite=Lax` cookie（启用 `secureCookie` 时再加 `Secure`）；JSON 请求得到 `200 {token}` 或 `401` 而非 HTML，脚本化客户端走同一端点。`GET /logout` 清除 cookie。guard 区分浏览器导航（`Sec-Fetch-Mode: navigate`，或 GET／HEAD 上的 `Accept: text/html`）——被 `302` 重定向到 `/login?next=…`——与其余一切请求，后者得到带 `WWW-Authenticate: Bearer` 的 `401`。`next` 重定向目标必须是根相对且不含协议的，因此登录页不能被用作开放重定向。login 与 logout 路由按路径豁免于 guard，登录页始终可达；未认证的导航到 SPA shell 会被重定向到 `/login`，cookie 落地后同一导航即交付 shell，其资产请求携带 cookie —— guard 守护包括 dist 在内的整个面。

`secret` 必填且至少 32 字符；它既是签名密钥也是共享口令（多副本部署共享一个 secret，如同共享一份配置）。其余都有默认值：`cookie`、`loginPath`、`logoutPath`、`lifetimeSeconds`（默认 24 小时）、`secureCookie`。

配置到出厂 Web 组合（profile patch 层）：

```yaml
- id: auth-jwt
  name: '@deepseek-ai/dsh-host-auth-jwt'
  config:
    secret: !!js process.env.DSH_AUTH_SECRET
```

## 模型体验

无，因为该包只把守浏览器与 Host 之间的 HTTP 传输，不注册任何面向模型的内容。

#### KV Cache 影响

无。

## 已知限制与延期工作

- **口令即密钥**：一个配置的 `secret` 既是 HMAC 密钥也是登录口令，轮换它会作废所有已签发的 token，也没有按用户的账号。用户账号、签发 API 与轮换属于真正的认证 seam；本包是部署级门锁。
- **登录表单无 CSRF token**：cookie 是 `SameSite=Lax`，登录 POST 要么同源，要么被 cookie 状态所排除，且被守护面只暴露 `Host` 围栏内的同源 API；敌意跨站登录 POST 最多只能白白消耗一次正确口令的机会。
- **token 无状态**：已登出但未过期的 token 在其有效期内对其他客户端仍然有效；`logoutPath` 只清除发起请求的浏览器的 cookie。吊销列表与账号属于同一个未来 seam。
