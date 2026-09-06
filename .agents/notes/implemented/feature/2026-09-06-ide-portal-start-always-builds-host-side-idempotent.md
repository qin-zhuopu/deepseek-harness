# Agent Note: ide-portal 启动 always builds; idempotence lives host-side

Status: implemented

## Problem

The first cut of the one-build 启动 (see feature/2026-09-06-ide-portal-start-single-idempotent-build.md) short-circuited in the portal: a cached HEALTHY/READY verdict from the last check suppressed the build entirely and logged 无需启动. The requester rejected this — the IDE has no self-check ability, so "already running" must be judged where the truth is, at build time on the host.

## Decision

Every 启动我的IDE click triggers exactly one `ide-provision` build with `ACTION=create`; the portal never suppresses it from cached state (the `start` short-circuit and its 提示 step are gone). Idempotence moved into `provision.sh`'s `start_and_probe`: when the container is already running and its front answers, the hook is not fired (`start-hook info already running and answering; skipping start`), the internal probe reports `(already running)`, and the run ends `ready` — no redeploy, no restart. A stopped container is started; a just-started or un-answering one gets the hook fired exactly as before. The portal renders the skip as `启动服务 — IDE 已在运行,无需启动`. Supersedes the short-circuit half of the earlier note; the one-build and business-language decisions stand.

## Consequences

A stale cached verdict can no longer produce a wrong no-op: the log always reflects a fresh host observation. Every click costs a queued Jenkins build even when nothing changes; the executor is the rate limiter (single-flight join still prevents duplicate concurrent builds per uid).

## Alternatives considered

Probe-before-decide in the portal (the original enter) — rejected by the requester: it doubles the builds and re-introduces the silent wait. Keep the cached-state hint — rejected: it reports stale host truth as fact.

## Required verification

`provision.spec` covers skip-on-running-and-answering for both create and start (no hook fire, ready reached) and the fired path for stopped containers; orchestrator/server/e2e specs assert the build fires even after a healthy check. Live dev chain: a healthy IDE's 启动 click ran one create build and logged the skip.
