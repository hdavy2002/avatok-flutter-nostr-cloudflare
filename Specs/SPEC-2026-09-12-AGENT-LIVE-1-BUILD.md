# SPEC `[AGENT-LIVE-1]` — AI Voice Agent listings on GPT-Live-1 — BUILD SPEC v2

**2026-09-12 · production feature · owner decisions locked · this is the document the coding
agents build from.** Detailed designs live in `Specs/codex-rounds/round2-astra.md` ("R2");
this spec fixes the scope, the simplifications v1 makes over R2, the file ownership per
workstream and the interfaces between them. Where this spec and R2 differ, **this spec wins**.
Proposal v1: `Specs/PROPOSAL-2026-09-12-AI-VOICE-AGENT-LISTINGS.md`; audit of the proposal:
`Specs/codex-rounds/round1-astra.md`; reuse map: `Specs/AUDIT-2026-09-12-AI-AGENT-REUSE-MAP.md`.

## 0. Locked decisions

| # | Decision |
|---|---|
| D1 | Listing `kind='agent'`, `section='ai_voice_agents'`, group `book_their_time` (worker `GROUP_FOR_SECTION` + web `HIDDEN_SECTIONS` + app `kHiddenListingSections` all updated so web+app agree). |
| D2 | Only the sole agent admin (`env.AGENT_ADMIN_UIDS`, exactly one uid, resolved from `hdavy2002@gmail.com`) can create/edit/publish agents and upload knowledge. `createListing` rejects `kind:'agent'` for anyone else (`403 agent_admin_only`). Never an email allowlist in remote config. |
| D3 | Engine: `wss://api.openai.com/v1/live/sessions`, model `gpt-live-1`, delegation `responses` → `gpt-6-astra`, **function tools only** (`search_knowledge`, `remember_fact`, `get_customer_time`, `describe_shared_image`). Browser ⇄ `AgentLiveRoom` DO ⇄ OpenAI **WebSocket relay**; PCM16 LE **24 kHz both directions**; binary frames for audio, JSON for control (R2 §3.2 envelope). The API key never reaches the browser. |
| D4 | Image reading = side channel: upload → R2 **`DIGITAL`** (private) → vision call on the backend model (Responses API, `input_image`) → `session.commentary.append` (no `response.create`) + stored analysis for `describe_shared_image`. GPT-Live-1 has no image input. |
| D5 | RAG = OpenAI Files + one Vector Store per agent; the DO calls `POST /v1/vector_stores/{id}/search` inside `search_knowledge`. Files ≤ 25 MB, ≤ 50/agent, PDF/TXT/MD/DOCX. |
| D6 | Memory per (agent, buyer) in `agent_live_user_memory` (summary ≤1500, facts ≤40×160, open_threads ≤10×160, timezone, version, erasure_generation). Kept until **Forget me**. Prompt fencing per R2 §5.2. Summariser after each session (JSON-schema output on the backend model). |
| D7 | Money: wallet hold at checkout (`opId agentlive:hold:<bookingId>`), one immutable decision per booking, deterministic refund `opId agentlive:refund:<bookingId>`, release via `release(env, orderId, adminUid, {gross: amount, feeRate: 0.2})` (idempotent on `rel:<orderId>`), durable `agent_live_money_jobs` + cron sweep. Outcomes: `completed_full` (connected then ended/hung up early; cancel < 10 min before start), `no_show` (never connected, provider session was actually up for the slot → full charge), `cancelled_by_customer_early` (≥ 10 min before start → 100 %), `refunded_platform_failure` (any provider/our failure, capacity, missing key → 100 %). **No pro-rata anywhere.** |
| D8 | Seats: single global `AgentSeatAuthorityDO` (SQLite, `transactionSync`) is the only authority for both caps (per-agent `max_concurrent`, platform `agentPlatformMaxConcurrent`). Provisional (5 min) → confirmed → active (lease, 30 s heartbeat, 45 s reconnect grace) → released/expired. Peak occupancy by boundary sweep. D1 `agent_live_bookings` is a projection. |
| D9 | Slots: 5/10/20/30/40/60 min on a 5-min grid; "Talk now" = `[now, now+minutes)`; scheduled = pick a day + free start in the visitor's tz. At `starts_at` the room starts the provider session even if the customer is absent (this is the no-show evidence). |
| D10 | Customer identity on the web = the existing guest email-code → Clerk account flow; `/j/<token>` agent branch mints the same Clerk sign-in ticket the consult lane uses (v1 simplification over R2 §7.2's booking-scoped capability; documented risk accepted, revisit in v2). |
| D11 | App is read-only: tile + detail + "Talk on the web" CTA → `https://avatok.ai/l/<id>`. |
| D12 | Fail closed: without `OPENAI_API_KEY`, a valid `AGENT_ADMIN_UIDS`, `JOIN_LINK_SECRET`, or with `agentTalkEnabled=false`, quote/checkout returns `503 agent_live_unavailable` **before any hold**; already-paid bookings that reach start time without a working lane are refunded in full. |

### v1 simplifications over R2 (deliberate, do not "restore" R2 detail without asking)

- No seat quarantine table; a stale lease whose provider socket the room could not confirm closed is treated as **occupied until `ends_at`** (simple and safe).
- No authority outbox; the room writes the D1 projection directly, and the 5-min cron reconciles bookings whose `ends_at` passed without a terminal state.
- Health evidence for no-shows = `session.started` received + lease heartbeats every 30 s until `ends_at` with no gap > 90 s + no provider error. (R2's 10 s backend probe is dropped.)
- Release uses the existing `ledger.release()` with an explicit `gross`; no `releaseAgentLiveExact` adapter. The money job records the wallet op result and only marks `done` on `status 200` or `duplicate`.
- Join link keeps the Clerk sign-in ticket (D10).
- Time refresh via `session.update` every 60 s (R2 §3.5) — implemented, but memory refresh mid-call is not (memory is loaded at start + `remember_fact` writes to D1 immediately).

## 1. D1 schema — `worker/migrations/2026-09-12-agent-live.sql` (CREATEs only; apply with `cf.sh worker d1 execute DB_META --remote --file=…`)

```sql
CREATE TABLE IF NOT EXISTS agent_live_agents (
  listing_id TEXT PRIMARY KEY, owner_uid TEXT NOT NULL,
  persona_kind TEXT NOT NULL DEFAULT 'companion',
  voice TEXT NOT NULL, language TEXT NOT NULL DEFAULT 'auto',
  greeting TEXT, instructions TEXT NOT NULL, backend_instructions TEXT NOT NULL DEFAULT '',
  image_instructions TEXT NOT NULL DEFAULT '',
  live_model TEXT NOT NULL DEFAULT 'gpt-live-1', backend_model TEXT NOT NULL DEFAULT 'gpt-6-astra',
  price_per_min INTEGER NOT NULL, slot_minutes TEXT NOT NULL DEFAULT '5,10,20,30,40,60',
  max_concurrent INTEGER NOT NULL DEFAULT 3,
  image_reading INTEGER NOT NULL DEFAULT 1, memory_enabled INTEGER NOT NULL DEFAULT 1,
  adults_only INTEGER NOT NULL DEFAULT 0,
  vector_store_id TEXT, persona_version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_live_kb_files (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL,
  bytes INTEGER NOT NULL, content_sha256 TEXT NOT NULL, r2_key TEXT NOT NULL,
  openai_file_id TEXT, status TEXT NOT NULL DEFAULT 'uploaded', -- uploaded|indexing|indexed|failed|deleted
  error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_live_kb_agent ON agent_live_kb_files(agent_id, status);
CREATE TABLE IF NOT EXISTS agent_live_bookings (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, buyer_uid TEXT NOT NULL, buyer_email TEXT, buyer_tz TEXT,
  starts_at INTEGER NOT NULL, ends_at INTEGER NOT NULL, minutes INTEGER NOT NULL,
  price_per_min INTEGER NOT NULL, amount INTEGER NOT NULL, beneficiary_uid TEXT NOT NULL,
  persona_version INTEGER NOT NULL, policy_version TEXT NOT NULL DEFAULT 'agent-live-v2',
  order_id TEXT NOT NULL UNIQUE,            -- 'agl_<bookingId>'
  idempotency_key TEXT, request_hash TEXT,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending|booked|in_progress|completed|cancelled|failed
  money_state TEXT NOT NULL DEFAULT 'none', -- none|hold_pending|held|refund_pending|refunded|release_pending|released|needs_attention
  instant INTEGER NOT NULL DEFAULT 0, is_test INTEGER NOT NULL DEFAULT 0,
  join_token_hash TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_live_bookings_agent ON agent_live_bookings(agent_id, status, starts_at);
CREATE INDEX IF NOT EXISTS idx_agent_live_bookings_buyer ON agent_live_bookings(buyer_uid, starts_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_live_bookings_idem ON agent_live_bookings(buyer_uid, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS agent_live_sessions (
  id TEXT PRIMARY KEY, booking_id TEXT NOT NULL UNIQUE, agent_id TEXT NOT NULL, buyer_uid TEXT NOT NULL,
  session_generation INTEGER NOT NULL DEFAULT 1, provider_session_id TEXT,
  provider_started_at INTEGER, customer_first_attached_at INTEGER, last_heartbeat_at INTEGER, ended_at INTEGER,
  end_reason TEXT, -- slot_complete|customer_end|disconnect_timeout|provider_error|capacity|platform_error|emergency_stop|no_show
  billed_seconds INTEGER NOT NULL DEFAULT 0, images_count INTEGER NOT NULL DEFAULT 0, tool_calls INTEGER NOT NULL DEFAULT 0,
  transcript_r2_key TEXT, usage_json TEXT, evidence_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_live_decisions (
  booking_id TEXT PRIMARY KEY, outcome TEXT NOT NULL, -- completed_full|no_show|cancelled_by_customer_early|refunded_platform_failure
  reason TEXT, amount INTEGER NOT NULL, refund_amount INTEGER NOT NULL, release_gross INTEGER NOT NULL,
  fee INTEGER NOT NULL, net INTEGER NOT NULL, beneficiary_uid TEXT NOT NULL, decision_hash TEXT NOT NULL, decided_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_live_money_jobs (
  id TEXT PRIMARY KEY, booking_id TEXT NOT NULL, kind TEXT NOT NULL, -- refund|release
  state TEXT NOT NULL DEFAULT 'pending', -- pending|running|done|needs_attention
  attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL, lock_token TEXT, lock_until INTEGER,
  last_error TEXT, result_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_live_money_due ON agent_live_money_jobs(state, next_attempt_at);
CREATE TABLE IF NOT EXISTS agent_live_user_memory (
  agent_id TEXT NOT NULL, buyer_uid TEXT NOT NULL, display_name TEXT,
  summary TEXT NOT NULL DEFAULT '', facts_json TEXT NOT NULL DEFAULT '[]', open_threads_json TEXT NOT NULL DEFAULT '[]',
  timezone TEXT, sessions_count INTEGER NOT NULL DEFAULT 0, last_seen_at INTEGER,
  version INTEGER NOT NULL DEFAULT 0, erasure_generation INTEGER NOT NULL DEFAULT 0, memory_enabled INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL, PRIMARY KEY (agent_id, buyer_uid)
);
CREATE TABLE IF NOT EXISTS agent_live_session_images (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, booking_id TEXT NOT NULL, r2_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'analyzing', -- analyzing|ready|failed
  analysis TEXT, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_live_images_session ON agent_live_session_images(session_id, created_at);
CREATE TABLE IF NOT EXISTS agent_live_tool_calls (
  session_id TEXT NOT NULL, call_id TEXT NOT NULL, name TEXT NOT NULL, args_hash TEXT NOT NULL,
  result TEXT, state TEXT NOT NULL DEFAULT 'running', created_at INTEGER NOT NULL, PRIMARY KEY (session_id, call_id)
);
```

`listings` row for an agent: `kind='agent'`, `section='ai_voice_agents'`, `price`=price/min, `billing_unit='minute'`,
`schedule_mode='always_on'`, `media_mode='audio_only'`, `capacity=NULL`, `creator_id`=admin uid, `adults_only` mirrored.

## 2. Remote config flags (declare in `PlatformConfig` + `DEFAULTS`; numerics → `numericKeys`; strings → `stringKeys`)

| Flag | Type | Default |
|---|---|---|
| `agentListingsEnabled` | bool | `false` |
| `agentCheckoutEnabled` | bool | `false` |
| `agentTalkEnabled` | bool | `false` |
| `agentEmergencyStop` | bool | `false` |
| `agentImageReadingEnabled` | bool | `true` |
| `agentMemoryEnabled` | bool | `true` |
| `agentLiveModel` | string | `gpt-live-1` |
| `agentBackendModel` | string | `gpt-6-astra` |
| `agentSlotMinutes` | string | `5,10,20,30,40,60` |
| `agentPlatformMaxConcurrent` | number | `20` |
| `agentMinPricePerMin` | number | `10` |

Server-only env (types.ts `Env`): `OPENAI_API_KEY?`, `AGENT_ADMIN_UIDS?` (wrangler var, prod value filled at rollout), `JOIN_LINK_SECRET`, bindings `AGENT_SEAT_AUTHORITY`, `AGENT_LIVE_ROOMS`, `DIGITAL` (exists).

## 3. Worker API surface (all under `/api/agents…`; one dispatcher `worker/src/routes/agent_live/index.ts` mounted from `worker/src/index.ts`)

Public / customer (Clerk `requireUser` unless noted):
- `GET  /api/agents/:id` — public persona card (no auth): title, blurb, persona_kind, voice, slot_minutes, price_per_min, adults_only, image_reading, `available_now: boolean`, `next_free_at`.
- `GET  /api/agents/:id/availability?minutes=20&day=YYYY-MM-DD&tz=Asia/Kolkata` (no auth) → `{ starts: number[] }` (epoch ms on the 5-min grid, filtered by both caps via the authority).
- `POST /api/agents/:id/quote` `{minutes, instant, startsAt?, tz}` → `AgentQuote` (R2 §2.2; signed HMAC with `JOIN_LINK_SECRET`, 2-min validity). 503 `agent_live_unavailable` when the lane gate fails.
- `POST /api/agents/:id/book` `{quote, idempotencyKey}` → hold → authority confirm → `{bookingId, startsAt, endsAt, talkPath:'/talk/<id>'}`; 402 `insufficient_tokens` (dual-emit legacy `insufficient_avacoins`), 409 `seat_taken` + `next_free_at`, 409 `idempotency_conflict`.
- `POST /api/agents/bookings/:bookingId/cancel` → decision `cancelled_by_customer_early` or `completed_full(customer_cancel_late)`.
- `GET  /api/agents/bookings/mine`, `GET /api/agents/bookings/:bookingId` (status, times, money_state, receipt lines).
- `POST /api/agents/talk/:bookingId/prejoin` → `{ ws_url, room_token, starts_at, ends_at, server_now, agent:{name, avatar, voice}, image_reading, memory_enabled }` (window `[starts_at−120s, ends_at)`).
- `GET  /api/agents/talk/:bookingId/ws?token=…` — WebSocket upgrade → DO.
- `POST /api/agents/talk/:bookingId/image` — multipart `file`; ≤ 8 MB; JPEG/PNG/WebP sniffed; ≤ 6 per session → `{imageId, status:'analyzing'}`.
- `DELETE /api/agents/:id/memory/me` — Forget me (bumps `erasure_generation`, blanks fields, keeps row).
- `GET  /api/join-link/:token/session` — existing route gains the `agent` branch (destination `/talk/<bookingId>`, `destination_kind:'agent'`).

Admin (`requireAgentAdmin`):
- `GET /api/agents/admin/list`, `POST /api/agents/admin` (creates `listings` + `agent_live_agents` in one batch), `GET/PATCH /api/agents/admin/:id`, `POST /api/agents/admin/:id/publish` `{publish:boolean}`,
  `POST /api/agents/admin/:id/kb` (multipart) → R2 + OpenAI file + vector store (create store lazily) → status polling `GET /api/agents/admin/:id/kb`, `DELETE /api/agents/admin/:id/kb/:fileId`,
  `POST /api/agents/admin/:id/test-call` → creates a 3-min `is_test=1` booking with no hold and no memory, returns `talkPath`.
- `GET /api/agents/admin/voices` → the 12 voice ids + labels (`quartz, ripple, vesper, willow, stone, gleam, meridian, bossa, tempo, beacon, delta, cinder`).

Internal (DO ⇄ worker): the room DO reads D1 directly via `env`; the image route POSTs `/image-analysis` to the room DO stub with `{imageId, sessionGeneration, analysis|error}`.

Cron (`*/5`): `runAgentLiveSweeps(env)` — claim due money jobs; bookings with `ends_at < now` and status `booked|in_progress` → ask the room DO to finalize (or decide `refunded_platform_failure(reason:'orphan')` if the DO never started); expire provisional reservations (authority alarm also does this).

## 4. Durable Objects

**`AgentSeatAuthorityDO`** (`worker/src/do/agent_seat_authority.ts`, binding `AGENT_SEAT_AUTHORITY`, `idFromName('global')`): schema + algorithm R2 §1.2–1.6 minus quarantine/outbox. RPC over `fetch` JSON: `reserveProvisional {bookingId, agentId, buyerUid, startMs, endMs, agentCap, platformCap}` → `{ok, token} | {ok:false, reason:'seat_taken', nextFreeAt}`; `confirm {bookingId, token}`; `release {bookingId, reason}`; `acquireLease {bookingId, owner}` → `{fence}`; `heartbeat {bookingId, fence}`; `nextFreeStart {agentId, minutes, fromMs, agentCap, platformCap}`; `freeStarts {agentId, minutes, dayStartMs, dayEndMs, gridMs, agentCap, platformCap}` (max 288 cells); `activeCount {agentId?}`. Alarm every 60 s expires provisional > 5 min and leases with `lease_expires_at < now − 45 s` (state → released only if `end_ms` passed; otherwise the row stays confirmed and counts).

**`AgentLiveRoom`** (`worker/src/do/agent_live_room.ts`, binding `AGENT_LIVE_ROOMS`, `idFromName(bookingId)`, DO migration tag **v24** `new_sqlite_classes = ["AgentSeatAuthorityDO","AgentLiveRoom"]`): R2 §3 protocol. Persist in DO storage: booking snapshot, session generation, transcript fragments, tool-call records, evidence, terminal intent. Alarms: start at `starts_at` (provider start even without customer), `ends_at − 60 s` wrap-up append, `ends_at` stop, heartbeat every 30 s, reconnect grace 45 s. Finalize: persist decision → D1 batch (decision + job + booking) → run the job inline once → queue summariser (`ctx.waitUntil`) → transcript JSON to `DIGITAL` key `agent-live/<agentId>/<bookingId>/transcript.json`.

## 5. Prompts (`worker/src/lib/agent_live/prompt.ts`)

`composeFrontendPrompt(agent)` (voice layer: persona voice/tone, hard rules: adult-content boundary from `adults_only`, no medical/legal/financial diagnosis, palmistry/astrology = entertainment, time budget "you have N minutes; when told one minute is left, wrap up warmly") and `composeBackendPrompt(agent, memory, timeBlock)` per R2 §5.2 with fenced `<untrusted_memory_json>`. `timeBlock(tz, now, lastSeenAt)` renders "It is 21:40 Saturday for the customer. Timezone: Asia/Kolkata. Last conversation: yesterday 22:10 (1 day ago)."

## 6. Web (Astro + React)

- Admin: `web/src/pages/admin/agents/index.astro`, `admin/agents/new.astro`, `admin/agents/[id].astro` → islands `web/src/islands/admin-agents/{AgentsList,AgentEditor,KnowledgePanel,VoicePicker,TestCallButton}.tsx`; API client `web/src/lib/agentLive.ts` (JSON via `apiClient.request`; multipart via `fetch` with `Authorization: Bearer <getActiveToken()>`). Gate: the page calls `GET /api/agents/admin/list`; a 403 renders "Admin only".
- Customer: `web/src/components/ListingDetailsComp.astro` gains the `kind==='agent'` branch rendering `<AgentBookingBox client:load listingId=…/>` (`web/src/islands/agent-live/AgentBookingBox.tsx`): duration chips, price, **Talk now** / **Next free HH:MM** / **Pick a time** (day picker → `availability`), then the existing guest-email → Clerk → wallet path (`web/src/islands/auth/*`, top-up via `/tokens`), `POST quote` → `POST book` → navigate `/talk/<id>`.
- Talk page: `web/src/pages/talk/[booking].astro` (`prerender=false`, `no-store`, noindex) → `web/src/islands/agent-live/AgentTalkRoom.tsx` + `AgentLiveSocket.ts` (R2 §3.2 envelope) + `web/src/islands/agent/AudioPipeline.ts` **parameterised** `{inputRate, outputRate}` (defaults unchanged for Gemini callers): mic permission → countdown → live (voice orb, captions, time ring, mute, **Share a photo** with camera/file, end) → ended card (money line, "Book again", "Forget me").
- Join: `web/src/islands/join/JoinLink.tsx` union gains `destination_kind:'agent'` + `/talk/` whitelist; `web/src/lib/urls.ts` `talkPath()`.
- Taxonomy: `web/src/lib/listingTaxonomy.ts` remove `ai_voice_agents` from `HIDDEN_SECTIONS`; `web/src/lib/card.ts` agent lane label "AI VOICE AGENT · from ₹N/min"; `web/src/islands/admin/labels.ts` rename "Voice agents (retired)" → "AI voice agents".
- Telemetry: `web/src/lib/analytics.ts` `capture()` for the events in §8. No transcripts, analyses, tokens in any event; `/talk/` and `/j/` paths carry no session replay.

## 7. Flutter app (read-only)

`app/lib/core/listing_groups.dart`: drop `ai_voice_agents` from `kHiddenListingSections`, map it to `book_their_time`. `app/lib/features/explore/native_listing_detail_v2.dart`: for `kind=='agent'` show "⚙ AI VOICE AGENT", "from ₹<price>/min", the slot chips (read-only) and one CTA **Talk on the web** → `url_launcher` to `https://avatok.ai/l/<id>`; hide the in-app booking flow. Gate on `RemoteConfig.agentListingsEnabled` (declare the getter; the flag is real per §2). Marketplace tile already handles the agent badge. No money in the app.

## 8. Telemetry (`Specs/SPEC-2026-09-02-TELEMETRY-CATALOG.md` § `[AGENT-LIVE-1]`)

Web: `agent_listing_view{agent_id}`, `agent_quote{minutes,instant,outcome}`, `agent_booking_created{minutes,instant,wait_s}`, `agent_seat_unavailable{next_free_in_s}`, `agent_talk_open`, `agent_talk_ready{connect_ms,outcome}`, `agent_talk_image_shared{outcome,ms}`, `agent_talk_ended{reason,billed_s}`, `agent_memory_forget`, `agent_admin_save{outcome}`, `agent_kb_upload{outcome,bytes}`.
Worker (`track()`): `agent_session_start{outcome,reason,agent_id}`, `agent_openai_error{code}`, `agent_capacity_refused`, `agent_session_settled{outcome,gross,refund,billed_s}`, `agent_memory_written{facts_n}`, `agent_money_job{kind,state,attempts}`, `$ai_generation` for summariser + vision (`$ai_model`, tokens, `$ai_total_cost_usd`).
Ship manifest (`tool/ship_manifest.json`) entry `AGENT-LIVE-1`: `two_sided:false`, flags `agentListingsEnabled, agentCheckoutEnabled, agentTalkEnabled`, success = `agent_talk_ready.outcome == 'ok'` (≥ 2 distinct persons) and `agent_session_settled.outcome == 'completed_full'` (≥ 1).

## 9. Workstreams & file ownership (agents work concurrently in ONE tree — touch only your files)

| WS | Owner files | Depends on |
|---|---|---|
| **A · foundations** | `worker/migrations/2026-09-12-agent-live.sql`; `worker/src/lib/agent_live/types.ts` (shared TS types: AgentRow, BookingRow, Quote, Decision, envelope types, tool names, VOICES, SLOT_MINUTES, constants); `worker/src/lib/agent_live/gate.ts` (`laneGate(env,cfg)`, `requireAgentAdmin`, `slotMinutesFrom(cfg)`); `worker/src/routes/config.ts` (flags §2); `worker/src/types.ts` (Env additions); `worker/wrangler.toml` (bindings + DO migration v24 + `AGENT_ADMIN_UIDS=""` var, prod+staging); `worker/src/routes/agent_live/index.ts` (dispatcher with the route table of §3 importing named exports listed below); one mount line in `worker/src/index.ts` + cron hook line calling `runAgentLiveSweeps`. | — (goes first; others code against `types.ts`) |
| **B · seat authority** | `worker/src/do/agent_seat_authority.ts`; `worker/src/lib/agent_live/seats.ts` (typed client: `seatAuthority(env).reserveProvisional(...)` etc.). | A types |
| **C · admin + listing integration + RAG ingest** | `worker/src/routes/agent_live/admin.ts` (exports `agentAdminList, agentAdminCreate, agentAdminGet, agentAdminPatch, agentAdminPublish, agentAdminKbUpload, agentAdminKbList, agentAdminKbDelete, agentAdminTestCall, agentAdminVoices`); `worker/src/lib/agent_live/openai_files.ts` (files + vector stores + `searchVectorStore`); `worker/src/routes/listings.ts` (KINDS gains `agent` + admin gate + defaults); `worker/src/lib/listing_section.ts` (`ai_voice_agents → book_their_time`); `worker/src/routes/agent_live/public.ts` (exports `agentPublicGet, agentAvailability`). | A, B client |
| **D · checkout + money + join** | `worker/src/routes/agent_live/checkout.ts` (exports `agentQuote, agentBook, agentBookingCancel, agentBookingsMine, agentBookingGet`); `worker/src/lib/agent_live/money.ts` (`decide()`, `enqueueMoneyJob()`, `runMoneyJob()`, `runAgentLiveSweeps()`); `worker/src/lib/agent_live/emails.ts` (confirmation with `/j/` link, via `queueEmail`); `worker/src/cal/ics.ts` + `worker/src/routes/join_link.ts` (agent kind/branch). | A, B client |
| **E1 · live room DO + protocol** | `worker/src/do/agent_live_room.ts`; `worker/src/lib/agent_live/openai_live.ts` (event types, `sessionStartEvent()`, parsers); `worker/src/routes/agent_live/talk.ts` (exports `agentTalkPrejoin, agentTalkWs`). | A, B client, E2 prompt/memory/vision APIs (import by agreed names) |
| **E2 · prompt + memory + vision + image route** | `worker/src/lib/agent_live/prompt.ts` (`composeFrontendPrompt, composeBackendPrompt, timeBlock`); `worker/src/lib/agent_live/memory.ts` (`loadMemory, appendFact, summariseAndStore, forgetMe`); `worker/src/lib/agent_live/vision.ts` (`analyseImage`); `worker/src/routes/agent_live/media.ts` (exports `agentTalkImageUpload, agentMemoryForget`). | A |
| **F · web admin** | `web/src/pages/admin/agents/**`, `web/src/islands/admin-agents/**`, `web/src/lib/agentLive.ts`, `web/src/islands/admin/labels.ts` (label only). | §3 contract |
| **G · web customer** | `web/src/components/ListingDetailsComp.astro` (agent branch only), `web/src/islands/agent-live/**`, `web/src/pages/talk/[booking].astro`, `web/src/islands/agent/AudioPipeline.ts` (rates param), `web/src/islands/join/JoinLink.tsx`, `web/src/lib/urls.ts`, `web/src/lib/listingTaxonomy.ts`, `web/src/lib/card.ts` (agent label). | §3 contract, R2 §3.2 envelope |
| **H · Flutter** | `app/lib/core/listing_groups.dart`, `app/lib/features/explore/native_listing_detail_v2.dart`, `app/lib/core/remote_config.dart` (getter). | §2 flag |
| **I · docs + telemetry + rulebook** | `Specs/SPEC-2026-09-02-TELEMETRY-CATALOG.md` (§8 appendix), `Specs/RULEBOOK-PAID-SESSIONS.md` (new §8 "AI voice agent sessions" with D7), `tool/ship_manifest.json`, `CLAUDE.md` (short pointer section), `CONFIG.md` (flags). | — |

Dispatcher contract (A writes; C/D/E1/E2 implement): every handler is `(req: Request, env: Env, ctx: ExecutionContext, params: Record<string,string>) => Promise<Response>`.

## 10. Acceptance (before flags flip in prod)

1. `npx tsc --noEmit` clean in `worker/`; `npm run build` clean in `web/`.
2. Two simultaneous `book` calls for the last seat: exactly one 200, one 409 `seat_taken` with `next_free_at`.
3. Duplicate `book` with the same idempotency key returns the same booking; different payload → 409.
4. Hold succeeds, authority confirm forced to fail → refund job runs, `money_state=refunded`, decision `refunded_platform_failure`.
5. Admin test call: OpenAI `session.started` received, audio both ways, captions render, image upload → commentary spoken, `remember_fact` row written, summariser wrote memory, Forget me blanks it and a late summariser write is rejected.
6. Real ₹ booking by a second person from the emailed `/j/` link → talk → settled `completed_full`, 80 % in the admin wallet (earnings hold), 20 % fee row.
7. Kill `agentTalkEnabled` mid-session: session continues; new prejoin gets 503; a paid booking at start time gets refunded.

## 11. v2.1 amendments from Codex Round 3 (`Specs/codex-rounds/round3-astra.md`) — BINDING

These override anything above that conflicts.

**M1 · Exact settlement (WS-D, may edit `worker/src/ledger.ts` + `worker/src/do/wallet.ts`).** Do not call `release()`. Add `releaseExact(env, {orderId, beneficiaryUid, gross, fee, net, title})` in `ledger.ts` that replays the creator leg via `walletOp(... op_id: 'rel:'+orderId, amount: net, commission: fee ...)` and the fee leg via the same ledger-row primitive `release()` uses with id `'fee:'+orderId`, using ONLY the frozen amounts from `agent_live_decisions` (never `escrowBalance`). Job = `done` only when the wallet op returned 200 or `duplicate` AND the fee leg was enqueued. Refund recovery: before refunding, look up the existing op `agentlive:refund:<id>` (add a read-only op lookup to WalletDO if none exists); an empty escrow after a lost response is not failure. In `wallet.ts` dedupe pruning, permanently retain op ids matching `agentlive:%`, `rel:agl_%`, `fee:agl_%` (extend the existing `listing:%` exemption in BOTH the predicate and the pruning SQL).

**M2 · Checkout recovery (WS-D).** Add booking columns `checkout_phase TEXT NOT NULL DEFAULT 'quoted'` (`quoted|reserved|hold_pending|held|confirm_pending|booked|aborted`) and `quote_json TEXT`, `persona_snapshot_json TEXT NOT NULL DEFAULT '{}'` (frozen persona config at checkout) — WS-A already wrote the migration; **WS-D appends these columns to the CREATE TABLE in `worker/migrations/2026-09-12-agent-live.sql`** (file not yet applied anywhere, so editing the CREATE is fine) and to `AgentLiveBookingRow` in `types.ts` (WS-D may edit that one type). Persist the booking row in phase `reserved` BEFORE the hold; advance phases durably. `runAgentLiveSweeps` recovers rows stuck in `reserved|hold_pending|held|confirm_pending` older than 3 min: re-query/replay the same hold opId, resolve via authority `getReservation`, and either complete or abort+refund. Never start a previously unattempted hold after quote expiry. Money job ids are deterministic: `<bookingId>:refund` / `<bookingId>:release` (PRIMARY KEY prevents duplicates).

**M3 · Decision integrity (WS-D + WS-A migration).** Add to `agent_live_decisions` CREATE: `CHECK (refund_amount >= 0 AND release_gross >= 0)`, `CHECK (refund_amount + release_gross = amount)`, `CHECK (fee >= 0 AND net >= 0 AND fee + net = release_gross)`, `CHECK ((refund_amount = amount AND release_gross = 0) OR (refund_amount = 0 AND release_gross = amount))`. One function `decideAndEnqueue(env, booking, outcome, reason)` performs the D1 batch (INSERT decision OR IGNORE → SELECT existing → compare hash → INSERT job OR IGNORE → UPDATE booking). No UPDATE of decisions anywhere. (WS-D edits the migration for this too.)

**M4 · Room RPCs (WS-E1 implements; WS-C/WS-D call via `env.AGENT_LIVE_ROOMS.get(idFromName(bookingId)).fetch('https://room/<op>')`):** `POST /schedule {bookingId}` → room loads the booking from D1, persists it, arms the start alarm, returns `{scheduled:true, startsAt, endsAt}`; `POST /cancel {bookingId, buyerUid, acceptedAt}` → room decides (`cancelled_by_customer_early` or `completed_full/customer_cancel_late`), revokes access, returns the decision; `POST /finalize {bookingId, trigger:'cron'|'admin'|'emergency'}` → idempotent terminal decision; `POST /forget {agentId, buyerUid, erasureGeneration}` → invalidates memory context in an active session and blocks its summariser. `agentBook` MUST call `/schedule` after the D1 `booked` write and before returning; the sweep re-calls `/schedule` for any `booked` row whose room reports not scheduled (`GET /state`). Room replays persisted terminal intent after a failed D1 batch on its next alarm.

**M5 · Seat authority invariants (WS-B).** Reservations store `request_hash`; `confirm` returns the authoritative `{startMs,endMs}` (instant bookings are rebased to confirmation time and the whole interval re-checked; D1/room/response use the returned interval); lease TTL = 90 s vs 30 s heartbeat; `heartbeat`/`releaseRuntime` require the current `{fence}`; `releaseRuntime` takes `providerClosed:boolean` — when false the row is flagged `provider_uncertain=1` and keeps occupying capacity past `end_ms` until a later `providerClosed {bookingId, fence}` call or `provider_expires_at` (now + 60 min); a new lease cannot be acquired for a booking whose previous provider is uncertain. Add `getReservation {bookingId}` and terminal `abort {bookingId}` (an aborted reservation can never confirm). Caps: `applyPolicy {platformCap, revision}` and per-agent caps passed on each call with the listing's `persona_version` as revision.

**M6 · Legacy bypasses closed (WS-C, WS-D).** `bookListing()` in `worker/src/routes/listings.ts` rejects `kind='agent'` with `409 agent_checkout_required` before any calendar claim or wallet op; generic listing create/update for `kind='agent'` by anyone (admin included) is rejected with `409 use_agent_admin_api` — agents are created only via `/api/agents/admin`. WS-D edits `worker/src/routes/admin_money.ts`: refund/release/hold on orders starting `agl_` → `409 agent_decision_required`.

**M7 · No-show evidence (WS-E1).** Full charge for a no-show requires ALL of: lease acquired within 10 s of `starts_at`; `session.started`; a booking-specific delegation readiness probe = one Responses API call to `agent.backend_model` (`max_output_tokens: 16`, no tools, `store:false`) returning 200 within 10 s of start; heartbeat evidence every 30 s with no gap > 90 s; no provider `error`, capacity or backend failure until `ends_at`. Anything missing or uncertain → `refunded_platform_failure`. Evidence JSON persisted on the session row.

**M8 · Image + Forget-me boundaries (WS-E1/WS-E2, migration edit by WS-E2).** `agent_live_sessions` gains `erasure_generation INTEGER NOT NULL DEFAULT 0`; `agent_live_session_images` gains `client_upload_id TEXT NOT NULL`, `session_generation INTEGER NOT NULL`, `erasure_generation INTEGER NOT NULL DEFAULT 0`, `analysis_revision INTEGER NOT NULL DEFAULT 1`, `UNIQUE(session_id, client_upload_id)`. The image route first calls the room `POST /image-reserve {bookingId, clientUploadId}` → `{ok, imageId, sessionGeneration, erasureGeneration} | {ok:false, reason:'quota'|'not_live'}`; only then stores + analyses; the callback `POST /image-analysis` carries `{bookingId, imageId, sessionGeneration, erasureGeneration, analysisRevision, analysis|error}` and the room drops stale ones. Transcript key `agent-live/<agentId>/<bookingId>/g<sessionGeneration>/transcript.json`. `forgetMe` bumps `erasure_generation`, blanks memory fields, deletes prior `DIGITAL` objects under `agent-live/<agentId>/<bookingId>/` for that buyer's bookings (best-effort, persisted as a job row in `agent_live_money_jobs` with `kind='erase'`), calls `/forget` on any booking room active in the last 2 h. Summariser writes use CAS on `(version, erasure_generation)` captured before the call; transcript persisted to R2 BEFORE the summariser job is enqueued (job row `kind='summarise'` in the same jobs table; `waitUntil` only accelerates).

**M9 · Join link (WS-D + WS-G).** The route is `POST /api/join-link/:token/session` (existing; WS-D adds the `agent` branch there — nothing is remounted under `/api/agents`). For `kind:'agent'` claims: fail closed when `JOIN_LINK_SECRET` is missing (no `dev-join-secret` fallback on this branch), exactly two segments, finite bounded `exp`, exact match of booking/agent/buyer + `join_token_hash`, reject when the booking has an accepted cancel/refund decision. Clerk ticket retained (D10) — WS-G must ensure no session replay and no token in analytics on `/j/` and `/talk/`.

**M10 · Privacy owners (WS-G).** WS-G also owns `web/src/lib/analytics.ts` (redact `/j/<token>` from `$current_url`, `$referrer`, `$pathname`, exception props; disable replay on `/j/` and `/talk/` before recording starts) and `web/src/lib/apiClient.ts` (`normalizeEndpoint` collapses `/api/join-link/<anything>/session` to `/api/join-link/:token/session`). `/j/[token].astro` and `/talk/[booking].astro` send `Cache-Control: no-store` + `Referrer-Policy: no-referrer`.

**M11 · Admin payloads (WS-C, F).** `POST /api/agents/admin` body: `{title, blurb, description, category (default 'ai_companion'), cover_media?, persona_kind, voice, language, greeting, instructions, backend_instructions, image_instructions, price_per_min, slot_minutes:number[], max_concurrent, image_reading, memory_enabled, adults_only}` → `{listing_id}`; PATCH accepts the same subset; GET returns `{listing:{…card fields…}, agent:{…agent_live_agents…}, kb:[…]}`; publish → `{status}`. Test call: `is_test=1`, `amount=0`, `order_id='agl_test_<id>'`, 3 min, no hold, no money job, `memory_enabled` forced 0 for that session; reserves a real seat.

**M12 · Gates (WS-E1, WS-D).** `agentTalkEnabled=false` blocks NEW provider starts and new quotes; reattachment to an already-running session within grace still works; `agentEmergencyStop=true` → rooms finalize with `refunded_platform_failure(emergency_stop)`. Receipts, refunds, Forget-me never gated.

**M13 · Acceptance additions (§10):** crash-after-hold recovery without a browser; creator leg ok + fee enqueue fails → retry yields exact original net/fee; retry after 48 h → no second wallet effect; cancel vs provider failure vs cron race → one decision; generic listing checkout and admin_money cannot move `agl_` money; uncertain provider closure past `ends_at` blocks a replacement seat; Live up but delegation probe fails → no-show refunded; parallel image uploads respect 6 total and stale results die on Forget-me; cross-account booking/image access rejected; reconnect during ordinary shutdown works, emergency stop refunds, admin tests never settle. Acceptance #5 is split: admin test = audio + images only; `remember_fact`/summariser/Forget-me are asserted on a real customer booking.
