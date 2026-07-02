# AvaApps Pipeline Fix — FINAL REPORT (Phases 0–6)

**Date:** 2026-07-02 · **Repo:** `avaTOK-2-Flutter` · **Source review:** `Specs/AVAAPPS-PIPELINE-REVIEW-2026-07-02.md`
**Status:** all 6 phases implemented, **18 commits local — NOTHING PUSHED** (per repo rule; the owner pushes/deploys).
**Stack unchanged:** Composio (OAuth + tool exec) + OpenRouter (LLM), Cloudflare Worker + Flutter. No Nostr, no Klavis, no BYOK reintroduced.

---

## 1. Commits (in order, all local)

| Phase | Commit | Message |
|---|---|---|
| 0 | `64cf04a` | [P0-1] Instrument /run + status server-side (stats out-param, orStep usage, cfetch onRetry, run_start/ok/error, status_ok) |
| 0 | `b7a2eef` | [P0-2] Instrument AvaApps screen (screen_open, query_submitted, result_rendered) |
| 0 | `2c47316` | [P0-3] Phase 0 report |
| 1 | `7dbec0d` | [P1-1] Server-side KV caches: decls(24h) + connectedToolkits(5min) + parallel + invalidation + AVAAPPS_KV_CACHE |
| 1 | `f52fbe8` | [P1-2] Client passes ?fresh=1 post-OAuth |
| 1 | `ca2f54a` | [P1-3] Phase 1 report |
| 2 | `9c5d435` | [P2-1] Per-account device snapshot cache (AvaAppsCache) + persist status/run |
| 2 | `08a5f97` | [P2-2] Stale-while-revalidate render + clear on sign-out |
| 2 | `f683ec1` | [P2-3] Phase 2 report |
| 3 | `353b435` | [P3-1] Token diet: context trimming + cheap-model routing + 90s read result cache |
| 3 | `420c02f` | [P3-2] Phase 3 report |
| 4 | `a4769dc` | [P4-1] Robustness: idempotency, confirm-before-send, pagination, partial results, log fallback |
| 4 | `29a9763` | [P4-2] Client confirm card |
| 4 | `3e7758d` | [P4-3] AvaApps security notes (#11/#13/#1) |
| 4 | `df081c8` | [P4-4] Phase 4 report |
| 5 | `0cf9f3f` | [P5-1] SSE streaming /run?stream=1 + /status?warm=1 prefetch + per-user quota |
| 5 | `6a8e7ff` | [P5-2] Client SSE streaming + warm + quota message |
| 5 | `f4ee0e7` | [P5-3] Phase 5 report |
| 6 | *(this doc + PHASE-6-REPORT)* | verification sweep, dashboard v2 |

Also: `Specs/AVAAPPS-SECURITY-NOTES-2026-07-02.md`, `Specs/reports/avaapps-fix/PHASE-{0..6}-REPORT.md`.

## 2. Kill-switch table (all flags + defaults)

| Flag / const | Scope | Default | Off/tune behavior |
|---|---|---|---|
| `AVAAPPS_KV_CACHE` | Worker env | on | bypass decls+conn KV caches (live Composio) |
| `AVAAPPS_CTX_TRIM` | Worker env | on | replay full tool results (pre-fix) |
| `AVAAPPS_SIMPLE_MODEL` | Worker env | =`google/gemini-2.5-flash` | override cheap-route model |
| `AVAAPPS_RESULT_CACHE` | Worker env | on | no 90s read cache |
| `AVAAPPS_IDEMPOTENCY` | Worker env | on | no write dedupe |
| `AVAAPPS_CONFIRM_SENDS` | Worker env | **off** | when on, sends/deletes require a confirm card |
| `AVAAPPS_PAGINATE` | Worker env | **off** | when on, search reads auto-page (≤3 pages/30 items) |
| `AVAAPPS_RUNS_PER_HOUR` | Worker env | 30 | per-user hourly /run cap |
| `kAvaAppsDeviceCache` | Flutter const | true | disable on-device snapshot cache |
| `kAvaAppsStreaming` | Flutter const | true | force non-streaming /run |

**Design principle:** caches + idempotency default ON but every one falls through to origin on any KV/Composio error — a missing KV entry or secret can never break the live app. The two behavior-changing features (confirm, pagination) default OFF (master rulebook rule 4).

## 3. KV key schemas (namespace: existing `TOKENS`)

| Key | Value | TTL |
|---|---|---|
| `avaapps:decls:<toolkit>:v1` | curated function decls (JSON) | 24h |
| `avaapps:conn:<uid>` | connected toolkit slugs (JSON) | 300s |
| `avaapps:res:<uid>:<tool>:<hash(args)>` | raw read result | 90s |
| `avaapps:idem:<hash(uid+tool+args+10min bucket)>` | write result | 24h |
| `avaapps:confirm:<token>` | `{uid,tool,args}` pending send | 300s |
| `avaapps:quota:<uid>:<yyyymmddhh>` | run counter | 2h |
| `avaapps:warm:<uid>:<yyyymmddhhmm>` | warm rate-limit marker | 60s |

Device (Flutter, per-account subdir `…/avaapps/<AccountScope.id>/`): `status.json`, `run_<hash>.json` (LRU cap 50, 10-min staleness).

## 4. New endpoints / params (NO `index.ts` route added)

- `POST /api/ava/apps/run?stream=1` — SSE streaming (status lines + answer deltas + `done{answer,pending_action}`).
- `POST /api/ava/apps/run { confirm_token }` — execute a confirmed pending send/delete.
- `POST /api/ava/apps/run { source }` — "screen"|"chat" telemetry tag.
- `GET  /api/ava/apps/status?fresh=1` — bypass the conn cache (post-OAuth).
- `GET  /api/ava/apps/status?warm=1` — prefetch/warm caches (rate-limited 1/min).

All ride existing registered routes — deliberately, to avoid contention on the concurrently-modified `index.ts`.

## 5. Expected wins (and the dashboard tile that proves each)

| Fix | Expected win | Proof tile (dashboard 788788) |
|---|---|---|
| KV decls/conn cache (P1) | −1–3 Composio hops/query; faster screen open | `avaapps_decls_cache`/`avaapps_conn_cache` hit-rate |
| Device cache (P2) | instant screen open + repeat reads | `avaapps_snapshot_render` (age/cache) |
| Context trim (P3) | −40–66% replayed tokens on multi-step | `avaapps_run_ok.chars_saved`, token spend trend |
| Cheap routing (P3) | lower $/simple-read | `route_reason` mix vs cost |
| Result cache (P3) | free repeat reads | `avaapps_result_cache` hit-rate |
| Idempotency (P4) | no double-sends | `avaapps_idem_dedupe` count |
| Confirm sends (P4) | no accidental sends | confirm funnel (shown→accepted) |
| Streaming (P5) | lower perceived latency | `run_stream_ok.ttfb_ms` p50/p95 |
| Quota (P5) | capped worst-case bill | `avaapps_quota_hit` |

## 6. Residual risks

- Streamed runs don't capture token usage (0) — token metrics come from non-streamed runs.
- Idempotency narrows but doesn't fully close the timeout-double-send window (Composio-accepted-then-we-timeout-before-store).
- Pagination page-arg names (`page_token`, `nextPageToken`) are unverified against live Composio → `AVAAPPS_PAGINATE` stays off until a device test.
- Quota counting is approximate (non-atomic KV increment) — a burst can slip a few over.
- Security items #11/#13/#1 are documented, not fixed (legacy shared code, out of scope) — see `Specs/AVAAPPS-SECURITY-NOTES-2026-07-02.md`.

## 7. Owner go-live checklist

1. **Review + push** the 18 `[AVAAPPS-FIX-*]` commits (a build runs on merge). Nothing was pushed by the agent.
2. **Secrets/vars (all optional — defaults are safe):** none required to ship. To change defaults later: `wrangler secret put AVAAPPS_CONFIRM_SENDS` → `on` (only AFTER the client with the confirm card is live), `AVAAPPS_PAGINATE` → `on` after verifying Composio page args, tune `AVAAPPS_RUNS_PER_HOUR`.
3. **Deploy order:** Worker first (server caches/telemetry/streaming), then the app build (client streaming, device cache, `?fresh`/`warm`, confirm card). Server is backward-compatible with the old app; the new app is backward-compatible with the old Worker (streaming falls back, `?fresh`/`warm` are ignored harmlessly).
4. **Watch for 48h (dashboard 788788):** build the deferred tiles once events ingest; watch error-rate by `stage`, cache hit-rates climbing, `chars_saved` > 0, `run_stream_fallback` low, `quota_hit` near-zero for legit users, `composio_retry` not spiking.
5. **Then, if desired:** flip `AVAAPPS_CONFIRM_SENDS=on` (safety), verify the confirm funnel; flip `AVAAPPS_PAGINATE=on` after a search-read device test.

---
*Per-phase detail: `Specs/reports/avaapps-fix/PHASE-{0..6}-REPORT.md`. Graphiti group `proj_avaflutterapp`. PostHog project 139917 (EU): dashboard 788788, annotations 95962/95969/95975/95977/95979/95985/95986.*
