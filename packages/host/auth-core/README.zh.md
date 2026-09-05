# `@deepseek-ai/dsh-host-auth-core`

[English](README.md) | 中文

webserver 闸门插件共享的认证面机制：一个库包（没有自己的插件 row），持有两个随附闸门持有者——[`dsh-host-auth-jwt`](../auth-jwt/README.zh.md)（HS256 共享密钥 token）与 [`dsh-host-auth-iam`](../auth-iam/README.zh.md)（企业 OIDC id_token）——否则各写一遍的请求面词汇：token 呈现（`Authorization: Bearer` 优先于认证 cookie）、`HttpOnly` `SameSite=Lax` 会话 cookie 签发、根相对 `next` 校验、浏览器导航识别、`WWW-Authenticate: Bearer` 挑战、限额请求体读取、规范化 base64url JSON 解码，以及 `mountAuthSurface()`。

`mountAuthSurface(ctx, options)` 是本包的产品：在调用方插件的 fiber 内注册 webserver 的 `WebGuard`（豁免路径放行；验签通过的 token 放行；未认证的 fallback 面浏览器导航 `302` 重定向到登录路径并携带 `next`；其余全部 `401` 加 Bearer 挑战）、`UpgradeGuard`（未经验证的 upgrade 在 upgrade 路由表之前被 `401` 拒绝），以及共享的 logout 路由（清除 cookie，重定向到 `/`）。每个注册都是调用方 fiber 的 effect，因此销毁闸门持有者会按 webserver 闸门契约的确切要求重新开放请求面。

本包加载时不注册任何东西，也不自带任何传输；它运行在被配置的闸门持有者的 fiber 里。面向用户的流程与配置见两个闸门持有者的 README。

## Model Experience

None, as the package is shared HTTP-transport mechanics between the browser and the Host and registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## 已知局限与后续工作

- **登录面样式归各持有者** —— core 只挂载闸门对与 logout 路由；每个闸门持有者渲染自己的登录面，视觉打磨留在持有者一侧而非此处。
