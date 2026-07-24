# Call Reliability Telemetry Contract — 2026-07-24 [CALL-REL-8]

**Status:** definitive event schema + rollout gates + acceptance dashboard contract
for Milestone E of `Specs/PERMANENT-P2P-CALL-RELIABILITY-IMPLEMENTATION-PLAN-2026-07-24.md`
(§9, §12) and REL-9/REL-10 of `Specs/FINAL-CALL-RELIABILITY-PLAN-2026-07-24.md`.

**Scope of this document:** the CONTRACT only — property lists, emission points,
forbidden content, correlation keys, rollout gates, and the six acceptance
queries. It does not implement client/server code; other agents are landing the
emitting code concurrently under `[CALL-REL-1]`..`[CALL-REL-7]`/`[CALL-REL-9]`.
Where an event name/property already exists in `app/lib/core/call_telemetry.dart`
or `app/lib/core/analytics.dart`, this doc amends it rather than inventing a
parallel name — implementers must reconcile any drift against this file, not
the other way around.

PostHog project: **139917** (EU, `https://eu.i.posthog.com`).

---

## 0. Cross-cutting rules (apply to every event below)

1. **Envelope identity.** All events go through `Analytics.capture(...)`, which
   stamps the account identity envelope (Clerk uid alias, email, phone when
   available) automatically — do not pass email/phone as a raw property unless
   this doc says so explicitly (receptionist events, see §8).
2. **Correlation keys required on every event in this contract:**
   - `call_id` — the room id shared by both peers (never a user id shape; see
     `call_id_shape` on `call_started`/`call_ended`).
   - `trace_id` — a per-call-attempt id that survives recovery/migration
     attempts, so one call's full timeline (both peers) can be reconstructed
     from a single filter. If the emitting code has no `trace_id` plumbed yet,
     it must reuse `call_id` until `trace_id` lands — never omit both.
   - Two-party correlation: `call_id` is common to both peers' events by
     construction (both peers write to the same room id), so a HogQL join on
     `call_id` reconstructs both timelines. Do not additionally embed the other
     party's email in these events — identity comes from the envelope on each
     peer's own event.
3. **Forbidden content — never present in any property, extra, or error
   message on any event in this contract:**
   - SDP (offer/answer bodies, `m=`/`a=` lines, fingerprints).
   - ICE candidates, ICE server URLs/credentials, TURN username/password/realm.
   - Any bearer/session token, `reconnect_token`, Clerk token, signed URL
     query strings.
   - Microphone/PCM audio bytes, recorded audio, transcript text.
   - Raw stack traces containing the above (the existing `_scrub`/
     `scrubServer`/`beforeSend` pipeline is the last line of defense, not a
     substitute for not sending it).
   - Allowed instead: booleans/enums/counts/durations/ids (`exact: bool`,
     `backend: string`, `elapsed_ms: number`, `request_id`, `attempt_id`).
4. **Dedup / cardinality.** Every event that fires on a state machine
   transition (route result, media health, recovery, receptionist reconnect)
   must fire once per transition, not once per poll. Polling loops sample
   internally and only call `Analytics.capture` on change, exactly like the
   existing `call_media_flow_state` pattern (`call_telemetry.dart:490-509`).
5. **`rtc_error` / `$exception` handled-Issue convention** (already landed,
   amended here for completeness — see `call_telemetry.dart:511-534`):
   - One handled `Analytics.captureException(..., handled: true, extra: {...})`
     call and one compact `rtc_error` event per **`call_id + stage`**, enforced
     client-side via a per-`CallTelemetry` instance `Set<String>` guard
     (`_reportedRuntimeErrorStages`). A second failure at the same stage in the
     same call is suppressed from Error Tracking/rtc_error but MAY still bump a
     local counter surfaced in `call_progress.rtc_error_count`.
   - `stage` is a fixed vocabulary, not a free string interpolated with
     dynamic data: `ice_restart_failed`, `relay_migration_failed`,
     `get_user_media_failed`, `native_audio_route_failed`,
     `native_audio_focus_failed`, `get_stats_failed`, `sdp_apply_failed`,
     `ice_candidate_apply_failed`, `callroom_socket_failed`,
     `receptionist_socket_failed`, `receptionist_playback_failed`. Add new
     stages by extending this list in this document first.
   - Every handled-exception `extra` includes `call_id`, `trace_id`, `stage`,
     `video`, `connected`, `ice_type`, `relay_used`, app version/build/release
     (from the analytics envelope), network class, direction (`outgoing`), call
     phase, `route`, `transport_state`, `recovery_attempt`, `media_path` when
     available. Never SDP/ICE-creds/tokens/audio (rule 3).
   - Server-side (`ReceptionRoom`, `CallRoom`) failures use the equivalent
     `hooks.trackException` path with the same `stage` vocabulary extended by
     `reception_gemini_connect_failed`, `reception_r2_record_failed`,
     `reception_push_delivery_failed`, `call_room_relay_migrate_failed`.
   - Dedup key for both client and server: `call_id + stage`. This is what
     keeps one bad network from generating hundreds of identical Issues.

---

## 1. Audio route events (Milestone A, flag `callAudioControllerV2`)

### 1.1 `call_audio_route_requested`

Emitted by `CallAudioController`/`NativeVoiceAudio.instance.selectRoute(...)`
the instant a route change is requested (user tap, initial setup, Bluetooth
connect, system fallback) — before the native call resolves.

| Property | Type | Notes |
|---|---|---|
| `call_id` | string | required |
| `trace_id` | string | required |
| `request_id` | string (uuid) | one per request; correlates to the matching `..._result` |
| `requested_route` | enum | `earpiece`\|`speaker`\|`bluetooth`\|`wiredHeadset`\|`unknown` |
| `source` | enum | `user`\|`initial`\|`bluetooth_connected`\|`system`\|`fallback` |
| `prior_active_route` | enum | last confirmed route, or `unknown` on first request |

**Forbidden:** device names/MAC addresses of Bluetooth peripherals — device
*class* only (`bluetooth`/`wiredHeadset`), never a paired-device identifier.

### 1.2 `call_audio_route_result`

Emitted once the native layer confirms (or fails to confirm) the requested
route — i.e., the closing half of `ROUTE_REQUESTED -> ROUTE_ACTIVE|ROUTE_FALLBACK|ROUTE_FAILED`
(§4.2 of the implementation plan).

| Property | Type | Notes |
|---|---|---|
| `call_id`, `trace_id`, `request_id` | string | `request_id` must match the originating `_requested` event |
| `requested_route` | enum | echoed from the request |
| `active_route` | enum | what Android actually confirmed |
| `exact` | bool | `active_route == requested_route` |
| `backend` | enum | `communication_device_api31`\|`legacy_sco`\|`none` |
| `elapsed_ms` | number | request→confirm latency |
| `fallback_reason` | string\|null | fixed vocabulary: `device_unavailable`, `timeout`, `platform_rejected`, `bluetooth_disconnected`, `null` when `exact` |

### 1.2b `call_audio_context_set` (legacy, `callAudioControllerV2`-off path)

Pre-existing event, not new to this contract — documented here for
completeness per this doc's own rule that drift must be reconciled. Emitted
by the legacy `RingbackPlayer._ensureCallAudioContext`
(`app/lib/core/ringback_player.dart:105-152`) whenever it applies (or fails to
apply) the platform `AudioContext` (speakerphone state + `AndroidAudioMode`)
before playing a ringback/searching tone. This is the audio-context call this
doc's Milestone B (`callAudioControllerV2`) is intended to eventually replace
with `CallAudioController`/native `AudioTrack` route ownership — until that
flag is on for a given call, this is the only event that observes ringback
audio-context application. Idempotent: only re-applied (and re-emitted) when
`speakerOn` or `mode` actually changes from the cached `_ctxSet` state.

| Property | Type | Notes |
|---|---|---|
| `speaker_on` | bool | requested speakerphone state |
| `audio_mode` | enum | `AndroidAudioMode.name` (e.g. `callScreening`, `inCommunication`, `normal`) |
| `ok` | bool | `true` on success; `false` when `setAudioContext` threw |
| `error` | string | failure path only — `e.toString()`; NOT scrubbed at the call site itself, relies on the downstream `_scrub`/`beforeSend` pipeline (rule 3's "last line of defense") — do not add SDP/ICE/token content to this path |

**Not yet carrying `call_id`/`trace_id`.** Unlike every other event in this
contract, this call site does not currently pass `call_id`/`trace_id` — it
relies on the surrounding `Analytics.capture` envelope and proximity to the
paired `call_audio` domain error (`Analytics.error(domain: 'call_audio', code:
'audio_context_set_failed', ...)`) and `Analytics.captureException(...,
extra: {stage: 'ringback_audio_context_set', ...})` also emitted on failure)
for correlation. Add `call_id`/`trace_id` to the emit site before relying on
this event for the cross-call joins the rest of this contract assumes (rule 2).

**Forbidden:** no SDP/ICE/token content in `error` (rule 3).

### 1.3 `call_audio_focus`

Emitted on every Android audio-focus transition observed by the controller
(`AUDIOFOCUS_GAIN`, `LOSS`, `LOSS_TRANSIENT`, `LOSS_TRANSIENT_CAN_DUCK`) while a
call is active.

| Property | Type | Notes |
|---|---|---|
| `call_id`, `trace_id` | string | required |
| `change` | enum | `gain`\|`loss`\|`loss_transient`\|`loss_transient_can_duck` |
| `active_route` | enum | route at time of change |
| `system_held` | bool | controller applied a hold independent of user mute |
| `user_muted` | bool | user's own mute choice, tracked separately from `system_held` |

---

## 2. Tone events (Milestone B, part of `callAudioControllerV2`)

`RingbackPlayer` is a decoder/player only; these fire from the tone owner
(native `AudioTrack` under `CallAudioController`, or the interim `audioplayers`
client). All four share a monotonically increasing `generation` int per call so
a late completion cannot be mistaken for the current tone.

### 2.1 `call_tone_requested` / 2.2 `call_tone_started` / 2.3 `call_tone_stopped` / 2.4 `call_tone_failed`

| Property | Type | Applies to | Notes |
|---|---|---|---|
| `call_id`, `trace_id` | string | all four | required |
| `kind` | enum (`searching`\|`ringback`\|`busy`) | all four | which tone |
| `generation` | number | all four | monotonic per call; a stale generation's late callback must not re-emit `started`/`stopped` |
| `route_requested` | enum | `requested` only | route the tone expects to play on |
| `active_route` | enum | `started` only | route confirmed at start |
| `backend` | enum (`native_audiotrack`\|`audioplayers_interim`) | `started` only | which player backend is live |
| `reason` | enum (`answered`\|`superseded`\|`terminal_handoff`\|`caller_hangup`) | `stopped` only | why it stopped |
| `error_code` | string | `failed` only | fixed vocabulary, no raw platform exception text |

**Forbidden:** no tone/audio bytes, no file paths beyond a bundled asset id.

---

## 3. Media health (Milestone C, flag `callPlayoutHealthV2`, observe-only first)

### 3.1 `call_media_health`

Sampled internally every 5s from `getStats()`; **emitted only on a class
transition** (see the classes table in plan §7.2 — `healthy`, `remote_quiet`,
`network_degraded`, `no_rtp`, `no_playout`, `route_broken`), never once per
5s sample. This is the event that proves "heard audio," not `call_media_flow_state`
(which only proves RTP receipt/transport state and remains unchanged).

| Property | Type | Notes |
|---|---|---|
| `call_id`, `trace_id` | string | required |
| `class` | enum | one of the six classes above |
| `from_class` | enum | prior class (nullable on first sample) |
| `audio_bytes_delta` | number | interval delta, `unknown` fields omitted rather than zero-filled |
| `playout_delta` | number | delta `jitterBufferEmittedCount` |
| `concealment_pct` | number | delta `concealedSamples`/`totalSamplesReceived` * 100 |
| `jitter_ms` | number | |
| `loss_pct` | number | |
| `route` | enum | native active route at sample time |
| `path` | enum (`direct`\|`relay`) | selected candidate pair type |
| `candidate_type` | enum (`host`\|`srflx`\|`relay`\|`prflx`\|`unknown`) | local candidate type of selected pair |

**Forbidden:** no candidate IP/port, no TURN relay address.

---

## 4. Recovery events (Milestone C, flags `callIceRecoveryV2` / `callRelayMigrationV1`)

All four share `attempt_id` (the `RecoveryAttempt.id` UUID sent in signaling,
plan §4.1/§7.3) so a full attempt timeline joins on it regardless of which peer
emits which event.

### 4.1 `call_recovery_started`

| Property | Type | Notes |
|---|---|---|
| `call_id`, `trace_id`, `attempt_id` | string | required |
| `reason` | enum | `noPlayout`\|`highConcealment`\|`transportDisconnected`\|`networkChanged`\|`peerRejoined`\|`routeMismatch` |
| `source_endpoint` | enum (`offerer`\|`callee`) | which side detected/requested it |
| `current_path` | enum (`direct`\|`relay`) | |
| `health_snapshot` | object | last `call_media_health` class + the 4 numeric deltas above, no raw stats blob |

### 4.2 `call_recovery_offer`

| Property | Type | Notes |
|---|---|---|
| `call_id`, `trace_id`, `attempt_id` | string | required |
| `coordinator_peer` | enum (`offerer`\|`callee`) | who the DO selected to offer, per the deterministic rule in plan §7.3.3 |
| `kind` | enum (`ice`\|`relay`) | ICE restart vs relay migration |
| `success` | bool | did the offer/answer exchange itself complete |
| `failure_code` | string\|null | fixed vocabulary: `sdp_create_failed`, `sdp_apply_failed`, `ice_gathering_timeout`, `peer_unreachable`, `null` on success |

### 4.3 `call_recovery_completed`

| Property | Type | Notes |
|---|---|---|
| `call_id`, `trace_id`, `attempt_id` | string | required |
| `path_before`, `path_after` | enum (`direct`\|`relay`) | |
| `elapsed_ms` | number | started→completed |
| `two_side_ack` | bool | true only when both: 2 consecutive healthy playout samples on the initiator AND a `recovery-ready` ack from the peer (plan §7.3 rule 5) |

### 4.4 `call_recovery_failed`

| Property | Type | Notes |
|---|---|---|
| `call_id`, `trace_id`, `attempt_id` | string | required |
| `terminal_reason` | enum | `recovery_timeout_no_playout`\|`route_repair_failed`\|`relay_migration_failed`\|`ice_restart_failed`\|`peer_unreachable` — must be the exact failed invariant, never generic `error`/`socket-lost` (plan Non-negotiable rules, §1) |
| `elapsed_ms` | number | |
| `last_health_snapshot` | object | same shape as §4.1 |

---

## 5. Receptionist reconnect events (Milestone D, flag `receptionistReconnectV1`)

### 5.1 `receptionist_reconnect_started` / 5.2 `..._completed` / 5.3 `..._failed`

| Property | Type | Applies to | Notes |
|---|---|---|---|
| `call_id`, `trace_id` | string | all three | `call_id` here is the receptionist session's own id, still the correlation key |
| `session_id_hash` | string | all three | hash only — never the raw `session_id`/`reconnect_token` |
| `attempt` | number | all three | 1-based retry count within the backoff ladder (`250ms,500ms,1s,2s,2s`, cap 8s) |
| `elapsed_ms` | number | `completed`/`failed` | since `started` |
| `terminal_reason` | enum | `failed` only | `recept_reconnect_timeout`\|`hard_cap_reached`\|`server_terminal_frame`\|`caller_hangup` |
| `resumed_next_server_seq` | bool | `completed` only | true if the DO returned `resumed` with a `next_server_seq` rather than restarting cold |

**Owner/party correlation (receptionist is 1:many, not peer-to-peer):**
per the workflow's "Telemetry (PostHog)" rule and existing `ReceptionRoom`
events, these events carry the caller's account identity via the normal
`Analytics.capture` envelope (email/phone if available) — do not add a second
raw email property; reuse the envelope exactly like the other `ReceptionRoom`
events already do (plan §9 "Instrumentation landed in this pass").

**Forbidden:** raw `session_id`, `reconnect_token` (even truncated), buffered
PCM, transcript text, Gemini connection URLs.

---

## 6. Ring audibility events (REL-10 / `[CALL-REL-9]`)

These are in scope for this contract because they were folded into Milestone E
in the FINAL plan's execution table (`[CALL-REL-9]` maps to Milestone A/E). No
new flag is introduced for these two — they observe/inform, they do not gate a
recovery behavior, so they ship unconditionally once the emitting code lands
(same as `call_incoming_shown` today). If a kill switch is later needed, reuse
`callAudioControllerV2`.

### 6.1 `call_ring_audibility`

Emitted on the **callee** device the moment the incoming-call UI is shown,
immediately after querying ringer/DND/volume state — proves whether the ring
*could* have been audible, not just that the UI rendered.

| Property | Type | Notes |
|---|---|---|
| `call_id`, `trace_id` | string | required |
| `ringer_mode` | enum (`normal`\|`vibrate`\|`silent`) | `AudioManager.getRingerMode()` |
| `dnd_filter` | enum (`none`\|`priority`\|`alarms`\|`none_interruption`) | `NotificationManager.getCurrentInterruptionFilter()` |
| `ring_stream_volume` | number | 0..max, current `STREAM_RING` volume index |
| `ring_stream_volume_max` | number | device max for `STREAM_RING` |
| `channel_importance` | enum | the in-call notification channel's `NotificationManager.IMPORTANCE_*` |
| `callkit_sound_started` | bool | whether the platform ringtone actually began playback (Android: `Ringtone.isPlaying()`/equivalent signal; not assumed from UI show) |
| `presentation` | enum (`full_screen_intent`\|`heads_up_only`) | which incoming-call presentation the OS granted |

**Forbidden:** no exact volume-in-dB estimate beyond the stream index, no
device audio recording of the actual ring.

### 6.2 `call_ring_fallback_played`

Emitted from `_startRingtoneFallback` (`app/lib/push/push_service.dart:1166`)
the instant the app starts its own bundled ringtone (`assets/audio/catalog/classic.mp3`)
as a fallback. Gated entirely by the caller before this fires — foreground/
unlocked, the callee's OWN ringer mode is NORMAL (never overrides silent/
vibrate/DND — this event never fires for those states), and nothing confirms
CallKit's native ring is actually making sound (the in-hand/OEM heads-up-only
failure mode REL-10 targets). The event is only emitted on successful start
(inside the `try`, after `player.play(...)` — a failure to start throws and is
caught without emitting this event).

| Property | Type | Notes |
|---|---|---|
| `call_id` | string | required |
| `reason` | string | currently always `foreground_normal_ringer_no_confirmed_sound`; treat as a fixed vocabulary — add new values here first if a second fallback trigger is ever introduced |

**Not currently emitted (do not rely on until code changes):** `trace_id` is
not plumbed into this call site yet; `trigger_reason`/`played`/`foreground` do
not exist as properties — the single `reason` value already encodes
"foreground + normal ringer + no confirmed sound," so there is nothing left to
disambiguate. If a future revision adds finer-grained trigger reasons or a
`played=false` (attempted-but-blocked) case, extend this table then.

**Caller-side honesty companion (not a new event, an amendment):** when
`call_ring_audibility` reports a silent/DND/zero-volume condition, the caller's
UI-facing call state string changes (e.g. "Tiger's phone is on silent") rather
than implying an audible ring — this is a UI/state change, not a new
telemetry event; it is observable via the existing `call_progress`/`call_ended`
event stream by checking the paired callee's `call_ring_audibility.ringer_mode`
for the same `call_id`.

---

## 7. Amended `call_progress`

`call_progress` (`call_telemetry.dart:456-482`) already fires every 30s while
connected. Add these fields to the existing payload (additive; no field is
removed) once the emitting flags are enabled:

| New field | Type | Notes |
|---|---|---|
| `media_path` | enum (`direct`\|`relay`) | last selected candidate pair type |
| `active_audio_route` | enum | last confirmed native route |
| `route_confirmed` | bool | `active_audio_route == desired route` at last check |
| `audio_playout_ok` | bool\|`"unknown"` | last `call_media_health` sample was `healthy`/`remote_quiet` vs `no_playout`/`route_broken`; `unknown` if `callPlayoutHealthV2` is off |
| `audio_concealment_pct_interval` | number | last `call_media_health.concealment_pct` |
| `audio_jitter_buffer_ms_interval` | number | last observed jitter-buffer delay delta |
| `recovery_state` | enum (`none`\|`recovering_ice`\|`migrating_relay`\|`degraded`) | current coordinator state |
| `recovery_attempt_count` | number | attempts so far this call |

Do not re-materialize raw per-5s stats samples into `call_progress` — it stays
a compact heartbeat; per-transition detail lives in `call_media_health`.

---

## 8. Rollout ladder per flag (§12)

Every flag below is declared in `worker/src/routes/config.ts` `DEFAULTS`
(default `false`) per the CLAUDE.md "no fake flags" rule — a flag the client
reads must exist in `DEFAULTS` or it cannot be flipped. Numeric flags (none in
this set — all booleans) would additionally need a `numericKeys` entry.

| Flag | Stage 0 (ship, default false) | Stage 1 (staging observe) | Stage 2 (staging active) | Stage 3 (prod, owner-request only) |
|---|---|---|---|---|
| `callAudioControllerV2` | Route/tone/focus events wired, behavior equivalent to pre-existing default route selection | Enabled for staging testers; watch `call_audio_route_result.exact` and `call_audio_focus` mismatch rate | N/A (this flag IS the active behavior — route ownership moves to the controller) | Flip only after staging shows `route mismatch rate` ~0 and no regression in `call_connected` conversion; owner must explicitly say "production" per CLAUDE.md |
| `callPlayoutHealthV2` | `call_media_health` computed and emitted, **old RTP-bytes watchdog still authoritative for termination** (plan §12 step 2: "observe-only") | Compare `call_media_health` transitions against old watchdog `call_media_flow_state` events and user reports; tune the §7.2 thresholds in this doc if staging data disagrees | Thresholds locked in; still observe-only (no automatic action) until `callIceRecoveryV2` is also enabled | Enable only alongside recovery flags and only on explicit owner request |
| `callIceRecoveryV2` | Coordinator code paths exist but gated off; legacy `_tryIceRestart()` remains active | Enabled for staging testers only; verify `call_recovery_started/offer/completed/failed` sequence is complete and non-overlapping (`attempt_id` uniqueness) per call | Same as staging; graduate once acceptance query 4 (below) shows recovery success rate stable across ≥1 staging test cycle | Owner-request only, after dashboard is green |
| `callRelayMigrationV1` | Migration code paths exist but gated off | Staging cellular tests only, capped at one migration per call (plan §7.4 rule 8) | Same; verify `path_before`≠`path_after` on success and old PC is never closed before 2 healthy playout samples on the new PC | Owner-request only, after `callIceRecoveryV2` has already graduated |
| `receptionistReconnectV1` | Server lease/reattach contract exists; client still uses `_finish()` on `onDone`/`onError` | Enabled for staging testers; verify idempotent finalization (server-side dedup by `session_id`, see acceptance query 5) before any client rollout beyond staging | Client reattach active in staging; watch `receptionist_reconnect_*` triplet completeness and duplicate-finalization count = 0 | Owner-request only, after duplicate-finalization count is proven 0 across staging test cycles |

Cross-cutting rollout notes (from plan §12 and CLAUDE.md flags section):

- Flags are flipped one at a time via `scripts/flags.sh set <key>=true`, never
  by re-materializing the whole KV blob.
- Promotion order follows plan §12 step order 1→5: controller/route telemetry
  first, then playout observe-only, then ICE recovery, then relay migration,
  then receptionist reconnect — each gated on the acceptance dashboard (§9
  below) being green for the flag(s) it covers.
- No production flag flip without an explicit owner request, per CLAUDE.md
  "STAGING vs PRODUCTION" section and plan §12's closing line ("Production is
  live. Do not flip a production flag... without an explicit owner request").

---

## 9. Acceptance queries (§9 of the implementation plan, six required)

All queries below are HogQL against `events` in project 139917 (EU). They are
the acceptance contract — they are written now, before events flow, and MUST
return non-empty, sane results before any flag graduates past staging-active.
Adjust the `WHERE timestamp` window per run; the versions below default to a
rolling 14-day window suitable for a staging test cycle.

### 9.1 `call_started` → `call_connected` conversion by network/candidate type

```sql
SELECT
    properties.$app_version AS app_version,
    properties.$os_version AS os_version,
    coalesce(started.properties.network_type, 'unknown') AS network_type,
    coalesce(connected.properties.ice_type, 'unknown') AS candidate_type,
    coalesce(started.properties.call_id_shape, 'unknown') AS call_id_shape,
    count(DISTINCT started.properties.call_id) AS calls_started,
    count(DISTINCT connected.properties.call_id) AS calls_connected,
    round(
        count(DISTINCT connected.properties.call_id) * 100.0
        / nullif(count(DISTINCT started.properties.call_id), 0), 1
    ) AS conversion_pct
FROM events AS started
LEFT JOIN events AS connected
    ON connected.properties.call_id = started.properties.call_id
    AND connected.event = 'call_connected'
    AND connected.timestamp >= started.timestamp
    AND connected.timestamp <= started.timestamp + INTERVAL 5 MINUTE
WHERE started.event = 'call_started'
    AND started.timestamp >= now() - INTERVAL 14 DAY
GROUP BY app_version, os_version, network_type, candidate_type, call_id_shape
ORDER BY calls_started DESC
```

### 9.2 `call_media_health` transitions to `noPlayout` by route/backend/device

```sql
SELECT
    properties.route AS route,
    properties.$device_model AS device_model,
    properties.path AS media_path,
    count() AS no_playout_transitions,
    count(DISTINCT properties.call_id) AS distinct_calls_affected
FROM events
WHERE event = 'call_media_health'
    AND properties.class = 'no_playout'
    AND timestamp >= now() - INTERVAL 14 DAY
GROUP BY route, device_model, media_path
ORDER BY no_playout_transitions DESC
```

### 9.3 Route request vs confirm mismatch rate + time-to-confirm

```sql
SELECT
    requested.properties.requested_route AS requested_route,
    result.properties.active_route AS active_route,
    result.properties.exact AS exact,
    count() AS request_count,
    round(avg(toFloat64(result.properties.elapsed_ms)), 0) AS avg_elapsed_ms,
    round(
        countIf(NOT result.properties.exact) * 100.0 / count(), 1
    ) AS mismatch_pct
FROM events AS requested
INNER JOIN events AS result
    ON result.properties.request_id = requested.properties.request_id
    AND result.event = 'call_audio_route_result'
WHERE requested.event = 'call_audio_route_requested'
    AND requested.timestamp >= now() - INTERVAL 14 DAY
GROUP BY requested_route, active_route, exact
ORDER BY request_count DESC
```

### 9.4 Recovery success: ICE restart vs relay migration

```sql
SELECT
    offer.properties.kind AS recovery_kind,
    countIf(completed.event = 'call_recovery_completed') AS succeeded,
    countIf(failed.event = 'call_recovery_failed') AS failed_count,
    round(
        countIf(completed.event = 'call_recovery_completed') * 100.0
        / nullif(countIf(completed.event = 'call_recovery_completed')
                 + countIf(failed.event = 'call_recovery_failed'), 0), 1
    ) AS success_pct,
    round(avg(toFloat64(completed.properties.elapsed_ms)), 0) AS avg_elapsed_ms
FROM events AS offer
LEFT JOIN events AS completed
    ON completed.properties.attempt_id = offer.properties.attempt_id
    AND completed.event = 'call_recovery_completed'
LEFT JOIN events AS failed
    ON failed.properties.attempt_id = offer.properties.attempt_id
    AND failed.event = 'call_recovery_failed'
WHERE offer.event = 'call_recovery_offer'
    AND offer.timestamp >= now() - INTERVAL 14 DAY
GROUP BY recovery_kind
```

### 9.5 Receptionist reconnect success rate + duplicate finalization count

```sql
-- Success rate
SELECT
    countIf(event = 'receptionist_reconnect_completed') AS completed,
    countIf(event = 'receptionist_reconnect_failed') AS failed,
    round(
        countIf(event = 'receptionist_reconnect_completed') * 100.0
        / nullif(countIf(event = 'receptionist_reconnect_completed')
                 + countIf(event = 'receptionist_reconnect_failed'), 0), 1
    ) AS success_pct
FROM events
WHERE event IN ('receptionist_reconnect_completed', 'receptionist_reconnect_failed')
    AND timestamp >= now() - INTERVAL 14 DAY;

-- Duplicate finalization count (must be 0 before any prod graduation)
SELECT
    properties.session_id_hash AS session_id_hash,
    count() AS finalize_events
FROM events
WHERE event = 'call_ended'
    AND properties.session_id_hash IS NOT NULL
    AND timestamp >= now() - INTERVAL 14 DAY
GROUP BY session_id_hash
HAVING count() > 1
ORDER BY finalize_events DESC
```

### 9.6 Terminal reasons breakdown (`recovery_timeout_no_playout` etc.)

```sql
SELECT
    properties.terminal_reason AS terminal_reason,
    count() AS occurrences,
    count(DISTINCT properties.call_id) AS distinct_calls,
    round(avg(toFloat64(properties.elapsed_ms)), 0) AS avg_elapsed_ms
FROM events
WHERE event = 'call_recovery_failed'
    AND timestamp >= now() - INTERVAL 14 DAY
GROUP BY terminal_reason
ORDER BY occurrences DESC
```

Bonus/underlying query used for insight (b) and (f) on the dashboard — call
outcome by `call_ended` reason, to see whether `recovery_timeout_no_playout`
correlates with hard call termination:

```sql
SELECT
    properties.reason AS end_reason,
    count() AS occurrences
FROM events
WHERE event = 'call_ended'
    AND timestamp >= now() - INTERVAL 14 DAY
GROUP BY end_reason
ORDER BY occurrences DESC
```

---

## 10. Dashboard

**Name:** `AvaTOK — Call Reliability (CALL-REL)`
**Project:** 139917 (EU)
**Dashboard:** id `845763` — https://eu.posthog.com/project/139917/dashboard/845763

Insights (created via the PostHog MCP as SQL/`DataVisualizationNode` insights,
each attached to the dashboard above; HogQL in §9 is the source of truth if any
insight needs to be recreated manually):

| # | Insight | Insight id / short_id | URL | Source query |
|---|---|---|---|---|
| (a) | `call_started` → `call_connected` conversion by network/candidate type | 5150072 / `C1d8Pc8u` | https://eu.posthog.com/project/139917/insights/C1d8Pc8u | §9.1 |
| (b) | `call_media_health` transitions to `noPlayout` by route | 5150073 / `FU3Gwms1` | https://eu.posthog.com/project/139917/insights/FU3Gwms1 | §9.2 |
| (c) | Route request vs confirm mismatch rate | 5150074 / `nZ38R2jj` | https://eu.posthog.com/project/139917/insights/nZ38R2jj | §9.3 |
| (d) | Recovery success: ICE vs relay migration | 5150075 / `A0IZA9vE` | https://eu.posthog.com/project/139917/insights/A0IZA9vE | §9.4 |
| (e) | Receptionist reconnect success rate | 5150076 / `9urO7pN4` | https://eu.posthog.com/project/139917/insights/9urO7pN4 | §9.5 |
| (e2) | Receptionist duplicate finalization count (must be 0 before prod graduation) | 5150077 / `Ags1DTgj` | https://eu.posthog.com/project/139917/insights/Ags1DTgj | §9.5 |
| (f) | Terminal reasons breakdown | 5150078 / `f3byOhKA` | https://eu.posthog.com/project/139917/insights/f3byOhKA | §9.6 |

All insights are expected to render **empty** until the corresponding
`[CALL-REL-1]`..`[CALL-REL-7]`/`[CALL-REL-9]` events start flowing in staging —
that is expected and is the acceptance contract, not a defect in this
deliverable. Do not consider a flag ready to graduate past staging-active until
its insight(s) here show non-empty, sane data for at least one staging test
cycle covering the plan §11 matrix scenario it maps to.

The PostHog MCP successfully created the dashboard and all seven insights
(§10 table) in this pass — no manual UI recreation is needed. They render
empty today (2026-07-24) because no `[CALL-REL-1]`..`[CALL-REL-7]`/`[CALL-REL-9]`
events have shipped yet; that is expected per the note above.

---

## 11. Traceability back to defects

| Event(s) | Defect(s) closed |
|---|---|
| `call_audio_route_requested/result`, `call_audio_focus` | REL-5, REL-6, REL-7 |
| `call_audio_context_set` (legacy, pre-existing) | REL-5, REL-6, REL-7 (observability for the flag-off path pending `callAudioControllerV2`) |
| `call_tone_*` | REL-5 (ducking/ownership) |
| `call_media_health`, amended `call_progress` | REL-1, REL-9 |
| `call_recovery_started/offer/completed/failed` | REL-2, REL-3, REL-4 |
| `receptionist_reconnect_started/completed/failed` | REL-8 |
| `call_ring_audibility`, `call_ring_fallback_played` | REL-10 |
| `rtc_error`/`$exception` handled-Issue convention | REL-9 (proof infrastructure for all of the above) |
