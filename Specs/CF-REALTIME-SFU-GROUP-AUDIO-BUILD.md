# CF Realtime SFU — Group AUDIO build spec (2026-06-28)

Owner-locked source: `Specs/FREE-LAUNCH-DIRECTION.md` §2. This is the
implementation-ready plan to move the **GROUP** call path off LiveKit onto
**Cloudflare Realtime SFU** (audio-only, 32 cap, no user time limit,
active-speaker pull). 1:1 + dialpad stay P2P (untouched). The LiveKit code in
`worker/src/routes/conference.ts` + `app/lib/features/conference/` is kept
**dormant, not deleted** (paid/video may return).

> Status: SCAFFOLDED, not yet built. The flag `groupAudioSfuEnabled` exists
> (default OFF, KV `platform_config`) and the client mirror
> `RemoteConfig.groupAudioSfuEnabled` exists. While OFF, group calls keep using
> LiveKit. This doc is the next session's task — it MUST run through GitHub
> Actions CI + a real two-device test before the flag is flipped on.

---

## 0. Why a new path (not a LiveKit tweak)

Cloudflare Realtime SFU is a **different model** from LiveKit: there are **no
rooms and no participant discovery**. There are only **Sessions** (one per
client PeerConnection) and **Tracks** (published "local" tracks and subscribed
"remote" tracks). The app is responsible for:

1. the **roster** — which sessions/track-names belong to a group call, and
2. **signalling** — telling each client which remote tracks to pull.

We build that roster + signalling in a **Durable Object** (`GroupCallRoom`),
one per groupId. This replaces LiveKit rooms + JWT.

Reference: https://developers.cloudflare.com/realtime/sfu/ (get-started +
example-architecture). Free tier: **1,000 GB/month** Cloudflare→client egress
(client→Cloudflare is always free). Audio-only @ ~40 kbps with active-speaker
pull keeps us far under this.

---

## 1. Secrets / config (Worker)

Add to `worker/wrangler.toml` secrets (NOT committed; set via `wrangler secret put`):

- `CF_RT_SFU_APP_ID`     — Realtime SFU App ID
- `CF_RT_SFU_APP_TOKEN`  — Realtime SFU App bearer token

SFU API base: `https://rtc.live.cloudflare.com/v1/apps/${CF_RT_SFU_APP_ID}`
Auth header on every call: `Authorization: Bearer ${CF_RT_SFU_APP_TOKEN}`.

NAT traversal: reuse `mintIceServers(env, ttl)` from `routes/media.ts`
(Cloudflare TURN/STUN — `TURN_KEY_ID` / `TURN_KEY_API_TOKEN`, already wired).

---

## 2. SFU REST API shape (server-proxied — token never reaches the client)

All four are proxied through our Worker so `CF_RT_SFU_APP_TOKEN` stays server-side.

| Step | Method + path | Body (in) | Returns |
|---|---|---|---|
| New session | `POST /sessions/new` | — | `{ sessionId }` |
| Publish local | `POST /sessions/{id}/tracks/new` | `{ sessionDescription:{type:"offer",sdp}, tracks:[{location:"local", mid, trackName}] }` | `{ sessionDescription:{type:"answer",sdp}, tracks }` |
| Subscribe remote | `POST /sessions/{id}/tracks/new` | `{ tracks:[{location:"remote", sessionId:<publisher>, trackName}] }` | `{ sessionDescription:{type:"offer",sdp}, requiresImmediateRenegotiation:true, tracks }` |
| Renegotiate | `PUT /sessions/{id}/renegotiate` | `{ sessionDescription:{type:"answer",sdp} }` | `{ }` |
| Close tracks | `PUT /sessions/{id}/tracks/close` | `{ tracks:[{mid}], sessionDescription? }` | `{ }` |

Flow: a publisher does ONE `tracks/new(local)` (its mic). A subscriber pulls
each speaker it wants via `tracks/new(remote, publisherSessionId, trackName)`,
applies the returned offer as remote description, and PUTs `renegotiate` with
its answer. Pulling/closing remote tracks is how active-speaker switching works.

---

## 3. Worker — new module `worker/src/routes/groupcall.ts`

Endpoints (all `requireUser`, all gated by `conferenceEnabled &&
groupAudioSfuEnabled`; group membership checked via D1 `conversation_members`
exactly like `conference.ts`):

- `POST /api/groupcall/:groupId/join`
  - Auth + membership + **size cap 32** (reject 33rd: 403). Drop the LiveKit
    `conf_min` daily allowance entirely (free = no time limit).
  - `POST /sessions/new` → `sessionId`.
  - `mintIceServers()` → iceServers.
  - Register `{uid, sessionId}` into the `GroupCallRoom` DO for this groupId;
    DO returns the current roster (other members' `{uid, sessionId, audioTrackName}`).
  - Telemetry: `trackUser(... "groupcall_join", { provider:"cloudflare_sfu",
    group_id, members, ...confGeo })`.
  - Return `{ sessionId, iceServers, wsUrl: "/api/groupcall/:groupId/ws", roster }`.
- `POST /api/groupcall/:groupId/publish` — proxy `tracks/new(local)`; on success
  record the member's `audioTrackName` in the DO and broadcast a roster update.
- `POST /api/groupcall/:groupId/pull` — proxy `tracks/new(remote, ...)`.
- `PUT  /api/groupcall/:groupId/renegotiate` — proxy renegotiate.
- `POST /api/groupcall/:groupId/leave` — proxy `tracks/close` + DO removes the
  member; broadcast roster update; if empty, DO schedules idle cleanup.
- `GET  /api/groupcall/:groupId/ws` — WebSocket upgrade into the DO (roster +
  active-speaker fan-out).
- `GET  /api/groupcall/:groupId/status` — `{ live, count }` for the in-chat PiP
  banner (mirror `conferenceStatus`).

Provider stamp on EVERY telemetry event: `provider: "cloudflare_sfu"` (so the
PostHog conference dashboard 779066 can separate CF-SFU from dormant LiveKit).

---

## 4. Durable Object `GroupCallRoom` (one per groupId)

State: `Map<uid, { sessionId, audioTrackName?, ws?, lastLevel, lastSeen }>`.

Responsibilities:
- **Roster**: join/leave/publish update the map; broadcast the full roster to all
  connected member WebSockets on every change.
- **Active-speaker selection (the key to 32-person audio + tiny bandwidth)**:
  each client reports its mic audio level (0–1, ~4×/sec) over the DO WS
  (`{t:"level", v:0.42}`). The DO keeps a smoothed level per member, computes the
  **top 3–6 loudest** (configurable `ACTIVE_SPEAKERS = 6`), and broadcasts
  `{t:"speakers", uids:[...]}` whenever the set changes (debounced ~300 ms with
  hysteresis so it doesn't flap). Clients pull ONLY those speakers' tracks and
  close the rest. A 32-person call therefore forwards ≤6 audio streams to each
  client, not 31.
- **Ops backstops** (not user-facing): empty-room idle timeout (e.g. close DO
  after 60 s with 0 members), per-member zombie cleanup (no `level`/heartbeat for
  45 s ⇒ evict + broadcast), and a sane **max call duration** (~12–24 h) to kill
  stuck rooms. The global kill switch is `conferenceEnabled` (master) +
  `groupAudioSfuEnabled` (this path).

Wire the DO in `worker/wrangler.toml`:
```toml
[[durable_objects.bindings]]
name = "GROUP_CALL_ROOM"
class_name = "GroupCallRoom"
# + a migration tag entry for the new class
```
Export the class from the Worker entry (alongside the existing `INBOX` DO).

---

## 5. Flutter client — `app/lib/features/conference/sfu_group_call.dart`

Gate the group-call entry behind `RemoteConfig.groupAudioSfuEnabled`; when false
fall back to the existing LiveKit `mesh_call_screen.dart`/conference screen.

Per-client sequence (uses `flutter_webrtc`, same package as `call_screen.dart`):
1. `POST join` → `{sessionId, iceServers, wsUrl, roster}`.
2. Create one `RTCPeerConnection` with the returned `iceServers`.
3. `getUserMedia({audio: <constraints>, video:false})` — reuse the **same
   AEC/NS/AGC constraints + `_tuneOpusSdp` Opus FEC/DTX/40 kbps tuning** added to
   `call_screen.dart` (audio-only — no video track ever; bandwidth hog per the
   launch doc). Factor the constraints + `_tuneOpusSdp` helper into a shared
   `app/lib/core/audio_tuning.dart` so 1:1 and group share one definition.
4. Add the mic track, `createOffer` → tune → `setLocalDescription` → `POST
   publish` → `setRemoteDescription(answer)`.
5. Open the DO WebSocket; on `roster`/`speakers` events, `POST pull` the active
   speakers' tracks, apply offer, `PUT renegotiate` with the answer, and attach
   incoming audio to playback; `tracks/close` (via `leave`/local close) for
   speakers that drop out of the active set.
6. Report mic level over the WS (~4×/sec) from a local audio meter.
7. On hang-up: `POST leave` + close PC + close WS.

UI: audio-only roster grid (avatars + speaking ring driven by the `speakers`
event), mute, leave, speaker/earpiece toggle. No video controls.

---

## 6. Telemetry (PostHog) — keep dashboard 779066

- Reuse the existing conference event names where sensible but stamp
  `provider:"cloudflare_sfu"`; add group-audio specifics: `groupcall_join`,
  `groupcall_publish`, `groupcall_speaker_change`, `groupcall_leave`,
  `groupcall_error` (+ `confGeo` country/city/region/continent/colo).
- Every event MUST carry the user email (and phone if available) per CLAUDE.md
  telemetry rule, via `trackUser(env, uid, email, ...)`.
- Add a **bandwidth/egress alert** tile vs the 1,000 GB/mo free tier.

---

## 7. Regression / acceptance (run in CI + on 2 real devices before flag-on)

1. 1:1 audio call connects, clear two-way audio, AEC/NS/AGC audibly on; verify
   `a=fmtp` opus line shows `useinbandfec=1;usedtx=1;maxaveragebitrate=40000`.
2. 1:1 **video** call still works (P2P, unchanged).
3. Dialpad call + AvaTOK-number + receptionist pickup unaffected.
4. Group audio: 3-way, then scale toward cap; only top ~6 speakers' audio is
   pulled (verify pulled-track count stays ≤6 on a 10+ party call).
5. Cross-region (e.g. EU↔NA) group audio stays connected via CF TURN.
6. 33rd joiner rejected (403, friendly "call is full (32)").
7. Idle/zombie cleanup: kill a client hard → it's evicted within ~45 s; empty
   room tears down.
8. Flag flip: `groupAudioSfuEnabled=false` cleanly falls back to LiveKit.
9. Basic free Ava chat still works; no paywalls/upgrade/top-up UI anywhere.

---

## 8. Commit plan (one issue per commit, local only, no push)

- `[FREE-SFU-1] config: groupAudioSfuEnabled flag (dormant)` — DONE (this change).
- `[FREE-SFU-2] worker: groupcall route + GroupCallRoom DO`
- `[FREE-SFU-3] worker: wire DO binding + migration in wrangler.toml`
- `[FREE-SFU-4] client: sfu_group_call.dart + shared audio_tuning.dart`
- `[FREE-SFU-5] client: gate group entry on groupAudioSfuEnabled, LiveKit fallback`
- `[FREE-SFU-6] telemetry: cloudflare_sfu provider + dashboard 779066 tiles`
