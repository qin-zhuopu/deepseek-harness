# Configuring a custom LLM provider on a running instance over its HTTP API

English | [中文](0002-configure-provider-over-api.zh.md)

Status: resolved

## Executive summary

A running dsh instance carries a fresh, empty `DSH_HOME`, so its model config
differs from your host: no custom providers, and a stock default model. You do
not need to edit files inside the container — the same settings surface the Web
UI drives is reachable over the instance's own HTTP RPC API at
`POST /api/<method>`. Adding a custom ("declared") provider is a single
`settings.update` write to the `llm-pi-ai` namespace; the API key goes through
`credentials.set`; `llm.discoverModels` validates connectivity and auth against
the real upstream before you commit; and `agent-default-model` selects it. Every
write hot-reloads with no restart. The subtle parts: the RPC envelope shape, the
browser-trust fence, revision-gated writes, and the fact that a container's
`localhost` upstream only resolves because the container runs `--network host`.

## The RPC surface

dsh's API proxy ([`packages/host/apiproxy/src/api-proxy.ts`](../../packages/host/apiproxy/src/api-proxy.ts))
exposes unary RPC over HTTP. Each call is `POST /api/<method>` with:

- Header `content-type: application/json` (a non-JSON media type is rejected 415).
- Header `Origin: http://127.0.0.1:<port>` — the browser-trust fence accepts
  loopback; a request with no/foreign Origin can be refused.
- Body, a `client-request` envelope:

```json
{ "type": "client-request", "rpcId": "<uuid>", "method": "<method>", "payload": { } }
```

The response is a `server-response` echoing `rpcId` with
`{"result":{"ok":true,"value":...}}` or `{"result":{"ok":false,"error":...}}`.
The `method` in the body must equal the method in the URL path.

Methods used here (all in the api-proxy dispatch table):

| Method | Purpose |
|---|---|
| `settings.describe` | Read every namespace's value + `revision` (secrets redacted) |
| `settings.update` | Merge-patch one namespace (revision-gated) |
| `llm.providers` | List configurable providers and whether each is active/declared |
| `llm.models` | List the models the instance currently serves |
| `llm.discoverModels` | Probe a provider's real upstream for its model list |
| `credentials.set` | Store one secret by ref name (the only wire direction a secret travels) |
| `session.create` / `session.prompt` / `session.history` | Drive an end-to-end test turn |

## Concepts that matter

**Custom vs built-in providers.** `llm.providers` returns many entries with
`declared: false` — these are built-in *templates* (openai, anthropic, groq …)
that exist but are not configured. A *custom* provider is one you declare
yourself under `llm-pi-ai.providers.<id>`; after the write it reports
`active: true, declared: true`. There is no separate "add custom provider" call —
declaring it in settings *is* adding it.

**Revision-gated writes.** `settings.update` takes `expectedRevision`. Read the
namespace's current `revision` from `settings.describe` first and pass it; a
stale value returns `settings-conflict` rather than clobbering a concurrent
write. A brand-new namespace is `revision: 0`.

**Hot reload.** The `llm-pi-ai` provider watches settings, so a successful write
takes effect immediately — the new model shows up in `llm.models` with no
restart.

**`localhost` upstream needs `--network host`.** The provider's `baseURL` here is
`http://localhost:20128/v1`, a gateway running on the WSL host. It resolves from
inside the container only because the container runs with `--network host` and
shares the host network namespace. Under bridge networking that `localhost`
would point at the container itself and fail; you would use the host address
instead.

## The procedure

Assume the instance is at `http://127.0.0.1:3080`. Payloads shown; wrap each in
the envelope above.

### 1. Read current state

`settings.describe` with `{}`. Note that `llm-pi-ai` starts as
`{"providers": {}}` at `revision: 0`, and `agent-default-model` holds the stock
default (e.g. `deepseek-official` / `deepseek-v4-flash`).

### 2. Declare the custom provider

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

Confirm with `llm.providers` — `nr` should be `active: true, declared: true` —
and with `llm.models`, which now lists `nr -> [kr/claude-opus-4.8, …]`.

### 3. Store the API key

`credentials.set` with `{ "ref": "NR_API_KEY", "value": "<key>" }`. This is the
one call that carries a secret across the wire; the value is never echoed back.
`apiKeyEnv` in step 2 names the credential ref the provider reads.

### 4. Validate before trusting it

`llm.discoverModels`:

```json
{ "settingsNs": "llm-pi-ai", "provider": "nr",
  "baseURL": "http://localhost:20128/v1", "api": "openai-completions" }
```

Omit `apiKey` to use the stored credential. A successful `models` list proves
three things at once: the upstream is reachable, the key authenticates, and the
provider config is well-formed. A failure returns `model-discovery-failed` with
the endpoint but never the key.

### 5. Select it as the default

`settings.update` on `agent-default-model` (read its `revision` first):

```json
{ "ns": "agent-default-model", "expectedRevision": 0,
  "patch": { "provider": "nr", "model": "kr/claude-opus-4.8" } }
```

### 6. End-to-end smoke test

`session.create` (`{ "cwd": "/app" }`) → `session.prompt`
(`{ sessionId, "mode": "queue", "content": [{ "type": "text", "text": "你好" }] }`)
→ poll `session.history`. A healthy turn ends with `turn/end` and `stopReason:
stop`, and the `assistant/message` event's `source` names
`provider: nr, model: kr/claude-opus-4.8` — confirming the reply came from the
provider you configured, not the stock default.

## Pitfalls hit

- **`credentials.describe` needs `refs`.** Calling it with `{}` returns
  `bad-request` — the payload requires a `refs` array. `credentials.set` instead
  takes `{ ref, value }` (see
  [`credentials.schema.ts`](../../packages/host/apiproxy/src/api/credentials.schema.ts)).
- **Shell quoting mangles the key.** Passing a secret through
  `powershell → wsl → bash → python` inline breaks on special characters.
  Base64-encode the value, carry it in one env var, and decode it inside Python;
  it also keeps the secret out of the command line and logs.
- **The reply is streamed, not returned.** `session.prompt` only acknowledges
  `{ accepted: true }`. The answer arrives as `assistant/chunk` events followed
  by a final `assistant/message`; read it from `session.history` (or the event
  stream), not from the prompt response.
- **Empty instance ≠ your host.** The container's default was
  `deepseek-official/deepseek-v4-flash` and its `llm-pi-ai` was empty. Configure
  the instance you are talking to; do not assume it inherited your host config.

## Lessons

- The Web UI has no privileged path — it drives the same `/api/*` RPC you can
  call directly. Automating instance setup is just replaying those calls.
- Validate an external dependency (`discoverModels`) before committing to it;
  one probe covers reachability, auth, and config shape together.
- Keep secrets on a single wire direction (`credentials.set`), pass them
  base64-wrapped through nested shells, and never print them.
- A provider's `localhost` upstream is a property of the container's network
  mode; `--network host` is what makes it resolve to the host gateway.
