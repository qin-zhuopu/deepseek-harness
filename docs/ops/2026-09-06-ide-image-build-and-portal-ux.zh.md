# 2026-09-06 IDE 镜像构建链修复 + 门户三按钮改造 + 生产恢复

[English](2026-09-06-ide-image-build-and-portal-ux.md) | 中文

> 运维会话日志。不含任何口令、token、密钥值;凭据只在 Jenkins 凭据库与宿主机 0600 文件里。IAM 密码已在会话中明文出现过一次,应轮换。

## 资源清单(URL/路径,全部长期有效)

| 资源 | 位置 |
|---|---|
| 门户入口(生产) | http://ide.jereh-pe.cn/ (容器 `ide-portal`,经 `jr-nginx-proxy`) |
| 门户 dev | `node --experimental-strip-types apps/ide-portal/src/cli.ts --config /tmp/portal-dev.yaml --state /tmp/ide-portal-dev-state`,监听 127.0.0.1:8188 |
| Jenkins | https://new-jenkins.jereh.cn (API 返回包了一层 `{"success":true,"data":{…}}`,取值先解 `data`) |
| 镜像构建任务 | `dsh-aio-dev-build`(参数 `PUSH_HARBOR`,必须 `--data-urlencode` 表单编码,JSON 体会被静默忽略回退 0) |
| 门户执行任务 | `ide-provision`(ACTION=probe/create/start/stop;probe 只读) |
| 宿主执行通道 | `dsh-aio-remote-exec`(参数 `TARGET_HOST=10.1.17.58`、`SCRIPT_B64`);单执行器,一个卡死的构建会堵住后续触发,队列卡住看 `/queue/item/<id>/api/json` 的 `why`,终止用 `POST /job/<job>/<n>/term` |
| 宿主机 | 10.1.17.58(ssh 用户 admin;Docker 网络 `dc_default`) |
| 用户 IDE | `http://ide-<工号>.jereh-pe.cn/`,容器名 `ide-<工号>`,示例:ide-14409 |
| 宿主机上的门户资产 | `/opt/ide-provision/`:portal.yaml(挂载为 /etc/ide-portal/portal.yaml)、ide-portal.env(IDE_JENKINS_TOKEN)、iam-trust.json、provision.sh、model-key.env/(目录,内容为 Jenkins 凭据落地) |
| 门户源码(宿主) | `/opt/ide-portal-src`(浅克隆 bitbucket master,部署时 `git fetch --depth 1 && git checkout FETCH_HEAD`) |
| 镜像 | `harbor.jereh.cn/base/dsh-aio:dev-amd64`(当前 = build 37,提交 b21968bef2)、`ide-portal:dev`(宿主本地,部署时构建) |
| 数据卷(ide-14409) | `ide-14409-workspace` → 挂载在容器 `/workspaces/system-admin`(用户代码持久化);`ide-14409-dshome` → `/root/.dsh`;`ide-portal-state` → 门户状态 |
| IAM | 生产 iam.jereh.cn(宿主机出网不通它,靠 trustFile 离线信任;测试环境 iam-test.jereh.cn 通,禁用于生产) |

## 镜像构建链:四个叠加的坑与修复

构建脚本 `docker/build-dsh-aio-dev-amd64-internal.sh`(Jenkins 在宿主机上执行),两段式:`docker/dsh/Dockerfile.internal` → `dsh:dev-amd64` → `docker/dsh-aio/Dockerfile.internal` → `dsh-aio:dev-amd64`。

1. **缓存失效(慢的根因)**:`COPY . .` 在依赖安装层之前,任何提交都使 939 个包从慢速 Nexus 重拉。修复:`COPY pnpm-lock.yaml pnpm-workspace.yaml ./` + `COPY patches/ patches/` + `RUN pnpm fetch` 预热 store,再 `COPY . .` + install。install 从 ~15 分钟降到 **1m40s**(提交 23b986dbd7、7ff7220f73)。
2. **`--offline` 丢链接**:fetch 后 `pnpm install --offline` 不在工作区包间建 node_modules 链接,镜像构建通过(tsconfig paths)但运行时 tsx 源码分发 `ERR_MODULE_NOT_FOUND` → 闸门 502。去掉 `--offline` 也没用——**pnpm 本来就只链接被依赖图引用的工作区包**,根 node_modules/@deepseek-ai 下长期只有 1 个链接(本地亦然)。
3. **根治**:`docker/dsh/link-workspaces.mjs` 在 install 后把全部 `@deepseek-ai` 工作区包(247 个)显式符号链接进根 node_modules。**符号链接目标必须绝对路径**——相对目标按链接所在目录解析,`test -d` 会碎(提交 245d89478d、b21968bef2)。构建期断言 `test -d dsh-client-ui-vnc-preview && test -d cordis-plugin-hmr` 把这类问题拦在构建阶段。
4. **web 起不来**:`pnpm dsh web` 不带 `--expose-internals`,新版 HMR 服务拒绝加载,cordis loader 在监听前退出 → 前端 502。且 `--expose-internals` **不允许进 NODE_OPTIONS**,必须作为 node 参数。修复:entrypoint 改 `exec node --expose-internals --import tsx/esm apps/cli/src/bin.ts web …`(提交 8deff0c346)。

宿主机硬约束:**用户容器必须两步走**——`--entrypoint bash -c 'sleep 60000'` 做 PID1,再 `docker exec -d <c> /usr/local/bin/entrypoint.sh`。直接 entrypoint 启动会卡死在 `autocutsel -fork`(前台子进程吞掉整个脚本)。nginx-proxy(jr-nginx-proxy)只认**环境变量** `VIRTUAL_HOST`/`VIRTUAL_PORT`,labels 无效。健康探针接受 200/302/401(401=闸门在保护)。

磁盘:589G 曾到 100%(ENOSPC 杀过 build 31;100% 满盘期间 `docker commit` 的镜像层会损坏——`ide-14409-fixed:v1` 快照 bash 二进制损坏即此因,已弃用)。清理 builder/dangling 腾出 ~21G。两个 1 月的 vllm 镜像共 ~40G 待用户确认删除:`98c6c84ac273`(vllm-glm4-flash:latest,双标签)、`e426f45eef5f`(vllm-openai:nightly-*)。

## 门户交互改造(均为需求方拍板,2026-09-06)

1. **秒开+SSE**:原来 `GET /` 内联 `await reconcile()`——每次打开页面都要等完整 Jenkins probe 往返才返回 HTML。改为立即返回静态页,到达检查后台跑、检查链经 `/api/events` SSE 流式推送;`StateEvent` 增加 `checking` 字段,检查期间显示"正在检查"而非可能被推翻的旧结论;探针失败显示为可见步骤而非静默吞掉(提交 2a7b697fd7)。
2. **三按钮常驻**:`检查我的IDE`(POST /api/check,只读复检)、`启动我的IDE`(POST /api/provision,幂等:HEALTHY 短路/进行中加入/仅 absent/stopped 真正 create/start,失败重试归它)、`进入我的IDE`(就绪才跳,否则日志区加提示行)。按钮**永不隐藏/禁用**,前序条件不满足在日志区提示(提交 448a3b91cf、4eecdebbc1、后续)。
3. **日志可读化**:probe 标记 detail 映射中文(`docker: running`→容器运行中、`HTTP 401 from container`→容器应答 HTTP 401(登录保护正常));每次检查渲染一条链(工号/域名/服务状态/Compose 位置/健康检查/结论),新链(以"工号"为链首标记)替换旧链;seq 单调跨 reset 保持 SSE 去重正确。

检查与启动**都走 Jenkins**(同一个 `ide-provision` 任务,ACTION 区分),门户(含 dev)只是 Jenkins 的 API 客户端,不持有 Docker/SSH 凭据(SR3);dev 与生产唯一差异是 portal.yaml(bindHost/port/jenkins.user/trustFile 路径)。dev 直连真实 Jenkins/宿主机,无 mock。

## 生产事故与恢复(教训)

部署门户时未先核对原容器配置就 `docker rm -f`,重建时猜错 `--env-file` 路径失败,生产门户 503 约 10 分钟。**恢复用的完整命令**(已在用,勿再猜):

```
docker run -d --name ide-portal --restart unless-stopped --network dc_default \
  -v ide-portal-state:/var/lib/ide-portal \
  -v /opt/ide-provision/portal.yaml:/etc/ide-portal/portal.yaml:ro \
  -v /opt/ide-provision/iam-trust.json:/etc/ide-portal/iam-trust.json:ro \
  --env-file /opt/ide-provision/ide-portal.env \
  -e VIRTUAL_HOST=ide.jereh-pe.cn -e VIRTUAL_PORT=8080 -e HTTPS_METHOD=noredirect \
  ide-portal:dev
```

教训:改生产前先 `docker inspect` 存下现有容器的完整 Env/Mounts/Cmd 再动手。其他教训:`pkill -f <模式>` 会匹配自己的 `bash -c` 命令行自杀,用 `pkill -f "dsh[ ]web"` 类括号写法规避;Jenkins API 参数必须表单编码;`curl -m` 别省。

## 当前状态

生产门户 = 提交 2a7b697fd7(秒开版,77 tests 绿);三按钮版(4eecdebbc1 起)已本地 dev 验证待发布。ide-14409 已开通健康(dev 页面点"启动我的IDE"走真实链路创建,build #125)。IDE 镜像 dsh-aio:dev-amd64 = build 37,开机全自动。
