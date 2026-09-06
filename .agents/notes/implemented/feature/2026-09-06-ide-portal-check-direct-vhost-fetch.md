# Agent Note: ide-portal check is a direct vhost fetch, no Jenkins build

Status: implemented

## Problem

The 检查我的IDE action triggered a read-only `ide-provision` probe build: the user waited a queue-plus-build round-trip for a fact a single HTTP fetch delivers, and the production portal's probe triggers were failing 404 against Jenkins, bricking the whole page on arrival.

## Decision

The check is a direct HTTP GET of the IDE's own vhost from the portal (`reconcile` → `probeUrl`), with `health.probeTimeoutMs` (default 5 s) as the silence budget. Any answer below 500 — 200, 302, and the gate's 401 — means running (`HEALTHY`); silence or a proxy 5xx means not running (`NO_SERVICE`). The absent/stopped distinction is dropped on purpose: it changes no user action, since 启动 converges both host-side (see feature/2026-09-06-ide-portal-start-always-builds-host-side-idempotent.md). The check chain is 工号 → 域名 → 检查 → 服务状态 → 结论, rendered the same second the page opens. The `probe` ACTION stays in provision.sh for manual diagnostics; the portal never triggers it. Jenkins is now only on the write path (启动).

## Consequences

The check cannot say why a service is not running (undeployed vs stopped vs proxy broken) — the verdict text names the convergence action instead. The portal must reach the vhost: it resolves through DNS to the host (verified from both the dev container and the dc_default network path via the same public name). Unit tests inject a scripted probe into the Orchestrator; e2e exercises the real vhost.

## Alternatives considered

Keep the Jenkins probe and fix the 404 — rejected: it spends a queued build per page view to learn what one fetch returns, and the user explicitly asked for the fetch. Probe the proxy with a Host header instead of the public name — kept as an option if DNS ever becomes unreachable from the portal network; the direct fetch needs no extra configuration today.

## Required verification

orchestrator/server specs cover healthy (401-as-gate), silent, and thrown checks plus chain reset and seq monotonicity; e2e asserts arrival triggers zero Jenkins builds and the log renders the chain; live dev: the full check chain completes within the same second.
