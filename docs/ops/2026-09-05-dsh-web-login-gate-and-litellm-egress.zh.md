# 2026-09-05 dsh.jereh-pe.cn 设置面登录闸门与 litellm 出口诊断

[English](2026-09-05-dsh-web-login-gate-and-litellm-egress.md) | 中文

> 运维会话日志。此处不记录任何口令或令牌；闸门密钥与 `NR_API_KEY` 只存在于宿主机 compose 环境中。

## 复现（CDP 浏览器内打开 https://dsh.jereh-pe.cn/ ）

1. 设置 → 模型：提供方目录弹窗报「加载提供方目录失败: settings are unavailable in this browser」。DevTools 网络里每个 `settings.describe`/`llm.providers` 特权调用都被拒；页面本身（普通方法）正常。
2. 已配置提供方的对话始终无响应：宿主侧对 `https://litellm.jereh.cn/v1/chat/completions` 的 fetch 在 connect 阶段即死。

两项改动之前均已在 CDP 浏览器中复现。

## 病因 A 与修复（弹窗／配置面）

`/api` 特权方法钉位只放行回环页面，远程浏览器——登录与否都一样——永远够不到 settings/credentials 面，且浏览器镜像在客户端一侧也拒发这些调用。仓库内修复（Agent Note「[认证闸门接纳特权面](../../.agents/notes/implemented/architecture/2026-09-05-auth-gate-admits-the-privileged-plane.zh.md)」）：钉位额外放行出示了已挂载闸门凭据（`dsh-host-auth-core` 的 `authPrincipal`）的请求，拒绝应答从 403 改为 401 + `WWW-Authenticate: Bearer realm="dsh"`；客户端镜像／作用域跟随新的 `privatePlane` 判定（探测 `GET /auth-state`，只有穿过守卫才得到 JSON `{authenticated:true}`）。

10.1.17.58 上的部署烘焙：`docker/dsh-aio/dshhome/jwt-gate.cordis.patch.yml` 被每个 Dockerfile 烘焙；`entrypoint.sh` 当且仅当设置了 `DSH_AUTH_SECRET`（≥32 字符，否则容器拒绝启动）时追加 `--patch /root/.dsh/jwt-gate.cordis.patch.yml`。web profile 的 `package.json` 声明 `@deepseek-ai/dsh-host-auth-jwt`（dependencies 而非 devDependencies），profile 自愈解析器才能找到它。宿主机 compose 文件携带 `DSH_AUTH_SECRET`（在宿主机上生成，永不入库）。登录：`/login` 接受该 secret，签发 `dsh_token` HS256 cookie（1 天），HTTP 与 WebSocket 上行都凭该 cookie 穿过守卫。

实机部署踩坑：launcher 在第一个不认识的 token 处停止解析自有 flag，因此 `--patch` 覆盖层必须**紧跟** `web` 子命令（`dsh web --patch … --no-open …`）；以及 `docker cp` 入口脚本进运行容器必须落为 755——宿主 exec 钩子里的 `nohup` 只会默默回一句 "Permission denied"，没有任何东西在守护。

刻意未部署：`DSH_IAM_GATE=1`。从 10.1.17.58 到 `iam.jereh.cn` 不可达（curl rc28），而挂载但不可达的 OIDC 闸会对一切（包括登录完成）401/重定向——彻底锁死。

## 病因 B 与结论（litellm 传输）——netops 工单，仓库内无解

- `NR_API_KEY` 是对的：compose 行与开发容器中可用的 key 一致，且用同一把 key 走开发容器的 litellm 路由能拿回 200（在运行中的开发容器内测得）。
- 从 17.58 到提供方的网络是死的：`litellm.jereh.cn` 解析到 `10.1.3.101`；**443 与 4000 端口从宿主机、`dsh-aio` 容器（dc_default）、jenkins1 三个位置都得到瞬时 TCP RST**。不是超时、不是 TLS 问题：不存在 SYN-ACK 路径。`curl` rc 7/35，node fetch `connect ECONNREFUSED 10.1.3.101:443`。
- 出口兜底也全是死的：宿主代理 8888（无监听）、`squid` 容器（已退出）、`jr-proxy` 容器（Exited(143)，约 4 周前）、Nexus `8081` CONNECT → rc56。Node 24 的 `NODE_USE_ENV_PROXY=1` 机制上工作，但没有可用代理可指；设置后请求挂起直到被取消，而不是 RST。
- 结论：修复是打通防火墙／路由 **10.1.17.58（及其 docker 网桥）→ 10.1.3.101:443/4000**——一张 netops 工单；或复活一个两侧都可达的出口代理。任何仓库内改动都替代不了。

## 可复用事实

- 特权方法的拒绝应答现在是 401 + `WWW-Authenticate: Bearer realm="dsh"`（原 403）；探测 `GET /auth-state` 得不到 JSON `{authenticated:true}` 的远程页面，其每一行设置都保持进程本地（memory）。
- 探测体与状态码的区别很重要：SPA 兜底对任何未认领路径应答 HTML 200，准入探测必须解析闸门的 JSON 响应体，不能信状态码。
- `ctx.get(name, false)`（宽容读）是热路径上读取可选挂载服务的唯一安全方式；提供方行缺席时，严格 `ctx.get`/`ctx.<name>` 抛 `cannot get property without inject`（cordis reflect.ts）。
- auth-jwt 的密码就是 `secret` 本身（部署级门锁，无账号）；token 无状态——logout 只清当前浏览器的 cookie。
- 客户端测试里的 fake `connection` 把手现在必须携带 `privatePlane: { getSnapshot, subscribe }`（handle 新增成员）；只伪造 `isLoopback` 的 spec 会在 `persistenceAllows` 崩掉。

## 待办跟进

- compose 仍在使用 sleep-60000 入口兜底（PID1 冻结）；在其约 16.7 小时到期前改为 `command: sleep infinity` + 宿主机 cron 定时 exec `/home/admin/dsh-aio-supervise.sh`。
- 开发实例的插件抖动：`DEV_WATCH=1`（aio 默认）会在活的 carrier 下重写 `lib/client.js`，撞上写了一半的 bundle 的页面加载会报 "Failed to load plugins"，且每次报错的包名都在轮换；演示机现已设 `DEV_WATCH=0`（烘焙 bundle）。
- `*.jereh-pe.cn` HTTPS 证书已于 2025-06-23 过期（jr-nginx-proxy 用它服务 dsh.jereh-pe.cn）；不续期浏览器会持续告警。
- 部署实例上遗留一个 "say hi" 会话与一份过时的 smoke job DSL（观感问题）。
