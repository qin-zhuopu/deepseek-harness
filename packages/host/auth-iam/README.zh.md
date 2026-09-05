# `@deepseek-ai/dsh-host-auth-iam`

[English](README.md) | 中文

面向 Web 服务器的企业 OIDC 闸门：函数插件（`name`/`inject`/`Config`/`apply`，依赖 `webServer`）。其 fiber 挂载期间，每条具名 HTTP 路由、fallback（SPA dist）面以及每个 WebSocket upgrade 都要求一个由身份提供方签名的 `id_token`；未认证的请求永远到不了 route handler。该 row 是自选的：没有 `auth-iam` row（或该 row 被禁用）时，服务器与之前一样不加认证；销毁 fiber 即恢复开放请求面（HMR 安全）。闸门、cookie 与挑战机制经由 [`dsh-host-auth-jwt`](../auth-jwt/README.zh.md) 与 [`dsh-host-auth-core`](../auth-core/README.zh.md) 共享——两个闸门挂载同一请求面，可共存，也可按部署二选一。

登录使用 Jereh IAM（`iam.jereh.cn` / `iam-test.jereh.cn`）所支持的 OAuth2 隐式流：`GET /login`（配置 `loginPath`）把浏览器重定向到提供方的 `authorization_endpoint`，携带 `response_type=token&scope=openid&client_id=…&redirect_uri=…&state=…`，并种下一个 `HttpOnly` 的 state cookie。提供方完成用户认证（IAM 自己的 `usk` 会话 cookie 是它的事），然后带着 URL **fragment** 中的 token 回到精确的 `redirectPath`（默认 `/auth/callback`）——fragment 永远不会到达服务器，因此回调页是一个单行同源脚本，把 fragment 转成对同一路径的 `POST`。回调先校验 `state`（跨站 POST 无法携带 HttpOnly 的 state cookie，陌生或缺失的 state 一律拒绝：会话固定防护），再对照提供方发布的 **JWKS** 验证 `id_token` 签名（RS256 与 ES256 密钥，可用算法取自 JWK 的 `alg`；token 自带的 `alg: none` 或 `HS256` 永远验不过），强制 `aud` 等于 `clientId`、`iss` 等于发现文档的 `issuer`、以及 `exp`，然后把 `id_token` 本身设为 `HttpOnly` `SameSite=Lax` 会话 cookie（默认 `dsh_token`；`secureCookie` 时追加 `Secure`），并返回 JSON 供页面执行 `location.replace(next)`。此后 `fetch`、`EventSource` 与同源 `WebSocket` 自动携带该 cookie，无需客户端代码——被守护的 GUI 用原版客户端 bundle 即可工作——能自行设置请求头的客户端可用 `Authorization: Bearer <id_token>`。

发现流程先读 `<issuer>/.well-known/openid-configuration`，再试顶层 `openid-configuration.json` 变体；文档加 JWKS 缓存 `refreshMinutes` 分钟（默认 60）；提供方短暂不可达时继续提供最后一次成功的文档；验签失败后强制刷新一次，使 JWK 轮换在一个窗口内落地。闸门期的验签同步地针对缓存文档：在首次成功拉取之前所有请求都被拒绝（登录页回答 `502 Identity provider unreachable`）。

`GET /logout` 清除会话 cookie（提供方自己的 `usk` 会话留在提供方主机上，不受干涉）。未认证的浏览器导航 `302` 重定向到 `/login?next=…`；其余请求得到 `401` 加 `WWW-Authenticate: Bearer`——本闸门不签发自己的 token，脚本化客户端属于 `auth-jwt`。

必填配置：`issuer`（`http(s)://` URL；发现与 JWKS 都从这里读取）与 `clientId`。可选：`redirectPath`、`cookie`、`loginPath`、`logoutPath`、`secureCookie`、`refreshMinutes`、`fetchTimeoutMs`，以及 `allowIssuerMismatch`——为以提供方签发的别名主机访问的部署准备的逃生口；它只跳过 `iss` 相等校验（签名与 `aud` 仍然约束 token）。

为随附 Web 组合配置生产环境 IAM（profile patch 层；`redirectPath` 必须与提供方登记一致——真实 IAM 要求外部可见 URL）：

```yaml
- id: auth-iam
  name: '@deepseek-ai/dsh-host-auth-iam'
  config:
    issuer: https://iam.jereh.cn/idp
    clientId: EnterpriseDingtalk
```

## Model Experience

None, as the package gates HTTP transport between the browser and the Host and registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## 已知局限与后续工作

- **仅隐式流** —— `response_type=token&scope=openid` 匹配随附的 IAM 客户端；`authorization_code` 部署需要 client secret 与 code 交换，本插件不做。
- **会话 token 就是提供方的 id_token** —— cookie 存活至 token 自身 `exp`（Jereh IAM 为 24 小时）；`refresh_token` 被忽略，因此提供方侧登出不会吊销本地 cookie 直到过期，且 `/logout` 不会结束提供方的 `usk` 会话（该主机的 cookie 超出本服务器的能力范围）。
- **不做提供方 end-session 重定向** —— IAM 的 `end_session_endpoint` 只接受 form-encoded POST；浏览器侧结束 IAM 会话是后续增强，目前未接入 `/logout`。
