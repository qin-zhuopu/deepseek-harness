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

## 当前状态

`ide-14410` 以整目录布局运行中，健康（401 = 门禁在保护），数据位于 `/data/ide/14410/`。`ide-14409` 与生产 portal 未受影响。待需求方评审后再动 `provision.sh`、`docs/containerization/0008` 或 portal。
