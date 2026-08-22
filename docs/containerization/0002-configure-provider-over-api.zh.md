# 通过 HTTP API 在运行中的实例上配置自定义 LLM 提供方

[English](0002-configure-provider-over-api.md) | 中文

状态:已解决

## 摘要

一个运行中的 dsh 实例带的是全新的空 `DSH_HOME`,所以它的模型配置和你宿主机上的不同:
没有自定义提供方,默认模型也是出厂值。你不需要进容器改文件 —— Web UI 驱动的那套
settings 接口,通过实例自己的 HTTP RPC API(`POST /api/<method>`)就能访问。添加一个
自定义("declared")提供方,就是往 `llm-pi-ai` 命名空间做一次 `settings.update` 写入;
API 密钥走 `credentials.set`;提交前用 `llm.discoverModels` 对真实上游验证连通与认证;
再用 `agent-default-model` 选中它。每次写入都热加载,无需重启。几个不那么直白的点:RPC
信封格式、browser-trust 校验、带 revision 的写入,以及容器里的 `localhost` 上游之所以
能解析,是因为容器用了 `--network host`。

## RPC 接口面

dsh 的 API proxy([`packages/host/apiproxy/src/api-proxy.ts`](../../packages/host/apiproxy/src/api-proxy.ts))
通过 HTTP 暴露一元 RPC。每次调用是 `POST /api/<method>`,要求:

- Header `content-type: application/json`(非 JSON 媒体类型会被 415 拒绝)。
- Header `Origin: http://127.0.0.1:<port>` —— browser-trust 校验放行 loopback;没有
  Origin 或跨源的请求可能被拒。
- Body 是一个 `client-request` 信封:

```json
{ "type": "client-request", "rpcId": "<uuid>", "method": "<method>", "payload": { } }
```

响应是 `server-response`,回显 `rpcId`,结果为 `{"result":{"ok":true,"value":...}}`
或 `{"result":{"ok":false,"error":...}}`。body 里的 `method` 必须和 URL 路径里的一致。

这里用到的方法(都在 api-proxy 的分发表里):

| 方法 | 用途 |
|---|---|
| `settings.describe` | 读每个命名空间的值 + `revision`(密钥已脱敏) |
| `settings.update` | 合并式 patch 某个命名空间(带 revision 校验) |
| `llm.providers` | 列出可配置的 provider 及其 active/declared 状态 |
| `llm.models` | 列出实例当前服务的模型 |
| `llm.discoverModels` | 探测某 provider 的真实上游,拿它的模型列表 |
| `credentials.set` | 按 ref 名存一个密钥(密钥在网络上唯一的传输方向) |
| `session.create` / `session.prompt` / `session.history` | 跑一次端到端测试对话 |

## 需要理解的概念

**自定义 vs 内置提供方。** `llm.providers` 会返回很多 `declared: false` 的条目 ——
它们是内置*模板*(openai、anthropic、groq …),存在但未配置。*自定义* provider 是你
自己在 `llm-pi-ai.providers.<id>` 下声明的;写入后它报告 `active: true,
declared: true`。没有单独的"添加自定义 provider"调用 —— 在 settings 里声明它*就是*添加。

**带 revision 的写入。** `settings.update` 接收 `expectedRevision`。先从
`settings.describe` 读到该命名空间当前的 `revision` 再传进去;传旧值会返回
`settings-conflict`,而不是覆盖掉并发写入。全新的命名空间是 `revision: 0`。

**热加载。** `llm-pi-ai` provider 监听 settings,所以写入成功后立即生效 —— 新模型无需
重启就会出现在 `llm.models` 里。

**`localhost` 上游依赖 `--network host`。** 这里 provider 的 `baseURL` 是
`http://localhost:20128/v1`,是跑在 WSL 宿主上的一个网关。它在容器内之所以能解析,正是
因为容器用了 `--network host`、共享了宿主网络命名空间。如果是桥接网络,那个 `localhost`
会指向容器自身而失败,那时应改用宿主地址。

## 操作步骤

假设实例在 `http://127.0.0.1:3080`。下面只给 payload,每个都要包进上面的信封里。

### 1. 读当前状态

`settings.describe`,传 `{}`。注意 `llm-pi-ai` 初始是 `{"providers": {}}`、
`revision: 0`,而 `agent-default-model` 是出厂默认(例如 `deepseek-official` /
`deepseek-v4-flash`)。

### 2. 声明自定义提供方

`settings.update`:

```json
{
  "ns": "llm-pi-ai",
  "expectedRevision": 0,
  "patch": {
    "providers": {
      "nr": {
        "displayName": "nr",
        "apiKeyEnv": "NR_API_KEY",
        "api": "openai-completions",
        "baseURL": "http://localhost:20128/v1",
        "models": [
          { "id": "kr/claude-opus-4.8",  "name": "kr/claude-opus-4.8" },
          { "id": "kr/claude-haiku-4.5", "name": "kr/claude-haiku-4.5" }
        ]
      }
    }
  }
}
```

用 `llm.providers` 确认 —— `nr` 应为 `active: true, declared: true`;再用
`llm.models` 确认,现在会列出 `nr -> [kr/claude-opus-4.8, …]`。

### 3. 存 API 密钥

`credentials.set`,传 `{ "ref": "NR_API_KEY", "value": "<密钥>" }`。这是唯一一个在网络上
携带密钥的调用;值不会被回显。第 2 步里的 `apiKeyEnv` 指定了 provider 读取的凭证 ref。

### 4. 信任前先验证

`llm.discoverModels`:

```json
{ "settingsNs": "llm-pi-ai", "provider": "nr",
  "baseURL": "http://localhost:20128/v1", "api": "openai-completions" }
```

不传 `apiKey` 就使用已存的凭证。成功返回 `models` 列表同时证明三件事:上游可达、密钥认证
通过、provider 配置合法。失败返回 `model-discovery-failed`,只带 endpoint,绝不带密钥。

### 5. 选为默认模型

对 `agent-default-model` 做 `settings.update`(先读它的 `revision`):

```json
{ "ns": "agent-default-model", "expectedRevision": 0,
  "patch": { "provider": "nr", "model": "kr/claude-opus-4.8" } }
```

### 6. 端到端冒烟测试

`session.create`(`{ "cwd": "/app" }`)→ `session.prompt`
(`{ sessionId, "mode": "queue", "content": [{ "type": "text", "text": "你好" }] }`)
→ 轮询 `session.history`。健康的一轮以 `turn/end` 和 `stopReason: stop` 结束,且
`assistant/message` 事件的 `source` 标明 `provider: nr, model: kr/claude-opus-4.8` ——
证明回复来自你配置的 provider,而不是出厂默认。

## 踩到的坑

- **`credentials.describe` 需要 `refs`。** 传 `{}` 调用会返回 `bad-request` —— payload
  要求一个 `refs` 数组。而 `credentials.set` 用的是 `{ ref, value }`(见
  [`credentials.schema.ts`](../../packages/host/apiproxy/src/api/credentials.schema.ts))。
- **Shell 引号会毁掉密钥。** 把密钥通过 `powershell → wsl → bash → python` 内联传递会在
  特殊字符处炸掉。把值 base64 编码、放进一个环境变量、在 Python 里解码;这也能让密钥不进
  命令行和日志。
- **回复是流式的,不是返回值。** `session.prompt` 只确认 `{ accepted: true }`。答案以
  `assistant/chunk` 事件流出、最后一个 `assistant/message` 收尾;要从 `session.history`
  (或事件流)读,而不是从 prompt 的响应里读。
- **空实例 ≠ 你的宿主机。** 容器默认是 `deepseek-official/deepseek-v4-flash`,`llm-pi-ai`
  是空的。配置你正在对话的那个实例,别假设它继承了你宿主机的配置。

## 经验

- Web UI 没有特权通道 —— 它驱动的就是你能直接调的那套 `/api/*` RPC。自动化实例配置,不过
  是重放这些调用。
- 在依赖一个外部依赖前先验证它(`discoverModels`);一次探测同时覆盖可达性、认证和配置格式。
- 密钥只走单一方向(`credentials.set`),在嵌套 shell 里用 base64 包裹传递,永不打印。
- provider 的 `localhost` 上游是容器网络模式的产物;是 `--network host` 让它解析到宿主网关。
