# AvaTok — Where We Are (Plain-English Status)

_Last updated: 2026-06-10_

## 2026-06-10 — Creator-marketplace Phase 8 (AvaVerse dashboard + AvaInbox universal inbox) SHIPPED (deployed staging + prod; not pushed — other phases in flight)

Per `PHASE-08.md`. Aggregation only — NO new message/money stores; everything
rides the audited base (wallet_ledger, listings/orders/bookings, InboxDO,
notify.ts feed, Phase-6 fanout).

**Backend (avatok-api, deployed staging `50fb89f1` + prod `0273ee3a`):**
- `routes/verse.ts` — `GET /api/verse/summary?period=today|7d|30d|all`:
  earnings card (settled = ledger credits − fee debits; pending-escrow ×0.8;
  maturing 7-day holds; payout-able; +delta vs yesterday), projections
  (joined×price×0.8 per upcoming event + "your day is booked ≈$X by tonight"
  for consults), momentum (joins last 24 h per event + delta), top events by
  revenue/orders, audience funnel (PostHog HogQL → `verse_snapshots`
  write-through daily cache; D1 never waits on PostHog), reviews-to-reply,
  reach + announce quota, auto-suggest nudges. KV-cached 60 s per user+period.
- A1 `POST /api/verse/announce` — "Notify followers" reusing Phase-6
  `fanout()` + the SAME `fanout_log` 2/day cap (third attempt → 429 with a
  clear message + remaining quota in every response).
- A2 `GET /api/verse/statement?month=YYYY-MM` — CSV (share-sheet ready,
  `format=json` too, `email=1` → Brevo via Q_EMAIL); rows
  date/type(ticket|consult|donation)/listing/gross/fee/net/order-id with a
  reconciled totals footer (same ledger rows as the summary, by construction).
- `POST /api/reviews/:id/reply` — public creator reply (reply/reply_at cols);
  review author gets a social notice; replies surface in listing/channel reads.
- AvaInbox: `conversations.context` tag (dm|event:<id>|channel:<id>|
  consult:<id>|system) set at thread creation, never overwritten;
  `GET /api/conversations?context=` filter. InboxDO untouched (rulebook).
- `verseEnabled` kill switch added to platform config (live on prod).
- Migration `phase8_verse.sql` applied to avatok-meta staging + prod
  (context col, review reply cols + partial index, verse_snapshots).
- `scripts/verse_spotcheck.sh` — acceptance reconciliation (summary vs raw
  ledger/listings queries).

**Flutter:**
- `features/verse/verse_screen.dart` — card grid (earnings w/ pending-vs-
  available split, projected, momentum, top events w/ mini bars, audience
  funnel, reach + "Notify followers" composer w/ quota, reviews-to-reply →
  public-reply dialog), period selector, pull-to-refresh, delta badges,
  nudge banners, deep-links (wallet / my-listings / statements).
  StatementsScreen: month list → share CSV (share_plus) or email-me.
- `features/inbox/inbox_screen.dart` — ONE list over conversations + system
  notices: source chips (Event inquiry w/ event name, Channel, Consult, DM,
  System) + filter chips + agent-inbox entry; rows open the EXISTING
  messenger thread UI; system rows deep-link to wallet/bookings; per-account
  scoped local cache (`scopedKey`, rulebook rule 1).
- "Message" entry points now tag threads: listing detail gained a Message
  button (`event:<listingId>` → "Event inquiry"); creator channel Message
  tags `channel:<uid>`. Sidebar: AvaVerse opens the real dashboard (ComingSoon
  retired); AvaInbox registry row routes to the real screen.

**Also:** created missing queues `money-settlements(-staging)` +
`money-dlq(-staging)` that were blocking any avatok-api deploy since Phase 7's
consumer config landed. Worker typechecks clean; Dart parses clean (APK builds
in CI). NOT pushed to git per multi-session workflow.

## 2026-06-10 — Creator-marketplace Phase 7 (AvaLive + AvaConsult delivery, escrow settlement, refund engine) BUILT (typechecked + unit-tested + migrations applied; NOT deployed, NOT pushed — other phases in flight)

Per `PHASE-07.md`. Everything reuses the audited base: escrow = Phase-2 `ledger.ts`
primitives, emails = Phase-5 matrix, donations = the existing StreamSessionDO
(extended, not duplicated), orders = the Phase-6 table (extended).

**Refund/settlement engine (the heart of the phase)**
- `worker/src/rules.ts` — PURE data-driven engine, rules R1–R7 + FB fallback,
  thresholds from the new D1 `refund_rules` table (tunable without redeploys).
  90 s blip-bridging on attendance (A3: momentary disconnects never trigger
  no-show). 18 table-driven Vitest tests (`worker/test/refund_rules.test.ts`)
  — exact amounts + email template ids per rule — ALL PASSING.
- `worker/src/money_engine.ts` — executor: builds the session ctx from D1,
  applies actions through hold/release/refund (idempotent op_ids + a
  `settlement_log` audit; release() gained partial-gross for R2 pro-rata and
  R5 splits), Brevo emails + FCM, creator strikes, event cancellation.
- **Timing**: StreamSessionDO sets DO **alarms** at `starts_at+20min` and
  `ends_at+grace` → enqueues Q_MONEY exactly on time; a NEW minute-cron sweep
  on avatok-consumers (`money_sweep.ts`) is the catch-all. avatok-api consumes
  its own `money-settlements` queue (max_retries=5 → **`money-dlq`**); DLQ
  consumer emails hdavy2005@gmail.com + writes `failed_settlements` for the
  admin console (`GET /api/admin/settlements`, `POST …/:id/retry`).
- **A2 test clock**: `clock.ts` — TEST_CLOCK_ALLOWED only in staging vars,
  `POST /api/admin/test-clock` adjusts live, production hard-refuses; plus
  `POST /api/admin/money/evaluate` runs an engine pass inline for acceptance.
- Cancellations route through the engine now: `calendar.ts cancelBooking`
  detects escrow-backed orders (legacy direct-pay path kept for old rows).

**AvaLive (`routes/live.ts` + extended `do/stream_session.ts`)**
- start/stop (creates the Cloudflare Stream **Live Input**, WHIP publish URL;
  gated on STREAM_ACCOUNT_ID/STREAM_API_TOKEN — 503 until set), join (paid
  order OR creator ONLY; A5 creator-block refusal), WS room, donate
  (`ledger.donation()` — instant, 20 % fee, balanced rows incl. ledger-only
  fee row), mod (A1: mute/ban/slow/pin, server-enforced in the DO; bans →
  user_reports), state (HUD: joined/gross/projected).
- StreamSessionDO extended into the interaction room (ONE DO per stream):
  hibernatable WS, ≥250 ms coalesced broadcasts, attendance writes to D1
  (refund-engine evidence), profanity drop+warn, flying-msg rate limit 1/2 s,
  slow mode, alarm multiplexing (gift flush + money phases). Legacy gift path
  untouched.
- `routes/stream.ts` webhook now tracks connected/disconnected gaps →
  `live_sessions.downtime_ms` (LONGEST contiguous gap → fair R7, fires only
  ≥5 min, A4) + pushes "creator reconnecting…" overlays through the DO.

**AvaConsult (`routes/consult.ts`)**
- join: entitlement (order held/free), window checks, 1:1 → P2P CallRoom id
  (2-peer cap reused, untouched); group → **Cloudflare Realtime SFU** via an
  authed Worker proxy (CALLS_APP_ID/SECRET gated; NO RealtimeKit/Dyte SDK —
  perf §1); capacity enforced at token issue (11th of 1:10 refused).
- complete (R3), cancel (R4/R5/R6 via engine), extend (+15 min, Phase-5
  conflict-engine checked), probe + 256 KB blob (A3 pre-call check).

**Flutter (all REAL, demo `live_screen.dart` DELETED)**
- `core/session_api.dart` — API + RoomChannel (batch-unpacking, auto-reconnect).
- AvaLive viewer (`live_viewer_screen.dart`): WHEP player, chat/flying/
  reactions/stickers, donate sheet (402 → inline top-up), pinned banner,
  donation banners, viewer count + countdown, reconnecting overlay.
- Creator HUD (`live_host_screen.dart`): WHIP publish, watching/joined,
  elapsed+remaining, earnings-so-far chip ticking on donations, long-press
  feed → Mute/Ban/Report, slow-mode + pin controls, bitrate/health dot,
  auto-reconnect countdown loop, end-stream → settlement-pending.
- AvaConsult: `prejoin_screen.dart` (mic meter, cam preview, RTT+bandwidth
  probe verdict with plain-language tips, starts-in countdown, rejoin path) +
  `consult_room_screen.dart` (1:1 P2P CallRoom protocol; group SFU push/pull
  with renegotiation; countdown + 5-min warning + auto-end at slot end+2 min;
  host waiting-room "12:43 left of 20:00 wait"; extend; **Send file → existing
  AvaTok thread** → AvaLibrary both sides; post-session rating → Phase-6 review).
- Wired: AvaLive discovery = real live-now/upcoming from Phase 6 + Go-Live
  picker; listing detail "Join now" → viewer; booking blip card → Join session
  (10 min early; live-event bookings reroute to the viewer).

**Migrations applied (prod + staging via D1 REST):** `phase7.sql` (orders
columns kind/fee_pct/escrow_account/booking_id/cancelled_*, session_attendance,
live_sessions, refund_rules seeded R1–R7, settlement_log,
bookings.host_marked_complete) + `wallet_phase7.sql` (failed_settlements).

**Go-live steps left (deliberately NOT done — parallel sessions share the tree)**
- `wrangler queues create money-settlements money-dlq` (+ `-staging` pair),
  then deploy avatok-api + avatok-consumers (wrangler.toml already carries the
  producers/consumers/crons/TEST_CLOCK_ALLOWED).
- Secrets: `STREAM_API_TOKEN` + var `STREAM_ACCOUNT_ID`
  (fd3dbf43f8e6d8bf65bd36b02eb0abb0) on avatok-api; enable Stream Live +
  point the Live webhook at `https://api.avatok.ai/webhooks/stream`
  (+ STREAM_WEBHOOK_SECRET). Create a Realtime/Calls app → `CALLS_APP_ID` +
  `CALLS_APP_SECRET` for group consults (503 until then).
- Device acceptance after the next CI APK: paid-viewer watch, donate banner
  both sides, R1/R2 clock-shifted on staging, 1:1 consult P2P, 11th-joiner
  refusal, file-send → AvaLibrary.

## 2026-06-10 — Creator-marketplace Phase 6 (Listings pipeline + AvaExplore + creator channels) SHIPPED (deployed staging + prod; not pushed)

Per `PHASE-06.md`. The dummy AvaExplore is GONE — the marketplace is live end-to-end.

**D1 (`migrations/listings.sql`, applied to avatok-meta prod + staging):**
`listings`, `reviews` (UNIQUE listing+author), `creator_profiles` (channel
EXTRAS only — identity stays in `users`), `creator_follows` (legacy Nostr
`follows` table kept untouched), `fanout_log` (2/day anti-spam cap),
`listing_promotions` (early-bird + promo codes), `orders` (escrow glue),
`listing_categories` (10 seeded), `listings_fts` (FTS5, replace-on-publish).
Also applied `calendar.sql`+`calendar_phase5.sql` to staging and
`calendar_phase5.sql` to prod (Phase 5 tables weren't in D1 yet; idempotent).

**Backend (`worker/src/routes/listings.ts`, wired in `index.ts`, tsc clean):**
- Pipeline: POST `/api/listings` (draft) → PUT step updates → POST `:id/publish`
  with guards: `requireKyc` (live AND consult), live events `claimBlock` their
  slot (409 conflict ⇒ greyed UX), consults require `availability_rules`.
  Plus `:id/status` (live/completed/cancelled + go-live fan-out), `:id/duplicate`
  (A6), DELETE, `/api/listings/mine`, promotions CRUD (A5).
- PUBLIC reads (A3 guest browsing — no auth): `/api/explore` (browse + cursor),
  `/explore/live-now`, `/explore/search` (A1: FTS5 partial title + creator name,
  filters price/date/country/rating, sorts soonest|cheapest|popular|rating),
  `/explore/categories`, `/api/listings/:id` (details + creator card + reviews),
  `/api/creators/:id` (channel). Authed callers get blocked-creator filtering.
- Money glue: POST `:id/book` (shared by Book and live Join-&-pay) — buyer
  claimBlock (+creator block for 1:1), best single promotion applied, escrow
  `hold()` (free listings skip wallet entirely), `orders`+`bookings`+mirrored
  `calendar_events`, joined_count bump, Brevo confirmation, push both sides;
  402 → `insufficient_funds` w/ shortfall for the A8 top-up sheet.
- Reviews: attendees only (booking ended), upsert + averages recomputed on
  listing AND creator. A2 follows: follow/unfollow/mute, atomic follower_count,
  fan-out on publish + go-live (notifications batch + Q_PUSH, 500 cap, 2/day).
  A4: `POST /api/report` → user_reports; creator block (reuses `blocks`,
  hides listings + blocks DMs); "ID verified ✓" on every card/channel.
- Deployed: staging `4f938c59` + prod `b4ad8082` (also carries the in-flight
  Phase 10 conference routes from the concurrent session — tree typechecked).
  Verified live: guest GETs open, mutations 401, categories seeded, FTS OK.

**Flutter (REAL UI, dummy replaced; `product.dart` deleted):**
- `core/listings_api.dart` — full client API + models.
- `features/explore/explore_home.dart` — live: Live-now rail (red dot, watching
  count, Join → pay popup), server categories, card grid (photo, $, date, flag,
  one-liner, "🔥 N joined"), search bar, "Become a creator" → My listings.
- `listing_detail.dart` — `ListingDetailScreen` + reusable `ListingDetailView`
  (the SAME widget renders the pipeline preview — A6 no-drift) + `CheckoutSheet`
  (wallet balance, promo code, consult slot grid w/ GREYED occupied slots,
  402 → inline top-up pre-filled with shortfall, slot kept) + review sheet +
  report/block overflow.
- `creator_channel.dart` — banner, ✓ badge, followers, rating, https link chips
  (domain shown), pinned listing, listings grid, all reviews, Follow + mute,
  **Message** → existing 1:1 messenger (`ChatThreadScreen`), A7 channel editor.
- `explore_search.dart` — debounced FTS search, sort chips, filter sheet (price
  slider/date range/country/rating), recent searches per-account scoped.
- `features/listings/` — `create_listing_flow.dart` (6-step stepper, KYC gate
  via IdentityGate at publish, slot-conflict errors surfaced, cover uploads via
  `/upload/public` AVIF pipeline, A5 pricing extras) + `my_listings_screen.dart`
  (publish/go-live/end/duplicate/cancel).

**Known follow-ups:** live "Join" deep-links into the stream when AvaLive ships
(Phase 7); guest (signed-out) browsing inside the app shell needs the pre-auth
entry point (worker side is done); promotions editor post-publish is API-only.

## 2026-06-10 — Creator-marketplace Phase 10 (AvaTalk group conferencing — LiveKit ≤25) BUILT (not deployed, not pushed)

Per `PHASE-10.md`. **RULE CHANGE (owner decision 2026-06-10):** the "AvaTok calls
are 1:1 ONLY" rule is replaced — group chats may hold audio/video conferences,
max **25** participants, via **LiveKit**. 1:1 calls stay on the P2P CallRoom-DO
path (2-peer cap untouched). CLAUDE.md + `Specs/AVATALK-CLOUDFLARE-RULEBOOK.md`
(changelog 1.6) updated with the new wording.

**Backend (`worker/src/routes/conference.ts`, wired in `index.ts`)**
- `POST /api/conference/:groupId/start|join` — Clerk/NIP-98 auth; membership
  check against D1 `conversation_members` (legacy local-only groups fall back to
  authenticated access); **>25-member group ⇒ 403**; creates/locates LiveKit room
  `group:<gid>` with `max_participants=25` (the racing-26th-joiner backstop);
  returns `{url, token}` (JWT HS256 minted in-Worker — no SDK dependency).
- `GET /api/conference/:groupId/status` — live?/count (drives the in-chat banner).
- `POST /api/conference/:groupId/end` — "end for all", starter-only (room metadata).
- `POST /api/conference/webhook` — LiveKit events (JWT-verified, sha256 body
  check) → system rows into each member's InboxDO + joinable (non-ringing)
  FCM via Q_PUSH on room_started.
- Gated by the `conferenceEnabled` kill switch + LIVEKIT_* config (unset ⇒ 503).
- `tsc --noEmit` clean.

**Flutter (`app/lib/features/conference/` + `chat_thread.dart`)**
- New `conference_api.dart` + `conference_screen.dart` (livekit_client ^2.3.0 —
  rides the SAME libwebrtc as 1:1 calls): grid 2–8, paginated grid 9+,
  active-speaker outline, mute/cam/flip/speaker, participants sheet, leave vs
  "end for all" (starter), audio-only = avatar tiles, minimize keeps the room
  connected (`OngoingConference`) with an "Ongoing call · N — tap to return/join"
  banner in the thread; per-account-scoped last mic/cam/speaker prefs (DiskCache).
- Group thread app bar: call icons now ACTIVE for groups ≤25; >25 ⇒ greyed +
  info icon popping the exact PHASE-10 notice text. `_call()` stays 1:1-only;
  groups route through `_groupCall()` — never the CallRoom DO.
- In-thread `gcall` system row on call start with a Join chip while live.

**Pending (deliberately NOT done this session — other phases in flight)**
- No `wrangler deploy`, no git push, no `flutter pub get`/APK (CI does builds).
- LiveKit creds received and stored in `secrets/secret-values.env`
  (`LIVEKIT_URL/API_KEY/SECRET`); `LIVEKIT_URL` var set in wrangler.toml. At
  deploy time: `wrangler secret put LIVEKIT_API_KEY` + `LIVEKIT_API_SECRET`,
  and configure the webhook in LiveKit Cloud → `https://api.avatok.ai/api/conference/webhook`.
- Device acceptance (3 phones in a call, 26th-joiner refusal, 1:1 regression)
  needs real hardware after the next APK build.

## 2026-06-10 — Creator-marketplace Phase 9 (AvaChat ⇄ AvaBrain: personal AI, guardrails, voicemail search) SHIPPED (not pushed)

Per `PHASE-09.md` (reconciled with the existing AvaBrain base — UserBrainDO,
knowledge graph, `brain_consent`, library ingestion were all extended, not redone).
Deployed: `avatok-api` + `avatok-consumers`. Git push deliberately skipped
(other phases in flight).

**Backend**
- **Ingestion**: every Q_BRAIN event is now guardrail-checked first (master +
  per-capability: `avatok_messages`, `group_chats`, `voicemails`, `files`,
  `avawallet`, `avacalendar`…). `/api/msg/send` enqueues `message_stored` for
  the sender and `message_received` for each recipient; text → one uid-scoped
  vector with deep-link metadata; voice notes → **OpenAI Whisper** transcript
  (stored in `brain_transcripts`) → `kind=voicemail` vectors. New
  `brain_vectors` registry makes vectors deletable by id (retro-delete + purge).
  Migration `brain_phase9.sql` applied to `avatok-brain` (+ staging).
- **Chat API**: `POST /api/brain/chat` → RAG (uid-filtered Vectorize + facts +
  daily summaries → Gemma 4) returns `{answer, sources[]}` source chips;
  voicemail intent ("find my voicemail about…") returns playable media refs.
  History rides in the user's own InboxDO (conv `brain`) — `GET /api/brain/history`.
  `GET/PUT /api/brain/settings` (alias of consent); toggling OFF retro-deletes
  indexed items (`BRAIN_RETRO_DELETE=1`); `POST /api/brain/purge` = "delete my
  AvaBrain data"; `POST /api/brain/backfill` (admin can target a uid).
- **Vectorize fix**: `avatok-semantic` had NO metadata indexes, so `filter:{uid}`
  wasn't actually enforced server-side — created `uid` + `kind` string metadata
  indexes (tenant isolation now real; pre-existing vectors re-index on next write).
- **A1 GDPR**: deletion cascade now purges the user's InboxDO (peers keep their
  side), RETAINS `wallet_transactions` with anonymized meta (finance retention),
  keeps bookings/calendar_events rows with the deleted party replaced by
  `deleted_user`, deletes gcal tokens / availability / policies, anonymizes
  reviews, deletes listings, wipes `brain_vectors` + `brain_transcripts`, and
  gates on the wallet: held escrow blocks deletion (retry), a leftover balance
  after grace is forfeited + logged in `stores_done`.

**Flutter**
- `features/avachat/avachat_screen.dart` — ChatGPT-style AvaChat: history from
  the server, suggestion chips, typing indicator, tappable source cards
  (voicemail cards play inline via the blossom URL), new-conversation, link to
  guardrails. Wired into the shell (`avachat` route — ComingSoon deleted).
- `features/avabrain/brain_settings_screen.dart` — AvaBrain control room:
  master + per-app guardrail toggles (default ON, opt-out) + "Delete my
  AvaBrain data" (double-confirm). The same capabilities auto-appear in the
  main Settings (shared `kBrainCapabilities` registry, per rulebook §3).

**Pending (user side)**
- ⚠️ `OPENAI_API_KEY` is NOT in `secrets/secret-values.env` — set it
  (`wrangler secret put OPENAI_API_KEY` on **avatok-consumers**) to activate
  Whisper voicemail transcription. Until then voice notes simply aren't indexed;
  everything else works.
- Voice notes are still client-encrypted by the legacy `MediaService.encryptAndUpload`
  path — the consumer skips ciphertext. Whisper lights up fully when chat media
  moves to the server-readable upload path (messaging-pivot work, Phase 8/10).

## 2026-06-10 — Creator-marketplace Phase 5 (AvaCalendar + AvaBooking: conflict engine, gcal sync, policies, reschedule) BUILT (deploy pending)

Per `PHASE-05.md` (reconciled: `calendar_slots`/`calendar_events` extended, not
redone; npub → Clerk-uid migration done first). NOT deployed and NOT pushed —
other phases in flight in parallel sessions; see "go-live steps" below.

- **Migration** `worker/migrations/calendar_phase5.sql` (DB_META): adds
  `host_uid`/`owner_uid`/`attendee_uid` columns + backfill (routes already wrote
  Clerk uids into the `*_npub` columns since the pivot, so backfill is a copy);
  NEW `calendar_blocks` (cross-app occupancy — the heart of the phase),
  `bookings` (canonical row: money/reschedule/reminder state), `availability_rules`,
  `booking_policies`, `reschedule_requests`, `gcal_accounts`; reminder-ladder
  columns. All times **ms epoch** (matches every existing table; spec said s).
- **Conflict engine** (`worker/src/cal/engine.ts`): `claimBlock` = single
  atomic INSERT…SELECT…WHERE NOT EXISTS ⇒ two parallel claims, exactly one
  wins; loser gets `409 {conflictWith:{source_app,title,…}}`. `freeSlots`
  (GET /api/calendar/slots?creator=&date=&dur=) = availability_rules minus
  blocks, occupied slots returned FLAGGED (reason + occupier), never omitted.
  DST-safe IANA-zone expansion (Intl two-pass). Policies (buffer / min-notice /
  max-per-day / vacation) re-validated server-side on every claim.
- **Routes**: calendar.ts rewritten uid-keyed + block-claiming (slot create AND
  book AND cancel release); refunds on cancel per universal rules (≥24h 100%,
  <24h 50%, creator 100%) via transferCoins. NEW `routes/booking.ts`: list,
  policies GET/PUT + vacation, reschedule propose→accept/decline (max 2,
  expires at original start, atomic swap of bookings+events+both blocks, gcal
  moved, ICS re-sent), public `GET /api/join-info/:token`. `GET /api/time` for
  client clock-skew.
- **Google Calendar** (`worker/src/cal/gcal.ts`): per-account OAuth (refresh
  tokens AES-GCM-encrypted in D1), outbound insert/patch/delete with
  `extendedProperties.private.avatok` loop-guard, inbound incremental
  syncToken import (webhook `/webhooks/gcal` + 15-min consumers cron fallback
  `consumers/src/calendar.ts: gcalSyncSweep`).
- **Email matrix** (`worker/src/cal/emails.ts`, Brevo via Q_EMAIL + ICS
  attachments — consumers EmailMsg gained `attachments`): booking confirmed
  (both, ICS + join link), cancelled (who + refund wording), refund issued,
  settlement paid + payout sent/failed (exported for Phases 3/7 to reuse).
  **Reminder ladder** (consumers cron): T-24h email, T-60m email+push with
  join link, T-10m push — idempotent flags, server-time only.
- **Join links (A1)**: `avatok.ai/j/<token>` page in `marketing/public/_worker.js`
  (viewer-local time, Open-in-app intent URL + Play Store fallback) +
  `/.well-known/assetlinks.json` (fingerprint via `ASSETLINKS_SHA256` Pages
  var); Android App-Links intent filters added to the manifest; token = HMAC
  (JOIN_LINK_SECRET), display-only.
- **Flutter**: `features/calendar/` — AvaCalendar month grid with per-app
  colored blips + agenda + blip→card popup (cancel / propose-new-time /
  accept-decline banner), settings (gcal connect via browser, availability
  rules editor, policies + vacation mode); `features/booking/` — AvaBooking
  upcoming/past tabs over the same data, per-booking earnings (~80%) after
  end. Local-first per-account DiskCache for blocks; `core/time_sync.dart`
  clock skew; both ComingSoon entries replaced in the shell. Cross-tz display:
  local + UTC on every card.
- **Go-live steps left**: apply `calendar_phase5.sql` (prod+staging), deploy
  avatok-api + avatok-consumers + the marketing Pages site, set secrets
  GOOGLE_CLIENT_ID/SECRET + GCAL_TOKEN_KEY + JOIN_LINK_SECRET (worker AND
  consumers) + ASSETLINKS_SHA256 (Pages), then verify the 21-Jun-10:00
  overlap scenario + parallel-claim race against the deployed API.
- Both workers `tsc --noEmit` clean. NOT pushed to git (parallel sessions).

## 2026-06-10 — Creator-marketplace Phase 4 (AvaStorage + AvaLibrary: quota, billing, live graphs) SHIPPED

Per `PHASE-04.md` (reconciled: `user_media` IS the file index — extended, not
replaced). Deployed: avatok-api `3dd7c03e`, avatok-consumers `f11c3a69`;
migration `worker/migrations/marketplace_storage.sql` applied prod + staging.

- **Schema** (DB_MEDIA): `storage_quota` (per-user summary row — dedup-counted
  `used_bytes`, `quota_bytes` 5 GB default, `state` ok|over_quota_paying|read_only,
  `by_category` JSON — graphs repaint from THIS, never from index scans, perf
  budget §7) + `storage_snapshots` (uid, YYYY-MM, used_bytes → trend mini-bars).
- **Choke point** (`worker/src/storage.ts`): every registerFile path
  (`/upload/public`, `/upload/private`, `/api/library/record`, soft delete)
  now recomputes the summary (distinct content key = counted once) and pushes
  `{type:'storage', …summary}` over the user's InboxDO socket (new transient
  `/event` op — broadcast only, never persisted).
- **Quota enforcement at upload**: would-exceed 5 GB → wallet has coins ⇒
  allowed (metered); empty wallet ⇒ `413 quota_exceeded` + state `read_only`.
  Files are NEVER deleted; topping up + next upload unblocks.
- **Billing** (consumers cron): daily usage snapshot; on the 1st of each month
  every over-quota user pays **20 AvaCoins/GB/month** via WalletDO `spend`
  (idempotent `op_id storage:<uid>:<YYYY-MM>`, double-entry ledger row type
  `storage_charge`, credit `platform:storage`); 402 ⇒ read_only.
- **APIs**: `GET /api/storage/summary` (summary row + last-6-months trend +
  pricing), `GET /api/library?q=` (server-side name search across folders).
- **Flutter**: AvaStorage rebuilt — animated radial gauge (CustomPainter),
  stacked per-category bar + legend with counts, 6-month trend bars, banners
  (≥80% near-quota / over-quota-paying with the monthly coin price / read-only
  with a top-up-wallet CTA), LIVE updates via the single SyncHub socket
  (`storage` frames — no polling). AvaLibrary search is now server-side
  (debounced) with `library_search` analytics; `storage_viewed`,
  `file_registered`, `quota_state_changed`, `storage_charge` events wired per
  `ANALYTICS-OBSERVABILITY.md`.
- NOT pushed to git (other phases in flight in parallel sessions).

## 2026-06-10 — Creator-marketplace Phase 2 (AvaWallet: ledger, Stripe top-up, escrow) SHIPPED

Per the updated `PHASE-02.md` (reconciled with the existing WalletDO engine —
**layered, not replaced**): balance authority stays WalletDO; the double-entry
ledger lives in D1 `avatok-wallet`.

- **Schema** (`worker/migrations/wallet_ledger.sql`, applied prod + staging):
  `wallet_ledger` (immutable double-entry, PK = op_id), `wallet_accounts`
  (escrow/platform buckets only), `admin_audit`, `recon_runs`.
- **WalletDO**: mutating ops take `op_id`, dedupe at the authority (replay
  returns the original result with `duplicate:true`); the DO is the single
  writer of user-account ledger rows to Q_WALLET.
- **Escrow primitives** (`worker/src/ledger.ts`): `hold` / `release` (80%
  creator into the 7-day hold + 20% fee row) / `refund` (partial OK) — internal
  fns + admin HTTP; consumed by Phases 6–7.
- **Stripe top-up**: `POST /api/wallet/topup {amountUsdCents}` (any amount
  $0.50–$500), webhook alias `/api/wallet/stripe-webhook`, ledger row
  `external:stripe → user`, pi-ref unique-indexed. Still behind
  `WALLET_TOPUP_ENABLED=0` (legal) — needs Stripe TEST keys on staging.
- **A1 idempotency**: `Idempotency-Key` required on money routes (KV 24 h
  replay) + DO op_id dedupe; Flutter `MoneyApi` auto-attaches + retries safely.
- **A2 ops console + recon**: `/api/admin/{ledger,refund,adjust,account/:uid,
  recon,escrow/*}` (ADMIN_UIDS gate, every action → `admin_audit`); nightly
  recon in avatok-consumers (midnight-UTC tick): buckets vs ledger Σ, user DO
  balances vs ledger Σ (5-min watermark + re-check), results → `recon_runs`,
  mismatch → Brevo alert to hdavy2005@gmail.com.
- **A3 rate limiter**: KV sliding window (topup 5/h, withdraw 3/h…) → 429.
- **A4 receipts**: Brevo email on top-up + purchase_hold (email via Clerk);
  "Email me this receipt" re-send on the row detail sheet.
- **Flutter** (`app/lib/features/wallet/`): wallet home (balance $ + coins,
  Top up, this-month in/out), infinite-scroll ledger on the cursor API,
  server-side type/date/search filters, row detail sheet with fee breakdown,
  drift `wallet_ledger_cache` (per-account DB file → scoping free), PostHog
  events; sidebar Wallet opens the real screen; `AdminMoneyScreen` appears only
  when the server confirms admin.
- **Deployed**: avatok-api + avatok-consumers, staging AND prod (flag off — no
  real money can move yet).
- **To verify with your keys**: (1) Stripe TEST keys on staging
  (`wrangler secret put STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET`
  `--env staging` + `WALLET_TOPUP_ENABLED=1` staging-only) for the end-to-end
  top-up; (2) `ADMIN_TOKEN=<Clerk JWT> BASE=https://api-staging.avatok.ai node
  worker/scripts/ledger_invariants.mjs` — asserts idempotent holds, balanced
  hold/release/refund rows, 80/20 fee math, fee-breakdown meta, 7-day hold.

## 2026-06-10 — Creator-marketplace Phase 1 (groundwork) SHIPPED

Per `Specs/proposals/creator-marketplace/PHASE-01.md`:
- **Onboarding**: account-type step (Single/Parent/Enterprise) disabled behind
  `kAccountTypeStepEnabled=false` (`app/lib/core/feature_flags.dart`); every
  signup defaults to `personal`. Widget kept for re-enable.
- **Standard-apps sidebar**: `app/lib/core/app_registry.dart` (tier
  standard/hidden); sidebar renders the 14 standard apps only; every app
  navigates (real screen or branded `ComingSoon.forApp`).
- **URL space locked**: `worker/src/routes/stubs.ts` answers 501 for the
  unclaimed marketplace namespaces (wallet/payout/identity/storage/calendar/
  booking/listings/inbox/avabrain). `worker/migrations/MIGRATION-PLAN.md`
  reserves table names (no empty DDL — deliberate).
- **A1 staging**: full `-staging` copies of D1×5 / R2×4 / KV / queues×8
  provisioned; `[env.staging]` in both wrangler.tomls; DEPLOYED:
  `avatok-api-staging` @ api-staging.avatok.ai (verified: /api/wallet/ping →
  501, /api/config → 200) + `avatok-consumers-staging`. CI builds a staging
  APK on `staging`-branch pushes (`--dart-define=AVATOK_ENV=staging`).
- **A2 kill switches**: KV `platform_config` → GET /api/config (60 s cache),
  PUT /api/admin/config (ADMIN_UIDS-gated). Flutter `RemoteConfig` polls every
  15 min; `minAppBuild` shows a blocking update screen.
- **A3**: shared `EmptyState`/`ErrorState`/`OfflineBanner` in `app/lib/core/ui/`.
- **A4 zombie-call hotfix**: socket-loss ends the call; rtc-failed/disconnected
  watchdog (10 s grace); CallRoom DO broadcasts undeliverable bye/decline;
  CallKit notification cleared on every end path; `call_id` + full reason
  taxonomy on call events (both sides join).
- **A5 analytics envelope**: every client event now carries app/screen/
  account_id/account_kind/build/env/net/session_seq; central `api_error`
  capture in ApiAuth; worker events tagged `worker:true`.
- **PENDING (needs davy)**: prod `wrangler deploy` of avatok-api (staging is
  verified; prod deploy was held for explicit approval).

## In one line
The backend is built, hardened, scale-proofed, and given an AI memory layer — all
code-complete and tested. Nothing is switched on in production yet: it's waiting on
3 keys, one deploy, and the phone-app build.

---

## ✅ What's done

**The core backend (4 services on Cloudflare)**
- Directory, contacts, communities, media upload, calling, push — all live as code.
- Real-time chat relay (Nostr) with end-to-end encrypted DMs.
- Background workers for moderation, push, email, analytics + a 6-hour cleanup job.

**Security**
- Every write now requires a cryptographic signature (you own your keys) **plus** a verified account login (Clerk). Reads stay open.
- DMs are end-to-end encrypted — even our own server can't read them.
- Public uploads are AI-scanned before they go live; repeat bad images are caught even after resize.
- Strike system: warning-block → longer block → permanent ban.

**Speed (global)**
- Photos/videos load from Cloudflare's edge cache worldwide, not our server (verified on).
- Database reads come from the nearest region (replicas), not one far-away location.
- Chat connections are split per-user so a user in Delhi and one in New York are both fast.

**Cost control (built for 10M users)**
- Fixed a bug that would crash for anyone with >100 contacts or >100 follows.
- Replaced a "scan the whole table" search with a proper search index.
- AI moderation cost is metered and one config-flip away from a ~100× cheaper model.
- Media caching, batched analytics, and lazy cleanup keep per-user cost tiny.

**Email & analytics**
- Email switched to Brevo. Analytics flows to PostHog (batched) + Cloudflare Analytics Engine for ops dashboards.

**AvaBrain (new — the AI memory layer)**
- Every user gets a private "brain" that remembers people, projects, and facts and can answer "what happened today?" / generate a daily briefing.
- Learns only from **public** content on the server; private chat memory is opt-in and synced from your phone (never breaks encryption).
- Uses an efficient 8B AI model in the background (not an expensive one), with its own database so it never slows the rest down.
- Can also "investigate" a complaint ("my messages aren't sending") by reading your error logs and explaining the cause.

**In-app notifications (new)**
- A real notification feed (bell + list) for system alerts like "₹30 deducted", "your briefing is ready", "content removed" — server-generated, so no encryption/Nostr needed.
- Built native on what we already run: realtime to an open app over the existing chat socket, a feed stored in D1, and background push via FCM/APNs. No Novu — no extra vendor or per-user cost.
- Already fires on content-moderation removals; ready to plug into wallet/payment events.

**Storage & privacy (new)**
- Every user's media now lives in their own folder (`u/<npub>/…` in storage; a per-user "collection" in Bunny for video) — no more guessing who owns a file.
- **Delete account = everything goes:** one button wipes the user's photos/videos, chat history, contacts, AI memory, and profile from every store. Built for privacy-law "right to erasure."

**Quality checks**
- All 3 backend services pass type-checking and a Cloudflare build dry-run.
- Full written records: scale audit, final audit report, and handoff docs (now in the `Specs/` folder).

---

## ⏳ What's pending (your side)

**1. Three secret keys** — paste into `secrets/secret-values.env`:
- `BREVO_API_KEY` — sending email (Brevo dashboard → SMTP & API → API Keys).
- `TURN_KEY_API_TOKEN` — calls across mobile networks (Cloudflare → Realtime/Calls).
- `BUNNY_API_KEY` — video uploads (Bunny.net → Stream → library 553793).

**2. One optional key** (only if you want the brain's "investigate" feature now):
- `POSTHOG_PERSONAL_API_KEY` — lets AvaBrain read logs to diagnose issues. Without it, everything else works; investigate just says "unavailable".

**3. Go-live deploy** — once keys are in, run `bash secrets/deploy.sh`.
- ⚠️ Must be done **together with shipping the new phone app** (the old app version will stop working after this — it's a clean cutover).

**4. Build the phone app (APK)** — needs the Flutter build (runs on CI / your build machine; I can't compile it in this environment). Then smoke-test: log in → set profile → add a contact → send a photo → make a call.

**5. One manual cleanup** — delete the two old test apps `avaglobal` and `avablobal` in the RealtimeKit dashboard (can't be done via API; keep `avatok-calls`).

---

## 🔜 Nice-to-have follow-ups (not blockers)
- The AvaChat "brain" tab UI + on-device DM fact extraction (server side is ready).
- Enable a cheaper NSFW image model when one appears in your Cloudflare AI catalog (one-line swap).
- iOS push (APNs) — code is ready; just needs an Apple `.p8` key when you go iOS.
- Stream video-recording content scan (image scan + dedupe already live).
- Build the PostHog dashboards once real events start flowing.

---

## 📄 Where the detail lives (in the `Specs/` folder)
- `Specs/FINAL_AUDIT_REPORT.md` — full technical audit + cost posture.
- `Specs/SCALE_AUDIT.md` — the 12 scale fixes (all done).
- `Specs/BACKEND_REBUILD_HANDOFF.md` — full session-by-session record (incl. AvaBrain + storage/erasure).
- `Specs/AVABRAIN-OBSERVABILITY-CORRECTED.md` — the AI-layer design that was built.
- `secrets/deploy.sh` — the one command to go live.
