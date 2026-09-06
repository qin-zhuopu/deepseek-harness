# 2026-09-07 用户 IDE 整目录挂载概念验证（工号 14410）

[English](2026-09-07-ide-whole-dir-mount-poc.md) | 中文

> 运维会话日志。不记录任何密码、令牌或密钥值；模型密钥只在宿主机上从容器复制进文件，全程未打印。

## 验证内容

当前按用户 IDE 的挂载是两个 named volume 加一个 bind 文件（`provision.sh` create 分支）：`ide-<uid>-workspace` → `/workspaces/system-admin`、`ide-<uid>-dshome` → `/root/.dsh`、`/opt/ide-provision/iam-trust.json` → `/etc/ide-portal/iam-trust.json:ro`。需求方希望评估 `/data` 下的整目录布局：

| 宿主机路径 | 容器挂载点 | 模式 |
|---|---|---|
| `/data/ide/14410/workspace` | `/workspaces/system-admin` | rw |
| `/data/ide/14410/root` | `/root`（整个目录，替代 dshome 卷） | rw |
| `/data/ide/14410/ide-provision` | `/etc/ide-portal`（整个目录，替代单文件挂载） | ro |

这只是概念验证：`provision.sh`、`docs/containerization/0008` 与 Dockerfile 均未改动，`ide-provision` Jenkins 任务仍按旧布局开通。等需求方评审本 PoC 后再定需求。

## 先摸清的宿主机事实

- `/data` 是 600G 的 LVM 卷（`datavg-datalv01`），可用 365G——2026-09-06 的磁盘压力在此不适用。
- 无 SELinux（没有 `getenforce` 命令），bind mount 不需要 `:z` 重打标签。
- 宿主机 `model-key.env/` 是空的（create 阶段用后即清）；本次从运行中的 `ide-14409` 容器 `Config.Env` 取模型密钥。

## 验证成功的配方（按序，可照抄）

1. `mkdir -p /data/ide/14410/{workspace,root,ide-provision}`，`chmod 700 /data/ide/14410`。bind mount 不会自动建宿主目录，docker 自建的 root 属主目录会静默遮住预期来源。
2. 从镜像播种 `/root`：用镜像 `harbor.jereh.cn/base/dsh-aio:dev-amd64` `docker create` 一个一次性容器，`docker cp <c>:/root/. /data/ide/14410/root/`，随后删除。这一步必须做：bind mount 会遮蔽镜像内容，而镜像里烤了 `/root/.dsh/jwt-gate.cordis.patch.yml` 和 `iam-gate.cordis.patch.yml`；不播种则 IAM 门禁无法组装，容器回 502。
3. `cp /opt/ide-provision/iam-trust.json /data/ide/14410/ide-provision/`——挂载目录里只能有 trust 文件，安全约束见下。
4. `docker inspect ide-14409` → 提取 `NR_API_KEY=…` 写入 `/data/ide/14410/ide.env`（`umask 077`），全程不回显。
5. `docker run`：上述三个 bind mount 加标准环境（`FRONT_PORT=8080`、`TRUSTED_HOSTS`/`VIRTUAL_HOST=ide-14410.jereh-pe.cn`、`VIRTUAL_PORT=8080`、`HTTPS_METHOD=noredirect`、`DSH_IAM_GATE=1`、`--shm-size 1g`、`--network dc_default`、`--restart unless-stopped`、label `com.jereh.uid`），PID1 用 `--entrypoint bash … -c 'sleep 60000'`。
6. 两步启动：`docker exec -d ide-14410 /usr/local/bin/entrypoint.sh`（C2 硬约束）。
7. 探测容器 IP `:8080` 直到 200/302/401，再用 `-H "Host: ide-14410.jereh-pe.cn"` 探测前置代理。

## 结果

- 容器内探测：第 6 次尝试（hook 后约 55 秒）回 HTTP 401——门禁已上线并在保护。
- 经 jr-nginx-proxy 探测：HTTP 401——vhost 已正确安装。
- 持久化：容器内写入的标记文件（`/workspaces/system-admin/.poc-14410-marker`、`/root/.poc-14410-marker`）立即出现在宿主路径；`docker restart` + 重放 hook 后仍在，且两项探测回到 HTTP 401。
- `docker inspect .Mounts` 显示的正是设计的三个 bind mount；容器内 `/etc/ide-portal` 只列出 `iam-trust.json`。
- 宿主侧 `/data/ide/14410/root/.dsh` 出现运行时内容（`profiles`、`settings.yaml`、`storages`、两个门禁 patch）——整个 `/root` 挂载确实在使用中，不是一份死副本。

## 需求决策要权衡的约束与风险

1. **`/root` 整目录的镜像升级冻结。** `/data/ide/<uid>/root` 下所有内容自首次创建起遮蔽镜像。后续镜像若修复 `jwt-gate.cordis.patch.yml` 或更新 `settings.yaml` 默认值，存量用户永远拿不到；只有新用户受益。旧布局在 `/root/.dsh` 上本就有此性质，整目录布局把冻结面扩大到 `/root` 全部（dotfiles、`.npm`、各类缓存）。重新播种流程（停容器 → 取新镜像 `/root` 但保留用户数据合并 → 起容器）尚不存在，需要时必须做合并而非覆盖。
2. **`/etc/ide-portal` 整目录挂载安全的前提是源目录只有一个文件。** `/opt/ide-provision/` 里还有 `ide-portal.env`（Jenkins token）和 portal 配置；PoC 因此把 trust 文件复制进专用目录，而不是直接挂 `/opt/ide-provision` 本身。今后任何往 `/data/ide/<uid>/ide-provision/` 写文件的操作都会把内容暴露给用户容器。
3. **模型密钥现在落在 `/data/ide/14410/ide.env`（0600）而非每次 create 管道传入。** `ide-provision` 的 SR5 规则（密钥只经 stdin，不落盘）在这条 PoC 路径上不成立；生产设计需要就此决策。
4. 放弃的 named volume 便利：删除即清理（`docker volume rm`），以及 Docker 首次使用时自动从镜像拷贝内容（此处由手工播种替代）。

## 复现方式

经 `dsh-aio-remote-exec` Jenkins 任务执行（`TARGET_HOST=10.1.17.58`、`SCRIPT_B64`，form-encoded `buildWithParameters`）：探测脚本收集宿主机事实；执行脚本完成步骤 1–7 及取证；重启脚本验证 stop/start 自愈。脚本为会话本地文件（操作者容器 `/tmp/poc*.sh`）；上文的配方即可持久形态。

## 双任务切换（2026-09-07 同日晚些时候）

整目录布局现在是一条可切换的第二开通路径，portal 零代码改动、零镜像重建：

- `docker/ide-provision/provision-whole-dir.sh` —— 与 `provision.sh` 相同的 argv、marker 协议、stdin 密钥流和探测阶梯；只有 create 分支不同（布局目录、带守卫的一次性 `/root` 镜像播种、trust 文件复制、三个 bind mount、`com.jereh.layout=whole-dir` 标签）。
- `Jenkinsfile.ide-provision-whole-dir` —— `Jenkinsfile.ide-provision` 的副本，把变体脚本运到 `/opt/ide-provision/provision-whole-dir.sh`。
- Jenkins 任务 `ide-provision-whole-dir` —— 克隆 `ide-provision` 的 config.xml，锚定 BitBucket 分支 `ops/ide-provision-whole-dir`（scriptPath `Jenkinsfile.ide-provision-whole-dir`）。用运维凭据经 `POST /createItem?name=…` 创建；build #1 对工号 14410 端到端探测（`reconcile healthy`）。

**portal 切换只改一个 `portal.yaml` 键。** `jenkins.job` 本来就是 fail-loud 的配置项（`apps/ide-portal/src/config.ts`）；portal 只是 Jenkins API 客户端，宿主机上切换布局的操作是：编辑 `/opt/ide-provision/portal.yaml`（`jenkins.job: ide-provision-whole-dir`），然后 `docker restart ide-portal`。两个任务参数完全一致，`probe`/`start` 与布局无关，存量用户不受影响；只有新创建的容器落到整目录布局。切回 = 把键改回去。生产 `portal.yaml` 在需求方点头前仍指向 `ide-provision`；切换前先合分支，因为任务从 SCM 构建。

## 切换执行（dev 与生产都切到整目录任务）

需求方要求 dev 与生产都切换，已于 2026-09-07 完成：分支快进合入 BitBucket master（`afdbd6dc29`），`ide-provision-whole-dir` 任务经 `config.xml` POST 改回 `*/master`（第一次 POST 返回 500 且未生效；重试返回 200——不要信任状态码，要回读生效配置），master 构建对 14410 的探测回 `reconcile healthy`，随后编辑 `/opt/ide-provision/portal.yaml` 为 `jenkins.job: ide-provision-whole-dir` 并 `docker restart ide-portal`（portal 经代理回 401，监听日志正常）。2026-09-06 的 dev portal 实例已不存在（`/tmp/portal-dev.yaml` 已清理，8188 无监听）：下次拉起时对其 `portal.yaml` 做同样的一键修改即可，这就是 dev 侧的全部操作。

回滚：把 `/opt/ide-provision/portal.yaml` 的 `jenkins.job` 改回 `ide-provision` 并重启 `ide-portal`；无论怎么切，存量容器都不受影响。

## 当前状态

`ide-14410` 以整目录布局运行中，健康（401 = 门禁在保护），数据位于 `/data/ide/14410/`。`ide-14409` 与生产 portal 未受影响。Jenkins 任务 `ide-provision-whole-dir` 已创建并验证；portal 仍指向 `ide-provision`。待需求方评审后再动 `provision.sh`、`docs/containerization/0008` 或 portal 配置。
