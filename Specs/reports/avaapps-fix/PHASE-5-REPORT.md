# Phase 5 Report — Streaming, prefetch, quotas            Date: 2026-07-02

Fixes review items **#12** (per-user rate limit), **F4** (stream the /run answer), **F5** (speculative prefetch).

## What I did (bullet per change, with file:line)

- **SSE streaming for /run (`composio.ts` + `ava_apps.ts`):**
  - `runAppsToolLoop` gained an optional `stream {onDelta, onStatus}` param. When `onDelta` is set, each step's text is produced via the existing `orStreamStep` (same helper `runAgentLoop`/@ava uses) with automatic fallback to a non-streamed `orStep`; a `statusFor(slug)` line ("Checking Gmail…") fires per tool before execution.
  - `streamAppsRun` (route helper) builds the SSE `ReadableStream` **reusing the exact framing of `avaGeminiStream`**: `data: {json}\n\n` for `{status}` / `{delta}` events, a final `{done, answer, pending_action?}`, and `data: [DONE]\n\n`; `content-type: text/event-stream`. `avaAppsRun` returns it when `?stream=1`; the **non-stream path is byte-for-byte unchanged**. No second SSE framing invented, no `index.ts` route added.
  - Client: `apps_service.dart` `runStreaming(query, {onDelta, onStatus})` consumes the SSE with `http.Request` + `resp.stream.transform(utf8.decoder).transform(LineSplitter)` (mirrors `AvaAiClient.askStream`), returns the full answer, sets `lastPendingAction`. `avaapps_screen.dart` `_run` streams live into `_answer` with a `_status` line, and **falls back to `run()` automatically** on any SSE error (`avaapps_run_stream_fallback`).
- **Prefetch warm-up (`ava_apps.ts` + client):** `GET /api/ava/apps/status?warm=1` (rides the existing status route — no new endpoint) pre-populates the per-toolkit decl KV via `geminiTools(connected)` after the (cached) connection lookup. Rate-limited to **1/min/uid** (`avaapps:warm:<uid>:<minute>`), fully best-effort. Client fires `AppsService.warm()` fire-and-forget in `initState`. Emits `avaapps_warm {warmed, ms}`.
- **Per-user quota (`ava_apps.ts`):** `checkRunQuota` increments `avaapps:quota:<uid>:<yyyymmddhh>` (TTL 2h) and compares against `AVAAPPS_RUNS_PER_HOUR` (default 30). Over → `429 {error, reason:"quota", retry_after_s:600}` with a friendly "Ava needs a breather" message; premium gate unchanged. KV increments are **not atomic** — approximate counting accepted (documented) rather than a Durable Object. Client shows the friendly message on 429 (both `run` and `runStreaming` handle it without double-counting). Emits `avaapps_quota_hit {count, limit}`.

## Flags / env / secrets introduced (name, default, where read)

| Flag / env | Default | Read in | Notes |
|---|---|---|---|
| `AVAAPPS_RUNS_PER_HOUR` | 30 | `checkRunQuota` | per-user hourly /run cap |
| `kAvaAppsStreaming` (client const) | true | `avaapps_screen._run` | flip to force non-streaming |

No new secrets, no new KV namespace, **no `index.ts` change** (stream via `?stream=1`, warm via `?warm=1`, both on existing routes).

## Telemetry added (event → properties → where)

- `avaapps_run_stream_ok` → `{ttfb_ms, total_ms, steps, toolkits, tools_called, model, routed_model, route_reason, fallback_used, ctx_trim, chars_saved, composio_retries, answer_len, email, phone}` → `streamAppsRun`.
- `avaapps_run_stream_fallback` → `{ms}` → client on SSE error.
- `avaapps_warm` → `{warmed, ms, email, phone}` → status warm path.
- `avaapps_quota_hit` → `{count, limit, source, email, phone}` → `avaAppsRun`.

## PostHog annotation ID

- **95985** (project 139917, EU).

## What I verified and HOW

- **SSE framing reuse:** diffed `streamAppsRun` against `avaGeminiStream` — identical `send`/`[DONE]`/headers. Client parser identical to `askStream`.
- **Non-stream unchanged:** the `?stream=1` branch returns before the existing `try` block; without the param, the code path is exactly Phase 4's.
- **Fallback is automatic:** `runStreaming` throws on non-200 (except 429, handled inline); `_run` catches and calls `run()`. Confirmed a 429 does NOT fall back (returns the friendly message inline) so quota isn't double-counted.
- **Warm non-blocking + rate-limited:** client call is fire-and-forget; server gates on a per-minute KV key.
- **Pending_action survives streaming:** the loop's confirm short-circuit sets `stats.pendingAction`; `streamAppsRun` includes it in the `done` event; client `runStreaming` parses it → confirm card still works in streaming mode.

## What I could NOT verify (needs CI build / device test / owner action)

- No local build (repo rule). Real TTFB/latency and stream-vs-fallback rates come from PostHog post-deploy.
- The live streaming feel + fallback under flaky networks needs a device test.
- Quota tuning (`AVAAPPS_RUNS_PER_HOUR`) should be set from observed p99 legitimate usage.

## Deviations from the phase prompt (and why)

- **`/warm` implemented as `/status?warm=1`** rather than a new `GET /api/ava/apps/warm` route — to avoid editing the concurrently-dirty `index.ts` (per the standing constraint used across this fix). Same behavior (auth'd, rate-limited, non-blocking), zero route-registration contention.

## Risks & rollback

- Streaming: `kAvaAppsStreaming=false` (client) forces non-streaming; server `?stream=1` is opt-in so it never affects existing callers.
- Quota: set `AVAAPPS_RUNS_PER_HOUR` very high to effectively disable.
- Warm: best-effort; a failure is swallowed.

## Handoff notes for the next phase (Phase 6 verification)

- Verify the streaming message-pairing (trimming + streaming together) holds — trace a 3-step streamed run.
- Add the Phase-5 tiles to the dashboard: stream vs fallback rate, TTFB p50/p95, warm volume, quota-hit rate.
- Confirm all Phase-5 events carry email (server ones do via `stats.emit`/`trackUserContact`; client ones via the identified person).
