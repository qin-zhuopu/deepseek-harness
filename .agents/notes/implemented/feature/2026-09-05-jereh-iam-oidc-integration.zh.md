# Agent Note: 经 Jereh IAM OIDC 提供方登录 dsh

Status: implemented

[English](2026-09-05-jereh-iam-oidc-integration.md) | 中文

## Problem

`dsh-host-auth-jwt` 用一个共享口令给 web 服务器设闸：每个人、每个脚本共用同一个密码。部署目标是 Jereh 企业 SSO——`https://iam.jereh.cn/idp`（测试环境 `iam-test.jereh.cn`）——一个 OIDC 提供方，登录从 `GET /idp/authCenter/authenticate?response_type=token&scope=openid&client_id=EnterpriseDingtalk&redirect_uri=…` 开始，并把 `id_token`（RS256，头部 `{alg:"RS256",kid:"RS256"}` 且没有 `typ`，载荷 `{sub: 工号, uid, aud, iss, exp, iat, jti, nonce:null}`）放进重定向的 URL **片段（fragment）**里。片段参数永远不会到达服务器，任何服务端重定向处理器都读不到 token。提供方在 `GET /idp/oidc/getPublicKey`（经 `/.well-known/openid-configuration` 发布）公开验签密钥；对未发送的 `state` 回显字面字符串 `null`；并且公开的 RSA 密钥不带 `alg` 字段，而带 `alg` 的是同一集合里的 EC 密钥。IAM 自己的会话 cookie（`usk`，`Domain=iam.jereh.cn`）不归我们设置或清除。浏览器登录必须用提供方公开的密钥验签，并落进现有 webserver 闸门席位接受的会话，同时不替换脚本客户端仍在使用的共享口令闸门。

## Decision

`@deepseek-ai/dsh-host-auth-iam` 是一个注入 `webServer` 的函数插件，经新的共享库包 `@deepseek-ai/dsh-host-auth-core` 挂载与 `auth-jwt` 相同的受闸表面。`mountAuthSurface()` 从一个选项对象（cookie 名、登录／登出路径、`secureCookie`、豁免路径、同步 `verify`）出发，把闸门、upgrade 闸门与登出路由注册为调用方 fiber 的 effect；两个闸门只在"如何取得并验证 token"上不同。抽包时被迫拆掉一个 66 token 的 jscpd 克隆：两个登出处理器完全相同，于是登出入驻 `mountAuthSurface`。

流程是与 IAM 实际话术一致的 OAuth2 隐式流。`GET /login` 等待一份新鲜的发现文档（提供方从未可达时返回 502 页面），把 `{state, next}` 存进 `HttpOnly` `SameSite=Lax` cookie，再重定向到文档的 `authorization_endpoint`，带 `response_type=token&scope=openid&client_id&redirect_uri&state`；`redirect_uri` 由请求最左侧的 `X-Forwarded-Proto` 与 `Host` 重建，TLS 终结器因此注册的是公网来源。token 落在片段里，所以 `GET /auth/callback` 返回一个同源脚本页面，把 `location.hash` 搬进对同一路径的 `POST`；POST 处理器先清 state cookie，最先回应提供方的 `error` 参数（在任何 fetch 之前），然后**先于** token 处理强制校验 state——跨站表单 POST 带不动这个 `HttpOnly` state，会话固定攻击因此得到 401——之后才验签。`id_token` 本身就成为会话 cookie（`dsh_token`、`HttpOnly`、`SameSite=Lax`、`Max-Age=exp−now`），同时也接受 `Authorization: Bearer` 呈现，同一个 token 同时满足浏览器与 API 通道。本包不设共享口令登录页：脚本客户端继续用 `auth-jwt`，两个闸门是二选一的部署形态，不是叠加栈。

验签同步针对缓存的提供方文档进行（闸门裁决不能 await 一次 fetch）。缓存文档保存发现字段加 JWK 集合；数据源对并发 fetch 单飞合并，失败时从不清除好文档（invalidate 只令新鲜度过期、保留最后一份好密钥，密钥发布抖动因此降级为按缓存密钥验签，而不是把闸门锁死），并按 `refreshMinutes`（默认 60）窗口重读。验签接受 RS256 与 ES256（原始 64 字节 IEEE P1363 签名；对畸形标量 `node:crypto` 只回答 false，从不抛异常）。签名算法取自 **JWK**：IAM 只在 EC 密钥上发布 `alg`，按头部 `alg` 选密钥根本不可行；token 头部的 `alg` 只用来圈定允许集合，密钥类型与算法必须互相吻合，`alg` 不被接受的 JWK 直接跳过——这也让 HS256 降级在结构上不可能：没有任何公开密钥能携带它。`typ` 仅在存在时校验，因为真实 IAM 不发它。`iss` 必须等于发现文档的 issuer，`aud` 必须包含 `clientId`（字符串或数组）；`allowIssuerMismatch` 是给"经提供方 URL 的主机别名访问"的部署留的文档化出口，其中签名与 `aud` 仍然强制执行，期望 issuer 改取 token 自己的声明。

## Consequences

IAM 的 `usk` SSO cookie 按设计不在范围内：dsh 的 `/logout` 只清我们自己的会话 cookie，IAM 会话仍活的浏览器会经静默重定向立刻重新落地——本包没有提供方 end-session（登出端点）的故事（真实文档只在带尾随空格的键 `end_session_endpoint ` 下发布它）。同一次重定向里的 `refresh_token` 被忽略；会话随 `exp`（该 IAM 为 24 小时）终结，重新导航即重启静默往返。片段中继页是一段只跑在精确回调路径上的内联脚本；不完成登录就直接 POST 回调的无头客户端撞上与浏览器相同的 401 分支。`redirectPath` 必须与 IAM 侧对该 client 的登记一致（`EnterpriseDingtalk` 登记的是 `login.dingtalk.com` 的回调；dsh 部署要登记自己的）。发现 fetch 在服务端执行、受 `fetchTimeoutMs` 约束，并容忍两种已发布的文档布局（先 `/.well-known/openid-configuration`，再顶层 `openid-configuration.json`）。插件与 `auth-jwt` 一样是自选启用：没有随附 bundle 启用它，启用即 cordis.yml 一行（`issuer`、`clientId`，TLS 之后再加 `secureCookie: true`）。测试用真实 socket 搭起假 IdP（发现 + JWKS 端点、可热换的密钥集合证明轮换在一个窗口内落地、仅 JWKS 侧的故障开关），驱动完整 Loader 组合：授权参数、state cookie 姿态、转发协议来源、cookie／Bearer／upgrade 三通道、会话固定与伪造 state 拒绝、超大 body 413、error 透传、secureCookie 姿态与 dispose（资源释放）。`auth-core` 与 `auth-iam` 都达到逐文件 100% 覆盖：单元套件（`id-token.ts`、`discovery.ts`）、钉死直接 `apply` 默认值的部分配置手搭套件，以及组合宿主套件。

## Alternatives considered

授权码流程被否决：该 IAM 登记说的是隐式流（`response_type=token`），且这个面向钉钉的 client 没有下发 client secret；补机密流程需要这套部署里根本不存在的凭据。让浏览器把片段 POST 到任意路径被否决，换成精确路径的同源页面：中继只存在于 `redirectPath`，state cookie 加 `SameSite=Lax` 让它无法被伪造。把声明装进 dsh 自签的会话 cookie 被否决：id_token 本就受 exp 限时、aud 限众、签名保护，再签一遍只会平添第二个信任根而不增加任何吊销能力。检查 token 头部 `alg` 是否在配置白名单内然后逐密钥尝试被否决：面对真实密钥集合（RSA 密钥不带 `alg`），那会让 EC 密钥去回应 RS256 头部；JWK 驱动算法选择加类型吻合，是唯一既能验过 IAM 的 token、又能让两种算法互不越界的分配方式。把回显的 `state=null` 读成"未配置 state"被否决——提供方在没收到 state 时回显字面字符串 `null`，任何与我们 cookie 内 state 不匹配的回显都拒绝登录。
