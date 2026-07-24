# CF Conference Telemetry Contract — 2026-07-24 [CF-CALL-005]

**Status:** definitive event schema + `$exception` convention + acceptance
dashboard contract for the Cloudflare-only group conference migration
(`Specs/CLOUDFLARE-ONLY-REALTIME-MEDIA-MIGRATION-PROPOSAL-2026-07-24.md`,
"PostHog Error Tracking and telemetry contract" + "Acceptance matrix"
sections). This is the CF-CALL-005 deliverable of that proposal's commit
sequence (`CF-CALL-001`..`CF-CALL-007`).

**Scope of this document:** the CONTRACT only — property lists, emission
points, the health-invariant chain, the `$exception` handled-Issue
convention, forbidden content, correlation keys, and the acceptance matrix as
concrete HogQL. It does not implement client/server emitting code — that
lands under `CF-CALL-001`..`CF-CALL-004`/`006`/`007`. Where this contract and
an actual emit site drift, this document is the source of truth; implementers
reconcile the code to it, not the reverse (same rule as
`Specs/CALL-RELIABILITY-TELEMETRY-CONTRACT-2026-07-24.md` §house style, which
this doc follows for conventions).

PostHog project: **139917** (EU, `https://eu.i.posthog.com`).

This contract is the group-conference (Cloudflare Realtime SFU) counterpart
to `Specs/CALL-RELIABILITY-TELEMETRY-CONTRACT-2026-07-24.md`, which covers
1:1 P2P call reliability. Do not duplicate 1:1 events here; `rtc_*`,
`call_media_health`, `call_recovery_*` etc. stay in that contract and
continue to apply unchanged to 1:1 calls per Phase 5 of the migration
proposal. Everything below is `cloudflare_conference_*` / `cloudflare_*`
group-conference-specific.

---

## 0. Cross-cutting rules (apply to every event below)

Mirrors `CALL-RELIABILITY-TELEMETRY-CONTRACT-2026-07-24.md` §0, restated for
the conference surface:

1. **Envelope identity.** All events go through `Analytics.capture(...)`,
   which stamps the account identity envelope (Clerk uid alias, email, phone
   when available) automatically — do not pass email/phone as a raw property.
2. **Required base properties on every event in this contract** (in addition
   to any event-specific properties below):

   | Property | Type | Notes |
   |---|---|---|
   | `call_id` | string | opaque per-conference id minted by `ConferenceAuthority`/`GroupCallRoom`; never a group id (migration proposal Non-negotiable rule 3) |
   | `call_trace_id` | string | per-join-attempt id that survives reconnects/recovery so one participant's full timeline reconstructs from a single filter; reuse `call_id` only until `call_trace_id` is plumbed, never omit both (mirrors CALL-REL contract §0.2) |
   | `transport` | enum | `cloudflare_realtime` (this contract's only value; `livekit` still appears on `conference_provider_selected` during migration — see §1) |
   | `group_id_hash` | string | HMAC/SHA-256 (or equivalent one-way hash, salted server-side) of the AvaTalk group id — never the raw group id, which is a resource/authorization key, not telemetry-safe on its own at group-membership-list granularity |
   | `participant_hash` | string | one-way hash of the participant's Clerk uid, distinct from the identity-envelope uid alias — lets conference-shaped queries join/count distinct participants without re-deriving PII from `call_id` fan-out; the envelope still carries the real identity per rule 1, this is for join-key stability across events that may be sampled/dropped |
   | `generation` | number | monotonic per-participant-session counter (PC/track/renderer generation guard from Phase 3); a stale generation's late callback must not re-emit a current-state event |
   | `media_kind` | enum | `audio`\|`video`\|`audio_video` — the call's negotiated media mode (`ConferenceAuthority.media_kind`) |
   | `participant_count` | number | roster size at emission time, from the local roster view, not a server round-trip |
   | `network_type` | enum | `wifi`\|`cellular`\|`ethernet`\|`vpn`\|`unknown` (device network class) |
   | `ice_type` | enum | `host`\|`srflx`\|`relay`\|`prflx`\|`unknown` — local candidate type of the session's active connection |
   | `relay_used` | bool | `ice_type == 'relay'` |
   | `app_release` | string | `$app_version`/build from the analytics envelope, restated as an explicit property so conference dashboards don't depend on PostHog's `$` person/session properties being backfilled the same way for server-origin events |

   Events that fire before a `call_id` exists (only
   `conference_provider_selected`, §1) are exempt from `call_id`/
   `call_trace_id`/`generation`/`participant_count`; every other event in
   this contract carries the full base set.

3. **Forbidden content — never present in any property, extra, or error
   message on any event in this contract** (identical list to
   `CALL-RELIABILITY-TELEMETRY-CONTRACT-2026-07-24.md` §0.3, restated because
   this is a distinct emit surface and must not be assumed inherited):
   - SDP (offer/answer bodies, `m=`/`a=` lines, fingerprints).
   - ICE candidates, ICE server URLs/credentials, TURN username/password/realm.
   - Any bearer/session token, the signed **join ticket** itself (or any
     substring of it), Clerk token, signed URL query strings, `ws_url` query
     string (the bare `wss://host/path` origin is fine; the ticket/nonce
     query params are not).
   - Microphone/camera/PCM audio bytes, recorded audio or video frames,
     transcript text.
   - Raw candidate IP/port, TURN relay address (matches
     `call_media_health`'s existing forbidden-content rule).
   - Raw group id or raw Clerk uid anywhere other than the PostHog identity
     envelope itself — every property on the event must use `group_id_hash`/
     `participant_hash`, never the plaintext id.
   - Raw stack traces containing the above (the existing `_scrub`/
     `scrubServer`/`beforeSend` pipeline is the last line of defense, not a
     substitute for not sending it).
   - Allowed instead: booleans/enums/counts/durations/ids
     (`exact: bool`, `kind: string`, `elapsed_ms: number`, `session_id_hash`,
     `attempt_id`).

4. **Dedup / cardinality.** Every event that fires on a state-machine
   transition (`cloudflare_media_health`, `cloudflare_renderer_state`,
   `cloudflare_route_state`) must fire once per transition, not once per
   poll — identical pattern to `call_media_flow_state`
   (`call_telemetry.dart:490-509`) and `call_media_health` in the P2P
   contract. Track publish/pull events fire once per operation (started once,
   then exactly one of completed/failed), keyed by `(call_id, track_name,
   attempt)`.

5. **`$exception` handled-Issue convention** (migration proposal, "PostHog
   Error Tracking and telemetry contract" section):
   - For every handled failure, send **both** `cloudflare_conference_error`
     and a standard PostHog `$exception` via
     `Analytics.captureException(..., handled: true, extra: {...})` (client)
     or `hooks.trackException(...)` with the same `$exception_list` shape
     (Worker — `ConferenceAuthority`/`GroupCallRoom`/`groupcall.ts`).
   - **Dedup key: `call_id + transport + stage + generation`.** One handled
     exception + one `cloudflare_conference_error` per unique tuple, enforced
     client-side via a per-controller `Set<String>` guard (same pattern as
     `CallTelemetry._reportedRuntimeErrorStages` in the P2P contract, keyed
     one dimension wider here because `generation` changes across
     reconnects/PC recreation within the same `call_id`). A repeat failure at
     the same `(call_id, transport, stage, generation)` bumps a local counter
     surfaced on `cloudflare_conference_error.repeat_count` instead of firing
     a second Issue.
   - `stage` is a fixed vocabulary (extend this list here first, mirroring
     the P2P contract's rule that new stages are added to the doc before the
     code):
     ```text
     ticket_mint_failed
     ticket_verify_failed
     session_create_failed
     ws_upgrade_rejected
     local_capture_failed
     publish_sdp_failed
     publish_track_rejected
     pull_sdp_failed
     pull_track_rejected
     renegotiation_failed
     ice_gathering_failed
     decode_failed
     renderer_bind_failed
     route_confirm_failed
     roster_sync_failed
     generation_conflict
     capacity_rejected
     provider_disabled
     socket_reconnect_failed
     billing_reconcile_failed
     ```
   - Every handled-exception `extra` includes: `call_id`, `call_trace_id`,
     `transport`, `stage`, `generation`, `media_kind`, `participant_count`,
     `network_type`, `ice_type`, `relay_used`, `app_release`, direction
     (`publish`\|`pull`\|`control`), and — when applicable —
     `track_kind`/`track_name_hash` (never the raw track name if it embeds
     anything sensitive; in practice `trackName` is server-issued and opaque,
     but hash it anyway for uniformity with `session_id_hash` elsewhere in
     the telemetry conventions). Never SDP/ICE-creds/tokens/media (rule 3).
   - Server-side (`ConferenceAuthority`, `GroupCallRoom`, `groupcall.ts`)
     failures use `hooks.trackException` with the same `stage` vocabulary,
     extended by: `worker_session_mint_failed`, `worker_ticket_sign_failed`,
     `worker_roster_cas_conflict`, `worker_realtime_api_failed` (upstream
     Cloudflare Realtime API 4xx/5xx).
   - Dedup key for both client and server: `call_id + transport + stage +
     generation`. This is what keeps one bad SFU session from generating
     hundreds of identical Issues across reconnect loops.

---

## 1. Provider selection

### 1.1 `conference_provider_selected`

Emitted once at the decision boundary, before any conference-specific
identifiers exist — the moment the client (or Worker, for the authoritative
copy) decides which provider a `start`/`join` request will use. This is the
event Phase 0 of the migration proposal requires ("Add
`conference_provider_selected` telemetry at the decision boundary").

| Property | Type | Notes |
|---|---|---|
| `group_id_hash` | string | required (base property; this event is the one exception that has no `call_id` yet) |
| `decided_provider` | enum | `cloudflare_realtime`\|`livekit`\|`disabled` |
| `cloudflare_conference_enabled` | bool | flag value observed at decision time |
| `livekit_conference_enabled` | bool | flag value observed at decision time |
| `media_kind_requested` | enum | `audio`\|`video`\|`audio_video` |
| `decision_source` | enum | `client`\|`worker` — client emits its own pre-flight decision; Worker emits the authoritative one after flag/membership checks; the two are expected to usually agree and a mismatch is a signal, not necessarily an error |
| `app_release` | string | base property |
| `network_type` | string | base property |

**Not carrying `call_id`/`transport`/`generation`/`participant_count`** per
§0.2's stated exemption — those don't exist yet at this decision point.

---

## 2. Ticket issuance and join funnel

### 2.1 `cloudflare_conference_ticket_issued`

Emitted by the Worker (`hooks.trackException`'s sibling success-path capture,
or the equivalent server analytics call) immediately after
`POST /api/conference/:groupId/start|join` mints the signed join ticket —
i.e. right after Phase 1's step 5 ("mint a short-lived signed join ticket").

| Property | Type | Notes |
|---|---|---|
| all base properties | — | required |
| `route` | enum | `start`\|`join` |
| `session_id_hash` | string | hash of the Cloudflare Realtime session id, never the raw id |
| `ttl_ms` | number | ticket expiry window |
| `max_participants` | number | from `ConferenceAuthority` |
| `existing_participant_count` | number | roster size at mint time |

### 2.2 `cloudflare_conference_join_started`

Emitted client-side the instant the WebSocket upgrade begins, ticket in hand.

| Property | Type | Notes |
|---|---|---|
| all base properties | — | required |
| `route` | enum | `start`\|`join` |
| `ticket_age_ms` | number | time since the ticket was received, proves the client isn't racing an expired ticket |

### 2.3 `cloudflare_conference_joined`

Emitted once the DO has bound the verified uid to the socket and the client
has received roster state — the closing half of the join funnel.

| Property | Type | Notes |
|---|---|---|
| all base properties | — | required |
| `elapsed_ms` | number | `join_started` → `joined` latency |
| `roster_size_on_join` | number | participants already present |

---

## 3. Track publish / pull

### 3.1 `cloudflare_track_publish_started` / `..._completed` / `..._failed`

Fires once per publish attempt (one local offer containing audio and
optional video, per Phase 2 "Publish"). `started` always pairs with exactly
one of `completed`/`failed`.

| Property | Type | Applies to | Notes |
|---|---|---|---|
| all base properties | — | all three | required |
| `track_kind` | enum (`audio`\|`video`\|`audio_video`) | all three | matches the request's negotiated tracks, not just one mid |
| `mid_count` | number | `started` | number of mids in the offer (1 for audio-only, 2 for audio+video) |
| `attempt` | number | all three | 1-based; a retried publish (e.g. after `generation_conflict`) increments |
| `elapsed_ms` | number | `completed`/`failed` | since `started` |
| `failure_code` | string\|null | `failed` only | fixed vocabulary reusing the `stage` list in §0.5 where applicable (`publish_sdp_failed`, `publish_track_rejected`, `ice_gathering_failed`, `generation_conflict`), `null` on success |

### 3.2 `cloudflare_track_pull_started` / `..._completed` / `..._failed`

Fires once per subscribe/pull operation (per-track, per Phase 2 "Pull/subscription").

| Property | Type | Applies to | Notes |
|---|---|---|---|
| all base properties | — | all three | required |
| `track_kind` | enum (`audio`\|`video`) | all three | |
| `quality_policy` | enum (`high`\|`medium`\|`low`\|`off`) | all three | requested subscription quality/RID tier |
| `subscription_reason` | enum (`dominant_speaker`\|`visible_grid_tile`\|`active_speaker_audio`\|`manual`) | `started` | why this track was pulled — proves the viewport-aware policy is behaving, not blind full-mesh pulling |
| `elapsed_ms` | number | `completed`/`failed` | since `started` |
| `failure_code` | string\|null | `failed` only | fixed vocabulary (`pull_sdp_failed`, `pull_track_rejected`), `null` on success |

**Failure-rate-by-kind is the acceptance-matrix insight (c)** — see §9.3.

---

## 4. Media health invariant chain

### 4.1 `cloudflare_media_health`

Sampled internally (mirrors the P2P `call_media_health` cadence, ~5s);
**emitted only on a class transition**, never once per sample. This is the
event that proves the full render pipeline is alive, not just RTP receipt —
`cloudflare_media_health` must distinguish RTP receipt from
decode/render/playout per the migration proposal's closing requirement.

The health invariant chain (each stage must be independently observable;
`class` below reflects the furthest stage reached / first stage that
regressed):

```text
local_capture_started
publish_progressing
subscribe_progressing
video_decode_progressing
renderer_bound
renderer_frame_progressing
audio_playout_progressing
route_confirmed
```

| Property | Type | Notes |
|---|---|---|
| all base properties | — | required |
| `track_kind` | enum (`audio`\|`video`) | which pipeline this sample describes — audio and video invariants are tracked and emitted independently, since camera-off must not regress the audio chain (Phase 2 "Roster" / migration rule) |
| `class` | enum | `healthy`\|`no_rtp`\|`rtp_no_decode`\|`decode_no_render`\|`render_no_playout`\|`route_broken` — mirrors the P2P contract's class-transition pattern but split at the decode/render boundary Cloudflare video adds |
| `from_class` | enum | prior class, nullable on first sample |
| `invariant_reached` | enum | the furthest invariant in the chain above confirmed true as of this sample — lets a query group by "how far did this session get" without re-deriving it from `class` |
| `rtp_bytes_delta` | number | interval delta; `unknown` fields omitted, never zero-filled |
| `decode_frames_delta` | number | video only |
| `playout_delta` | number | delta `jitterBufferEmittedCount` equivalent |
| `concealment_pct` | number | audio only |
| `jitter_ms` | number | |
| `loss_pct` | number | |
| `route` | enum | native active audio route at sample time (audio pipeline only) |

**Forbidden:** no candidate IP/port, no TURN relay address, no raw frame data
(rule 3).

**Acceptance-matrix insight (d)** groups `cloudflare_media_health`
transitions to unhealthy classes by `media_kind` — see §9.4.

### 4.2 `cloudflare_renderer_state`

Emitted on renderer lifecycle transitions (bind/unbind/rebind), independent
of the health sampler — this is the Flutter-side renderer generation guard
from Phase 3 ("use generation guards around every PC, track, and renderer
callback").

| Property | Type | Notes |
|---|---|---|
| all base properties | — | required |
| `renderer_state` | enum | `unbound`\|`binding`\|`bound`\|`frame_progressing`\|`stalled`\|`disposed` |
| `stall_ms` | number\|null | time since last frame when transitioning into `stalled`; `null` otherwise |

### 4.3 `cloudflare_route_state`

Emitted on audio route confirmation transitions for the conference call —
distinct from `cloudflare_media_health`'s `route` field because this is the
discrete confirm/mismatch event, mirroring `call_audio_route_result` in the
P2P contract but scoped to the conference session.

| Property | Type | Notes |
|---|---|---|
| all base properties | — | required |
| `active_route` | enum | `earpiece`\|`speaker`\|`bluetooth`\|`wiredHeadset`\|`unknown` |
| `route_confirmed` | bool | whether this matches the desired route for a conference call (conference calls default-route to speaker) |

---

## 5. Reconnect

### 5.1 `cloudflare_reconnect_started` / `..._completed` / `..._failed`

Fires when the signaling socket reconnects without killing healthy media
(Phase 3: "reconnect the signaling socket without killing healthy media";
"recreate the SFU PC only after the new path has remote media evidence").

| Property | Type | Applies to | Notes |
|---|---|---|---|
| all base properties | — | all three | required |
| `attempt_id` | string (uuid) | all three | one per reconnect attempt, joins the triplet like `call_recovery_*`'s `attempt_id` in the P2P contract |
| `reason` | enum | `started` | `socket_closed`\|`socket_error`\|`app_foregrounded`\|`network_changed`\|`heartbeat_timeout` |
| `media_kept_alive` | bool | `started`/`completed` | whether the existing PC/tracks survived the socket drop without teardown |
| `elapsed_ms` | number | `completed`/`failed` | since `started` |
| `pc_recreated` | bool | `completed` | true only if the SFU PC itself was recreated (should be false in the common case per Phase 3's requirement) |
| `terminal_reason` | string\|null | `failed` only | fixed vocabulary: `socket_reconnect_timeout`\|`ticket_expired_during_reconnect`\|`generation_superseded`\|`server_rejected` |

**Acceptance-matrix insight (e)** is reconnect success rate — see §9.5.

---

## 6. Roster / participants

### 6.1 `cloudflare_participant_joined` / 6.2 `cloudflare_participant_left`

Emitted on every roster-converging event, both for the local participant's
own transitions and remote participants observed via the DO roster push
(needed for the acceptance matrix's "participant join/leave" row: "roster
and track state converge on every device").

| Property | Type | Applies to | Notes |
|---|---|---|---|
| all base properties | — | both | `participant_hash` here refers to the participant who joined/left, which may differ from the observer whose device emitted the event — both are present: the base `participant_hash` is the observer (per §0.2, hashed from the emitting device's own uid), plus `subject_participant_hash` below for the roster member the event is about |
| `subject_participant_hash` | string | both | hash of the uid that joined/left (may equal the base `participant_hash` for self-emitted events) |
| `roster_size_after` | number | both | |
| `leave_reason` | enum | `left` only | `voluntary`\|`disconnected`\|`kicked`\|`capacity_evicted`\|`generation_superseded` |

---

## 7. Billing

### 7.1 `cloudflare_billing_beat` / 7.2 `cloudflare_billing_reconciled`

Emitted per the acceptance matrix's "background/foreground" row ("signaling
reattach and billing reconcile correctly").

| Property | Type | Applies to | Notes |
|---|---|---|---|
| all base properties | — | both | required |
| `beat_seq` | number | `beat` | monotonic heartbeat counter for this participant session |
| `billed_ms_interval` | number | `beat` | duration attributed to this beat |
| `reconcile_reason` | enum | `reconciled` only | `foreground_resume`\|`session_end`\|`periodic_audit` |
| `drift_ms` | number | `reconciled` only | difference between client-tracked and server-authoritative billed duration; large drift is the signal this event exists to catch |

---

## 8. Terminal events

### 8.1 `cloudflare_conference_left`

Emitted once per participant session on clean or forced departure.

| Property | Type | Notes |
|---|---|---|
| all base properties | — | required |
| `leave_reason` | enum | same vocabulary as `cloudflare_participant_left.leave_reason` |
| `session_duration_ms` | number | join → leave |
| `final_media_health_class` | enum | last observed `cloudflare_media_health.class` before leaving |

### 8.2 `cloudflare_conference_error`

Paired with the `$exception` per §0.5. This is the compact, queryable half of
the handled-Issue convention.

| Property | Type | Notes |
|---|---|---|
| all base properties | — | required |
| `stage` | string | fixed vocabulary from §0.5 |
| `direction` | enum | `publish`\|`pull`\|`control`\|`ticket`\|`socket`\|`billing` |
| `repeat_count` | number | 1 on first occurrence at this `(call_id, transport, stage, generation)`; incremented, not re-emitted as a new Issue, on repeats |
| `recoverable` | bool | whether the client will retry automatically or is surfacing a terminal error to the user |

**Acceptance-matrix insight (f)** is `cloudflare_conference_error` breakdown
by `stage` — see §9.6.

---

## 9. Acceptance matrix as HogQL

All queries are HogQL against `events` in project 139917 (EU), following the
same pattern as `CALL-RELIABILITY-TELEMETRY-CONTRACT-2026-07-24.md` §9: they
are written now, before events flow, and are the acceptance contract for
"disabling LiveKit" per the migration proposal's Acceptance matrix table.
Every insight is expected to render **empty** until the corresponding
`CF-CALL-001`..`CF-CALL-004` code lands and staging traffic flows — that is
expected, not a defect. Adjust the `WHERE timestamp` window per run; defaults
below use a rolling 14-day window.

### 9.1 Provider selection split (LiveKit vs Cloudflare) over time

```sql
SELECT
    toStartOfDay(timestamp) AS day,
    properties.decided_provider AS provider,
    count() AS selections
FROM events
WHERE event = 'conference_provider_selected'
    AND timestamp >= now() - INTERVAL 14 DAY
GROUP BY day, provider
ORDER BY day, provider
```

### 9.2 CF join funnel: ticket_issued → join_started → joined

```sql
SELECT
    toStartOfDay(issued.timestamp) AS day,
    count(DISTINCT issued.properties.call_id) AS tickets_issued,
    count(DISTINCT started.properties.call_id) AS joins_started,
    count(DISTINCT joined.properties.call_id) AS joins_completed,
    round(
        count(DISTINCT joined.properties.call_id) * 100.0
        / nullif(count(DISTINCT issued.properties.call_id), 0), 1
    ) AS funnel_conversion_pct
FROM events AS issued
LEFT JOIN events AS started
    ON started.properties.call_id = issued.properties.call_id
    AND started.event = 'cloudflare_conference_join_started'
    AND started.timestamp >= issued.timestamp
    AND started.timestamp <= issued.timestamp + INTERVAL 5 MINUTE
LEFT JOIN events AS joined
    ON joined.properties.call_id = issued.properties.call_id
    AND joined.event = 'cloudflare_conference_joined'
    AND joined.timestamp >= issued.timestamp
    AND joined.timestamp <= issued.timestamp + INTERVAL 5 MINUTE
WHERE issued.event = 'cloudflare_conference_ticket_issued'
    AND issued.timestamp >= now() - INTERVAL 14 DAY
GROUP BY day
ORDER BY day
```

### 9.3 Track publish/pull failure rates by kind

```sql
SELECT
    'publish' AS operation,
    properties.track_kind AS track_kind,
    countIf(event = 'cloudflare_track_publish_completed') AS succeeded,
    countIf(event = 'cloudflare_track_publish_failed') AS failed_count,
    round(
        countIf(event = 'cloudflare_track_publish_failed') * 100.0
        / nullif(countIf(event = 'cloudflare_track_publish_completed')
                 + countIf(event = 'cloudflare_track_publish_failed'), 0), 1
    ) AS failure_pct
FROM events
WHERE event IN ('cloudflare_track_publish_completed', 'cloudflare_track_publish_failed')
    AND timestamp >= now() - INTERVAL 14 DAY
GROUP BY track_kind

UNION ALL

SELECT
    'pull' AS operation,
    properties.track_kind AS track_kind,
    countIf(event = 'cloudflare_track_pull_completed') AS succeeded,
    countIf(event = 'cloudflare_track_pull_failed') AS failed_count,
    round(
        countIf(event = 'cloudflare_track_pull_failed') * 100.0
        / nullif(countIf(event = 'cloudflare_track_pull_completed')
                 + countIf(event = 'cloudflare_track_pull_failed'), 0), 1
    ) AS failure_pct
FROM events
WHERE event IN ('cloudflare_track_pull_completed', 'cloudflare_track_pull_failed')
    AND timestamp >= now() - INTERVAL 14 DAY
GROUP BY track_kind
ORDER BY operation, track_kind
```

### 9.4 `cloudflare_media_health` transitions to unhealthy by `media_kind`

```sql
SELECT
    properties.media_kind AS media_kind,
    properties.track_kind AS track_kind,
    properties.class AS unhealthy_class,
    count() AS transitions,
    count(DISTINCT properties.call_id) AS distinct_calls_affected
FROM events
WHERE event = 'cloudflare_media_health'
    AND properties.class != 'healthy'
    AND timestamp >= now() - INTERVAL 14 DAY
GROUP BY media_kind, track_kind, unhealthy_class
ORDER BY transitions DESC
```

### 9.5 Reconnect success rate

```sql
SELECT
    countIf(event = 'cloudflare_reconnect_completed') AS completed,
    countIf(event = 'cloudflare_reconnect_failed') AS failed_count,
    round(
        countIf(event = 'cloudflare_reconnect_completed') * 100.0
        / nullif(countIf(event = 'cloudflare_reconnect_completed')
                 + countIf(event = 'cloudflare_reconnect_failed'), 0), 1
    ) AS success_pct,
    round(avg(toFloat64(properties.elapsed_ms)), 0) AS avg_elapsed_ms,
    countIf(properties.pc_recreated = true) AS pc_recreations
FROM events
WHERE event IN ('cloudflare_reconnect_completed', 'cloudflare_reconnect_failed')
    AND timestamp >= now() - INTERVAL 14 DAY
```

### 9.6 `cloudflare_conference_error` breakdown by stage

```sql
SELECT
    properties.stage AS stage,
    properties.direction AS direction,
    count() AS occurrences,
    count(DISTINCT properties.call_id) AS distinct_calls,
    sum(toFloat64(properties.repeat_count)) AS total_including_repeats
FROM events
WHERE event = 'cloudflare_conference_error'
    AND timestamp >= now() - INTERVAL 14 DAY
GROUP BY stage, direction
ORDER BY occurrences DESC
```

---

## 10. Dashboard

**Name:** `AvaTOK — CF Conference Migration (CF-CALL)`
**Project:** 139917 (EU)
**Dashboard:** id `845814` — https://eu.posthog.com/project/139917/dashboard/845814

Insights (created via the PostHog MCP as `DataVisualizationNode`/HogQL
insights, each attached to the dashboard above; HogQL in §9 is the source of
truth if any insight needs to be recreated manually), mapped to the migration
proposal's Acceptance matrix:

| # | Insight | Insight id / short_id | URL | Source query | Acceptance-matrix row(s) it evidences |
|---|---|---|---|---|---|
| (a) | Provider selection split (LiveKit vs Cloudflare) over time | 5150398 / `3sUmkWIV` | https://eu.posthog.com/project/139917/insights/3sUmkWIV | §9.1 | "LiveKit disabled" (proves the cutover actually shifted traffic before disabling LiveKit) |
| (b) | CF join funnel: ticket_issued → join_started → joined | 5150399 / `tzLKkWAN` | https://eu.posthog.com/project/139917/insights/tzLKkWAN | §9.2 | "expired/replayed ticket", "non-member/unauthenticated" (funnel drop-off surfaces both) |
| (c) | Track publish/pull failure rates by kind | 5150400 / `5zNsaS78` | https://eu.posthog.com/project/139917/insights/5zNsaS78 | §9.3 | "camera off/on", "Cloudflare group video 2/5/10/25" |
| (d) | `cloudflare_media_health` transitions to unhealthy by `media_kind` | 5150401 / `JmLWs2gw` | https://eu.posthog.com/project/139917/insights/JmLWs2gw | §9.4 | "Cloudflare group audio 2/5/10/25", "Cloudflare group video 2/5/10/25", "forced relay" |
| (e) | Reconnect success rate | 5150402 / `KpGdZbJP` | https://eu.posthog.com/project/139917/insights/KpGdZbJP | §9.5 | "background/foreground", "participant join/leave" |
| (f) | `cloudflare_conference_error` breakdown by stage | 5150403 / `r5A6RLjy` | https://eu.posthog.com/project/139917/insights/r5A6RLjy | §9.6 | "provider outage" (clear retry UX, grouped PostHog Issue, no mesh fallback) |

The PostHog MCP successfully created the dashboard and all six insights
(table above) in this pass — no manual UI recreation is needed. They render
empty today (2026-07-24) because no `CF-CALL-001`..`CF-CALL-004` emitting
code has shipped yet; that is expected per the note below.

All insights are expected to render **empty** until `CF-CALL-001`..
`CF-CALL-004` land and staging traffic flows through the Cloudflare
conference path — that is the expected acceptance state today (2026-07-24),
not a defect in this deliverable. Do not consider `cloudflareConferenceEnabled`
ready to graduate past staging, and do not disable LiveKit (`CF-CALL-006`/
`CF-CALL-007`), until every row of the migration proposal's Acceptance matrix
has a corresponding non-empty, sane insight result for at least one staging
test cycle.

---

## 11. Traceability back to the migration proposal

| Event(s) | Migration proposal section |
|---|---|
| `conference_provider_selected` | Phase 0 |
| `cloudflare_conference_ticket_issued`, `cloudflare_conference_join_started/joined` | Phase 1 (signed join ticket) |
| `cloudflare_track_publish_*`, `cloudflare_track_pull_*` | Phase 2 (Publish, Pull/subscription) |
| `cloudflare_media_health`, `cloudflare_renderer_state`, `cloudflare_route_state` | Phase 3 (renderer/decode/route confirmation requirements) |
| `cloudflare_reconnect_*` | Phase 3 ("reconnect the signaling socket without killing healthy media") |
| `cloudflare_participant_joined/left` | Phase 2 (Roster) |
| `cloudflare_billing_beat/reconciled` | Acceptance matrix "background/foreground" row |
| `cloudflare_conference_left` | Phase 2/3 lifecycle |
| `cloudflare_conference_error` + `$exception` handled-Issue convention | "PostHog Error Tracking and telemetry contract" section; Non-negotiable rule 6 |
