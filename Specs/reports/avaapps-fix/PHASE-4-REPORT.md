# Phase 4 Report — Robustness & safety            Date: 2026-07-02

Fixes review items **#2** (pagination), **#3** (idempotent sends + confirm), **#4** (partial results), **#5** (fallback error), and documents **#1/#11/#13**.

## What I did (bullet per change, with file:line)

- **Idempotency for write tools (`composio.ts` `executeTool`):** for non-read slugs, `idemKey = avaapps:idem:<fnv1a(uid+tool+normalized args+10-min bucket)>`. Before executing → if the key exists, emit `avaapps_idem_dedupe` and return the stored result WITHOUT re-executing. After a successful write → store (TTL 24h). Converts a timeout-double-send into at-most-once per 10-min window for identical args. Flag `AVAAPPS_IDEMPOTENCY` (default on). Residual risk (Composio accepted but we timed out before storing) documented in a code comment and here.
- **Confirm-before-send (`composio.ts` loop + `ava_apps.ts` route + client):**
  - Loop: when the model calls an `isSendType` tool (`/SEND|DELETE|REMOVE|TRASH|CREATE_EVENT|QUICK_ADD/`) and `AVAAPPS_CONFIRM_SENDS` is on, it stores `{uid,tool,args}` in KV `avaapps:confirm:<token>` (TTL 5 min), sets `stats.pendingAction {tool, human_summary, args_digest, confirm_token}`, emits `avaapps_send_confirm_shown`, and RETURNS the human summary instead of executing.
  - Route: `avaAppsRun` returns `pending_action` to the client. A new **body param** `POST /api/ava/apps/run { confirm_token }` (no new endpoint, so `index.ts` untouched) looks up the token, verifies `uid`, executes exactly once (idempotency covers a double-tap), clears the token, emits `avaapps_send_confirm_accepted` (or `_expired` on a missing/foreign/expired token → HTTP 410).
  - Client: `apps_service.dart` captures `lastPendingAction` + `confirmSend(token)`; `avaapps_screen.dart` shows a confirm `AlertDialog` (`_confirmPending`) then calls `confirmSend`. Emits `avaapps_send_confirm_client`.
  - Flag `AVAAPPS_CONFIRM_SENDS` **default OFF** — see deviation below.
- **Bounded pagination (`composio.ts`):** `paginateRead` auto-fetches up to 2 more pages (3 total) for `PAGINATABLE` search reads (`GMAIL_FETCH_EMAILS`, `GOOGLECALENDAR_EVENTS_LIST`, `GOOGLEDRIVE_FIND_FILE`) when the result carries a next-page token and the query `isSearchLike`, merging into the primary array capped at 30 items. Emits `avaapps_paginate {tool, pages}`. Flag `AVAAPPS_PAGINATE` **default OFF** (Composio page-arg names unverified without a live call — safe scaffold now, flip after a device test).
- **Partial results at step cap (`composio.ts`):** the bare "didn't finish" string is replaced with a digest of the last few tool-result summaries ("I got as far as N tool steps… Here's what I found so far: … Ask me to continue with a narrower request."). Emits `avaapps_step_cap_hit {steps, tools_called}`.
- **Stop swallowing the primary-model error (`composio.ts`):** the `catch` around the primary `orStep` now captures the error and emits `avaapps_model_fallback {primary_model, error}` BEFORE falling back.
- **Documentation-only (`Specs/AVAAPPS-SECURITY-NOTES-2026-07-02.md`):** #11 (plaintext access tokens in legacy `gmail.ts`/`drive.ts`/`gcal.ts`), #13 (two OAuth surfaces), #1 (Composio refresh race) — recommendations only, NO legacy-path code changes.

## Flags / env / secrets introduced (name, default, where read)

| Flag | Default | Read in | Notes |
|---|---|---|---|
| `AVAAPPS_IDEMPOTENCY` | on | `idempotencyOn` | additive safety; dedupes identical write in 10-min window |
| `AVAAPPS_CONFIRM_SENDS` | **off** | `confirmSendsOn` | requires client confirm card (shipped); flip on after verify |
| `AVAAPPS_PAGINATE` | **off** | `paginateOn` | flip on after confirming Composio page-arg names |

No new secrets, no new KV namespace, no `index.ts` change (confirm rides on the existing `/run` route via a body param).

## Telemetry added (event name → properties → where fired)

- `avaapps_idem_dedupe` → `{tool, email, phone}` → `executeTool` on a dedupe hit.
- `avaapps_send_confirm_shown` → `{tool}` → loop when a send is intercepted.
- `avaapps_send_confirm_accepted` → `{tool, ok}` → route confirm path.
- `avaapps_send_confirm_expired` → `{has_token}` → route confirm path (expired/foreign token).
- `avaapps_send_confirm_client` → `{accepted}` → client dialog.
- `avaapps_paginate` → `{tool, pages}` → loop after auto-paging.
- `avaapps_step_cap_hit` → `{steps, tools_called}` → loop at cap.
- `avaapps_model_fallback` → `{primary_model, error}` → loop before fallback.

## PostHog annotation ID

- **95979** (project 139917, EU).

## What I verified and HOW

- **Message pairing still valid with confirm:** the confirm return happens AFTER `messages.push(assistantToolMsg(...))` but the run ends there (return) — no orphaned tool_call is sent to the model, since the loop exits.
- **At-most-once:** traced `executeTool` — a second identical write in the same 10-min bucket hits the idem KV and returns the stored result without a Composio POST.
- **Confirm ownership:** the route rejects a token whose stored `uid` ≠ caller (`stored.uid !== ctx.uid`) with 410.
- **Reads never confirmed / writes never read-cached:** `isSendType` (confirm) and `READ_TOOL_SLUGS` (cache) are disjoint by construction (reads aren't send-type; sends aren't in the read whitelist).
- **Defaults preserve behavior:** with `AVAAPPS_CONFIRM_SENDS=off` and `AVAAPPS_PAGINATE=off` the loop behaves exactly as Phase 3; only idempotency (safe/additive), partial-results (better message), and fallback-logging (telemetry) are active by default.

## What I could NOT verify (needs CI build / device test / owner action)

- Composio's exact next-page token field + page arg name (`nextPageToken`/`next_page_token`, `page_token`) — hence `AVAAPPS_PAGINATE` defaults off until a live call confirms them.
- The end-to-end confirm UX (card → confirm → send) needs a device test with `AVAAPPS_CONFIRM_SENDS=on`.

## Deviations from the phase prompt (and why)

- **`AVAAPPS_CONFIRM_SENDS` defaults OFF, not ON.** The phase prompt said default ON for send/delete. The **master prompt wins on conflict** (rule 4: a behavior change must preserve current behavior unless flag-enabled and must never break the live app). Defaulting ON before the confirm-card client is deployed would make sends require a card the old app can't render → broken sends. The full client card IS implemented here, so the owner can set `AVAAPPS_CONFIRM_SENDS=on` the moment the app ships. Documented, deliberate, reversible.
- **`AVAAPPS_PAGINATE` defaults OFF** for the same safety reason (unverified Composio pagination params).

## Risks & rollback

- Idempotency: could block a legitimate identical resend within 10 min — rare; rollback `AVAAPPS_IDEMPOTENCY=off`.
- Confirm/pagination: default off; enabling is a single flag each, disabling likewise.

## Handoff notes for the next phase

- Phase 5's streaming `/run?stream=1` must ALSO surface `pending_action` (a send mid-stream should still stop for confirm) — reuse `stats.pendingAction`.
- The confirm-token KV convention (`avaapps:confirm:<token>`) and the `/run` body-param pattern (no new route) are the model for Phase 5's endpoints — keep new behavior on existing routes to avoid `index.ts` contention.
