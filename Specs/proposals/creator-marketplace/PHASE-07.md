# Phase 7 — AvaLive + AvaConsult Delivery, Escrow Settlement, Refund Engine

**Read first:** `00-UNIVERSAL-PROPOSAL.md` §4 (money + refund rules), §6 (video
stack). Prereqs: Phases 2, 3, 5, 6.

## Objective
Deliver the sessions people paid for: AvaLive streaming (creator streams from the
phone; buyers watch live), AvaConsult video sessions (1:1 P2P; 1:10/1:20 via SFU),
then settle escrow (80/20) or refund by rule. Emails at every money event.

## ⚠️ ALREADY BUILT — verified 2026-06-10. Reuse, don't duplicate.
- **Donations/gifts engine EXISTS:** `worker/src/do/stream_session.ts`
  (StreamSessionDO) — per-stream gift aggregation that settles to the creator's
  WalletDO. **The "donate" feature = the existing gift flow** + a ledger row
  type `donation` via Q_WALLET + the on-screen banner. Do NOT build a separate
  donation path.
- **Stream webhook EXISTS:** `worker/src/routes/stream.ts` — Cloudflare Stream
  Live event sink (live_input lifecycle) + post-stream recording dispatched to
  Q_MODERATION. Extend it for attendance/no-show evidence; don't re-create.
- **LiveRoomDO:** prefer EXTENDING StreamSessionDO (it already holds per-stream
  state + sockets pattern) into the interaction room (reactions/flyers/
  stickers/moderation) rather than adding a parallel DO — decide in-session
  after reading the file; either way ONE DO per stream, not two.
- `bunny.ts` + `bunny_collections` = legacy Bunny.net video storage — do not
  wire new work to it; Stream/R2 only.
- **avaconsult/ dir** contains an earlier RealtimeKit-based consult app — treat
  as REFERENCE ONLY: the perf budget (§1) forbids shipping the RealtimeKit/Dyte
  SDK; consult group calls use Cloudflare Realtime SFU via its HTTPS API +
  the shared `flutter_webrtc`.
- Orders/escrow/refund engine + attendance: genuinely NEW — build as specced
  (on the Phase 2 WalletDO primitives).

## Video stack (per owner direction)
- **AvaLive (1→many):** Cloudflare **Stream Live** — create Live Input per event;
  creator publishes via WHIP (low-latency WebRTC ingest) from the phone; viewers
  play LL-HLS/WebRTC playback URL. Webhook `live_input.connected/disconnected`
  already partially handled — extend it. (Verify current CF offering with
  `mcp__cloudflare__docs` at build time; use Realtime/SFU broadcast if Stream Live
  latency is unacceptable for interactive shows.)
- **AvaConsult 1:1:** P2P WebRTC via existing CallRoom-DO signaling pattern
  (2-peer cap reused).
- **AvaConsult 1:10 / 1:20:** Cloudflare **Realtime (RealtimeKit)** SFU — the
  `avaconsult/` dir already uses RealtimeKit; productionize it. Capacity from the
  listing (10 or 20) enforced at token issue.
- Access control: join token issued ONLY to users with a paid order for that
  listing (creator gets a host token).

## Backend (`routes/live.ts`, `routes/consult.ts`, `orders` table)
```sql
CREATE TABLE orders (
  id TEXT PRIMARY KEY, listing_id TEXT, buyer_id TEXT, creator_id TEXT,
  kind TEXT, amount INTEGER, fee_pct INTEGER DEFAULT 20,
  status TEXT NOT NULL,
  -- held|settled|refunded_full|refunded_partial|cancelled
  escrow_account TEXT,            -- 'escrow:<orderId>'
  booking_id TEXT, created_at INTEGER, updated_at INTEGER
);
CREATE TABLE session_attendance (
  order_id TEXT, user_id TEXT, role TEXT,        -- host|attendee
  joined_at INTEGER, left_at INTEGER,
  PRIMARY KEY(order_id, user_id, joined_at)
);
```
- **Session lifecycle:** scheduled → (start window) → live → ended → settled.
  Host start/stop + webhook events write attendance; attendance is the evidence
  for the refund engine.

### Refund/settlement engine (DO Alarms + cron sweep)
Precision timing via **Durable Object Alarms**: each session's DO (LiveRoomDO /
consult session) sets alarms at `starts_at`, `starts_at+20min` (no-show check),
and `ends_at` — rules fire exactly on time, co-located with attendance state.
A minute-cron on `avatok-consumers` remains as the SWEEP (catches missed alarms,
settles ended sessions) so the system is alarm-precise and cron-safe.
Data-driven rules table; initial rules:
| # | Condition (evaluated at/after start time) | Action |
|---|---|---|
| R1 | Creator never went live/joined within **20 min** of start | 100% refund all orders, cancel event, email both sides, creator strike |
| R2 | Creator present, buyer never joined, creator waited **20 min** (1:1) | Creator receives 20-min pro-rata (`price × 20/duration`, fee applies), remainder refunded, "you never showed up" email |
| R3 | Session completed normally (ended after ≥50% duration or host marked complete) | `release(order)` → 80% creator / 20% platform, settlement email |
| R4 | Buyer cancels ≥24 h before | 100% refund |
| R5 | Buyer cancels <24 h | 50% refund, 50% to creator (fee applies) |
| R6 | Creator cancels | 100% refund + strike |
| R7 | Platform failure (stream infra error) | 100% refund, no fee |
Rules stored in a config table (`refund_rules`) so thresholds (20 min, 24 h, 50%)
are tunable without redeploys. Every action = ledger rows (Phase 2 primitives) +
Brevo email from templates + FCM push. All transitions idempotent.

## Flutter

### Live interaction layer (backend, powers the viewer/creator UIs)
- **LiveRoomDO** per live event: one WS per participant, broadcasts low-value
  high-volume events (reactions, flying messages, sticker drops, viewer-count
  ticks, donation banners). Ephemeral — not stored in InboxDO; coalesced ≥250 ms
  batches (perf budget §4). Auth: join token only with a paid order (host token
  for creator).
- `POST /api/live/:id/donate` {amount} → wallet ledger `donation` (instant to
  creator minus 20% fee, universal §4) → LiveRoomDO broadcasts a donation banner
  {name, amount} → creator HUD increments live earnings.
- Stickers/emoji sets: static asset catalog (small, tree-shaken); flying messages
  are plain text ≤120 chars, rate-limited per user (1/2 s) + moderation hook.

### AvaLive — viewer UI (TikTok/YouTube-Live conventions)
- Full-bleed player (LL-HLS), overlay: scrolling chat, **flying messages**
  (bullet-style across the video), **emoji reactions** (tap-burst hearts etc.),
  **sticker sends**, **Donate button** → amount sheet → wallet deduct → their
  donation banner animates on-stream for everyone.
- Top bar: creator chip (tap → channel), LIVE badge, **viewer count**,
  **time remaining** (scheduled end countdown). Leave/rejoin within entitlement.
- Insufficient wallet balance on donate → inline top-up (Phase 2 sheet).

### AvaLive — creator UI (broadcast HUD)
- Go-live (WHIP publish, camera/mic/flip), HUD: **how many joined / watching
  now**, **elapsed + time remaining**, earnings-so-far chip (ticket revenue +
  live donations ticking up), donation/reaction feed, pinned-message control,
  end-stream → settlement-pending state.

### AvaConsult — buyer (end-user) room UI
- Join from booking card/reminder email deep-link → pre-join screen (cam/mic
  preview, "starts in 03:12") → room: 1:1 mirrors the existing AvaTok call
  screen; group (≤10/20) = grid + active speaker (Cloudflare SFU via
  flutter_webrtc, perf budget §1). **Time remaining countdown** visible; 5-min
  warning toast; session auto-ends at slot end (grace 2 min).

### AvaConsult — creator room UI
- Today's sessions list → room as host: same controls + **time remaining**,
  waiting-room indicator ("waiting for buyer… 12:43 left of 20:00 wait" — feeds
  refund rule R2), next-booking peek, extend-session offer (only if next slot
  free — calendar check, Phase 5).
- Both sides: post-session "rate this session" → review (Phase 6).

### File exchange during consults/streams
- No file pipes inside the rooms. The room shows a **"Send file" button that
  opens the existing AvaTok thread** between the two (or the event group thread);
  files sent there flow through the normal media pipeline and are auto-registered
  in **AvaLibrary** (Phase 4 `registerFile`) for both parties. Zero new
  infrastructure, consistent history.

## Acceptance criteria
- [ ] Paid viewer can watch the live event; non-payer cannot obtain playback/join token.
- [ ] End-to-end happy path settles escrow 80/20 and emails the creator; AvaVerse-
      facing fields (joined_count, gross, projected) correct.
- [ ] R1 and R2 simulated (clock-shifted test events) produce exact ledger rows + emails.
- [ ] 1:1 consult connects P2P; 11th participant in a 1:10 consult is refused.
- [ ] All refund actions idempotent (cron re-run = no double refunds).
- [ ] T-60 reminder email (Phase 5 cron) arrives with a working join deep-link.
- [ ] Viewer can send emoji/flying message/sticker; all watchers see them <1 s.
- [ ] Donation deducts wallet, creator HUD earnings tick up, banner shows on
      both screens, ledger rows balanced (donation + fee).
- [ ] Creator HUD shows correct watching-now count and time remaining; consult
      rooms show countdown + 5-min warning on both sides.
- [ ] File sent via the room's "Send file" → AvaTok thread → appears in BOTH
      parties' AvaLibrary.

## Folded from audit (build in this phase)

### A1. Live moderation tools [MUST]
- LiveRoomDO room state: `muted_users`, `banned_users`, `slow_mode_sec`,
  `pinned_message` (survives hibernation in DO storage).
- Creator HUD: long-press any chat/flying message → Mute (no more messages,
  can watch) / Ban (kicked + join token revoked, no re-entry) / Report.
  Toolbar: slow-mode toggle (off/5s/30s), pin message.
- Server enforces: muted/banned checked in the DO before broadcast; bans also
  write to `user_reports` pipeline for pattern review. Banned PAID viewer keeps
  entitlement refund decision with admin (default: no auto-refund).
- Viewer side: report message/stream (existing report endpoint, targetType
  `live_message|stream`); profanity filter = existing moderation hook on the
  message text before broadcast (drop + warn on hit).
- Acceptance: muted user's messages stop appearing for everyone; banned user's
  rejoin attempt is refused at token issue; slow mode rate-limits server-side.

### A2. Refund-engine test clock + DLQ alerting [MUST]
- `TEST_CLOCK_OFFSET_MS` env var (staging ONLY; worker refuses it in prod):
  every `now()` in the rules engine goes through `clock.ts` honoring the offset.
  Staging admin route `POST /api/admin/test-clock` adjusts it live so R1/R2/R4/R5
  are testable in minutes.
- Vitest suite for the rules table: each rule Rn = table-driven test (inputs:
  attendance rows + times; expected: exact ledger rows + email template ids).
- Refund/settlement queue gets `max_retries=5` + **dead-letter queue**
  `Q_MONEY_DLQ`; consumer on DLQ sends an alert email to hdavy2005@gmail.com
  with the failed job payload and writes `failed_settlements` row for the admin
  console (Phase 2 A2) to retry manually.
- Acceptance: forced consumer exception lands in DLQ + alert email arrives;
  manual retry from admin console settles it; no double-settle (idempotency).

### A3. Pre-call check + rejoin [MUST]
- Pre-join screen runs: mic permission+level meter, cam preview, network probe
  (RTT to worker + a 2 s bandwidth estimate) → green/yellow/red verdict with
  plain-language tips ("Move closer to Wi-Fi").
- Entitlement persists for the whole slot: app crash/drop ⇒ reopening the
  booking card shows "Rejoin" (new token, same order). LiveRoomDO/SFU treats
  rejoin as the same identity (no duplicate participant).
- Both-sides drop (network blip) does NOT trigger R1/R2: rules only fire on
  cumulative absence (attendance gaps), not momentary disconnects <90 s.
- Acceptance: kill the app mid-consult, reopen, rejoin within 10 s; verify a
  60 s disconnect does not mark no-show.

### A4. Stream health + fair R7 [SHOULD]
- Creator HUD: publish bitrate + connection indicator (green/yellow/red from
  WHIP stats); on publisher drop, auto-reconnect loop with on-screen countdown;
  viewers see a "Creator reconnecting…" overlay (LiveRoomDO broadcast), player
  auto-resumes.
- **R7 clarified:** infra-failure auto-refund fires only after **5 contiguous
  minutes** of stream downtime (measured from Stream webhooks
  disconnected→connected gaps), not transient blips. Configurable in
  `refund_rules`.

### A5. Creator block list [SHOULD]
- Creator blocks a buyer (post-session sheet or from AvaInbox thread):
  `blocks` table (existing) row creator→buyer ⇒ buyer cannot book this
  creator's listings (slot API hides), cannot join their streams (token refused),
  cannot message. Existing paid bookings stay valid unless creator also cancels
  (then R6 full refund applies).

## Definition of done
Deploy (staging then prod), Stream/Realtime creds + webhooks configured,
Graphiti episode, STATUS_REPORT.md, push.
