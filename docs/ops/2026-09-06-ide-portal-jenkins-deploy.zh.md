# 2026-09-06 ide-portal 经 Jenkins 部署到 10.1.17.58

[English](2026-09-06-ide-portal-jenkins-deploy.md) | 中文

> 运维会话日志。这里不记录任何口令或令牌;凭据保存在 Jenkins 凭据库和加密的 `~/.jereh-cli/.env` 条目里。

## 部署了什么

`ide-portal:manual-<utc-stamp>`(提交 `9ab415a936`,autoCheck 双模式门户)以容器 `ide-portal` 运行在 10.1.17.58:`dc_default` 网络、`VIRTUAL_HOST=ide.jereh-pe.cn`、宿主挂载 `/opt/ide-provision/{portal.yaml,ide-portal.env,model-key.env}`(0600)、命名卷 `ide-portal-state`。入口 `http://ide.jereh-pe.cn/` 经 `jr-nginx-proxy` 提供服务;未认证的 HTML 请求得到 `302 → /login → IAM`。

## 新建的 Jenkins job(new-jenkins.jereh.cn)

- `ide-provision`(0008 执行器):Pipeline script from SCM,仓库 `bitbucket.jereh.cn/scm/ai/deepseek-harness.git` 的 `*/master`,凭据 `bitbucket`,脚本路径 `Jenkinsfile.ide-provision`。经 `POST /createItem` 用克隆自 `dsh-aio-dev-build` 的 config.xml 创建(Script Console 的 Groovy 路线在这个 git 插件的构造器重载上会失败)。
- `ide-portal-deploy`:内联流水线(参数 `BRANCH`),阶段 Checkout(`git` step)→ 传树到宿主(`git ls-files -z | tar --null -cf - --no-recursion -T -` → ssh tar,只传被跟踪文件)→ 宿主上构建并运行(heredoc `bash -s -- <domain> <dir>`)→ 健康检查(宿主回环 curl 带 `Host:` 头)。同样方式创建;配置更新走 `POST /job/ide-portal-deploy/config.xml`。
- Jenkins 用户 `portal` + 项目角色 `ide-provision-runner`(模式 `^ide-provision$`,Item.Build/Read/Cancel)+ 固定 API token。已验证:`portal` 的 token 能读 `ide-provision`,读其他全部 404。Token 写入宿主 `/opt/ide-provision/ide-portal.env`。

## 真构建暴露的构建修复

1. XML 里的内联 Jenkinsfile:只转义 `&<>` 即可——Groovy 字符串插值是旧日志的坑,XML 不是那个坑。
2. 只传被跟踪文件:`git ls-files -z | tar --null --create --no-recursion --files-from=-`。裸 `tar -cf - .` 会把 Jenkins agent 的 `.git`(连同 `core.hooksPath = /dev/null`)带进构建上下文。
3. 门户 Dockerfile 现在在 `pnpm install` 前从复制进来的 `package.json` 删掉根 `postinstall`(lefthook,开发工作树工具,在 git 检出外必炸),安装全 workspace,再跑 `pnpm run build:lib:host`:`@deepseek-ai/dsh-host-auth-core` 的包主入口是构建产物 `lib/`,而 git 不携带它。缺这一步容器会带着 `ERR_MODULE_NOT_FOUND` 循环重启;期间代理对它的 vhost 回答 502。
4. Jenkins `sh '''…'''` 里 heredoc 的 `$(...)` 在 agent 上展开,不在宿主上——把值当 `bash -s --` 参数传进去。

## 出网发现与离线信任的解法

10.1.17.58 到**生产** `iam.jereh.cn`(10.1.13.181)不通:从宿主本身 ping/443/80 全死(不是 docker/iptables 问题——`--network host` 和网桥表现相同)。同一宿主到 Jenkins 和 Nexus 正常。**测试**环境 `iam-test.jereh.cn`(10.1.17.35,同子网)宿主机和 17.58 上的容器都通:把 `portal.yaml` 指到 `https://iam-test.jereh.cn/idp`,真实 IAM 登录页经 Chrome 端到端渲染出来。

服务端对 IAM 只有两个静态 GET(发现文档、JWKS);登录往返本身跑在用户的浏览器里。门户现在接受 `iam.trustFile`:从任何够得到 IAM 的网络抓下这两份文档、灌到宿主机上,门户就完全不 fetch。抓取命令和条件挂载都在 [docker/deploy-ide-portal.sh](../../docker/deploy-ide-portal.sh) 里。

线上落地的灌法(在够得到 IAM 的网络上执行)与宿主接线:

```bash
node -e 'const f=async(u)=>JSON.parse(await (await fetch(u)).text());
  (async()=>{const d=await f("https://iam.jereh.cn/idp/.well-known/openid-configuration");
    process.stdout.write(JSON.stringify({discovery:d,jwks:await f(d.jwks_uri)))})()' > /opt/ide-provision/iam-trust.json
chmod 600 /opt/ide-provision/iam-trust.json
# portal.yaml: iam: {…, trustFile: /etc/ide-portal/iam-trust.json}
# docker run adds: -v /opt/ide-provision/iam-trust.json:/etc/ide-portal/iam-trust.json:ro
```

就这样部署后:`GET /login` 直接回 `https://iam.jereh.cn/idp/authCenter/authenticate…` 的 `302`,服务端一步都没有出网,Chrome 会话到达真实的生产 IAM 登录页——需要够到 IAM 的是用户的浏览器。IAM 轮换密钥后重抓该文件。

## 验证

- Chrome(CDP,本容器):`http://ide.jereh-pe.cn/` → `302 /login?next=/` → IAM authCenter 页渲染(测试环境,已截图;随后经灌入的信任文件到生产 IAM,已截图)。没有信任文件且 IAM 不可达时,渲染闸门的 `identity provider unreachable` 页——失败即报路径工作正常。
- 容器健康:`GET /`(HTML)302→/login;`/api/state` 401(API 契约);直连容器 IP 探测 302/401;nginx-proxy 的 vhost 在 `docker run` 后数秒内生效。
- 通配 DNS:`ide-<uid>.jereh-pe.cn` 已经解析(用 `ide-14409` 探过),每用户 vhost 不需要任何额外配置。
- `10.1.13.181`(生产 IAM)从本 agent 容器有应答(200),从 10.1.17.58 没有;`10.1.17.35`(IAM 测试,与 17.58 同子网)两边都有。信任文件把服务端这一侧的空档补上了;用户自己的机器够不到 IAM 时,在任何部署上都登录不了——登录往返是浏览器的。
- 隐式流按设计不需要 client secret:浏览器完成往返,门户对照公开 JWKS 验 `id_token`,因此 `usk` cookie 既伪造不出也拿不到。脚本客户端继续用共享口令 JWT 闸门;门户的浏览器会话就是浏览器自己的。
- `/opt/ide-provision/model-key.env` 是占位:create 动作的开通需要需求方把 `NR_API_KEY` 写进去;probe/start/健康检查不带它也能跑(已验证)。

## 可复用的运维配方

- 触发并跟踪任意 Jenkins job:`curl -u user:token POST /job/<job>/buildWithParameters`,沿 `Location:` 队列项解析 `executable.number`,轮询 `…/<n>/api/json` 的 `result`,读 `consoleText`。
- Jenkins API token 是带版本前缀的 34 字符(`~` + 32 位 hex);Script Console 的 `ApiTokenStore.addFixedNewToken(name, token)` 能登记自选值;`generateNewToken` 返回的 TokenInfo 通过 token-value 属性读明文。
