# Agent 笔记:按人开通 IDE 的门户

状态:已实现

[English](2026-09-05-per-user-ide-portal.md) | 中文

## 问题

企业用户要用上自己的 DSH IDE,此前只能靠运维在 10.1.17.58 上逐个手敲 `docker run`。需求([0007](../../../../docs/containerization/0007-per-user-ide-requirements.zh.md))是:公司 IAM 登录后,从已验证的 token 推出 `ide-<工号>.jereh-pe.cn`,对 nginx-proxy(永不被改动,C3)后面的容器做 reconcile,经由唯一宿主机执行器 Jenkins(C9)创建或启动,全过程实时直播到页面,健康后把浏览器交给 IDE。落地代码必须回答的开放问题:谁执行宿主机变更、进度如何跨进浏览器、门户自己重启后怎么续。

## 决定

`@deepseek-ai/dsh-ide-portal`(apps/ide-portal)是独立 Node 应用,不是 webserver 插件 fiber:门户自己持有监听器,没有可挂载网关的 Cordis 运行时。它复用已交付网关的纯函数部分——`dsh-host-auth-iam` 的 `verifyIdToken` 和 discovery 驱动的 provider source(走其声明的 `./src/*` 导出),以及 `dsh-host-auth-core` 的 cookie/body/redirect 助手——自己组装路由;该模块硬编码的 IAM 特性都是针对这一个提供方的协议事实(implicit flow、fragment 中继页、按 origin 拼装的免注册 `redirect_uri`,C10)。

Jenkins 是唯一的宿主机执行器。进度通道就是构建控制台:`Jenkinsfile.ide-provision` 把 `docker/ide-provision/provision.sh` 推到宿主,create 时把模型 key 从 ssh 会话的 stdin 喂进去;脚本每个宿主步骤打一行 `[DSH_STEP] <seq> <step> <ok|fail|info> <detail>` 标记,行间夹杂的普通控制台文本照单容忍。门户用 Jenkins 的增量控制台(`?start=<偏移>`)轮询,把标记解析成只追加的步骤日志,经 SSE 广播且(重)连时全量回放;状态机(0007)按标记语义推进,不按挂钟时间。这让 Jenkins 保持事实源(门户与宿主之间没有第二套协议),`probe` 构建只有几秒,N2 的 2 秒步骤时延只是轮询节奏参数。

按 uid 的正确性分三层:门户进程内 busy 集合(joiner 等 owner 的终态,绝不重复触发)、Jenkins `disableConcurrentBuilds`(宿主变更全局串行)、脚本对 `docker run --name ide-<uid>` 撞名的容忍(两个竞争构建收敛为「已创建 → 继续 start/probe」)。每个 uid 一个标记文件(`--state` 目录,具名卷)记录最后触发的构建;启动时门户重新挂上未完成的构建继续轮询,门户重启既不丢运行也不丢日志(N3)。

uid 取 `sub` 并与 `userId` 交叉核对、过配置的正则,两层都查——否则门户拒绝推导域名(SR1),宿主脚本在任何插值前再验一遍(Jenkins 参数白名单之后的纵深)。平台 key(FR10)的路径:后端 `.env` → 掩码的 `password()` Jenkins 参数 → ssh stdin → 宿主 0600 env 文件 → `docker run --env-file` → 立刻删除;只有 `ACTION=create` 读取,任何一层都不会泄漏进控制台行或 argv(SR5)。

## 后果

门户手工部署一次(`docker/deploy-ide-portal.sh`,配置 `docker/ide-portal/portal.example.yaml`),挂在同一个代理后面,`VIRTUAL_HOST=ide.jereh-pe.cn`;它不自我开通。它绑 `bindHost: 0.0.0.0`,因为代理是经 `dc_default` 访问容器的(0005)——只绑回环是 dsh web 的规则,不是所有服务的。控制台通道意味着 Jenkins 失联时直播冻结、事实不冻结:下一次 reconcile 重读 Docker 状态。标记文件恢复是尽力而为:门户停机期间完成的构建,会在下一次进入时以普通 reconcile 呈现。启动页是零框架构建的静态 SPA(`web/`),不用打包器就满足了前后端分离。入口模式由配置开关 `autoCheck` 决定(需求方拍板,2026-09-06:两条路径都保留,先跑手动,验证无误后再切):`true` 在 `GET /` 内 reconcile——容器健康时入口以一条裸 `302` 应答,冷路径页面从 `/api/state` 自行启动本轮;`false`(线上默认)交付一个静默壳子,检查按钮发出的 `POST /api/provision` 是浏览器通往 Jenkins 的唯一入口,用户不点击就不产生构建、不触碰 Docker 状态。`/api/state` 携带该模式,同一个页面渲染两种形态。测试用本地 HTTP 服务器上的真实 RSA JWKS 冒充 IAM,用脚本化标记构建冒充 Jenkins;`docker/ide-provision/provision.sh` 用 `docker`/`curl` 假件做 hermetic 演练;真实宿主的冷启动是 0008 发布步骤 2。用户容器随镜像带上了随附的 IAM 闸门(O2):`docker/dsh-aio/dshhome/iam-gate.cordis.patch.yml` 在 `DSH_IAM_GATE=1`(开通脚本固定注入)时经 entrypoint 的 `--patch` 层挂上 `auth-iam`,健康探测接受闸门的 `302`/`401` 应答;没带这个开关的容器保持开放,既有部署不受影响。闲置回收(O4)、TLS(O5)、资源上限(O7)按需求方指示继续搁置。

## 考虑过的替代方案

把 `dsh-host-auth-iam` 作为 Cordis 插件挂载被否决:那会把整个 webserver fiber(以及门户根本不持有的第二个监听器)拖进一个只有路由和 SSE 的服务。门户直连 SSH 到宿主机被否决:Jenkins 已经拥有宿主访问、凭据注入、审计和串行构建(0008 的约束 C9 记录了需求方的选择)。门户与任务之间另设机器可读协议被否决,选择控制台标记:控制台本来就是增量的、本来就保留,再加一条平行通道等于制造第二个事实源。用 Redis 或数据库存步骤日志和锁被否决——运行日志就是 Jenkins 控制台,宿主事实就是 Docker,门户本地唯一状态是每 uid 一个小小的标记文件。
