# Phase 0 Report — Baseline telemetry + instrumentation audit            Date: 2026-07-02

## What I did (bullet per change, with file:line)

- **Audited existing telemetry.** Pre-existing `track*` calls in the AvaApps surface:
  - `worker/src/routes/ava_apps.ts`: `ava_app_connect`, `ai_error` (connect), `ava_app_disconnect`, `ava_apps_run` (answer_len only), `ai_error` (run), and the rich `genui_action_exec` (already well-instrumented with validate/coerce/exec/render ms + cache visibility).
  - `worker/src/lib/composio.ts`: none directly; `runAgentLoop` (the in-chat @ava path, NOT apps/run) exposes an `onTool` callback the caller wires to telemetry.
  - Flutter: `Analytics.capture('ava_tool_cache')` (apps_service), `avaapps_connect_open` / `avaapps_connected` / `avaapps_coming_soon` (screen), `genui_action_client` (apps_service), `Analytics.appsUnavailable(...)`.
  - Helper signatures confirmed in `worker/src/hooks.ts`: `track(env,uid,event,app_name,props,trace_id?)`, `trackUser(env,uid,email,event,app_name,props,trace_id?)`, `trackUserContact(env,uid,email,phone,event,app_name,props,trace_id?)`. `contactFor(env,uid) → {email,phone}` in `worker/src/lib/identity.ts`. Client: `Analytics.capture(event, {props})` in `app/lib/core/analytics.dart`.
- **Instrumented the /run pipeline end-to-end (no behavior change):**
  - `composio.ts`: added exported `AppsRunStats` interface + `newAppsRunStats()`. `runAppsToolLoop(...)` now takes an optional `stats` out-param and populates `steps`, `toolkits`, `tools_called`, `model`, `fallback_used`, `prompt_tokens`, `completion_tokens`, `result_chars`, `step_ms[]`, `tool_ms[]`, `composio_retries`, `setup_ms`. Control flow and return value are unchanged when `stats` is omitted.
  - `composio.ts` `orStep(...)`: now also returns `usage {prompt_tokens, completion_tokens}` parsed from the OpenRouter response body (`out.usage`). Extra field is ignored by existing `{text,calls}` destructuring in `runAgentLoop`.
  - `composio.ts` `cfetch(...)`: added optional `onRetry(attempt,status)` in init, fired on each transient 429/5xx and network/timeout retry. Threaded through `connectedToolkits(env,uid,onRetry?)` and `geminiTools(env,slugs,onRetry?)` (both optional, backward compatible).
  - `ava_apps.ts` `avaAppsRun`: emits `avaapps_run_start` at entry `{query_chars, source}`; on success emits legacy `ava_apps_run` (unchanged) **plus** `avaapps_run_ok` with the full stats + flattened `step_<i>_ms` keys; on failure emits legacy `ai_error` (unchanged) **plus** `avaapps_run_error` `{stage, detail, duration_ms, source}` where `stage` ∈ auth/premium(handled earlier)/status/llm/tool_exec/run. `onRetry` closure emits `avaapps_composio_retry {attempt,status}` and increments `stats.composio_retries`.
  - `ava_apps.ts` `avaAppsStatus`: emits `avaapps_status_ok {status_fetch_ms, connected_count}` and, on failure, `avaapps_run_error {stage:"status"}`.
- **Instrumented the screens (Flutter), following the existing `Analytics.capture` pattern:**
  - `avaapps_screen.dart` `_load()`: `avaapps_screen_open {status_fetch_ms, connected_count}`.
  - `avaapps_screen.dart` `_run()`: `avaapps_query_submitted {query_chars}` at submit, `avaapps_result_rendered {total_ms, answer_len}` after the answer renders.
- **Funnel / email enrichment:** every new server event uses `trackUserContact(env, uid, email, phone, ...)` with `{email,phone}` from `contactFor(env,uid)` — so `email`/`phone` land as both event props and `$set` person props (see `hooks.ts:76-93`). Client events inherit the identified PostHog person (uid) via `Analytics._base`.
- **Dashboard:** created **"AvaApps Pipeline Health"** (id **788788**, https://eu.posthog.com/project/139917/dashboard/788788). Tiles are described in its metadata and will be populated in Phase 6 once the new events ingest post-deploy (they don't exist in the schema until the instrumented Worker + app ship). Annotation **95962** added.

## Commits (hash + message, in order)

- `[AVAAPPS-FIX-P0-1]` Instrument /run + status server-side (composio.ts stats out-param, orStep usage, cfetch onRetry; ava_apps.ts run_start/ok/error + status_ok)
- `[AVAAPPS-FIX-P0-2]` Instrument AvaApps screen (screen_open, query_submitted, result_rendered)
- `[AVAAPPS-FIX-P0-3]` Phase 0 report
  (hashes recorded in the FINAL report; commits are local only — never pushed.)

## Flags / env / secrets introduced (name, default, where read)

- None. Phase 0 is instrumentation-only. No flags, no new env, no new secrets.

## Telemetry added (event name → properties → where fired)

- `avaapps_run_start` → `{query_chars, source, email, phone}` → `ava_apps.ts` avaAppsRun entry.
- `avaapps_run_ok` → `{duration_ms, source, steps, toolkits[], tools_called[], model, fallback_used, prompt_tokens, completion_tokens, result_chars, setup_ms, composio_retries, step_ms[], step_<i>_ms, tool_ms[], answer_len, email, phone}` → avaAppsRun success.
- `avaapps_run_error` → `{stage, detail, duration_ms, source, email, phone}` → avaAppsRun catch + avaAppsStatus catch (stage:"status").
- `avaapps_composio_retry` → `{attempt, status, email, phone}` → onRetry closure (fired from cfetch).
- `avaapps_status_ok` → `{status_fetch_ms, connected_count, email, phone}` → avaAppsStatus success.
- `avaapps_screen_open` → `{status_fetch_ms, connected_count}` → Flutter `_load`.
- `avaapps_query_submitted` → `{query_chars}` → Flutter `_run`.
- `avaapps_result_rendered` → `{total_ms, answer_len}` → Flutter `_run`.

**Design choice (justified):** `avaapps_run_ok` carries BOTH the `step_ms` array (ad-hoc inspection) and flattened `step_0_ms…step_5_ms` numeric props. PostHog filters/aggregates flat numeric properties far more reliably than array elements (you can't `avg()` over an array element index cleanly), so the flat keys drive the dashboard while the array stays for debugging. Cap is 6 steps, so at most 6 flat keys.

## PostHog annotation ID

- **95962** (project 139917, EU): "AvaApps fix Phase 0 baseline telemetry…".

## What I verified and HOW

- Read every edited hunk back. Confirmed `runAppsToolLoop` still returns the same strings on every path (no-toolkits message, per-step no-call returns, step-cap message) and only *writes* to `stats` when provided — zero control-flow change.
- Confirmed `orStep`'s extra `usage` field cannot break `runAgentLoop`, which destructures `{calls, text}` / `{text, calls}` only.
- Confirmed `cfetch`'s `onRetry` is wrapped in try/catch so a telemetry throw can never abort a Composio call.
- Confirmed new server events all route through `trackUserContact` with `contactFor` → email/phone enrichment present on 100% of new server events.
- Annotation + dashboard created live via the PostHog MCP (ids above returned by the API).

## What I could NOT verify (needs CI build / device test / owner action)

- No local TypeScript/Flutter build (repo rule: CI builds only). Type-correctness verified by careful reading.
- Actual event payloads in PostHog can only be confirmed after the Worker + app deploy and a real /run — the events don't exist in the schema until then. Dashboard tiles are intentionally deferred to Phase 6 for this reason.

## Deviations from the phase prompt (and why)

- Dashboard created as a **shell** (named, described, tagged) rather than with fully built tiles, because the new events have zero rows until deploy; building trend tiles now would bind them to non-existent events. Tile definitions are recorded in the dashboard description and will be added in Phase 6 after ingestion. This matches the prompt's own guidance that real numbers come post-deploy.

## Risks & rollback

- Negligible: instrumentation-only, all telemetry best-effort (try/catch, un-awaited sends). To disable, the events can simply be ignored; no flag needed because nothing changed behaviorally. Reverting the three commits fully restores the prior state.

## Handoff notes for the next phase

- `AppsRunStats` / `newAppsRunStats()` are exported from `composio.ts` — Phase 3 should extend `run_ok` with `ctx_trim`/`chars_saved` and Phase 3/5 with `routed_model`/`route_reason` by adding fields to the stats object rather than new events.
- `connectedToolkits` and `geminiTools` now accept an optional `onRetry` — Phase 1's KV cache wrappers should keep threading it so cache-miss origin fetches still count retries.
- Server events use prefix `avaapps_` with `_ok`/`_error`; keep that convention.
