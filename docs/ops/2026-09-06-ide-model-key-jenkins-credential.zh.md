# 2026-09-06 模型 key 迁入 Jenkins Secret text 凭据

[English](2026-09-06-ide-model-key-jenkins-credential.md) | 中文

> 运维会话日志。这里不记录任何口令或令牌;凭据保存在 Jenkins 凭据库里。

## 做了什么

平台 LLM key 的家从"Portal 侧 env 文件 + 掩码构建参数"改为 **Jenkins 全局 Secret text 凭据 `ide-model-key`**。create 阶段的 build 用 `withCredentials([string(credentialsId: 'ide-model-key', variable: 'MODEL_KEY_SECRET')])` 绑定,空值即失败即报;取值以 `umask 077` 落进 workspace 文件,经 ssh stdin 管给 `provision.sh`,`post { always }` 抹掉暂存。`MODEL_KEY` 参数从 job 定义中删除——key 不再进入构建记录(SR5)。

- 凭据创建:Script Console 里 `SystemCredentialsProvider...addCredentials(Domain.global(), new StringCredentialsImpl(GLOBAL, "ide-model-key", ..., Secret.fromString(...)))`。key 取值经文件传入 Groovy 脚本体(`--data-urlencode script@file`),全程不回显。
- 值来源:本 agent 容器 harness 的 `NR_API_KEY`(litellm 网关 key,`/v1/models` 带 key 探活 200 确认有效,25 字符)。**这是平台共用 key**,SR5 的"可吊销、有消费上限"仍待需求方确认;若要换成舰队专用 key,在 Jenkins UI 上更新该凭据的值即可,门户与任务代码不动。

## Role Based Authorization Strategy 的实操坑

`portal` 触发用户原有角色 `ide-provision-runner`(`^ide-provision$`,Item.Build/Read/Cancel)不含凭据使用权,`withCredentials` 会在解析期报 "Credential 'ide-model-key' not found"(凭据视图按 Jenkins.ANONYMOUS 评估,不只是触发者身份)。给该角色补 `CredentialsProvider/UseItem` + `View` 的过程:

1. 权限对象在 `com.cloudbees.plugins.credentials.CredentialsProvider.USE_ITEM/VIEW`(权限 id 是 `com.cloudbees.plugins.credentials.CredentialsProvider.UseItem`,不是 `Credentials/Use`)。
2. `/role-strategy/strategy/addRole` 的表单参数名和 `doAddRole` 的参数名不可依赖(参数反射只给 arg0..argN)。可靠路线是 Script Console 直接操作 RoleMap:`map.removeRole(old)` → 用 4 参构造器 `Role(String, String, Set<String>, String)`(`pattern.toString()`,权限 **id 字符串**集合)重建 → `map.assignRole(fresh, PermissionEntry.user("portal"))` → `Jenkins.get().save()`。
3. 持久化位置是 `$JENKINS_HOME/config.xml` 里 RoleBasedAuthorizationStrategy 的内嵌块(没有独立的 role-strategy.xml);验证 `config.xml` 里同时出现 `UseItem` 与 `portal` 才算落盘。

## 验证

- 临时 job `ide-model-key-smoke`(内联 pipeline):SUCCESS,console 只出现 `staged 26 bytes`(25 字符 + 换行)与 `wiped`,无明文;验后已删除该 job。
- portal 测试 66/66,typecheck 干净;Jenkinsfile 不再有任何 `MODEL_KEY` 参数路径。

## 部署备忘

- 17.58 上 `/opt/ide-provision/model-key.env` 已无引用,可随手删除;`portal.yaml` 删掉 `modelKey:` 行,否则新镜像(严格 schema)启动即报。
- Jenkins job 定义(Pipeline script from SCM)自动取 master 的新 Jenkinsfile,无需改 job 配置。
