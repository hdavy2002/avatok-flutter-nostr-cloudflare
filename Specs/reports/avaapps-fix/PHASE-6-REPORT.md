# Phase 6 Report — Verification sweep, dashboard v2, final report            Date: 2026-07-02

No new features. Cross-phase audit + verification + dashboard upgrade.

## 1. Cross-phase self-audit (per file)

| File | Scoping ✓ | Flags default-safe ✓ | Telemetry email-enriched ✓ | Commit prefix ✓ | Notes |
|---|---|---|---|---|---|
| `worker/src/lib/composio.ts` | n/a (server) | ✓ caches/trim/idem default on w/ fallback; confirm/paginate **off** | ✓ via `stats.emit`/`onRetry` (route supplies email) | ✓ | decls-cache events app-global but still email-tagged when run from a user loop |
| `worker/src/routes/ava_apps.ts` | n/a | ✓ quota default 30; stream opt-in | ✓ all `trackUserContact(email,phone)` | ✓ | confirm/quota/warm on existing routes (no `index.ts`) |
| `app/lib/core/apps_service.dart` | ✓ (no local store; delegates to AvaAppsCache) | ✓ `kAvaAppsStreaming` | ✓ client person=uid | ✓ | |
| `app/lib/core/avaapps_cache.dart` | ✓ **per-account subdir `avaapps/<AccountScope.id>/`** | ✓ `kAvaAppsDeviceCache` | ✓ (client) | ✓ | audited: no raw global path |
| `app/lib/features/avaapps/avaapps_screen.dart` | ✓ uses scoped cache | ✓ | ✓ | ✓ | |
| `app/lib/features/settings/settings_screen.dart` | ✓ clears scoped cache on sign-out | n/a | n/a | ✓ | |

**Findings:** all green. No fixes required. Verified via grep of call-sites (arg counts consistent), flag defaults (7 server flags + 2 client consts), and that `connectedToolkits`'s now-unused import was removed in P1.

**Git hygiene:** 18 commits, all prefixed `[AVAAPPS-FIX-P<n>-<k>]`, one concern each, **all local — nothing pushed** (`git log` shows no push; the pre-push hook remains). Every commit passed explicit paths to the wrapper so no other agent's concurrent changes were swept in.

## 2. Message-pairing trace (trimming ON, 3-step run)

Legend: `S`=system, `U`=user, `A`=assistant(tool_calls), `T`=tool(result), `A*`=assistant(final text).

```
Step 0:
  before orStep: [S, U]
  model → 1 tool_call (id=c0)     → push A{tool_calls:[c0]}
  execute → push T{tool_call_id:c0} (full)         rec0(step0)
  messages: [S, U, A(c0), T0]                       ← every tool_call has its T ✓

Step 1 (step<2 → no trim):
  before orStep: [S, U, A(c0), T0]
  model → 1 tool_call (id=c1)     → push A{tool_calls:[c1]}
  execute → push T{tool_call_id:c1} (full)         rec1(step1)
  messages: [S, U, A(c0), T0, A(c1), T1]            ← pairing intact ✓

Step 2 (step>=2 → trim rec.step <= 0, i.e. rec0):
  T0.content ← summary (string swap; T0 object & its tool_call_id kept)
  before orStep: [S, U, A(c0), T0'(trimmed), A(c1), T1(full)]   ← T1 (most recent) NOT trimmed ✓
  model → final text (no calls)  → return A* text
```

At every LLM call each `assistant.tool_calls[id]` still has exactly one matching `{role:"tool", tool_call_id:id}` message (only its `content` string shrank). **No message is ever deleted.** OpenAI schema validity holds. ✓ In streaming mode the same trace applies (only the transport of the assistant text differs).

## 3. Telemetry completeness matrix (events added P0–P5)

| Event | Fires where | Key properties | Email? |
|---|---|---|---|
| `avaapps_run_start` | route avaAppsRun | query_chars, source | ✓ |
| `avaapps_run_ok` | route (non-stream) | duration_ms, steps, tokens, toolkits, tools_called, model, routed_model, route_reason, ctx_trim, chars_saved, setup_ms, composio_retries, step_i_ms | ✓ |
| `avaapps_run_stream_ok` | route streamAppsRun | ttfb_ms, total_ms, steps, model, route_reason, chars_saved… | ✓ |
| `avaapps_run_error` | route (run/status/confirm) | stage, detail, duration_ms, source | ✓ |
| `avaapps_composio_retry` | cfetch via onRetry | attempt, status | ✓ |
| `avaapps_status_ok` | route status | status_fetch_ms, connected_count, fresh | ✓ |
| `avaapps_decls_cache` | declsForToolkit | toolkit, cache, ms | ✓ |
| `avaapps_conn_cache` | cachedConnectedToolkits | cache, ms | ✓ |
| `avaapps_result_cache` | executeTool | tool, cache | ✓ (loop/confirm) |
| `avaapps_idem_dedupe` | executeTool | tool | ✓ (loop/confirm) |
| `avaapps_model_fallback` | loop | primary_model, error | ✓ |
| `avaapps_send_confirm_shown` | loop | tool | ✓ |
| `avaapps_send_confirm_accepted`/`_expired` | route confirm | tool, ok / has_token | ✓ |
| `avaapps_paginate` | loop | tool, pages | ✓ |
| `avaapps_step_cap_hit` | loop | steps, tools_called | ✓ |
| `avaapps_quota_hit` | route | count, limit, source | ✓ |
| `avaapps_warm` | route status | warmed, ms | ✓ |
| `avaapps_screen_open`/`query_submitted`/`result_rendered` | client | ms / chars | person=uid |
| `avaapps_snapshot_render`/`bg_refresh_ok`/`_error` | client | kind, age_s, ms | person=uid |
| `avaapps_send_confirm_client`/`run_stream_fallback` | client | accepted / ms | person=uid |

**Gaps:** streamed runs report `prompt_tokens=0/completion_tokens=0` (orStreamStep doesn't parse `usage`) — accepted, documented; token spend is measured from non-streamed `run_ok`. No other gaps.

## 4. Dashboard v2

- Dashboard **788788** "AvaApps Pipeline Health" upgraded with a v2 text tile (id 130954) enumerating every tile to build post-ingest + the kill-switch matrix.
- Insight tiles intentionally deferred: the events have **zero rows until deploy**, so trend tiles would bind to non-existent events. The tile plan is precise enough to build them in minutes once data flows.
- Annotation **95986** "AvaApps fix complete (Phases 0–6)".

## 5. What I could NOT verify

- No compile/build (repo rule) — verified by reading + grep of call-sites/signatures. No `tsc` (not authorized by a phase prompt).
- All runtime numbers (latency, hit rates, token savings) require deploy + ingestion.

## PostHog annotation ID

- **95986** (completion). Dashboard v2 text tile **130954**.
