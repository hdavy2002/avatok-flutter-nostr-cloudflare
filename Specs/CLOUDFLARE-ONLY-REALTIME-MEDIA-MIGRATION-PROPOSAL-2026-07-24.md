# AvaTOK Cloudflare-Only Realtime Media Migration Proposal

**Date:** 2026-07-24  
**Decision requested:** make Cloudflare the only external realtime media provider for AvaTOK group audio/video and WebRTC traversal.  
**Scope:** remove LiveKit from AvaTOK group conferencing, extend the existing Cloudflare Realtime SFU path from audio-only to audio/video, keep 1:1 calls on raw WebRTC with Cloudflare TURN/STUN/ICE, and preserve Cloudflare Durable Objects for signaling/presence.

## Executive summary

The current repository is not Cloudflare-only. The actual state is:

```text
1:1 audio/video        raw flutter_webrtc + CallRoom DO + Cloudflare ICE/TURN
group audio (flag off) LiveKit conference path
group audio (flag on)  Cloudflare Realtime SFU + GroupCallRoom DO
group video            LiveKit ConferenceScreen
free mesh fallback     raw flutter_webrtc + MeshRoom DO
```

`worker/src/routes/config.ts` currently defaults `conferenceEnabled=true` and
`groupAudioSfuEnabled=false`. `app/pubspec.yaml` still includes
`livekit_client`, and `ConferenceScreen` connects to LiveKit. Cloudflare Realtime
now supports audio/video/data SFU workloads, while Cloudflare TURN Service is the
managed traversal layer. The existing `groupcall.ts` implementation uses only
audio and must be extended; changing a flag alone would break group video.

The target is:

```text
1:1 audio/video        raw flutter_webrtc + authenticated CallRoom DO
                        + Cloudflare TURN/STUN/ICE
group audio/video      Cloudflare Realtime SFU sessions/tracks API
                        + authenticated GroupCallRoom DO
                        + Cloudflare TURN/STUN/ICE
group signaling        Cloudflare Worker + Durable Objects only
provider fallback      none; fail clearly and safely, never fall back to mesh
external SFU provider  none; remove LiveKit after migration acceptance
```

Cloudflare Realtime is deliberately low-level: it has no built-in rooms or
presence, so AvaTOK must own the authenticated room authority, participant roster,
track distribution, subscription policy, reconnection, and lifecycle. This is
acceptable and aligns with the existing `GroupCallRoom` design, but it is a real
media-provider migration, not a configuration toggle.

## Cloudflare product boundaries

- **Cloudflare Realtime SFU:** forwards WebRTC audio/video/data tracks. It is the
  group media provider.
- **Cloudflare TURN Service / Cloudflare Calls ICE minting:** provides STUN/TURN
  ICE servers for 1:1 P2P and Cloudflare-SFU client sessions.
- **Cloudflare Durable Objects:** own authenticated room authority, participant
  presence, call generations, track metadata, recovery coordination, and bounded
  signaling messages. They do not carry media bytes.
- **Cloudflare Workers:** authenticate users, validate membership, mint short-lived
  SFU session credentials, proxy the Realtime API, and emit server telemetry.
- **Cloudflare RealtimeKit:** optional higher-level product, not the immediate
  implementation target because the app is Flutter and the existing custom
  low-level SFU proxy already matches the needed architecture. Do not introduce
  RealtimeKit and raw Realtime SFU as two competing provider layers.

Official references:

- https://developers.cloudflare.com/realtime/sfu/
- https://developers.cloudflare.com/realtime/sfu/introduction/
- https://developers.cloudflare.com/realtime/sfu/simulcast/
- https://developers.cloudflare.com/realtime/

## Non-negotiable migration rules

1. Do not turn off LiveKit before Cloudflare A/V passes the staging acceptance
   matrix.
2. Do not keep an automatic P2P mesh fallback for group video. A failed SFU join
   must show a retryable error and produce telemetry; silently creating a five-way
   mesh recreates the original scalability failure.
3. Every group call receives a unique opaque `call_id`; a group id is only an
   authorization/resource key and must not be the call identity.
4. Authenticate both HTTP endpoints and WebSocket upgrades. A group id, query
   parameter, or client-generated participant id is never an authorization token.
5. Cloudflare API tokens and Realtime app tokens remain Worker secrets. Clients
   receive only short-lived, scoped session credentials.
6. Every transport transition, track transition, recovery attempt, and provider
   error is correlated in PostHog by `call_id`, `call_trace_id`, transport, uid,
   and release.
7. Never log raw SDP, ICE credentials, TURN passwords, access tokens, camera data,
   transcripts, or media bytes.

## Phase 0 — freeze and inventory

Before implementation, record the current behavior and prevent accidental
provider drift:

- Add a source-level provider enum: `cloudflare_realtime` and `disabled`.
- Add a server-returned `transport` field to every conference ticket.
- Add a unique `call_id` and `call_trace_id` to the ticket.
- Add a kill switch `cloudflareConferenceEnabled`, default false in production
  until staging acceptance is complete.
- Add `livekitConferenceEnabled`, default true only during migration and scoped to
  an explicit staging cohort. It must not be used after cutover.
- Add a server assertion: when `cloudflareConferenceEnabled=true`, the Worker must
  reject `/api/conference/*` LiveKit issuance with a clear provider-disabled error
  rather than silently issuing LiveKit credentials.
- Add `conference_provider_selected` telemetry at the decision boundary.

Do not flip a production default in source until the owner explicitly authorizes
the production rollout. Staging must be the first target.

## Phase 1 — authenticated Cloudflare conference authority

### New authoritative state

Create a `ConferenceAuthority` Durable Object or extend a dedicated conference
authority layer. It stores/coordinates:

```text
call_id
group_id
provider = cloudflare_realtime
media_kind = audio | video | audio_video
started_by
generation
created_at / ended_at
max_participants
state = starting | live | ending | ended
participant uid -> {session_id, audio_track, video_track, generation, last_seen}
```

The DO is not a media server. It is the source of truth for room membership and
track metadata and forwards bounded control messages.

### Signed join ticket

`POST /api/conference/:groupId/start` and `/join` must:

1. authenticate the Clerk user;
2. verify group membership and plan/capacity policy;
3. create or load the unique call authority;
4. create a Cloudflare Realtime session;
5. mint a short-lived signed join ticket containing call id, uid, session id,
   generation, expiry, and nonce;
6. return the ticket, ICE servers, WebSocket endpoint, media mode, and limits.

The WebSocket upgrade must verify the ticket before reaching the DO. The DO must
bind the verified uid to the socket and reject duplicate/stale generations.

## Phase 2 — extend Worker Realtime API from audio to A/V

Modify:

- `worker/src/routes/groupcall.ts`
- `worker/src/do/group_call_room.ts`
- `worker/src/index.ts`
- `worker/src/routes/media.ts` / the existing `mintIceServers` path

### Join response

Return:

```json
{
  "provider": "cloudflare_realtime",
  "call_id": "opaque-call-id",
  "call_trace_id": "trace-id",
  "session_id": "cloudflare-session-id",
  "join_ticket": "short-lived-signed-ticket",
  "ice_servers": [],
  "media": { "audio": true, "video": true },
  "max_participants": 25,
  "ws_url": "wss://..."
}
```

### Publish

The client publishes one local offer containing audio and optional video. The
client sends explicit track metadata:

```json
{
  "tracks": [
    {"location":"local", "mid":"0", "kind":"audio", "trackName":"audio-..."},
    {"location":"local", "mid":"1", "kind":"video", "trackName":"video-..."}
  ]
}
```

The Worker validates allowed kinds, track-name length, session ownership, call
generation, and media mode. It never trusts a client-supplied uid.

### Roster

Replace the single `track` field in `GroupCallRoom` with explicit track metadata:

```text
uid, session_id, audio_track, video_track, video_enabled, generation, last_seen
```

Track publication is an idempotent update. A camera-off operation clears or
disables only the video track; it must not remove the audio track or create a new
session.

### Pull/subscription

For audio, keep active-speaker selection with a bounded maximum. For video:

- subscribe to the dominant speaker at high quality;
- subscribe to visible grid tiles at low/medium quality;
- stop or downgrade off-screen tiles;
- cap simultaneous video subscriptions by device class and viewport;
- use Cloudflare Realtime simulcast RIDs where supported;
- never pull every 25 video tracks at full quality on a mobile device.

The pull API must accept `kind`, `track_name`, and an optional quality policy or
preferred RID. The server must authorize that the subscriber may receive the
publisher track. Every pull/close operation must be idempotent.

## Phase 3 — Flutter Cloudflare A/V client

Replace the LiveKit-specific group screen with a Cloudflare implementation. New
or renamed files should be:

- `app/lib/features/conference/cloudflare_conference_api.dart`
- `app/lib/features/conference/cloudflare_conference_screen.dart`
- `app/lib/features/conference/cloudflare_conference_telemetry.dart`
- shared `app/lib/features/conference/conference_media_controller.dart`

The controller owns one authenticated `RTCPeerConnection` per participant session
or one negotiated connection according to the Cloudflare Realtime API contract;
it must not mix the audio-only assumptions from `SfuGroupCallScreen` with video.

Implementation requirements:

- initialize camera/mic before publishing and validate live tracks;
- await every `addTrack` and sender configuration call;
- use explicit capture constraints and bounded video encoding;
- use generation guards around every PC, track, and renderer callback;
- serialize publish/pull/renegotiate operations;
- handle track-added and track-removed independently for audio/video;
- confirm decode and renderer progress before reporting video healthy;
- reconnect the signaling socket without killing healthy media;
- recreate the SFU PC only after the new path has remote media evidence;
- dispose stream, PC, renderer, and timers in a deterministic order.

No `livekit_client` import may remain in the AvaTOK group-call path after cutover.

## Phase 4 — remove LiveKit safely

After Cloudflare A/V passes staging:

1. route all group calls through the Cloudflare ticket;
2. set `livekitConferenceEnabled=false` in staging;
3. verify no LiveKit tokens are issued and no LiveKit room is created;
4. remove `/api/conference/*` LiveKit issuance and webhook routes after the
   retention window;
5. remove `livekit_client` from `app/pubspec.yaml`;
6. remove `ConferenceScreen`, `ConferenceTelemetry`, `ConferenceApi`, LiveKit
   Worker secrets, region-routing code, and LiveKit wrangler variables;
7. rename Cloudflare-specific paths only after telemetry queries and dashboards
   are migrated;
8. delete the old LiveKit code in a separate commit, after a rollback tag exists.

Do not delete LiveKit credentials or deploy a provider removal until staging has
demonstrated a rollback and the owner authorizes production.

## Phase 5 — 1:1 P2P remains Cloudflare-native

1:1 calls should remain raw WebRTC because Cloudflare Realtime SFU is not required
for a two-party call. Continue using Cloudflare TURN/STUN/ICE from `IceCache` and
`mintIceServers`. Apply the separate video fixes:

- await track installation;
- add camera constraints and sender bitrate limits;
- use balanced degradation;
- serialize renegotiation and ICE recovery;
- add camera flip using `replaceTrack` or transceiver direction;
- protect renderer generations;
- add playout/decode/route confirmation;
- force TURN only as a measured recovery path, not as a blind timer.

## PostHog Error Tracking and telemetry contract

Every Cloudflare conference event includes:

```text
call_id, call_trace_id, transport=cloudflare_realtime,
group_id_hash, participant_hash, generation, media_kind,
participant_count, network_type, ice_type, relay_used, app_release
```

Required events:

```text
conference_provider_selected
cloudflare_conference_ticket_issued
cloudflare_conference_join_started
cloudflare_conference_joined
cloudflare_track_publish_started/completed/failed
cloudflare_track_pull_started/completed/failed
cloudflare_media_health
cloudflare_renderer_state
cloudflare_route_state
cloudflare_reconnect_started/completed/failed
cloudflare_participant_joined/left
cloudflare_billing_beat/reconciled
cloudflare_conference_left
cloudflare_conference_error
```

For every handled failure, send both `cloudflare_conference_error` and a standard
PostHog `$exception` using `Analytics.captureException(..., handled:true)`. The
Worker uses `trackException` with the same `$exception_list` structure. Deduplicate
by `call_id + transport + stage + generation`; include the account email/phone via
the normal analytics identity envelope, but never include tokens, SDP, ICE
passwords, raw URLs, transcripts, or media bytes.

Minimum health invariants:

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

`cloudflare_media_health` must distinguish RTP receipt from decode/render/playout.

## Acceptance matrix before disabling LiveKit

| Test | Required result |
|---|---|
| 1:1 video Wi-Fi | clear audio/video, camera flip, no renderer race |
| 1:1 video cellular | bounded bitrate, adaptation, recovery, measured Cloudflare relay |
| Cloudflare group audio 2/5/10/25 | stable active-speaker selection and recovery |
| Cloudflare group video 2/5/10/25 | viewport-aware subscriptions, no mobile memory runaway |
| camera off/on | video track state changes without audio interruption or new session |
| participant join/leave | roster and track state converge on every device |
| background/foreground | signaling reattach and billing reconcile correctly |
| expired/replayed ticket | WebSocket rejected |
| non-member/unauthenticated | HTTP and WebSocket rejected |
| forced relay | Cloudflare ICE relay candidate confirmed |
| provider outage | clear retry UX, grouped PostHog Issue, no mesh fallback |
| LiveKit disabled | no LiveKit token, room, import, or provider event remains |

## Recommended implementation commits

1. `CF-CALL-001` authenticated conference authority and join tickets.
2. `CF-CALL-002` A/V track metadata and Cloudflare Worker API.
3. `CF-CALL-003` Cloudflare Flutter A/V controller and renderer lifecycle.
4. `CF-CALL-004` video subscription/adaptation policy.
5. `CF-CALL-005` PostHog health/error contract and dashboards.
6. `CF-CALL-006` staging cutover with LiveKit kill switch.
7. `CF-CALL-007` remove LiveKit code, secrets, dependencies, and routes.

The provider switch is complete only after commit `CF-CALL-007` is staged,
validated, and production rollout is explicitly authorized. Until then, the
existing LiveKit group-video path must remain available only as a controlled
staging rollback, never as an unannounced production fallback.
