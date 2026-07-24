# AvaBrain Product, Memory and Scale Bible

Status: implementation specification and code audit  
Date: 2026-07-24  
Scope: AvaBrain personal AI, Messenger integration, Services integration, files/media memory, voice, billing, telemetry, privacy and 3-million-user scale.

## 1. Product definition

AvaBrain is the user's personal AI layer across AvaTOK. It is not merely `@ava`, an Ask Ava overlay, a chatbot persona picker, or a marketplace assistant. Those are clients of one personal-brain service.

The product promise is:

1. The user can ask questions about their own activity, conversations, files, calls, listings, wallet activity, calendar and future products.
2. AvaBrain can remember durable user-approved facts, preferences, projects, goals and reminders without sending the entire platform history into every prompt.
3. AvaBrain can operate in a private personal chat, in an existing Messenger conversation when explicitly summoned, and in a voice conversation.
4. New features integrate through a single ingestion contract. A feature is not complete until it declares its brain domain, consent capability, event schema, deletion behavior, retention class, and telemetry.
5. Expensive model work is paid from AvaWallet tokens. There are no AI subscriptions. A user with insufficient tokens receives a deterministic block before provider work starts.

The word “remember” must be split into three guarantees:

- Event history: an append-only, bounded-retention record of what happened.
- Searchable memory: derived summaries, facts and embeddings that can be recalled.
- Conversation context: the small working context sent to a model for one answer.

They are not interchangeable. The full event log must never be stuffed into a prompt, and a vector result is not proof that a fact is true.

## 2. Findings from the code audit

### 2.1 What already exists

The repository already contains substantial foundations:

- `worker/src/lib/brain_domains.ts` is the One-Brain domain registry.
- `worker/src/lib/brain_ingest.ts` is the consent-gated, idempotent queue entry point.
- `consumers/src/brain.ts` performs extraction, entity upserts, embeddings, transcription, retention and deletion.
- `worker/src/do/user_brain.ts` is a per-user reasoning and recall Durable Object.
- `worker/src/lib/ava_search.ts` implements 1,024 shared AI Search shards with per-user folder isolation.
- `VECTOR_INDEX` is bound for semantic recall and D1 tracks vector IDs for deletion.
- `DB_BRAIN` stores the high-volume brain event and derived-memory tables.
- `Q_BRAIN` moves extraction off the request path.
- `app/lib/core/brain_recall.dart` and the local-brain classes provide a device lane for private Messenger content.
- `app/lib/features/ava_companion/companion_home.dart` and `companion_thread.dart` provide a personal chat UI.
- `worker/src/routes/ava_live.ts` and `app/lib/features/avachat/voice_call/live_voice_controller.dart` provide a low-latency Gemini Live audio path.
- Listings, calls, voicemail, wallet, profile, identity, calendar, live, verse and files already have partial producers.

### 2.2 What is not the promised product yet

1. The footer had removed the AvaBrain action and replaced it with Inbox. The fixed AvaBrain action is now restored in `app/lib/shell/v2/app_switcher_bar.dart`.
2. The visible Services root still exposed Marketplace terminology in several labels. The main shell labels now say Services, but route keys and backend names remain `marketplace` for compatibility.
3. Ask Ava, Companion and `@ava` are parallel product surfaces. They do not yet share one canonical personal-thread/session identity, one memory policy, or one voice entry point.
4. The Companion thread’s “voice” affordance is text-to-speech playback; the real two-way voice path is a separate screen. The thread now has a Call AvaBrain button. The AI receptionist path is already metered with `chargeAmount()` at the established per-second/token tariff, but the personal AvaBrain Live path is separate: `ava_live.ts` mints a direct Gemini Live token and currently records telemetry without invoking receptionist settlement. The tariff can be reused, but the billing connection still needs to be made explicit.
5. `BRAIN_DOMAINS` has no first-class daily-media domain. A video or audio note is not automatically a durable transcription/summary/embedding job merely because it was uploaded.
6. Private Messenger message bodies and E2E media are deliberately marked `device_private`. Server Brain cannot remember them unless the user explicitly exports a bounded summary or uses an on-device model. This is a privacy boundary, not a missing `brainIngest` call.
7. Mem0 is currently wired for Guardian Sentinel’s derived behavior memory and purge path, not as the user’s comprehensive AvaBrain memory. It must not become the system of record.
8. AI Search currently has free/premium quota behavior. The desired product policy is wallet-token metering, so AI Search, extraction, embeddings, transcription, vision and model turns need a unified cost ledger rather than a subscription check.
9. Tool calls, image generation, file analysis, transcription, artifacts and personal Live voice do not all pass through the same wallet settlement path. Receptionist voice has a real settlement path; personal Live voice currently has a route/lifecycle gap. A model switch without provider-agnostic usage accounting will undercharge or leak cost.
10. Proactive Messenger behavior—comments, stickers, suggestions, reminders—must remain a separate policy engine. A personal-memory index alone does not safely authorize AvaBrain to post into a group.

## 3. Non-negotiable architecture

```text
Feature event
   │  authenticated, scoped, consent checked, idempotency key
   ▼
brainIngest() ──► Q_BRAIN ──► brain consumer
                                 │
             ┌───────────────────┼───────────────────┐
             ▼                   ▼                   ▼
        DB_BRAIN          Vectorize              AI Search
      event/facts       semantic candidates      file/document recall
             │                   │                   │
             └──────────────► UserBrainDO ◄──────────┘
                                  │
                    small verified recall packet
                                  ▼
                    model router + wallet ledger
                                  │
                                  ▼
                    chat / Messenger / voice response
```

Rules:

- InboxDO remains the messaging source of truth. AvaBrain is a derived consumer.
- DB_BRAIN is the event and derived-memory source of truth for the Brain domain. Vectorize and AI Search are rebuildable indexes.
- Mem0, if retained, is a rebuildable preference/fact cache. Every row must contain `uid`, source event IDs, consent key, model/version, confidence and created/updated timestamps.
- Never use a global AI Search namespace without the mandatory per-user folder filter in `worker/src/lib/ava_search.ts`.
- Never send private Messenger text or ciphertext to the Worker merely to make recall easier. Use on-device indexing and send only the minimum user-approved excerpts to a cloud model.
- Every background task must be idempotent and safe to retry. The idempotency key must be derived from `(uid, domain, kind, sourceId)`.
- Request handlers may acknowledge the product action immediately, but durable brain work must use a queue or `ctx.waitUntil`; never silently drop it after the response.

## 4. Memory model

### 4.1 Memory classes

Use explicit classes, not one undifferentiated “memory” table:

| Class | Example | Default retention | Can cloud Brain read it? |
|---|---|---:|---|
| Profile | name, language, preferences | until changed/deleted | yes, consent-gated |
| Episodic | “I uploaded a voice note on Friday” | 12 months, configurable | yes, metadata/derived text |
| Semantic fact | “I prefer morning calls” | until stale or corrected | yes, confidence-scored |
| Goal/reminder | “remind me about Tiger next week” | until complete/expired | yes |
| File index | file title, type, extracted summary | until file deletion | yes, if account-private consented |
| Private conversation | DM/group message body | local-first | no by default; explicit export only |
| Safety record | moderation/enforcement evidence | legal policy | guardian-only |

### 4.2 Fact quality

Every derived fact must carry:

```json
{
  "fact_id": "uuid",
  "uid": "account id",
  "content": "user prefers ...",
  "type": "preference|goal|habit|deadline|decision|reminder|insight",
  "confidence": 0.0,
  "source_ids": ["event ids"],
  "source_domain": "profile|files|media|...",
  "model": "provider/model/version",
  "valid_from": 0,
  "valid_until": null,
  "user_confirmed": false,
  "consent_key": "files"
}
```

The model must say “I found a note suggesting…” when confidence is low. A nearest vector is a retrieval candidate, not an authoritative fact.

### 4.3 Mem0 decision

Do not make Mem0 the canonical memory store. At 3M users, external managed memory creates vendor lock-in, duplicate deletion obligations, and a second privacy boundary. Use the existing DB_BRAIN + Vectorize + UserBrainDO as the canonical personal-memory architecture. If Mem0 remains, use it only as an optional derived semantic-memory cache for high-value confirmed facts, behind `avaBrainMem0Enabled`, with:

- per-user namespace;
- source-event references;
- hard timeout and circuit breaker;
- no raw private Messenger content;
- export/delete parity;
- PostHog cost and latency telemetry;
- rebuild-from-DB_BRAIN capability.

## 5. Daily audio and video memory pipeline

Add a new `media_memory` domain to `worker/src/lib/brain_domains.ts` and mirror it in `consumers/src/brain.ts`. Do not overload `files` for recordings: media has different retention, processing cost and user expectations.

### 5.1 Client behavior

The Flutter recorder must:

1. Create a local content-addressed file and a durable outbox row immediately.
2. Render the message/note bubble immediately with `uploading` state.
3. Upload in the background with resumable chunks, retry/backoff, pause/resume and app-kill recovery.
4. Attach an explicit user choice: “Remember this in AvaBrain”, “Keep local only”, or the account default.
5. Never block the composer on transcription, thumbnailing, waveform generation or embedding.
6. Persist `client_media_id`, hash, local path, MIME, duration, size, capture time, account scope and consent snapshot.

### 5.2 Worker/consumer behavior

After upload completion:

1. Enqueue `media_uploaded` with a stable source ID.
2. Verify account ownership and private/public visibility.
3. Run malware/type/size checks before AI processing.
4. For audio: transcribe with the configured STT provider, store a bounded transcript, chunk it, embed it, and extract facts.
5. For video: extract audio; sample frames at bounded intervals; caption only sampled frames; combine transcript + visual summary; embed the combined segments.
6. Store processing state: `queued`, `transcribing`, `summarizing`, `embedding`, `ready`, `failed`, `deleted`.
7. Emit progress to the device using the existing message/media status mechanism; never make a failed AI job look like a failed upload.
8. Delete all derived transcript/vector/fact rows when the source is deleted or the consent capability is disabled.

### 5.3 Cost controls

- Maximum duration and size per free operation, configurable by flags.
- Audio transcription once per source hash.
- Video frame sampling with a hard frame budget, not every frame.
- Deduplicate by content hash across re-uploads while maintaining per-user ownership rows.
- Queue concurrency per user and global provider circuit breakers.
- Use a cheap model for captions/summaries; reserve the strongest model for user-requested reasoning.

## 6. Messenger integration without conflict

Messenger and AvaBrain have different authorities:

- Messenger owns delivery, ordering, receipts, reactions, membership, moderation and local message presentation.
- AvaBrain owns personal recall, suggestions and AI reasoning.
- AvaBrain must never silently rewrite, delete, send, react, sticker or warn in a Messenger thread.

### 6.1 Private chat

The current `device_private` rule is correct. On-device Brain can index local decrypted messages. A cloud answer may receive only the user’s query plus the minimum selected excerpts after the existing disclosure. A cloud server-side “remember everything” mode requires a separate explicit export consent and a clear non-E2E disclosure; it cannot be enabled by adding a background producer.

### 6.2 Group companion mode

Implement as a policy-controlled participant, not as a hidden observer:

- `companionMode` per group: off, suggestions-only, summoned-only, active.
- Group owner/admin approval and member-visible disclosure.
- Cooldown and daily budget per group.
- No autonomous warnings about individuals; use neutral safety templates and human confirmation for consequential actions.
- Suggested sticker/comment appears as a draft card; user or group policy must approve posting.
- Group memory is scoped to the group and must not become a user’s private memory unless the user saves it.
- Never use one group’s transcript to answer another group.

### 6.3 Proactive behavior loop

```text
new message/event → local or server feature hook → policy evaluator
                  → relevance + cooldown + safety + token check
                  → draft suggestion/sticker/comment
                  → visible preview → user/admin approval → Messenger send
```

The evaluator must be deterministic enough to shut down quickly with `companionEnabled`, `odlEnabled`, per-group and per-user kill switches.

## 7. Multi-model router

Do not hardcode one model into every surface. Add a server-side capability router with provider adapters and one usage schema.

Recommended policy:

| Work | Default | Fallback | Strong model only when |
|---|---|---|---|
| short chat | Haiku-class or Grok fast | Kimi K3 | user requests depth |
| tool call | Kimi K3 or verified tool-capable model | Gemini | tool schema requires it |
| classification/safety | Cloudflare Workers AI small model | Haiku-class | never silently skip |
| embeddings | Cloudflare BGE binding | none | deterministic retry |
| audio STT | Cloudflare/OpenAI Whisper tier | alternate STT | language/quality failure |
| video captions | Workers AI vision/cheap vision | alternate vision | user requests detailed analysis |
| artifact/file comparison | cheap extraction first | Kimi/Grok | complex synthesis |
| live voice | supported low-latency realtime provider | controlled fallback | never direct client secret |

The router chooses by capability, latency budget, privacy class, availability and estimated cost. “Fastest” must not mean “unmetered direct provider call.” Every adapter returns:

```json
{
  "provider": "openrouter|cloudflare|gemini",
  "model": "provider/model",
  "input_tokens": 0,
  "output_tokens": 0,
  "cached_tokens": 0,
  "audio_seconds": 0,
  "image_units": 0,
  "request_id": "provider request id",
  "latency_ms": 0,
  "finish_reason": "stop|tool|error"
}
```

## 8. Wallet-token billing

Remove subscription checks only after every AI capability has a server-side reserve/settle path. The correct sequence is:

1. Estimate worst-case cost from capability, model, input size and output cap.
2. Reserve wallet tokens with an idempotency key before provider work.
3. Refuse with `402` and a top-up action if reservation fails.
4. Call the provider with a timeout and request ID.
5. Settle actual usage, including fallback provider/model.
6. Release unused reservation on failure/cancellation.
7. Record an immutable wallet ledger row and a PostHog settlement event.

Pricing formula:

```text
provider_cost_usd
× 1.30 markup
× wallet_tokens_per_usd
rounded up to integer tokens
```

The existing plain `@ava` wallet meter is a foundation, not proof that image, OCR, STT, artifacts, AI Search, Vectorize, tool calls and personal Live voice are covered. The receptionist’s established charge is the canonical voice tariff and should be reused, not duplicated. Add a capability matrix and test every route. A direct Gemini Live token route is especially important: minting a token without a hold/lease and final settlement lets users consume provider time outside the receptionist ledger.

Never put provider API keys in Flutter. Never trust client-reported token counts for settlement. Never charge twice for a retry: use an operation ID shared by the request, queue job and provider call.

## 9. API and data contracts to add

### 9.1 Brain event contract

All feature producers call `brainIngest` with:

```ts
{
  uid,
  domain,
  kind,
  sourceId,
  text?,
  meta,
  ts,
  consentSnapshot?,
  emailForTelemetry?
}
```

The registry derives scope and consent. Callers must not supply a more permissive scope.

### 9.2 Media processing endpoints

Add authenticated endpoints:

- `POST /api/brain/media/prepare` → upload session and policy decision.
- `POST /api/brain/media/complete` → idempotent completion event.
- `GET /api/brain/media/:id` → status/progress only.
- `DELETE /api/brain/media/:id` → source + derived-data deletion job.
- `POST /api/brain/export` → explicit private-content export to cloud Brain, bounded and auditable.

### 9.3 Personal chat

Converge Ask Ava and Companion on one account-scoped session model. Keep compatibility routes, but make them call one service that owns:

- `session_id`, `surface`, `context_hint`, `privacy_mode`;
- recall packet and citations;
- wallet operation ID;
- provider/model usage;
- user-visible memory controls.

## 10. Telemetry and PostHog Error Tracking

Calling and personal AI are moat surfaces. Every event must be pullable by account without putting raw private content into PostHog. Use `uid`, normalized email where policy permits, and HMAC phone ID—not raw phone numbers.

### 10.1 Required event properties

Common fields:

`uid`, `email`, `account_scope`, `app_build`, `environment`, `session_id`, `trace_id`, `surface`, `privacy_mode`, `consent_key`, `feature_flag_version`, `operation_id`, `provider`, `model`, `latency_ms`, `status`, `error_code`.

Do not include message bodies, transcripts, file contents, auth tokens or raw media URLs.

### 10.2 Brain events

- `avabrain_opened`
- `avabrain_turn_started`
- `avabrain_recall_completed` with hit count, source domains and recall latency
- `avabrain_turn_settled` with input/output tokens, wallet tokens, provider/model and total latency
- `avabrain_wallet_blocked`
- `avabrain_provider_fallback`
- `avabrain_memory_ingest_queued/completed/failed`
- `avabrain_media_processing_stage`
- `avabrain_memory_deleted`
- `avabrain_consent_changed`
- `avabrain_companion_draft_created/approved/rejected`
- `avabrain_group_policy_blocked`

### 10.3 Error Tracking

Send high-value exceptions to PostHog Error Tracking with grouped fingerprints:

- `AvaBrainProviderTimeout`
- `AvaBrainProviderRateLimited`
- `AvaBrainWalletReservationFailed`
- `AvaBrainSettlementMismatch`
- `AvaBrainRecallIsolationFailure`
- `AvaBrainQueueDrop`
- `AvaBrainMediaTranscriptionFailed`
- `AvaBrainMediaVideoDecodeFailed`
- `AvaBrainVectorUpsertFailed`
- `AvaBrainSearchShardFailure`
- `AvaBrainMem0CircuitOpen`
- `AvaBrainPrivateContentBoundaryViolation`
- `AvaBrainVoiceSessionFailed`

Capture stack, route, build, environment, trace and operation ID. Redact provider prompts and response bodies. Add sampling for expected 4xx blocks, but never sample away settlement mismatches, privacy violations or queue loss.

### 10.4 SLOs for 3M users

- p50 text first token < 1.5s; p95 < 6s for fast lane.
- p95 recall < 500ms excluding provider time.
- 99.9% queue acceptance; zero silent drops.
- 99.99% wallet ledger idempotency.
- 100% deletion completion or visible retry state.
- 0 cross-user search results.
- media upload bubble visible locally < 100ms.
- voice session start success and provider fallback rates tracked separately.

## 11. Scale plan for 3 million users

- Keep per-user hot state in UserBrainDO, not a global coordination DO.
- Keep high-volume immutable events in D1 with indexes on `(uid, created_at)` and `(uid, idempotency_key)`; roll up and expire raw events.
- Use Q_BRAIN with bounded retries and a dead-letter queue. Alert on age, depth and retry rate.
- Keep Vectorize IDs deterministic and maintain a deletion registry.
- Keep AI Search at fixed shard count; never create one namespace per user.
- Apply per-user token buckets to model, transcription, vision and proactive jobs.
- Use provider circuit breakers and regional/transport timeout budgets.
- Cache stable profile/memory summaries in UserBrainDO; never recompute all memory per turn.
- Batch embeddings and extraction where latency allows.
- Use content hashes to prevent duplicate media processing.
- Separate interactive queues from bulk backfill queues.
- Run retention and deletion as resumable jobs, not one request.
- Add load tests for 3M logical users, 100K concurrent active users, bursty queue traffic and shard hot spots.

## 12. Ordered implementation plan

### P0 — correctness and product identity

1. Land the footer AvaBrain action and Services labels (implemented in this audit).
2. Make the Companion call button route to wallet-metered AvaBrain voice.
3. Create one `AvaBrainSession` contract shared by Ask Ava, Companion and `@ava`.
4. Add the capability-based model router and usage response schema.
5. Extend wallet reserve/settle/release to every AI capability before removing subscriptions.
6. Add PostHog Error Tracking wrappers with redaction and operation IDs.

### P1 — complete memory ingestion

1. Add `media_memory` domain, consent UI and deletion contract.
2. Build durable audio/video processing queue with STT, bounded vision and embeddings.
3. Add explicit private-content export from on-device Messenger to cloud Brain.
4. Add citations/source chips in AvaBrain answers.
5. Add memory review, correction, forget and export screens.

### P2 — Messenger companion

1. Add group policy and member disclosure.
2. Produce drafts for comments/stickers/warnings; require approval.
3. Add cooldowns, safety review and per-group token budgets.
4. Measure suggestion acceptance, rejection, mute and false-positive rates.

### P3 — performance and launch gates

1. Run static CI build and integration tests for all provider fallback paths.
2. Run privacy isolation tests across users, accounts and groups.
3. Run wallet ledger replay/idempotency tests.
4. Run media app-kill/resume tests.
5. Run load tests and queue-drain tests at 3M-user logical scale.
6. Enable features by staging flags, then production flags one capability at a time.

### Voice billing clarification

The owner confirms that AvaBrain voice should cost the same as the AI receptionist. Treat that as a pricing decision, not as evidence that the two implementations already share billing. The implementing agent must either:

1. route personal AvaBrain voice through the existing `ReceptionRoom` billing lifecycle; or
2. add an equivalent personal-voice session lease, balance runway, usage capture, `chargeAmount()` final settlement and idempotent refund/release path around `ava_live.ts`.

The second option must account for direct Gemini Live disconnects, reconnects, app kills, pause/minimize, token expiry and a missing usage report. The client must never be the billing authority. Only after this integration is verified should `AiVoiceAgentScreen` replace the subscription check with a wallet balance/estimated-minutes check.

## 13. Files for the implementing agent

Start with:

- `worker/src/lib/brain_domains.ts`
- `worker/src/lib/brain_ingest.ts`
- `consumers/src/brain.ts`
- `worker/src/do/user_brain.ts`
- `worker/src/lib/ava_search.ts`
- `worker/src/routes/ava_rag.ts`
- `worker/src/routes/ava_live.ts`
- `worker/src/feature_pricing.ts`
- `worker/src/routes/config.ts`
- `worker/src/types.ts`
- `worker/wrangler.toml`
- `app/lib/features/ava_companion/companion_home.dart`
- `app/lib/features/ava_companion/companion_thread.dart`
- `app/lib/features/avachat/voice_call/ai_voice_agent_screen.dart`
- `app/lib/features/avachat/voice_call/live_voice_controller.dart`
- `app/lib/core/brain_recall.dart`
- `app/lib/core/ava_ai_client.dart`
- `app/lib/shell/shell_v2.dart`
- `app/lib/shell/v2/app_switcher_bar.dart`
- `app/lib/shell/v2/services_root.dart`
- `app/lib/shell/v2/shell_chrome.dart`

Related audit: `Specs/REPORT-2026-07-24-avabrain-chat-audit.md`.  
Messenger audit: `Specs/AUDIT-MESSENGER-AI-MEDIA-UI-2026-07-24.md`.

## 14. Definition of done

AvaBrain is not production-ready until a user can upload a daily recording, see it appear locally immediately, later ask a grounded question about it, see the source and confidence, correct or forget the memory, and receive a wallet ledger entry that exactly matches provider usage. The same account must be able to ask about a listing or file without exposing another user’s data, discuss a private Messenger chat without breaking its privacy promise, and call AvaBrain without bypassing billing. Every failure must be visible in the UI, retriable, idempotent and diagnosable in PostHog.
