# Phase 3 Report — LLM cost reduction (token diet)            Date: 2026-07-02

Fixes review item **#7** (full tool results replayed every step → quadratic tokens), plus cheaper routing (C2) and the server half of **#9** (result cache, C3).

## What I did (bullet per change, with file:line)

- **Context trimming (`composio.ts` `runAppsToolLoop`):** each pushed tool message is recorded in `toolRecs` with a precomputed ≤300-char `summary` (`summarizeToolResult`: `"[trimmed] <name> → N items; ids: a,b,c…; full result already consumed…"`). Before each step's LLM call (`step >= 2`), every rec with `rec.step <= step-2` has its `msg.content` replaced by the summary in place (`trimmed` guard prevents double-work). The **most recent step's results are never trimmed**; **no message is deleted** — only the content string shrinks — so the OpenAI `tool_call ↔ tool` pairing stays valid. Flag `AVAAPPS_CTX_TRIM` (default on). `chars_saved` accumulated into stats.
- **Model routing (`composio.ts`):** `isSimpleRead(query)` — heuristic, no extra LLM call: `< 120` chars, no `and`, matches a read verb (check/read/show/list/see/view/get/fetch/what's) AND a target noun (email/inbox/calendar/files/docs/drive/…). If simple → primary model = `simpleModel(env)` (`AVAAPPS_SIMPLE_MODEL`, default `OR_FALLBACK_MODEL` = gemini-2.5-flash); else the smart model. The existing catch-fallback to `OR_FALLBACK_MODEL` is unchanged in both routes. `stats.routed_model` / `route_reason` recorded.
- **Server-side result cache (`composio.ts` `executeTool`):** for slugs in `READ_TOOL_SLUGS` only, key `avaapps:res:<uid>:<tool>:<fnv1a(stableStringify(args))>`, TTL 90s (KV). Hit → return cached raw result (no Composio call); miss → execute, cache only on success. KV errors fall through to a live execute. Flag `AVAAPPS_RESULT_CACHE` (default on). `emit` threaded from the loop so `avaapps_result_cache` carries email.
- **Token deltas:** `avaapps_run_ok` now also carries `routed_model`, `route_reason`, `ctx_trim`, `chars_saved` (`worker/src/routes/ava_apps.ts`). Real token numbers come from PostHog post-deploy (Phase 0 already captures `prompt_tokens`/`completion_tokens`) — not fabricated here.

## The read-only whitelist (reproduced in full — contains ZERO write tools)

```
GMAIL_FETCH_EMAILS, GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID, GMAIL_GET_CONTACTS,
GOOGLEDRIVE_FIND_FILE,
GOOGLECALENDAR_EVENTS_LIST, GOOGLECALENDAR_FIND_EVENT,
GOOGLECALENDAR_FIND_FREE_SLOTS, GOOGLECALENDAR_GET_CURRENT_DATE_TIME,
GOOGLEDOCS_GET_DOCUMENT_BY_ID,
GOOGLESHEETS_GET_SPREADSHEET_INFO
```

Cross-checked against `CURATED`: every send/create/update/draft/reply/batch tool
(`GMAIL_SEND_EMAIL`, `GMAIL_CREATE_EMAIL_DRAFT`, `GMAIL_REPLY_TO_THREAD`,
`GOOGLEDOCS_CREATE_*`/`UPDATE_*`, `GOOGLESHEETS_CREATE_*`/`BATCH_UPDATE`,
`GOOGLEDRIVE_CREATE_*`, `GOOGLECALENDAR_CREATE_EVENT`/`QUICK_ADD`) is **absent** —
so a mutating action can never be served from cache.

## Worked example — message array size before vs after trimming (computed from the code)

A 4-step run where each of steps 0–2 makes one tool call returning a result at the
`RESULT_CHARS` cap (≈ 8000 chars serialized); step 3 produces the final answer. Summary ≈ 120 chars.

| At step | Tool contents replayed (no trim) | Tool contents replayed (trim ON) | Saved |
|---|---|---|---|
| step 2 LLM call | step0+step1 = 16000 | step0→120, step1=8000 → **8120** | 7880 |
| step 3 LLM call | step0+step1+step2 = 24000 | step0→120, step1→120, step2=8000 → **8240** | 15760 |

So the final planning step replays ≈ **8.2 KB instead of 24 KB** of tool content — a ~66% cut on the replayed-result tokens, growing with step count (the quadratic term is defused). `chars_saved` for this run ≈ 15760.

## Flags / env / secrets introduced (name, default, where read)

| Flag | Default | Read in | Off behavior |
|---|---|---|---|
| `AVAAPPS_CTX_TRIM` | on | `ctxTrimOn(env)` | no trimming (today's full replay) |
| `AVAAPPS_SIMPLE_MODEL` | `OR_FALLBACK_MODEL` | `simpleModel(env)` | overrides the cheap model target |
| `AVAAPPS_RESULT_CACHE` | on | `resultCacheOn(env)` | no result caching, live execute (telemetry `bypass`) |

All independently disable-able. No new secrets. Reuses `TOKENS` KV.

## Telemetry added (event name → properties → where fired)

- `avaapps_result_cache` → `{tool, cache: hit|miss|bypass, email, phone}` → `executeTool` (via `emit`).
- `avaapps_run_ok` extended: `+ routed_model, route_reason, ctx_trim, chars_saved`.

## PostHog annotation ID

- **95977** (project 139917, EU).

## What I verified and HOW

- **Message-pairing validity:** hand-traced the loop. Trimming only mutates `rec.msg.content` (a string); the `{role:"tool", tool_call_id}` object and its matching `assistant.tool_calls[id]` remain — so every tool_call still has exactly one tool message. No `messages.splice`/delete anywhere in the trim path.
- **"Never trim the most recent":** the guard `rec.step <= step-2` leaves step `step-1` (the results the current call consumes) untouched; first trim only fires at `step >= 2`.
- **Whitelist safety:** grepped `READ_TOOL_SLUGS` against `CURATED` — no overlap with any write verb (list reproduced above).
- **Cache correctness:** result cached pre-`trimToolResult` (raw), same as a live call, so hits and misses feed the model identical shapes; only successful reads are stored.
- **Flags:** each helper (`ctxTrimOn`/`resultCacheOn`/`simpleModel`) defaults to today's behavior when unset and flips cleanly to off.

## What I could NOT verify (needs CI build / device test / owner action)

- No local TS build (repo rule). Real token-savings % and cache hit-rate come from PostHog after deploy (`avaapps_run_ok.prompt_tokens` pre/post, `chars_saved`, `avaapps_result_cache`).
- Routing accuracy (does `isSimpleRead` mis-route compound asks?) needs live `route_reason` distribution review.

## Deviations from the phase prompt (and why)

- None. All three sub-features implemented with the exact flags named in the prompt.

## Risks & rollback

- Trim risk: a summary that drops an id the model later needs. Mitigated — most recent results never trimmed, and the summary keeps a count + first ids. Rollback: `AVAAPPS_CTX_TRIM=off`.
- Routing risk: cheap model underperforms on a mis-classified request → the request still runs (error-fallback intact); rollback: set `AVAAPPS_SIMPLE_MODEL` to the smart model, or the classifier is conservative (`and` and length gates).
- Result-cache risk: a 90s-stale read. Acceptable for inbox/agenda; rollback `AVAAPPS_RESULT_CACHE=off`.

## Handoff notes for the next phase

- Phase 4's idempotency + confirm logic lives in `executeTool` / the loop too — it must run BEFORE the result-cache path for reads is irrelevant (reads aren't confirmed) but write dedupe must not read the read-cache. Keep the `READ_TOOL_SLUGS` vs write split as the single source of truth.
