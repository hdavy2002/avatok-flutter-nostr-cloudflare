# PROPOSAL — AI Voice Agent listings on GPT-Live-1 (`[AGENT-LIVE-1]`)

**Date:** 2026-09-12 · **Owner decision:** admin-only listing kind for AI voice agents ·
**Status:** v1 draft → to be hardened by 5 Codex (gpt-6-astra) audit rounds → build.

Read alongside: `Specs/RULEBOOK-PAID-SESSIONS.md` (money rules), `Specs/PIVOT-2026-08-27-MARKETPLACE-FIRST-PAID-SESSIONS.md`
(web pays, app is read-only for money), `Specs/SPEC-2026-09-02-TELEMETRY-CATALOG.md`, and the reuse map
produced for this proposal (`Specs/AUDIT-2026-09-12-AI-AGENT-REUSE-MAP.md`).

---

## 0. What the owner asked for (plain words)

A third listing type next to *live stream* and *1:1 session*: an **AI voice agent**. Only the admin
(`hdavy2002@gmail.com`) can create one. Creating one means: pick a **voice**, write the persona, and
**train it** with PDFs / a knowledge base (RAG). While a customer is talking, he can **upload a photo
and the agent reads it live** (e.g. a palm → palmistry reading). Customers **without the app** open
a shared link in the browser and just talk — the same no-login web lane the paid 1:1 video sessions
use. The agent **remembers every customer across days** ("she remembers yesterday's chat and asks
about it"), knows the **live time and the customer's time zone**, and asks related questions. A
customer who did not pre-book can **pay for a slot and talk right now**. Slots: **5, 10, 20, 30, 40,
60 minutes**. Engine: **OpenAI GPT-Live-1**, and because one agent can only hold **x concurrent
calls**, availability must be **concurrency-aware** and open up bookings the moment a seat frees.

## 1. Ground truth about GPT-Live-1 (checked 2026-09-12)

Sources: openai.com announcement, developers.openai.com model card + Live API reference, Twilio's
GPT-Live-1 tutorial (code-level event names).

| Fact | Consequence for us |
|---|---|
| Model id **`gpt-live-1`**; endpoint **`wss://api.openai.com/v1/live/sessions`** (server WebSocket) and `POST /v1/live/sessions` (WebRTC/telephony). Auth `Authorization: Bearer <OPENAI_API_KEY>`. | We relay through a Durable Object (the proven `AgentVoiceRoom` pattern) — the key never reaches the browser. |
| Full-duplex; native ASR transcripts + response text; 12 voices (Quartz, Ripple, Vesper, Willow, Stone, Gleam, Meridian, Bossa, Tempo, Beacon, Delta, Cinder). | Voice picker = this list; transcripts come free (memory + captions). |
| **Image input is NOT supported by gpt-live-1** (model card: Image — not supported). | "Read my palm live" is done by the **backend**: the photo goes to a vision-capable Responses model; the result is spoken by GPT-Live via `session.commentary.append` / tool output. See §5.4. |
| Delegation: `session.delegation = { type: "responses", responses: { model, instructions, tools } }` (or `type: "client"`). Backend reasoning models: **`gpt-6-astra`**, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`. | Persona reasoning, RAG (`file_search`) and memory tools run on the backend model; GPT-Live only talks. |
| Client events: `session.start`, `session.update` (delegation only), `session.input_audio.append`, `session.input_audio.mute/unmute`, `session.instructions.append`, `session.thinking.append`, `session.commentary.append`, `response.item.create`, `response.create`. Server: `session.started`, `session.updated`, `session.output_audio.delta`, `session.output_transcript.delta`, `response.event` (nested `response.output_item.done` etc.), `error`. **Model, frontend instructions, audio and startup input are immutable after `session.start`.** | Everything dynamic (memory, "the user just shared a photo", time-of-day) is injected with `instructions.append` / `commentary.append`, not by restarting the session. |
| Audio: PCM16 LE @ 16 kHz or 24 kHz, or G.711 @ 8 kHz. | Our web `AudioPipeline.ts` already does mic 16 kHz in / 24 kHz out. Reuse as-is. |
| Billing **$0.05/min per second** for the voice layer (+ backend tokens). At ₹96/$ that is ≈ ₹4.8/min. | Floor price per minute must cover this: default floor **₹10/min** (flag), so a 5-min slot is ≥ ₹50. |
| **Concurrent sessions by org tier: T1 25 · T2 50 · T3 200 · T4 300 · T5 500.** | A **platform cap** flag (`agentPlatformMaxConcurrent`, default 20 — assume Tier 1 until the owner confirms the tier) AND a **per-agent cap** set on the listing. Availability = seats, not people. |
| Not in prod today: **no `OPENAI_API_KEY` secret** (verified with `wrangler secret list`). | Blocker for go-live, not for build. Lane fails closed (503 + auto-refund) until the secret exists. Owner must supply a platform API key with billing. |

## 2. Reuse vs build (from the audit)

**Reuse as-is** — `listings` table + card pipeline (`kind` gains `agent`; the web `agent` lane, badge
and app "⚙ AI VOICE AGENT" badge already exist); `listing_section.ts` already maps `agent` →
`ai_voice_agents` (only needs a group); wallet primitives `hold/release/refund` with `opId`; admin gate
`requireAdmin` (`ADMIN_UIDS`) + `clerkEmail`; `/j/:token` join-link + Clerk sign-in ticket + guest
email-code auth; `/upload/public` for cover images; PostHog helpers; `web/src/islands/agent/AudioPipeline.ts`
(PCM16 mic/speaker); `AgentVoiceRoom` DO structure (per-minute meter, wrap-up nudge, hard cap, tool
calls, transcript, finalize); `avavoice.ts` `composePrompt` layering + `activeCalls` concurrency gate;
`listing_schedule.ts` (non-event kinds are "open"); `zonedEpoch`/`isValidTimezone`; email outbox.

**Copy-and-adapt** — `avavoice_agents/bookings/sessions` schema → `agent_*` tables; `AgentForm.tsx`
(vision studio) → admin agent form; `ConsultRoomGS` page shell → `/talk/[booking]`; commercial
confirmation email → agent confirmation.

**Build new** — OpenAI Live adapter in a new `AgentLiveRoom` DO; concurrency-seat booking engine;
per-customer memory (`agent_user_memory` + end-of-session summariser); image-reading side channel;
OpenAI vector-store RAG per agent; admin pages `/admin/agents*`; customer talk page; app un-hide of
the `ai_voice_agents` section + "Talk on the web" CTA; 9 remote-config flags; telemetry.

**Deliberately NOT reused** — `commercial_sessions*` (D1 CHECKs bind them to GetStream and to
`live_event|consult_1to1`; an AI session has no provider call and no host check-in), GetStream
(no media provider needed — audio goes browser ↔ DO ↔ OpenAI), Gemini File Search (RAG moves to the
same vendor as the reasoning model so `file_search` runs inside delegation with zero extra hops).

## 3. Data model (D1 `DB_META`, new file `worker/migrations/2026-09-12-agent-live.sql`, CREATEs only)

```sql
CREATE TABLE IF NOT EXISTS agent_personas (
  listing_id        TEXT PRIMARY KEY,            -- 1:1 with listings.id (kind='agent')
  owner_uid         TEXT NOT NULL,               -- admin who created it (= listings.creator_id)
  persona_kind      TEXT NOT NULL DEFAULT 'companion', -- companion|palmist|astrologer|coach|custom
  voice             TEXT NOT NULL,               -- one of the 12 gpt-live-1 voices
  instructions      TEXT NOT NULL,               -- persona prompt (frontend layer, ≤ 6 KiB)
  backend_instructions TEXT,                     -- reasoning-layer prompt (≤ 6 KiB)
  greeting          TEXT,                        -- first line she says
  language          TEXT NOT NULL DEFAULT 'auto',
  live_model        TEXT NOT NULL DEFAULT 'gpt-live-1',
  backend_model     TEXT NOT NULL DEFAULT 'gpt-6-astra',
  price_per_min     INTEGER NOT NULL,            -- tokens (₹) per minute
  slot_minutes      TEXT NOT NULL DEFAULT '5,10,20,30,40,60',
  max_concurrent    INTEGER NOT NULL DEFAULT 3,  -- per-agent seats
  image_reading     INTEGER NOT NULL DEFAULT 1,
  memory_enabled    INTEGER NOT NULL DEFAULT 1,
  vector_store_id   TEXT,                        -- OpenAI vector store (RAG)
  adults_only       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_kb_files (
  id TEXT PRIMARY KEY, listing_id TEXT NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL,
  bytes INTEGER NOT NULL, r2_key TEXT NOT NULL, openai_file_id TEXT, status TEXT NOT NULL DEFAULT 'uploaded', -- uploaded|indexed|failed
  error TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_kb_listing ON agent_kb_files(listing_id);
CREATE TABLE IF NOT EXISTS agent_bookings (
  id TEXT PRIMARY KEY, listing_id TEXT NOT NULL, buyer_uid TEXT NOT NULL,
  buyer_email TEXT, buyer_tz TEXT,
  starts_at INTEGER NOT NULL, ends_at INTEGER NOT NULL, minutes INTEGER NOT NULL,
  price_per_min INTEGER NOT NULL, amount INTEGER NOT NULL,      -- tokens held in escrow
  order_id TEXT NOT NULL UNIQUE,                                 -- 'agl_<id>'
  status TEXT NOT NULL DEFAULT 'booked',  -- booked|in_progress|completed|cancelled|refunded|failed
  instant INTEGER NOT NULL DEFAULT 0,     -- 1 = "talk now"
  join_token_hash TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_bookings_seat ON agent_bookings(listing_id, status, starts_at, ends_at);
CREATE INDEX IF NOT EXISTS idx_agent_bookings_buyer ON agent_bookings(buyer_uid, starts_at);
CREATE TABLE IF NOT EXISTS agent_sessions (
  id TEXT PRIMARY KEY, booking_id TEXT NOT NULL UNIQUE, listing_id TEXT NOT NULL, buyer_uid TEXT NOT NULL,
  started_at INTEGER, last_beat_at INTEGER, ended_at INTEGER,
  billed_seconds INTEGER NOT NULL DEFAULT 0, openai_session_id TEXT,
  end_reason TEXT,  -- user|hard_cap|disconnect|provider_error|capacity|kill_switch
  transcript_r2_key TEXT, images_count INTEGER NOT NULL DEFAULT 0,
  gross INTEGER NOT NULL DEFAULT 0, refunded INTEGER NOT NULL DEFAULT 0, settled_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_user_memory (
  listing_id TEXT NOT NULL, buyer_uid TEXT NOT NULL,
  display_name TEXT, timezone TEXT, summary TEXT NOT NULL DEFAULT '',   -- ≤ 2 KiB rolling summary
  facts TEXT NOT NULL DEFAULT '[]',        -- JSON array of short durable facts
  open_threads TEXT NOT NULL DEFAULT '[]', -- JSON array: things to ask about next time
  sessions_count INTEGER NOT NULL DEFAULT 0, last_seen_at INTEGER, updated_at INTEGER NOT NULL,
  PRIMARY KEY (listing_id, buyer_uid)
);
CREATE TABLE IF NOT EXISTS agent_session_images (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, r2_key TEXT NOT NULL, analysis TEXT, created_at INTEGER NOT NULL
);
```

`listings` itself: `kind='agent'`, `section='ai_voice_agents'`, `price` = price per minute,
`billing_unit='minute'`, `schedule_mode='always_on'`, `creator_id` = admin uid. No `ALTER`.

## 4. Concurrency-aware availability (the seat engine)

A seat = one concurrent GPT-Live session. Two caps: **per agent** (`agent_personas.max_concurrent`)
and **platform** (`agentPlatformMaxConcurrent` flag, ≤ the OpenAI tier). A booking `[starts_at,
ends_at)` is valid iff, for every instant in the window, overlapping non-dead bookings of that agent
`< max_concurrent` **and** overlapping non-dead bookings across all agents `< platform cap`.

- **Slot grid:** 5-minute grid from `now` rounded up; durations from `slot_minutes`. Availability
  endpoint `GET /api/agents/:id/availability?minutes=20&tz=Asia/Kolkata&day=2026-09-13` returns
  free start times for that day (max 288 cells, computed from one overlap query, sweep-line).
- **Talk now:** `POST /api/agents/:id/book { minutes, instant:true }` → window
  `[now, now+minutes)`; if no seat, response includes `next_free_at` so the UI offers the next slot.
- **Atomic claim (D1 batch = one transaction):** `INSERT booking (status='booked')` → `SELECT` the
  two overlap counts → if either exceeds its cap `DELETE` the row and return `409 seat_taken`. Hold
  the tokens (`hold(env, uid, 'agl_<id>', amount, {opId:'agent:hold:<id>'})`) **before** the batch;
  on 409 refund with `opId:'agent:seat-miss:<id>'`. (Same hold→verify→refund order as
  `commercialCheckout`.)
- **Runtime gate:** at `session start` the DO re-checks live session counts (from
  `agent_sessions` where `ended_at IS NULL AND last_beat_at > now-90s`) against both caps and
  handles OpenAI `429/insufficient capacity` by ending with `end_reason='capacity'` → **100 %
  refund + apology email**. Failing closed is the rule; there is no fallback engine.
- **Seats free up on end**, not on schedule: a session that ends early releases the seat
  immediately (booking status → completed), so the next booking can start at once.
- **No-show:** the booking window passes with no session → status `completed`, customer pays
  (rulebook rule 3: the agent was present). Cancellation ≥ 10 min before start → 100 % refund.

## 5. Runtime: `AgentLiveRoom` Durable Object (new binding `AGENT_LIVE_ROOMS`, DO migration `v24`)

Browser `WS wss://api.avatok.ai/api/agents/talk/:bookingId/ws?t=<room token>` ⇄ DO ⇄
`wss://api.openai.com/v1/live/sessions`. One DO instance per booking (`idFromName(bookingId)`).

5.1 **Start:** verify room token (HMAC, minted by `POST /api/agents/talk/:bookingId/prejoin` which
checks the buyer, window `[starts_at-2min, ends_at)`, booking status). Load persona + memory +
customer tz. Send `session.start` with `model: gpt-live-1`, `audio: {format:{type:'audio/pcm',
rate:24000}, output:{voice}}`, `instructions` = **frontend prompt** (persona voice/tone + hard rules
+ time budget), `delegation: {type:'responses', responses:{ model: backend_model, instructions:
backend prompt + MEMORY BLOCK + TIME BLOCK, tools:[file_search(vector_store_id), remember_fact,
read_shared_image, get_time_now] }}`. Wait for `session.started` → tell browser `ready` → start
the meter.

5.2 **Time & timezone:** the browser sends `Intl.DateTimeFormat().resolvedOptions().timeZone`
and its local clock at connect; the DO writes the TIME BLOCK ("It is Saturday 21:40 for the
customer in Asia/Kolkata; last session was 1 day ago at 22:10") into the backend instructions and
refreshes it every 10 min via `session.instructions.append`. `get_time_now` tool returns the same
so the agent can reason about "late night", "before work", etc.

5.3 **Memory:** at start, MEMORY BLOCK = `summary` + `facts` + `open_threads` ("she asks him how the
interview went"). During the call the `remember_fact(fact)` tool appends to `facts` immediately
(so a crash never loses it). At end, the DO builds the transcript from
`session.output_transcript.delta` + ASR items in `response.event`, and runs one Responses call on
the backend model to produce the new `{summary, facts, open_threads, display_name}` → upsert
`agent_user_memory`, transcript → R2 `agent-transcripts/<session>.json` (private bucket `BLOBS`).
Memory is per (agent, customer); a customer can wipe it (`DELETE /api/agents/:id/memory/me`, shown
in the talk page footer) — required for consent and for the "girlfriend remembers" use to be
opt-out-able.

5.4 **Live photo reading (image side channel):** the talk page has "Share a photo" (camera or file).
Browser `POST /api/agents/talk/:bookingId/image` (multipart, ≤ 8 MB, JPEG/PNG/WebP) → Worker
stores in R2 (private), calls the **backend vision model** (`gpt-6-astra` via Responses with
`input_image`) with the persona's image instructions ("You are a palmist. Describe the lines you
see and interpret them in the persona's voice; entertainment only, never medical claims") →
analysis text is saved on `agent_session_images` and pushed to the DO, which sends
`session.commentary.append` ("The customer just showed you their palm. What you see: …") followed by
`response.create`, so she reacts within a couple of seconds and can keep referring to it (the
`read_shared_image` tool returns the latest analyses). Hard rule in both prompts: **no diagnosis of
disease; palmistry/astrology are framed as entertainment.**

5.5 **Meter, wrap-up, hard cap:** identical to `AgentVoiceRoom`: per-second billed time while the
OpenAI socket is up; at `ends_at − 60 s` inject `session.instructions.append("One minute left —
wrap up warmly")`; at `ends_at` stop audio, close OpenAI socket, finalize. Browser drop → 45 s grace
for reconnect to the same DO (seat stays), then finalize with `end_reason='disconnect'`.

5.6 **Settle:** `release(env, order_id, owner_uid, {feeRate: PLATFORM_FEE_RATE, gross: amount})` —
the creator IS the platform admin, so the 80/20 split lands in the admin's wallet and the platform
fee account (unchanged ledger semantics, no special case). Provider/capacity failure before 30 s of
audio → `refund()` 100 %. Failure after → refund the unused **whole minutes** (the only pro-rata
in this lane, and only for OUR failure — the rulebook's "no pro-rata" is about human late/absent).

5.7 **Kill switches:** `agentListingsEnabled` (whole lane), `agentTalkEnabled` (new sessions;
running ones finish), per-agent `status` on the listing.

## 6. Surfaces

6.1 **Admin (web, `/admin/agents`, `/admin/agents/new`, `/admin/agents/[id]`)** — gate: uid in
`ADMIN_UIDS` **or** Clerk email in flag `agentAdminEmails` (default `hdavy2002@gmail.com`). Form
(adapted from `islands/vision/AgentForm.tsx`): title, blurb, description, cover (upload/public),
persona kind, **voice** (12, with a 3-second sample line generated once via `/v1/audio/speech` and
cached in R2), language, greeting, persona instructions, backend instructions, image reading on/off
+ image instructions, memory on/off, **price per minute** (₹, floor from flag), allowed slot
lengths (checkboxes 5/10/20/30/40/60), max concurrent seats, 18+ toggle, **knowledge base**: drag &
drop PDF/TXT/MD/DOCX (≤ 25 MB each, ≤ 50 files) → R2 + OpenAI Files → vector store; per-file status
chip (uploaded / indexed / failed); **Test call** button (admin talks to it free, 3 min, not billed,
no memory write); Publish / Unpublish. Server: `POST /api/agents` (creates the `listings` row with
`kind='agent'` + `agent_personas`), `PATCH /api/agents/:id`, `POST /api/agents/:id/kb`,
`DELETE /api/agents/:id/kb/:fileId`, `POST /api/agents/:id/publish`, `GET /api/agents/mine`.
`createListing` itself rejects `kind='agent'` from non-admins (`403 admin_only`).

6.2 **Customer — listing page (`/l/[id]`, existing SSR)** — for `kind==='agent'` render
`AgentBookingBox`: duration chips (from `slot_minutes`), price = minutes × price_per_min, **"Talk
now"** (if a seat is free right now) or **"Next free: 21:45"**, plus "Pick a time" (day picker →
free starts in the visitor's tz). Payment = the existing web wallet/guest flow (`GuestEmail` → email
code → Clerk account → wallet hold; top-up via the existing web rail). Confirmation email with the
`/j/<token>` link (`destination_kind: 'agent'` → `/talk/<bookingId>`), .ics for scheduled slots.

6.3 **Customer — talk page (`/talk/[booking].astro` → `AgentTalkRoom.tsx`)** — no dashboard, no
onboarding (pivot §7 stays true): mic check → countdown to start (if early) → **live**: animated
voice orb, her name/avatar, live captions (both sides, from transcripts), remaining time ring,
mute, **Share a photo** (camera/file, shows a thumbnail + "she's looking…"), end call, "Forget me"
link. After end: receipt line + "Book again" chips. Reuses `AudioPipeline.ts` (16 k in / 24 k out),
`islands/join/JoinLink.tsx` whitelist gains `/talk/`.

6.4 **App (Flutter)** — read-only, minimal: un-hide `ai_voice_agents` in
`app/lib/core/listing_groups.dart` and add the section to a group (worker `GROUP_FOR_SECTION` too,
so web + app agree: `ai_voice_agents → book_their_time`); `NativeListingDetailV2` for `kind=='agent'`
shows price/min, the duration chips **and a single CTA "Talk on the web"** that opens
`https://avatok.ai/l/<id>` (payments are web-only; the app never charges). One `ship it` build.

## 7. Remote-config flags (declare in `PlatformConfig` **and** `DEFAULTS`, numerics in `numericKeys`)

| Key | Type | Default | Meaning |
|---|---|---|---|
| `agentListingsEnabled` | bool | `false` | lane visible + bookable |
| `agentTalkEnabled` | bool | `true` | allow new sessions to start |
| `agentLiveModel` | string | `gpt-live-1` | |
| `agentBackendModel` | string | `gpt-6-astra` | reasoning/vision/RAG model |
| `agentPlatformMaxConcurrent` | number | `20` | ≤ OpenAI tier concurrent sessions |
| `agentMinPricePerMin` | number | `10` | ₹ floor |
| `agentSlotMinutes` | string | `5,10,20,30,40,60` | allowed durations |
| `agentAdminEmails` | string | `hdavy2002@gmail.com` | extra admin allowlist (email) |
| `agentImageReadingEnabled` | bool | `true` | platform-wide switch for §5.4 |
| `agentMemoryEnabled` | bool | `true` | platform-wide switch for §5.3 |

Prove each with `ALLOW_PROD=1 scripts/flags.sh set <key>=…` (no 400) after deploy — the fake-flag rule.

## 8. Telemetry (add to `Specs/SPEC-2026-09-02-TELEMETRY-CATALOG.md` § "AGENT-LIVE-1")

Web: `agent_listing_view`, `agent_booking_started`, `agent_booking_created {minutes, instant, wait_s}`,
`agent_seat_unavailable {next_free_in_s}`, `agent_talk_open`, `agent_talk_ready {connect_ms}`,
`agent_talk_image_shared {analysis_ms, outcome}`, `agent_talk_ended {reason, billed_s}`,
`agent_memory_forget`. Worker: `agent_session_start {outcome, reason}`, `agent_openai_error {code}`,
`agent_capacity_refused`, `agent_session_settled {gross, refunded, billed_s}`,
`agent_memory_written {facts_n}`, `$ai_generation` for every backend Responses call (summariser,
vision) with `$ai_model`, tokens and cost. Admin: `agent_admin_create`, `agent_kb_indexed {files, ms}`.
Every event carries `email`/`clerk_uid` (retrieval key) for both the buyer and the agent id.
Success assertion for the ship manifest: `agent_talk_ready.outcome == ok` from ≥ 2 distinct persons
and `agent_session_settled.gross > 0`.

## 9. Cost & price sanity

Voice ₹4.8/min + backend (gpt-6-astra, light use) ≈ ₹1–3/min + vision ≈ ₹1/image. At the ₹10/min
floor a 20-min slot = ₹200, cost ≈ ₹120–160 → thin; recommend the admin prices companions at
₹15–25/min and readings at ₹30+/min. The floor flag exists so this can be raised without a deploy.

## 10. Rollout (production, in this order, owner confirms each prod write)

1. `wrangler secret put OPENAI_API_KEY` (prod) — **owner supplies the key**.
2. D1: `scripts/cf.sh worker d1 execute DB_META --remote --file=migrations/2026-09-12-agent-live.sql`.
3. `worker/`: `npx tsc --noEmit` → commit → `ALLOW_PROD=1 scripts/cf.sh worker deploy` (adds DO `v24`).
4. Flags: one `flags.sh set` call: `agentListingsEnabled=true` (+ any tuning), wait 60 s, `get`.
5. Web: `gh workflow run web-deploy.yml` (never a laptop Pages deploy).
6. Admin creates the first agent + KB, runs **Test call**; then a real ₹ booking from a second
   person; check the ship-manifest assertions in PostHog.
7. App: `ship it` (alpha) → approve gate → verify `latestAppBuild` moved.

## 11. Open questions for the owner (answered = build)

1. OpenAI platform key + which usage tier (sets `agentPlatformMaxConcurrent`).
2. Should customers who leave early be charged the full slot (rulebook-consistent, proposed) or
   only used minutes?
3. Is the admin's wallet the right destination for the 80 % creator share (proposed), or 100 % to
   the platform fee account?
4. Memory retention: keep forever until the customer taps "Forget me" (proposed), or auto-expire
   after N days?
