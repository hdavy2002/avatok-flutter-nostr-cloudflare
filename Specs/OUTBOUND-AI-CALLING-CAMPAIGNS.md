# Outbound AI Calling Campaigns — Consolidated Build Plan (Final)

**Status:** APPROVED FOR BUILD — GO for limited production rollout.
**Reviewed:** engineer-to-engineer design sessions, 2026-07-20. 129 requirements agreed + 8 cross-feature seams closed (§19).
**Scope:** production feature. All work lands on `staging` first and is promoted to `main`/prod per the repo's staging↔prod rules. Builds are manual (`workflow_dispatch`) only.
**This document is the single source of truth.** It supersedes the earlier v2/v3/v4 layered drafts — everything is folded into one linear plan below.

---

## 1. Overview

### 1.1 Goal
Let a small-business user run an **outbound AI calling campaign**: upload a contact list (Excel/CSV or Google Sheet link), describe in plain language what the AI agent should achieve, attach knowledge files and (optionally) their Google Calendar, pick or buy a dedicated phone number, and launch. The system calls each contact via Vobiz, holds a live AI voice conversation (with knowledge grounding, tool calling, appointment booking, and warm handover to a human), records + transcribes each call, and posts every outcome into the user's Inbox as one campaign thread. Rich per-campaign and account-level analytics are available in a new Analytics area.

### 1.2 Scope (v1)
India-only (IST, Vobiz India DIDs). Excel/CSV upload + Google Sheet link import. Gemini File Search KB. Google Calendar booking via Composio. Warm human handover. PostHog-backed analytics. Token-wallet billing.

### 1.3 Non-goals (v1)
CRM connectors beyond Calendar; multi-country/timezone campaigns; retention cohort analysis of callees; full Google OAuth Sheets sync (link-import only); SMS/WhatsApp follow-up; presence-based owner availability.

### 1.4 Supported providers
Vobiz (Plivo-lineage) is the only telephony provider in v1, behind a `TelephonyProvider` interface so Twilio/Plivo can be added later without touching campaign logic. Gemini 3.1 Flash Live is the voice model (reusing the inbound receptionist bridge). PostHog (EU cloud) is the analytics compute layer. Composio is the connector layer for Google Calendar.

### 1.5 Design principles
- **D1 is the authoritative store; Durable Objects are executors that reconstruct from D1.** Cloudflare alarms are at-least-once, so nothing is driven from DO memory alone.
- **Money lives only in WalletDO.** Rooms report usage; they never hold billing state.
- **Every side-effecting call is idempotent, keyed on `attempt_uuid`.**
- **Reuse the existing inbound stack** (Vobiz webhook surface, `VobizAgentRoom` Gemini bridge, `InboxDO`, `WalletDO`, telephony subscription pattern) rather than building a parallel system.
- **PostHog computes analytics; it never holds truth about money or progress and never appears as UI.**

---

## 2. Core architecture & ownership boundaries

```
Flutter app ── HTTPS ──► Cloudflare Worker ──► D1 (authoritative state)
                              │                └► R2 (recordings, KB originals)
                              │                └► KV (caches, gauges)
                              ├► WalletDO          (money: reserve/consume/release)
                              ├► CampaignDO        (per-campaign scheduler/executor)
                              ├► DialerGateDO      (per-user channel pool + rate limit)
                              ├► VobizAgentRoom     (Gemini Live bridge + ToolRuntime)
                              └► InboxDO           (per-user threads)
       Vobiz  ◄── REST (outbound calls, DID provisioning) / webhooks ──►  Worker
       PostHog ◄── Query API (analytics compute, key held only in Worker) ──► Worker
       Composio ◄── executeTool (Google Calendar, per-owner scoped) ──► VobizAgentRoom
```

**Ownership boundaries (the whole system in one table):**

| Concern | Owner | Notes |
|---|---|---|
| Authoritative state (campaigns, contacts, attempts, DIDs, suppression) | **D1** | DOs reconstruct from here on wake |
| Money (balance, reservations, spend) | **WalletDO** | `reserve` / `consumeReserved` / `release`; op-id dedupe |
| Campaign orchestration / dial loop | **CampaignDO** (1/campaign) | scheduler only; owns no money, no channel truth |
| Channel pool + rate limiting + fairness | **DialerGateDO** (1/user) | `requestDialPermit → PERMIT | RETRY_AFTER(ms)` |
| Live conversation + tool execution | **VobizAgentRoom** (1/call) | disposable; `CallFSM` owns state, not the room |
| Call + handover state truth | **CallFSM** (per attempt, persisted to D1) | room death never strands telephony state |
| Inbox threads | **InboxDO** (1/user) | idempotent append on `client_id` |
| Analytics computation | **PostHog** | via Worker Query API only; never UI, never money |
| Tenancy / security / query generation | **Worker** | injects ownership constraints; holds all secrets |
| Presentation | **Flutter** | native charts; never sees HogQL or API keys |

**Recovery philosophy:** any DO can be evicted/redeployed at any time. On wake it rebuilds from D1 and resumes. A crashed `VobizAgentRoom` never aborts telephony — provider webhooks continue advancing the `CallFSM` via the Worker.

**Idempotency philosophy:** `attempt_uuid` is minted and persisted **before** the outbound Vobiz POST. On an uncertain POST (timeout) the Worker queries provider call state before any retry. Wallet ops, Inbox appends, and calendar `CREATE_EVENT` are all idempotent on `attempt_uuid`.

---

## 3. Data model (D1, `metaDb` shard)

```sql
user_dids(
  id, uid, e164, provider,                 -- 'vobiz' now
  purpose,                                  -- receptionist | campaign | shared
  monthly_tokens INTEGER DEFAULT 700,
  status,                                   -- active | past_due | released
  purchased_at, next_renewal_at, provider_meta JSON);

campaigns(
  id, uid, name, goal_text,
  prompt_version, compiled_prompt TEXT, compiled_prompt_hash TEXT,   -- frozen at launch
  tool_runtime_version, fsm_version, kb_version, analytics_schema_version,
  kb_store, business_kb_attached,
  did_e164, language_hint, voice_persona,
  status,   -- draft|ready|running|pausing|paused|cancelling|window_wait|completed|cancelled|out_of_tokens
  concurrency INTEGER DEFAULT 1,
  window_start_min INTEGER DEFAULT 600,     -- 10:00 IST
  window_end_min   INTEGER DEFAULT 1140,    -- 19:00 IST
  retry_policy JSON,                        -- per-cause (see §6.4)
  spend_cap_tokens INTEGER NOT NULL,        -- mandatory; default = estimate*1.5
  booking_enabled, handover_enabled, handover_number, handover_window,
  max_handovers_per_day, record_handover DEFAULT 0,
  -- counters (columns, not JSON):
  n_total, n_done, n_answered, n_missed, n_busy, n_machine, n_failed, n_dnc,
  tokens_spent, seconds_talked,
  created_by, created_at, contacts_hash, started_at, completed_at);

campaign_contacts(
  id, campaign_id, name, e164_raw, e164, extra JSON, source_row INTEGER,
  status,   -- pending|dial_reserved|calling|done|missed|busy|voicemail|invalid|dnd_blocked|failed
  attempts INTEGER DEFAULT 0, last_outcome, last_called_at, next_attempt_at);

campaign_call_attempts(
  attempt_uuid PRIMARY KEY, campaign_id, contact_id, call_uuid,
  purpose DEFAULT 'LIVE',                   -- LIVE | TEST
  -- frozen version snapshot (all five on this one row, §19 seam 4):
  prompt_version, tool_runtime_version, fsm_version, kb_version, analytics_schema_version,
  kb_store_name, kb_files_meta JSON,        -- so replay survives KB GC (§19 seam 3)
  created_at, ring_at, answered_at, ended_at,
  outcome,                                  -- answered|no_answer|busy|machine|failed|canceled
  hangup_cause_raw,                         -- provider cause VERBATIM
  amd_result, amd_confidence,
  ai_duration_s, pstn_total_duration_s,     -- distinct durations (§19 seam 2)
  human_segment_seconds,
  tokens_reserved, tokens_spent,
  recording_key, recording_status,          -- pending_upload | stored | expired
  human_recording_key,
  transcript_lang, transcript JSON, summary_text,
  tools_used JSON,                          -- [{tool, success, elapsed_ms, result_summary}]
  booking_event_id,
  handover_status);                         -- none|attempted|connected|failed|failed_machine|caller_abandoned

fsm_transitions(attempt_uuid, from, to, ts, trigger, correlation_id);  -- audit rows, not JSON list

campaign_kb_files(campaign_id, r2_key, name, bytes, sha256, indexed_at, status);

dnc_suppression(uid, e164, reason, source_campaign_id, created_at,
  PRIMARY KEY(uid, e164));                  -- ACCOUNT-level, permanent
```

**R2 layout:** `campaign/<uid>/<campaignId>/kb/<fid>/<name>` (KB originals), `campaign/<uid>/<campaignId>/<attempt_uuid>.wav` (AI recording), `.../handover/<attempt_uuid>.wav` (opt-in human segment). **KV:** analytics response cache (`campaign_id+metric+range`, 30–60s), concurrency gauges, receptionist-settings cache pattern reused. **Retention:** AI recording WAV in R2 90 days then GC; transcript kept indefinitely in D1; KB store soft-deleted 30 days after campaign deletion then hard-GC'd.

---

## 4. Call state machine (CallFSM)

The `CallFSM` (persisted to D1, `fsm_version`ed) owns each attempt's truth. Every transition writes an `fsm_transitions` audit row `(from, to, ts, trigger=webhook|tool|user|system, correlation_id)`. The `VobizAgentRoom` is disposable; provider webhooks drive the FSM through the Worker even if the room is gone.

- **Attempt lifecycle:** `dial_reserved → calling → (answered | no_answer | busy | machine | failed) → settled`.
- **Handover sub-machine:** `HandoverRequested → DialHuman → HumanAnswered → BridgeRequested → BridgeConfirmed → AILeaving → Completed`. One webhook = one transition. The AI leg never leaves before **BridgeConfirmed** (= caller-leg conference member-join event; a Transfer-API 200 is only `BridgeRequested`).
- **Allowed transitions** are explicit; unknown/duplicate webhooks are ignored if no longer valid.
- **Timeout rules:** ring 30s; handover human-leg ring 25s; `BridgeRequested` join-event timeout → `handover_failed`; conference TTL 60s + destroy-on-single-participant; AI hard cap 10 min (`time_limit=615s` provider backstop), wrap cue at 8 min.

Full failure matrix (H1–H9) is in §16.

---

## 5. Billing & wallet

- **Rates:** AI talk time **6 tokens/min** (0.1/s); bridged human-to-human segment **2 tokens/min** (0.033/s). DID **700 tokens/month**. Extra simultaneous channels reuse the ₹700/mo telephony add-on record.
- **Escrow model (one billing engine for inbound + outbound):** `WalletDO.reserve()` → `consumeReserved()` (moves reserved→spent atomically, per-second) → `release()` refunds the remainder at hangup. All ops idempotent on `attempt_uuid:reserve|settle`. Rooms report elapsed seconds; **WalletDO owns the reserved→spent movement.**
- **Reservation sizing:** 60 tokens (10 min AI) reserved at dial. Admission requires `balance ≥ outstanding_reservations + 60`. On handover, a **rolling** top-up of 20 tokens per 10 min at the 2/min tariff; no hard cap on the human segment; top-up failure → polite warning/disconnect at credit exhaustion.
- **Tariff switch, no blending:** at AI disconnect (BridgeConfirmed) WalletDO switches 6/min → 2/min. Vobiz carrier cost (~₹0.65/min per leg) continues on both legs regardless — that is our cost, separate from the user's token meter.
- **Billable start** = provider answer timestamp (not Gemini session start). Ringing/AMD is free to the user.
- **Spend cap** is mandatory per campaign (default estimate×1.5), enforced at admission. **Pre-flight:** launch requires runway ≥ max(60, 6×min(contacts,10)) + first reservation.
- **DID renewal** is lazy (checked on tick/status read, like `telephony_tiers.maybeRenew()`), 3-day grace → `past_due` pauses campaigns on that DID. Backfill receptionist-purchased numbers into `user_dids` so both features share one store; reusing an existing DID is free.

**Per-call deduction transparency (user requirement).** Every settled call writes **one visible wallet deduction** `campaign_call:<attempt_uuid>` with a `detail` JSON payload: AI segment (`ai_seconds @ 6/min`), handover segment (`handover_seconds @ 2/min`), `tokens_reserved/charged/refunded`, an escrow trail (`reserve→topup→consume→release`), contact + campaign names, and links (`conv`, `inbox_msg`). Wallet history renders "AI call · Rajesh (+91…) · Diwali offers · −45 tokens"; tapping opens an itemized sheet with an expandable escrow trail and deep-links to the Inbox card (recording/transcript) and campaign dashboard — bidirectional. DID renewals are their own "−700 · monthly" entry. **Zero-token calls (no-answer/busy) write no visible deduction.** The visible entry is written in the same idempotent settlement step as `consumeReserved/release`, so history can never disagree with the ledger. **`tokens_charged` in analytics is only emitted once settlement is final** — intermediate reservation consumption stays inside WalletDO, never in analytics events (§19 seam 7).

---

## 6. Campaign engine (scheduling, ingestion, DID provisioning)

### 6.1 DID provisioning
`TelephonyProvider.searchNumbers` → Vobiz `GET …/inventory/numbers`; `purchaseNumber` → `POST …/numbers/purchase-from-inventory`; `releaseNumber` → `DELETE …/numbers/{e164}`. Caller ID must be a Vobiz India number the account owns; media anchored in India. Purchase flow shared with the AI-receptionist number component; server validates the DID belongs to the owner before any use.

### 6.2 Contact ingestion
Raw file uploaded to the Worker (`POST /api/campaign/:id/contacts/upload`), parsed **server-side** with SheetJS — one path for xlsx/csv/Google-Sheet CSV export. Google Sheets v1: paste a share link, Worker fetches `export?format=csv` (403/HTML → prompt to enable link sharing); full OAuth import is a fast-follow. Hardening: 5 MB / `campaignMaxContacts` (2000) caps; UTF-8 BOM strip; formula-prefix strip (`= + - @`); NFKC digit normalization (Devanagari/Arabic-Indic numerals); 2 KB per-cell cap; E.164 normalize (default IN); **dedupe after normalization** (+91 98…, 098…, 98… collapse); preserve `source_row`; reject ambiguous multi-phone rows unless mapped; `contacts_hash` stored for audit; invalid rows surfaced pre-launch. Large lists chunk through the existing `contacts-chunk` queue pattern.

### 6.3 Dial loop
**DialerGateDO** (per user) owns the channel pool + token bucket (per-DID CPS=1, per-account CPS from tier) + round-robin fairness across a user's running campaigns, exposing `requestDialPermit(campaignId) → PERMIT | RETRY_AFTER(ms)`. **CampaignDO** ticks (alarm; dial immediately while permitted, sleep only when blocked):
1. Admission: `running`? inside 10:00–19:00 IST (server-enforced)? spend cap not hit? DID active? → request a permit.
2. Acquire a contact via conditional `UPDATE … SET status='dial_reserved' WHERE status='pending'` (0 rows = taken by another tick). Insert the `campaign_call_attempts` row (persist `attempt_uuid` **before** the network call). `WalletDO.reserve(60, attempt_uuid:reserve)`.
3. `provider.makeCall(from=DID, to, answer_url, ring_url, hangup_url, machine_detection=true, machine_detection_url, ring_timeout=30, time_limit=615)`. On timeout → `getCallState(call_uuid)` before any retry.
4. On answer, `answer_url` returns the bidirectional `<Stream>` XML into `VobizAgentRoom` (campaign mode). See §8.
5. On end → settle wallet, write attempt + Inbox message (idempotent), update counters, request next permit.

**Shared-DID reservation:** when a `purpose=shared` DID has the receptionist enabled, one channel is permanently reserved for inbound; `effective_outbound_capacity = total_channels − reserved_inbound − current_inbound_calls`. Inbound always wins.

### 6.4 Retry taxonomy (per raw provider cause, stored verbatim)
`USER_BUSY`, `NO_ANSWER`, recoverable network/5xx/congestion → retry (backoff 180 min, max 2 attempts). `CALL_REJECTED` → no retry. `UNALLOCATED`/invalid → never (mark invalid). DND/suppressed → never. `machine` → configurable (silent hangup default, or 20s scripted voicemail). Our own 429 → retry via token bucket, not counted as an attempt.

### 6.5 Circuit breaker
20 consecutive failures OR ≥50% provider 5xx over 5 min OR provider outage → auto-pause campaign + notify owner (`circuit_breaker_tripped`).

### 6.6 Pause / cancel / window
Transitional `pausing`/`cancelling` states (no new dials). Cancel gives an in-flight call a 30s wrap cue then forced hangup. At 19:00 IST → `window_wait`, alarm at next 10:00 (in-flight call finishes, latest ≈19:10). Wallet empty → `out_of_tokens`, push, resumable. **Completion** = `pending==0 && calling==0 && no retries due`.

---

## 7. Telephony pipeline

- **Outbound call flow:** Vobiz `POST /api/v1/Account/{auth_id}/Call/` (200 = queued, not answered). Real state arrives on `ring_url`/`answer_url`/`hangup_url` webhooks (secret-in-path auth, HMAC where available). One authority for ring timeout: `ring_timeout` (do not also set `hangup_on_ring`).
- **Provider webhooks** advance the `CallFSM`. Duplicate deliveries are idempotent (one webhook = one valid transition).
- **AMD is advisory only.** Agent speaks immediately (dead air = robocall UX). Three signals — carrier AMD, Gemini transcript, audio features — feed a state machine `UNKNOWN → LIKELY_HUMAN/LIKELY_MACHINE → CONFIRMED_MACHINE`; never jump `UNKNOWN → HANGUP`. Gemini self-classifies voicemail in-prompt; a late carrier AMD verdict is injected as a *hint* the model may ignore. Conversation mode unlocks only after positive human evidence (callee speaks).
- **Voicemail lane** (reused): Whisper `large-v3-turbo` transcription for machine-answered calls if a scripted message is left.
- **Handover** (warm transfer via conference): agent keeps caller engaged → outbound leg from the campaign DID to `handover_number` (**AMD enabled on this leg too**, so the owner's own voicemail never receives the caller) → context whisper `<Speak>` (contact, campaign, reason, 1-line summary) then `<Conference>hx_<attempt_uuid></Conference>` → on human answer, Transfer-API the caller's aleg into the same conference → caller-leg join event = `BridgeConfirmed` → AI leaves. Window/DNC checks do **not** apply to the handover leg (it's the owner's own number). Wrap timers disabled once handover starts. See §16 for failures.
- **Recording & teardown:** both AI legs recorded to R2. Human-to-human segment **not recorded by default** (privacy); `record_handover=true` plays a second disclosure and stores a **separate** asset. On R2 upload failure, mark `recording_status=pending_upload` and retry — never lose the transcript.

---

## 8. AI conversation runtime

- **Prompt** compiled server-side, frozen with `compiled_prompt_hash` + `prompt_version` at launch. Includes an **immutable identity+purpose disclosure preamble** users cannot edit or remove.
- **KB attachment:** campaign mode declares Gemini `fileSearch` with the campaign store (`kb_store`), optionally plus the business KB store; prompt rule "prefer campaign knowledge on conflict". Gemini grounds server-side — no tool round-trip.
- **ToolRuntime** (net-new in the Gemini room; `tool_runtime_version`ed): generic mid-call tool loop — declare `functionDeclarations` per campaign; on `msg.toolCall` run the handler and reply via `sendGem({toolResponse:{functionResponses:[…]}})`. Rules: **single in-flight tool**, FIFO queue for extras; structured responses `{success, error_code, elapsed_ms, …}`; 8s timeout; **3-failure circuit breaker** → tools disabled for the rest of the call; **tool budget 6 total / 2 availability / 2 booking** per call, then the agent gracefully offers a callback; tool availability **frozen at session creation**; prompt pattern **speak filler before issuing the tool call** ("one moment while I check the calendar…"). Every tool call + result is persisted to `tools_used` and rendered in the transcript as a **system event** ("System: Appointment booked for Tue 3 PM"), not free text (§19 seam 6).
- **Wrap timers** (8-min cue, 10-min cap) are disabled once a handover begins.
- **Human engagement detection:** engaged = `ai_duration_s > X` OR ≥2 human turns; used for the analytics "human engagement rate" (a "Hello?"+hangup is not engagement).
- **Gemini failure fallbacks:** if Gemini is unavailable, play a polite line and hang up rather than sit silent. On a mid-call Gemini reconnect while a tool is in flight, **do not replay** the tool result into the new session — complete + log it, mark `undelivered`, and give the new session a system note; the agent re-calls if still needed.

---

## 9. Knowledge base

- **Campaign KB:** wizard uploader (pdf/doc/docx/txt/md, ≤25 MB each, ≤`campaignKbMaxFiles`=10). Reuses the receptionist Gemini File Search pipeline with a **per-campaign store** `campaign-<uid>-<campaignId>`; originals in R2; store name + `kb_version` frozen into the campaign row at launch.
- **Business KB:** optional "also use my business KB" checkbox attaches the existing receptionist store as a second `fileSearchStoreName` (campaign-first precedence prompt rule).
- **Store lifecycle:** campaign deletion = **soft delete, store retained 30 days**, then GC hard-deletes. `kb_store_name`, `kb_files_meta` (hashes/names), and `kb_version` are captured **on the attempt row** so a call is reproducible; after KB GC, replay is transcript/audio only — do not attempt to reconstruct grounding (§19 seam 3).

---

## 10. Connectors & tools (Google Calendar)

- **Gating:** the wizard's "Appointment booking" toggle appears only when the user's Composio `googlecalendar` connected_account is ACTIVE (else a "Connect Google Calendar" deep-link to the AvaApps hub). All calendar ops go through the existing `executeTool(env, ownerUid, slug, args)` — per-owner scoped, no new auth surface.
- **Tools:** `check_availability(date_range)` → `GOOGLECALENDAR_FIND_FREE_SLOTS`; `book_appointment(name, phone, start, duration, notes)` → `GOOGLECALENDAR_CREATE_EVENT` (attendee = contact, description carries campaign + transcript link, **explicit `timeZone`**, IST assumptions fine for India-only v1).
- **Idempotency:** `CREATE_EVENT` carries `attempt_uuid` in a private extended property; on a slot-taken conflict the tool returns `{success:false, error_code:'slot_taken', alternatives:[next 2]}` and the agent offers alternatives — **never silently books a different slot**. Composio 401 mid-call → one refresh + one retry, then `authorization_failed` and the calendar tool circuit-breaks.
- **Handover is a system tool that does NOT consume the 6-call ToolRuntime budget** — it has its own limit of **1 per call** (§19 seam 1), so a call can still book *and* hand over.

---

## 11. Inbox & user experience

- **One thread per campaign:** `conv = campaign_<uid>__<campaignId>`, `sender = "ava_campaign"`, idempotent on `attempt_uuid`.
- **Answered calls → individual cards** (`campaign_call`): name, number, duration, 1-line Gemini summary, expandable transcript, recording player, language tag, booking/handover badges ("Booked: Tue 3 pm", "Handed over at 3:42 — AI recording ends here"). Mirrors `VoicemailCard`.
- **Misses → periodic digest card** (`campaign_missed_digest`): "Today's unreachable (17): Rajesh, Anita, Vivek… tap to retry / open dashboard" — the owner's requirement to clearly see who didn't pick up, without hundreds of messages.
- **Status messages** (`campaign_status`): launched / paused / window-wait / circuit-breaker / completed with stats.
- **Recording behavior:** expired recordings render "Recording expired. Transcript retained." **Test calls** carry a visible "Test Call" prefix and `purpose=TEST` everywhere.
- **Campaign dashboard** (screen): live progress, per-contact filterable list, heartbeat-driven "blocked: reason" banner, pause/resume/cancel, spend meter vs cap (D1-sourced), open-thread + open-analytics shortcuts, "test call to my number" (real pipeline, `purpose=TEST`, bypasses window/DNC, capped 3/day).

Wizard screens: **Goal** (name, brief, structured fields, language, persona, **KB uploader**, disclosure preview) → **Contacts** (upload/sheet link, column mapping, validation) → **Number** (reuse existing DID / buy new 700/mo) → **Schedule & channels** (fixed window, start now/later, concurrency + add-ons, retry policy, mandatory spend cap) → **Booking & handover** (Calendar toggle if connected; handover number + window if enabled) → **Review & launch** (cost estimate, runway check, test-call). New top-level **Analytics** menu = account rollup (§12).

---

## 12. Analytics

**PostHog is the compute layer only** — never embedded UI, never a source of money or progress. Layering: **D1/WalletDO = transactional truth · PostHog = analytical computation · Worker = tenancy/security/query-generation · Flutter = presentation.**

### 12.1 Event taxonomy
Campaign is modeled as a **PostHog Group** (`campaign`) in addition to a `campaign_id` event property. **Person = the owner only; never create a Person for a callee.** Every event carries `owner_uid`, `campaign_id`, `attempt_uuid`, `analytics_schema_version`.

Events: `campaign_launched`, `dial_requested`, `dial_permitted`, `dial_denied{reason}`, `call_started`, `call_answered`, **`call_completed{call_outcome, conversation_type, ai_duration_s, pstn_total_duration_s, tokens_charged, hangup_cause_raw, retry_attempt}`** (the single canonical terminal event — do not split into per-outcome events), `tool_invoked{tool, success, elapsed_ms}`, `booking_made`, `handover_requested`, `handover_connected`, `handover_failed{reason}`, `optout_captured`, `dnc_blocked`, `circuit_breaker_tripped`. Canonical breakdown dimensions: `call_outcome` (answered|busy|no_answer|machine|failed|handover|booked), `conversation_type` (human|voicemail|handover).

**`call_completed` fires exactly once, after full PSTN completion** — not at AI teardown — carrying both `ai_duration_s` and `pstn_total_duration_s` (§19 seams 2 & 5). For handover calls, `handover_connected` fires at bridge, then the single `call_completed` fires when the whole PSTN call ends. `tokens_charged` is only present once settlement is final (§19 seam 7). Every analytics query **excludes `purpose=TEST` by default** (§19 seam 8).

### 12.2 PostHog access architecture
Worker RPC `GET /api/campaigns/:id/analytics?metric=funnel&period=30d`: the Worker authenticates the session → resolves `owner_uid` server-side → verifies the `campaign_id` belongs to that owner in D1 → builds the **entire** PostHog Query API payload (TrendsQuery/FunnelsQuery, HogQL where needed) with an injected `owner_uid = <session uid> AND campaign_id IN (<owned ids>)` constraint → returns compact metric JSON. Flutter renders native `fl_chart`; it never sees HogQL or the personal API key and cannot influence filters (fixed metric catalog). KV cache 30–60s keyed `campaign_id+metric+time_range`. An "Open Advanced Analytics" embedded-dashboard deep-link is offered to support/power users only.

### 12.3 Per-campaign metrics (shipped)
Conversion **funnel** (Queued → Dial permitted → Answered → Engaged ≥X s → Booked/Handed-over — FunnelsQuery); outcome breakdown (TrendsQuery by `call_outcome`); hour-of-day performance across the 10–7 window; cost (tokens/day, ₹ estimate, **cost-per-answer**, **cost-per-booking**); retry effectiveness (by `retry_attempt`); tool performance (per tool: count, success %, latency); handover analytics (requested/connected/failed + reason); machine/voicemail rate; **human engagement rate** (duration>X or ≥2 human turns); **time-to-answer** (dial_permitted→answered, carrier-quality signal). RetentionQuery intentionally skipped in v1.

### 12.4 Account Analytics menu
Spend over time; cross-campaign funnel; **campaign leaderboard** (grouped by campaign — answer/booking rate, ROI proxy); dial volume; outcome distribution. **DID utilization is computed in our backend** from channels/minutes/capacity, not PostHog.

### 12.5 Dashboard cards & freshness
Analytics cards are labeled **"Analytics (may lag a few minutes)."** Money/progress numbers always come from D1; PostHog powers only trends/graphs. If PostHog is delayed/unavailable, the D1 dashboard renders immediately and analytics cards degrade to "Analytics temporarily unavailable." Monitor **analytics reconciliation lag** (median + P95 from D1 event creation to PostHog visibility) as its own metric.

---

## 13. Security & multi-tenancy

- **Ownership checks:** the Worker verifies `campaign_id` ownership in D1 before every analytics query and every campaign mutation; the client never supplies a trusted `owner_uid`.
- **Analytics isolation:** shared PostHog project, one personal API key held only in the Worker; per-request server-side tenant-constraint injection (§12.2). The client never sends HogQL or arbitrary filters. **No per-owner PostHog projects** — overkill for a shared-project B2B app.
- **Connector scoping:** Composio `connected_accounts` are per-owner (`user_id = ownerUid`); calendar ops always run under the owner's identity.
- **DID ownership:** caller ID is server-validated as an owner-owned DID; arbitrary caller ID is impossible.
- **Prompt safety:** the disclosure preamble is compiled server-side and cannot be removed by user prompt text.
- **Per-account scoping** (house rule): all new per-user local state on device is namespaced via `scopedKey`/`AccountScope.id`.

---

## 14. Compliance & privacy (India)

- **Disclosure:** every call opens with an immutable identity+purpose line.
- **DNC:** account-level permanent `dnc_suppression` (not per-campaign); auto-add on opt-out phrases (agent confirms then `end_call`), on Vobiz NDNC complaint webhook, and manually; checked at admission. Fast-follow: DND-registry pre-scrub.
- **Recording:** AI segment recorded with disclosure; human-to-human segment off by default (separate asset + second disclosure when opted in).
- **Calling window:** 10:00–19:00 IST, server-enforced (stricter than TRAI's 10–21). Window/DNC never gate the handover leg (owner's own number).
- **Data retention:** AI WAV 90 days in R2 then GC; transcript kept in D1; KB store soft-delete 30 days; audit rows (creator, timestamp, frozen prompt+hash, contacts_hash) retained for complaint handling.

---

## 15. Observability & operations

- **Events:** the §12.1 taxonomy, every event tagged `attempt_uuid + campaign_id + owner_uid`, so support can pull a call's full timeline by any key.
- **Heartbeats:** every active CampaignDO emits every 60–120s while not progressing — `status, blocked_reason (wallet|window|channels|cps|no_contacts|provider|paused), pending, calling, available_channels, next_alarm_at` — the one-event answer to "why didn't my campaign call anyone in the last hour."
- **Error tracking:** ON for both Flutter and Worker via SDK/manual integration (not the wizard on the Worker side).
- **Reconciliation dashboard (primary tripwire):** compares authoritative counts across every subsystem — attempts created → provider calls placed → provider answers → AI rooms started/ended → transfers requested/confirmed → wallet reserve/consume/release → inbox cards written → **wallet entries written**. Any drift beyond tolerance is treated as a production bug even before users complain.
- **Circuit breakers:** per §6.5 (campaign) and §8/§10 (tool + calendar).
- **PostHog telemetry & bug-fix tooling:** run `npx -y @posthog/wizard@latest` against **Flutter only, for infrastructure** (Error Tracking, Session Replay, crash plumbing) — it must **not** invent analytics events or touch the typed taxonomy. **Do not run the wizard on the Worker** (backend has deliberate hand-rolled emission; add Error Tracking via SDK instead). **Session Replay ON for Flutter** to debug UI flows (upload, mapping, DID purchase, analytics UI), with **aggressive masking** of phone numbers, transcripts, KB documents, and all text inputs — replay is UI debugging, not content capture.
- **Support workflow:** analytics queries exclude `purpose=TEST` by default; support can include test calls explicitly.

---

## 16. Failure matrix

**Handover (H1–H9):**
- **H1** transfer API 5xx → `handover_failed`, AI resumes at 6/min, transfer reservation released, inbox "handover attempted but failed, AI continued."
- **H2** transfer accepted but caller-leg join event never arrives → timeout at `BridgeRequested` → `handover_failed`, AI resumes ("I couldn't connect you — can I take a message or arrange a callback?"). Never end the AI session without `BridgeConfirmed`.
- **H3** caller hangs up during `DialHuman` → `caller_abandoned`, cancel the ringing human dial (terminate the leg if the race loses), AI billed to caller hangup, no transfer tariff, inbox "caller disconnected while waiting for handover."
- **H4** human answers then hangs up pre-bridge → `handover_failed`, AI resumes with callback offer.
- **H5** owner voicemail answers → AMD/whisper-detection aborts, `handover_failed_machine`, back to AI, no transfer tariff.
- **H6** Gemini room dies mid-handover → **FSM (orchestration) continues** from webhooks; unrecoverable pre-bridge → fail handover, terminate human leg, finalize.
- **H7** calendar OAuth revoked mid-call → refresh once, retry once, then circuit-break with a graceful line.
- **H8** Gemini reconnect while a tool is in flight → don't replay the result; complete + log + mark undelivered; new session gets a system note.
- **H9** caller asks for a human but handover disabled/ineligible → the `transfer_to_human` tool isn't declared; agent says "I can't transfer this call to a person, but I can take a message or arrange for someone to contact you."

**Also covered:** provider outages (circuit breaker → auto-pause), Worker restarts (DO reconstructs from D1), tool failures (3-failure breaker), analytics failures (degrade gracefully, D1 dashboard unaffected), R2 upload failure (`pending_upload` retry).

---

## 17. Rollout plan

Each phase ships independently and can be dark-launched behind flags.

- **A — Foundations:** `TelephonyProvider` + `VobizProvider` (dial/hangup/DID lifecycle), `user_dids` migration + receptionist-number backfill, DID purchase UI, prompt freeze + audit rows.
- **B1 — Money & gate:** WalletDO `reserve/consumeReserved/release`, DialerGateDO, reconciliation events. Prove escrow correctness in isolation before any real dialing.
- **B2 — Calling:** CampaignDO, outbound answer lane, campaign mode in `VobizAgentRoom`, `CallFSM`, attempts + fsm_transitions tables, retry taxonomy, circuit breaker. Beta behind `campaignOwnerAllowlist`, calling our own test numbers.
- **C — Conversation features:** ToolRuntime, campaign KB (F1), Calendar booking (F3), human handover (F4), wizard UI + ingestion behind `campaignsEnabled`.
- **D — Analytics & polish:** event taxonomy + Group, Worker analytics RPC, Flutter Analytics menu + per-campaign cards, PostHog wizard (Flutter infra), session replay + error tracking, Google Sheets OAuth import, multi-channel upsell, DND-registry scrub.

**Beta strategy:** keep the first beta small (owner's own numbers → a handful of friendly customers); spend week one validating telemetry and the reconciliation dashboard before adding features.

---

## 18. Configuration (feature flags & limits)

All declared in `worker/src/routes/config.ts` `DEFAULTS` **and** the `PlatformConfig` interface in the same change, and proven flippable (`ALLOW_PROD=1 scripts/flags.sh set <key>=…` must not 400; numeric keys also need a `numericKeys` entry).

Booleans (default false unless noted): `campaignsEnabled`, `campaignDialerEnabled`, `campaignOwnerAllowlist`, `campaignMachineDetection` (true), `campaignGoogleSheets`, `campaignKbEnabled`, `campaignToolsEnabled`, `campaignBookingEnabled`, `campaignHandoverEnabled`.
Numerics: `campaignMaxContacts` 2000, `campaignCallMaxMin` 10, `campaignWrapCueMin` 8, `campaignTokensPerMin` 6, `campaignDidMonthlyTokens` 700, `campaignKbMaxFiles` 10, `campaignToolBudget` 6, `campaignHandoverRingSec` 25, `campaignHandoverTokensPerMin` 2, `campaignHandoverTopupMin` 10.

---

## 19. Cross-feature seams — explicitly closed

1. **Tool budget vs handover:** `transfer_to_human` is a **system tool with its own limit (1/call)**; it does **not** draw from the 6-call ToolRuntime budget, so a call can book *and* hand over.
2. **`call_completed` vs transfer:** define `ai_duration_s` and `pstn_total_duration_s` separately; `call_completed` fires **once, after the entire PSTN call ends**, carrying both — keeps billing, analytics, and inbox aligned.
3. **KB deletion vs replay:** persist `kb_store_name`, `kb_files_meta` (hashes/names), and `kb_version` on the attempt row; after 30-day KB GC do not reconstruct grounding — document that replay past GC is transcript/audio only.
4. **Version capture:** all five version fields (`prompt`, `tool_runtime`, `fsm`, `kb`, `analytics`) captured on the **same attempt row** as one snapshot, so every call is reproducible.
5. **Analytics after transfer:** emit `handover_connected` at bridge, then **one final `call_completed` after PSTN completion** — never at AI disconnect.
6. **Tool results in transcript:** render every successful tool execution as a **system event** in the timeline ("System: Appointment booked for Tue 3 PM"), not free text — deterministic and searchable.
7. **Reservation vs analytics:** never emit `tokens_charged` until settlement is final; intermediate reservation consumption stays in WalletDO, not analytics events.
8. **Test calls:** every analytics query excludes `purpose=TEST` by default; support can include them explicitly.

---

## 20. Traceable requirements checklist (129 items)

**Telephony/billing/engine (v2, 1–58):** provider abstraction & outbound client (1–5); escrow billing with `attempt_uuid` idempotency, reservation-aware admission, mandatory spend cap, one billing model (6–10); D1-authoritative scheduling, `dial_reserved`, DO reconstruction, DialerGateDO, token bucket, round-robin, reserved inbound channel (11–18); uuid-before-POST, query-before-retry, attempts table, raw causes, per-cause retry, provider-answer billable start, transitional pause/cancel, graceful cancel (19–26); AMD advisory + Gemini self-detect + hint injection + human-evidence gate + immutable disclosure (27–32); ingestion caps/formula-strip/unicode-digits/BOM/dedupe/cell-cap/source_row/ambiguity (33–40); inbox thread + answered cards + miss digests + dashboard + TEST flag (41–45); account suppression + auto-DNC + server window + complaint webhook + circuit breaker (46–50); heartbeat + dial-denied reasons + id propagation + rollups + searchable timeline (51–55); WAV 90d + transcript kept + expired-recording UI (56–58).

**KB/tools/calendar/handover (v3, 59–89):** per-campaign store + 30-day soft-delete + business-KB attach + freeze at launch (59–61); ToolRuntime — generic runtime, single in-flight, FIFO queue, structured responses, 8s timeout, 3-failure breaker, 6/2/2 budget, freeze at session start, filler-before-tool (62–70); calendar `attempt_uuid` idempotency, explicit-alternative conflicts, explicit timezone (71–73); handover FSM, caller-join=BridgeConfirmed, AI stays until bridge, conference TTL, rolling reservation, tariff switch, wrap-timers-off, eligibility checks, recording-off-default, separate asset when on, AMD on handover leg, callback fallback (74–85); FSM audit rows + schema versioning + tool results on attempt row + handover status on attempt row (86–89).

**Analytics/telemetry (v4, 90–129):** PostHog=compute-only, Worker analytics RPC, native charts, KV cache, advanced deep-link (90–94); campaign-as-Group, owner-only Person, no callee Persons, `analytics_schema_version`, canonical `call_completed`, canonical dimensions (95–100); funnel/outcome/hour-of-day/cost/retry/tool/handover/machine/engagement/time-to-answer insights (101–110); account spend/funnel/leaderboard/volume/distribution + DID-utilization-from-D1 (111–116); ownership check per query, tenant-constraint injection, client never supplies identity, client never sends HogQL, key never leaves Worker (117–121); Flutter wizard infra-only, preserve taxonomy, Worker manual instrumentation, Worker error tracking via SDK, Flutter session replay + masking (122–126); dashboard/wallet D1-authoritative, analytics labeled eventually-consistent, analytics failures degrade gracefully (127–129).

---

## 21. Verdict

**GO for limited production rollout.** Clean separation of concerns (D1 = transactional truth, WalletDO = money, PostHog = analytical computation, Worker = tenancy/security/query-generation, Flutter = presentation), idempotent billing and dialing, recoverable state, deterministic call/handover FSM, a reusable ToolRuntime, and graceful degradation throughout. No architectural conflicts remain. Standing operational recommendations going into beta: watch the **reconciliation dashboard** and **analytics reconciliation lag**, and keep the first beta small while validating telemetry.
