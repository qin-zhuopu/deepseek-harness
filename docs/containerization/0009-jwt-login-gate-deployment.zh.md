# 在托管 aio 实例上部署 JWT 登录门

[English](0009-jwt-login-gate-deployment.md) | 中文

状态:使用中(已部署于 `10.1.17.58`,入口 `https://dsh.jereh-pe.cn/`)

## 摘要

aio 镜像把登录门以休眠状态烘焙进每一张镜像:Cordis 覆盖层 [`docker/dsh-aio/dshhome/jwt-gate.cordis.patch.yml`](../../docker/dsh-aio/dshhome/jwt-gate.cordis.patch.yml) 始终在镜像里,但只有容器看到 `DSH_AUTH_SECRET`(≥ 32 字符)才会挂载。宿主机 compose 里一行环境变量即可激活整条链路——守卫、登录页、`/auth-state` 探测,以及已登录远程浏览器的特权设置面([准入设计](../../.agents/notes/implemented/architecture/2026-09-05-auth-gate-admits-the-privileged-plane.zh.md))。本章是操作规程:设置什么、按什么顺序、如何验证,以及重建容器时的几类故障模式。

## 登录门对部署的影响

| 面 | 未认证 | 已认证(cookie `dsh_token`) |
|---|---|---|
| `/`、SPA、静态资源 | `401` + `WWW-Authenticate: Bearer realm="dsh"` | 正常 |
| `/login` | `200`(页面),密码正确时 `303` | — |
| `/auth-state` | `401` | `{"authenticated":true}` |
| 特权 RPC(`/api/settings.describe`、`llm.providers` 等) | `401` | `200` |

密码就是密钥本身(`dsh-host-auth-jwt`:整部署一个口令,没有账号体系)。cookie 为 HS256、1 天有效期、HttpOnly。`/logout` 只清除发起请求的浏览器自己的 cookie;轮换 `DSH_AUTH_SECRET` 则一次性作废全部令牌。

## 部署步骤(compose,10.1.17.58)

1. 在宿主机上一次性生成密钥:`openssl rand -base64 48 > /home/admin/.dsh_auth_secret`,然后 `chmod 600`。密钥永不进入仓库、Jenkins 任务或任何日志。
2. 在 compose 目录(`/home/admin/git/dc`)的 `.env`(`chmod 600`)中放入 `DSH_AUTH_SECRET_FILE=<密钥>`,并在服务 env 中引用:`- DSH_AUTH_SECRET=${DSH_AUTH_SECRET_FILE}`。compose 文件本身保持无密钥。
3. 重建:`docker-compose up -d dsh-aio`。当且仅当 `DSH_AUTH_SECRET` 已设置时,入口脚本追加 `--patch /root/.dsh/jwt-gate.cordis.patch.yml`;值短于 32 字符时拒绝启动。
4. 保活:admin 的 crontab 每 2 分钟执行 `docker exec dsh-aio /usr/local/bin/supervise.sh`(compose 入口设为 `sleep infinity` 以规避 [0001](0001-dockerize-dsh-pitfalls.zh.md) 记载的 PID1 冻结;`supervise.sh` 幂等,已有守护进程时立即退出)。

## 验证(容器内,8080 前置代理)

```sh
docker exec dsh-aio curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8080/       # 401
docker exec dsh-aio curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8080/login  # 200
docker exec dsh-aio curl -s -w " [%{http_code}]" http://127.0.0.1:8080/auth-state         # 401
docker exec dsh-aio sh -c "grep -m1 'JWT gate' /tmp/entrypoint.log"  # gate mounted
```

完整登录回环:`POST /login` 携带 `password=<密钥>`(表单体)→ `303` + `dsh_token` cookie → `/auth-state` 返回 JSON → 特权 RPC 返回 `200`。浏览器侧,设置 → 模型的提供方目录只在该探测成功后才渲染;登录前客户端按设计把每一行设置留在进程本地。

## 故障模式

- **launcher 参数顺序。** `dsh web` launcher 在第一个不认识的 token 处停止解析自有参数。`--patch` 必须紧跟 `web` 子命令:`dsh web --patch X --no-open …` 可解析,`dsh web --no-open … --patch X` 则以 `unknown option '--patch'` 退出。入口脚本已按此放置门覆盖层。
- **`docker cp` 与执行位。** 把入口脚本拷进运行中的容器必须落为 `755`;守护进程经 `nohup` 启动它,对不可执行文件只回一句 "Permission denied",而死掉的进程没有任何东西在守护。
- **门生效下 `DEV_WATCH=1` 的插件抖动。** aio 默认会在提供服务的 carrier 之下重写 `lib/client.js`;撞上写了一半的 bundle 的页面加载会报 "Failed to load plugins",且每次报错的包名都在轮换。托管实例应设 `DEV_WATCH=0`,使用烘焙 bundle。

## 回滚与 IAM 变体

回滚只需改一行 compose:删掉 `DSH_AUTH_SECRET` 环境变量行并重建——没有密钥时覆盖层永不挂载,实例回到普通 loopback/信任边界部署([0005](0005-reverse-proxy-exposure.zh.md))。在无法访问 `iam.jereh.cn` 的主机上切勿设置 `DSH_IAM_GATE=1`:挂载了却不可达的 OIDC 门会把包括登录完成回调在内的每个请求都重定向,导致全员锁死。IAM 门的前提是容器到签发方网络可达。
