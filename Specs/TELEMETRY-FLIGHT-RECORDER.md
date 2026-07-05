# PostHog as Flight Recorder — Telemetry Specification

v1.0 — 2026-07-05. Companion to Specs/DETERMINISTIC-CORE-ARCH.md (v1.2). PLAN ONLY.

Philosophy: **PostHog is not analytics — it is the black-box flight recorder.** When a
user says "my call failed", one trace_id query replays the whole journey, no
screenshots, no repro attempts.

## The universal pattern (applies to every category below)

Every significant operation emits up to four events:
1. `*_started`
2. `*_succeeded` — always with `duration_ms`
3. `*_failed` — always with a machine-readable `reason` (never just "error")
4. `*_recovered` — when a retry/repair path saved it (with `recovery_ms`, attempts)

Universal properties on EVERY event: `trace_id` (UUIDv7, minted at the user action),
`app_version`, `device_id`, `network_type`, `fg_bg`, and the account identity (email —
required by project workflow for support lookup by user). Server-side events add
`colo`, `do_class` where relevant.

## Naming rule — keep what exists

We already have a live taxonomy (call_started, call_connected, call_ring_ack,
call_place_ok/failed, push_register_*, push_no_device, msg_outbox_*,
call_dup_session_blocked, call_media_stalled/recovered, hub_reconnect, …).
**Existing names are NEVER renamed** (dashboards/history break); new events fill gaps
using the schema below. Where this spec lists a concept we already emit under another
name, the existing name is canonical (mapping table kept at the end).

## Categories

### 1. Trace IDs (foundation — Phase A [TRACE-ID-1])
`trace_id` minted client-side at the initiating user action (call button, send tap,
upload pick), propagated HTTP → Worker → CallRoom DO → InboxDO → push payload →
receiving client → RTC telemetry. Both devices' events for one call share one
trace_id. PostHog stitching = filter by trace_id.

### 2. Call lifecycle (states from the CALL-FSM event log — the DO emits these)
call_created, call_invite_sent, call_push_sent*, call_push_received,
call_ring_started, call_ring_ack*, call_answered, call_connecting, ice_connected,
dtls_connected, media_started, call_connected*, call_reconnecting, call_reconnected,
call_ended* (* = exists today, kept).
Props: trace_id, call_id, generation, event_seq, caller, callee, device_id,
network_type, duration_s (on ended), end_reason.

### 3. Message lifecycle
message_created, msg_outbox_enqueued*, message_upload_started/finished,
message_server_ack, message_echo_received, message_delivered, message_read,
message_failed, msg_outbox_retry, message_deduplicated (server, on dedup hit).
Props: trace_id, client_msg_id, server_msg_id, retry_count, outbox_age_ms,
media_size, conv_hash (never raw conversation content/ids in plain form).

### 4. Durable Object events (worker→PostHog)
InboxDO: do_resumed, do_hibernated, message_insert (sampled), message_duplicate,
cursor_advanced (sampled), sync_requested/finished.
CallRoom: call_fsm_transition (every one — this IS the event log mirrored),
lease_created/renewed(sampled)/expired, generation_incremented, command_rejected
{reason: stale_generation|stale_version|illegal_transition|lease_conflict},
participant_joined/left.

### 5. Network Brain (client)
netbrain_online, netbrain_offline, netbrain_degraded, netbrain_recovering,
netbrain_restored. Props: transport (wifi/mobile), latency_ms, packet_loss,
hub_connected, ws_connected, internet_reachable, time_in_prev_state_ms.

### 6. WebSocket health
ws_connect/connected/disconnect/resume/resume_success/resume_failed, ws_timeout.
Props: socket ('inbox'|'call'), latency_ms, disconnect_reason, retry_n,
session_duration_ms. (Pings/pongs are NOT individually logged — see sampling.)

### 7. Push pipeline
push_register*, push_register_ok*, push_register_failed*, push_token_refreshed*,
push_token_invalid (new: server→client invalidation signal), push_token_pruned*,
push_sent (=call_push_sent/push_fanout_result*, kept), push_received (client, new —
closes the sent-vs-received gap that made no-ring cases invisible), push_clicked,
push_expired, push_no_device*. Props: provider, token_age_h, error, device_model.

### 8. WebRTC
rtc_offer_created, rtc_answer_created, ice_gathering, ice_connected, ice_failed,
ice_restart, dtls_connected, media_started, call_media_stalled*,
call_media_recovered*, turn_used. Props: path (relay|direct), candidate_type,
selected_pair, jitter, packet_loss, rtt_ms, bytes_sent/received. Individual
ice_candidate events are NOT logged (volume) — gathered summary on ice_connected.

### 9. Media watchdog
`media_health` every 30s while connected (client-aggregated from the 5s polls — we
do not ship every poll): audio_bytes_delta, video_bytes_delta, jitter, packet_loss,
rtt_ms, bitrate, health_score. Stall/recovery use existing call_media_stalled/
call_media_recovered.

### 10. Outbox
msg_outbox_enqueued*, msg_outbox_retry, outbox_paused/resumed (NetBrain-driven),
msg_outbox_sent*, msg_outbox_gave_up*. Props: queue_depth, retry_n, age_ms,
network_state.

### 11. Synchronization
sync_started/finished/failed, sync_gap_detected (cursor discontinuity),
sync_repaired, cursor_reset. Props: cursor_before/after, rows, duration_ms.

### 12. diagnostic_snapshot (the crown jewel)
Fired automatically on ANY *_failed event and on user-invoked "report a problem":
{network_state, call_state+gen+lease, active_sessions, outbox_depth, ws_states,
battery, memory, fg_bg, last 20 breadcrumb event names}. Every failure becomes
self-contained — no follow-up questions to the user.

### 13. Performance
app_launch (cold/warm, ms), login_complete, conversation_open_ms,
call_screen_open_ms, message_render_ms (sampled), sync_duration_ms,
search_duration_ms, db_query_slow (only >100ms).

### 14. Cloudflare server-side
worker_exception, worker_timeout (worker_request NOT logged per-request — volume;
use CF analytics for that), do_request_slow (>250ms), sqlite_slow (>50ms),
do_exception, do_restart, do_hibernated/resumed (sampled).

### 15. Security
auth_refresh, auth_failed, jwt_expired, device_added/removed/verified,
signature_failed, replay_attack_blocked.

### 16. Feature usage (product analytics — the only "classic analytics" bucket)
voice_call_started, video_call_started, media_sent, image_sent, file_sent,
sticker_sent, typing_used, reaction_added, reply_used.

### 17. Release Health Dashboard (single dashboard, per app_version)
- Messaging: send success %, avg send time, outbox retries/user, duplicate rate
  (message_deduplicated — should be >0 and tiny; 0 means dedupe broke, spike means
  ACK path broke), failed sends %.
- Calls: ring success % (push_received/call_push_sent), connect success %
  (call_connected/call_created), avg setup time, ICE failure %, TURN usage %,
  media stall rate, avg duration.
- Network: offline time/user, reconnect frequency, ws resume failure %, push failure %.
- DOs: hibernation/restore counts, sqlite_slow rate, dedupe hits, FSM violations.
- Client: crash-free users, ANRs, cold start ms, memory.
Alert thresholds per PRODUCTION-HARDENING-PLAN §2.4.

### 18. invariant_protected (gold — the regression seismograph)
One event name, `invariant_protected`, prop `kind`:
duplicate_message_blocked, stale_generation_rejected, stale_version_rejected,
duplicate_session_prevented (=call_dup_session_blocked*, kept as alias),
illegal_state_transition, invalid_command, lease_conflict, duplicate_call_join,
replay_attack_blocked. Baseline is near-zero-but-nonzero; a spike after a release
means new code is generating races the guards are absorbing — you find out before
users do. Standing insight + alert on week-over-week spike.

## Reliability Score (v1.1 addition)

Every call session computes a client-side score on `call_ended`:
`reliability_score = 100 − packet-loss penalty − reconnect penalty (10/attempt) −
media-stall penalty (15/stall) − TURN-relay penalty (5) − push-failure penalty (10)`
(clamped 0–100; exact weights tunable in one place). Property on `call_ended`;
similar lightweight score on message sessions later. Standing PostHog insight:
"worst 100 calls today" = sort by reliability_score ascending — triage without log
diving. Messaging equivalent deferred until call score proves itself.

## Delivery rule (binding)

Telemetry is ALWAYS fire-and-forget: events are queued locally and flushed async
with drop-oldest overflow; no user-facing operation ever awaits a telemetry write.
PostHog being down must be invisible to the product.

## Sampling & cost tiers (non-negotiable at 1M DAU)

- **Tier 1 — 100%, never sampled:** all OUTCOMES (*_succeeded/_failed/_recovered,
  call_ended, msg_outbox_sent/gave_up), invariant_protected, diagnostic_snapshot,
  security events, DO exceptions, FSM command_rejected.
- **Tier 2 — sampled 10%:** breadcrumbs (call_progress, media_health, sync_finished,
  cursor_advanced, message_insert, lease_renewed, do_hibernated). EXCEPTION: any
  session that ends in a Tier-1 failure uploads its buffered Tier-2/3 breadcrumbs in
  full (client keeps a rolling in-memory buffer) — failures always get full context.
- **Tier 3 — never shipped as events:** ws ping/pong, individual ICE candidates,
  per-request worker logs, 5s watchdog polls (aggregate client-side).
- Identity: every event carries the account email (project rule) and device_id.

## Rollout mapping

- Phase A ([TRACE-ID-1]): §1 trace_id, §3 message lifecycle completion (echo/ack/dedup
  events), §10 outbox gaps, §18 invariant_protected wrapper.
- Phase B (CALL-FSM-1): §2 full call lifecycle from the DO event log, §4, §5 NetBrain,
  §8 RTC additions, §12 diagnostic_snapshot, §14.
- With release gates: §17 dashboard + alerts before the staged rollout starts.

## Existing-name mapping (canonical, do not rename)
call_push_sent, call_ring_ack, call_place_ok, call_place_failed, call_connected,
call_ended, call_dup_session_blocked (alias of invariant_protected/
duplicate_session_prevented — emit both during transition), call_self_busy_ignored,
call_media_stalled, call_media_recovered, call_teardown_slow, msg_outbox_enqueued,
msg_outbox_sent, msg_outbox_gave_up, push_register_ok/failed, push_token_pruned,
push_no_device, push_fanout_result, hub_reconnect, inbox_resume_reconnect.
