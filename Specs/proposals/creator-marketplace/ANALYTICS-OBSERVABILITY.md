# Analytics & Observability Standard (BINDING, all phases)

**Why:** PostHog audit 2026-06-10 — current capture is thin (onboarding,
diag_log, autocapture, 5 call events; ~nothing from chat/library/explore).
The zombie-call bug was diagnosable only because call events existed AT ALL;
with no shared `call_id` the two sides couldn't be joined. Every app must emit
enough to troubleshoot remotely. Companion: the earlier
`Specs/proposals/posthog-capture-catalog-by-screen.md` (extend, don't duplicate).

## 1. The envelope — properties on EVERY event
`Analytics.capture(event, props)` (extend the existing helper) auto-merges:
`app` (avatok|wallet|explore|avalive|…), `screen`, `account_id` (Clerk id — no
emails/names in properties), `account_kind`, `build` (CI build number), `env`
(prod|staging), `net` (wifi|cell|offline), `session_seq` (monotonic per app
session). Worker-side events (see §4) add `worker: true`, `colo`.

## 2. Mandatory event classes (every app, every phase)
- **Screen views:** `screen_viewed {app, screen, from}` — on every route push.
- **API failures (client):** `api_error {endpoint, status, code, latency_ms,
  retry_count}` — captured centrally in the HTTP client wrapper, NOT per screen.
- **Action funnels:** every multi-step flow emits `<flow>_started`,
  `<flow>_step {step}`, `<flow>_completed|abandoned {reason}` — listing
  pipeline, top-up, checkout, KYC, payout, reschedule, onboarding (exists).
- **Money events (client+worker mirror):** `topup_*, checkout_*, donation_sent,
  refund_received, payout_*` with `amount, currency, order_id, listing_id`.
- **Realtime health:** `ws_connected/ws_dropped {do_type, duration_s, reason}`
  for SyncHub + LiveRoom sockets — this is how we see "users keep losing the
  socket in region X".

## 3. Domain catalogs (added in the phase that builds them)
- **Calls (P1 hotfix):** `call_invited/ringing/connected/ended {call_id, kind:
  audio|video, reason, duration_s, rtc_state_at_end}` — both sides, joined by
  `call_id`. Conference (P10): + `conference_joined/left {room_size}`.
- **Wallet (P2):** balance_viewed, topup funnel, ledger_filter_used,
  receipt_resent, insufficient_funds_shown {context}.
- **KYC/Payout (P3):** kyc_started/verified/failed {failure_reason},
  bank_add funnel, withdraw funnel incl. quote_viewed.
- **Storage/Library (P4):** file_registered {kind, bytes, source_app, dedup:bool},
  quota_state_changed {state}, library_search, storage_viewed.
- **Calendar/Booking (P5):** slot_conflict_shown {occupied_by}, booking funnel,
  reschedule funnel, gcal_connected/sync_error, reminder_sent (worker).
- **Explore (P6):** listing_viewed/opened {listing_id, category, position},
  search {q_len, filters_used, results}, follow_toggled, listing-pipeline funnel,
  guest_gate_shown {action}.
- **Live/Consult (P7):** stream_started/ended {event_id, peak_viewers,
  duration_s}, viewer_joined/left {watch_s}, reaction/flyer/sticker_sent,
  donation funnel, waiting_room_state, no_show_detected {rule}, rejoin_used,
  publish_health {bitrate_avg, drops}.
- **Verse/Inbox (P8):** card_viewed/tapped {card}, announce funnel,
  statement_exported, inbox_filter {source}.
- **AvaChat (P9):** brain_query {intent, latency_ms, sources_returned},
  brain_source_opened {kind}, guardrail_toggled {app, on}, brain_feedback.

## 4. Worker-side capture
Worker/consumers post server-truth events to PostHog (key already on consumers):
money settlements, refund-rule firings `{rule: R1..R7}`, reminder sends, fan-out
sizes, cron/DLQ failures `cron_error {job, error}`, recon results. Server events
carry the same `account_id` so client+server join in one funnel.

## 5. Diagnostics bridge
`diag_log` (exists, high volume) stays for the in-app Diagnostics screen, but
anything we'd ALERT on must be a typed event (above), not a diag_log line.
$exception autocapture stays on; release tagging: set `build` on init so
error-tracking "release" filtering works.

## 6. Per-phase verification (added to every phase's acceptance criteria)
Run the phase's flows once on staging, then in PostHog:
`SELECT event, count() FROM events WHERE properties.app='<app>' AND
properties.env='staging' AND timestamp > now() - INTERVAL 1 HOUR GROUP BY event`
— every catalog event for the phase must appear with sane properties (no nulls
for required keys). Record the query output in STATUS_REPORT.md.

## 7. Scheduling & realtime backbone (decision record, 2026-06-10)
- **Crons:** Cloudflare **Cron Triggers** on `avatok-consumers` (exists) for
  sweeps (reminder scan, recon, storage billing, verse snapshots) + **Durable
  Object Alarms** for per-entity precision timing (a booking's no-show check at
  start+20 min, LiveRoom auto-close, slot soft-hold expiry). No third-party cron
  service — DO Alarms ARE the managed per-event scheduler, co-located with the
  state they fire on. (QStash available as a fallback if we ever need complex
  external schedules.)
- **Realtime: no Ably.** We already run edge WebSockets on DOs (InboxDO,
  LiveRoomDO) — hibernatable, per-user/per-room sharded, no per-message vendor
  pricing, no second SDK (perf budget §1/§4 forbids one). Ably would duplicate
  exactly what DOs do while adding cost + a vendor. Revisit only if we hit a
  measured DO fan-out wall (>~10k concurrent viewers per room); the escape hatch
  then is sharded LiveRoomDOs (room → N relay DOs), still Cloudflare-native.
