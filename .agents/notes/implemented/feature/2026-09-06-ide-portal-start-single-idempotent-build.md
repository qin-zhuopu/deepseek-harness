# Agent Note: ide-portal 启动 converges in one idempotent build, no preceding probe

Status: implemented

## Problem

The 启动 button ran a read-only probe build before every provisioning, so a cold start paid two Jenkins builds and a silent round-trip wait, and the log showed raw marker names (docker-run, probe-internal) that a business user cannot read.

## Decision

The portal's 启动我的IDE action never triggers the read-only probe build. It runs exactly one `ide-provision` build with `ACTION=create`, which converges host-side: an absent container is created, an existing one is started (the log names the skipped deploy), and the post-start probes gate readiness. When the latest check found the IDE running, the action builds nothing and appends a `提示` step (`IDE 已在运行,无需启动。`) instead. The 检查我的IDE action stays a pure probe.

Run steps render in business language (`开始启动/准备运行环境/部署/启动服务/启动后自检/外部访问检查/就绪/启动失败`); the state machine keeps consuming the raw marker names underneath, so `STEP_STATE` and failure attribution (`snapshot.failedStep`) are unchanged. Check chains keep their own labels (`工号/域名/检查/服务状态/Compose 位置/健康检查/结论`).

The portal-side short-circuit for a cached-HEALTHY IDE (no build, a 提示 step) was reversed the same day — see feature/2026-09-06-ide-portal-start-always-builds-host-side-idempotent.md; every 启动 now builds and the host decides.

## Given up

The old pre-flight `reconcile` before provisioning (and with it the `enter`/`retry` methods): 启动 now acts on possibly stale state. That is safe because host-side idempotence makes any action on any state converge to running; the price is that a stale-`NO_SERVICE` start repeats work the probe would have skipped (harmless: create-on-existing degrades to start). `retry` is subsumed: clicking 启动 again re-runs the same idempotent convergence.

## Alternatives considered

Keep the pre-flight probe and only skip it when the probe says healthy — rejected: it still pays the probe round-trip on the common cold path and needs two builds per cold start. Push the convergence decision into the portal by reconciling more cheaply — rejected: only the host knows container truth, and duplicating that knowledge in the portal recreates the drift the probe exists to resolve.

## Consequences

The log a business user reads shows only convergence phases in Chinese; operators correlate a run to its Jenkins build through the  step's build number and the marker file, not through step names. Raw marker names survive in  and state transitions, so dashboards and the state-module edge table stay untouched.

## Required verification

`apps/ide-portal` unit + e2e suites cover: one-build convergence from absent, skip-deploy log line from stopped, no-build hint from healthy, failure terminals, restart attach. Live dev chain verified against real Jenkins (`localhost:8188`).
