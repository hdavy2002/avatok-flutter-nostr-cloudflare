# Handover — [CALL-SFU-1] the remaining client seam

Everything below the seam is built, pushed and type-checked. What is left is
wiring `CallSession` to use it. This note exists so the next session does not
re-derive the design decisions, two of which are not obvious.

## Done and on main

| Piece | File | State |
|---|---|---|
| Worker routes (join/publish/peer/pull/renegotiate/close) | `worker/src/routes/call_sfu.ts` | done, `tsc` clean |
| Route registration | `worker/src/index.ts` | done |
| Seat registry (`/sfu-seat`, `/sfu-peer`, `/sfu-seat-clear`) | `worker/src/do/call_room.ts` | done |
| Flags `callSfuV1` (false) / `callSfuAudioOnly` (false) | `worker/src/routes/config.ts` | done, NOT yet deployed |
| Dart API client | `app/lib/core/calls/call_sfu_api.dart` | done |
| Dart transport | `app/lib/core/calls/call_sfu_transport.dart` | done |
| **Seam in `call_session.dart`** | — | **NOT STARTED** (deliberately reverted, see below) |

`call_session.dart` is byte-for-byte untouched. A partial seam was written and
backed out rather than left half-wired: it referenced `_wirePc`, `_sfu`,
`_sfuActive`, `_sfuAborted` and `RemoteConfig.callSfuV1`, none of which exist yet.
With no local Flutter toolchain, a non-compiling `call_session.dart` costs a
40–80 minute CI round trip to discover and breaks every call in the meantime.

## Decision 1 — do NOT let the transport create the peer connection

`CallSfuTransport.connect` currently calls `createPeerConnection` itself and hands
the result back via `onPeerConnection`. **Change this.** The right shape is for
`CallSession` to build the PC through `_newPC`, because `_newPC` already installs
the `onTrack` and `onConnectionState` handlers that everything downstream depends
on — the renderer, `_telemetry.connected()`, `_startMediaWatchdog()`,
`_startPlayoutHealthSampler()`, the connect watchdogs, the ringback stop, the
prewarm abort, the `gOutgoingCall*` globals. Duplicating ~150 lines of that inside
the transport creates a second copy that will silently drift.

Add a parameter instead:

```dart
Future<RTCPeerConnection> _newPC({
  bool forceRelay = false,
  List<Map<String, dynamic>>? sfuIce,   // non-null => SFU mode
}) async
```

When `sfuIce != null`:
- use it as `iceServers` (Cloudflare's, minted by `/join`) instead of `_ice`;
- **never** set `iceTransportPolicy: 'relay'` — the SFU *is* the relay, and a
  relay-only policy against Cloudflare's own ICE list is the same
  can-never-gather trap that made relay migration fail 12/12 on P2P;
- skip the `onIceCandidate` peer send — there is no peer to trickle to, only a
  server, and the SFU takes candidates in the SDP.

Everything else in `_newPC` (generation stamping, `_addStreamTracks`, video codec
preference, `onTrack`, `onConnectionState`) is transport-independent and correct
as-is. Then `CallSfuTransport.connect` should take a `Future<RTCPeerConnection>
Function()` instead of owning `createPeerConnection`.

## Decision 2 — both phones MUST agree on the transport, and it must be announced

The dangerous failure is a **split transport**: one side on the SFU, one on P2P.
Both report "connected" and neither can hear anything. This is worse than either
transport failing outright, because nothing looks broken.

The P2P flow already elects a decider: the second phone to arrive receives
`welcome` with a non-empty `peers` list and is the one that offers
(`call_session.dart:4525`). Reuse that election:

- Decider receives `welcome` with peers → `_send({'type':'sfu-start','to':_remoteId})`,
  then runs its own connect.
- Peer receives `sfu-start` → runs its own connect. It does **not** wait for an offer.
- If **either** side's connect fails → `_send({'type':'sfu-abort','to':_remoteId})`,
  set a sticky `_sfuAborted`, and fall through to the existing `_newPC()` +
  offer path. The receiving side tears down its own attempt and does the same.
- `sfu-abort` must be sticky for the life of the call. A retry after an abort
  re-opens the split-brain window.

The CallRoom DO relays arbitrary `to`-scoped frames, so no server change is
needed for these two message types.

## Decision 3 — the health sampler baseline reset is not optional

`call_session.dart:1267-1273` points the sampler at a different peer connection
without resetting `_phBytes` / `_phPackets` / the other `_ph*` deltas (only
`_startPlayoutHealthSampler` at `:1240-1249` resets them). The new PC's small
cumulative counter minus the old PC's large one is negative, which
`:1537` classifies as `noRtp`.

This is the bug that made every P2P recovery fail. **The SFU inherits it**: an SFU
reconnect also swaps peer connections, and the same sampler decides whether the
result is alive. Reset the baselines at the PC-switch site. ~5 lines. The owner
deferred the rest of the proof-logic work (`[CALL-PROOF-1]`) but this piece is a
prerequisite, not a nice-to-have.

## Remaining work, in order

1. `_newPC({sfuIce})` parameter + `CallSfuTransport.connect` taking a PC factory.
2. `_startSfuMedia({required bool announce})` on `CallSession`; fields `_sfu`,
   `_sfuActive`, `_sfuAborted`.
3. `welcome` / `sfu-start` / `sfu-abort` handling in `_onSignal` (switch at `:4500`).
4. `RemoteConfig.callSfuV1` + `callSfuAudioOnly` getters in `remote_config.dart`
   (server side already declares both — client getters are missing).
5. Teardown: `_sfu?.dispose()` in `_teardownImpl` (`:6461-6649`), before the PC
   close, so the seat is cleared while the session id is still known.
6. Mid-call camera-on: `toggleCamera` (`:4948`) must call
   `CallSfuTransport.publishVideo` instead of `_restartWithVideo` when
   `_sfuActive`. **The SFU accepts no client-initiated re-offer**, so
   `_restartWithVideo`'s `createOffer` + `_send({'type':'offer'…})` at `:5031-5033`
   is a no-op at best on this transport.
7. Peer camera-on: pull their video. Needs a trigger — simplest is a
   `{'type':'sfu-video'}` frame from the publisher, mirroring `sfu-start`.
8. Recovery on network change: replace the ICE-restart/relay-migration path with
   a rejoin (`connect` again, new session), mirroring the conference
   controller's `_attemptReconnect` make-before-break at
   `cloudflare_conference_controller.dart:1144-1320`. That is the whole point of
   the migration — do not port the P2P recovery ladder.
9. `End-to-end encrypted` label at `call_screen.dart:785` → transport-driven.
10. Verify: `tsc`, design guard, `vitest` on the worker, then a **staging**
    two-device call including a WiFi→mobile switch mid-call.

## Things that must NOT change

- `CallRoom`'s 2-peer cap.
- Ringing, accept, decline, busy, presence, the receptionist handoff, billing —
  all still on `CallRoom`, all transport-independent.
- The five `...Coins` config keys and every lowercase `snake_case` wire field.
- `callSfuV1` ships **false**. It is the rollback.

## Known telemetry consequence

`call_media_health`'s `media_path` / `local_candidate_type` /
`remote_candidate_type` stop meaning what the dashboards assume: on the SFU the
remote candidate is always the Cloudflare edge, so every call reads as one hop to
a server. `_telemetry.setMediaPath('sfu')` distinguishes it, but any saved insight
that splits `direct` vs `relay` needs revisiting after rollout.
