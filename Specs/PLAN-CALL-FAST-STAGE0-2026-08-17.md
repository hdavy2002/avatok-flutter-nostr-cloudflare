# STAGE 0 — corrected spec (truthful state + free latency)

**Date:** 2026-08-17 · **Status:** amendments accepted; ready to implement
**Scope:** audio-first. No pre-pull. No mic before Accept. Staging target.

---

## PART 1 — Amendments accepted

| # | Reviewer amendment | Response |
|---|---|---|
| 1 | `track.enabled=false` is not a playout boundary | **ACCEPTED, P0.** Creating a remote audio track can initialise the Android audio device, take focus and change audio mode — while ringing. **Pre-pull is withdrawn from the plan until a native fail-closed gate exists and passes the four proofs.** |
| 2 | Pre-pull creates speculative media on unanswered calls | **ACCEPTED.** Teardown matrix + a hard rule that no consumer (recording, translation, transcription, AvaBrain, waveform) may ever see pre-Accept audio. Gated behind the same fail-closed work. |
| 3 | Fresh ICE in the ring payload conflicts with instant ringing | **ACCEPTED — dropped.** Ring goes out immediately; the earliest ring handler runs join-only pre-warm and takes ICE from `/join`. No TURN credentials in FCM. |
| 4 | Stage 0 must not redefine the existing `_connected` block | **ACCEPTED, and it changes the design — see Part 2.** |
| 5 | The publisher cannot observe the peer's decoded frame | **ACCEPTED.** Four events + a peer ack over CallRoom. |
| 6 | `waitUntil` needs `ExecutionContext` threading | **CONFIRMED in code.** `dispatch(req, env, ctx)` already has `ctx` and index.ts already uses `ctx.waitUntil` elsewhere; the seven `callSfu*` handlers are called as `(req, env, room)`. So: 7 signatures + 7 call sites. Not three lines — ~30, low risk, established pattern. |
| 7 | Sampling breaks "event missing ⇒ code never ran" | **ACCEPTED.** Deterministic sampling by call id + unsampled feature-entry breadcrumbs. |
| 8 | Per-call DO sharding — fleet cost, not a global hotspot | **AGREED**, wording corrected. |

---

## PART 2 — The state ladder (the important correction)

The reviewer is right that `_connected = true` is load-bearing far beyond the
UI. Verified: today's single block does **all** of this at first remote track —
stop ringback, `_telemetry.connected`, haptics, clear outgoing-call globals,
`_connected = true`, start talk-time (`_connectedAtMs`), `peerAway = false`,
`_setPhase('connected')`, start media watchdog, start playout sampler, cancel
ring/connect/fail/relay timers, abort receptionist pre-warm.

**Therefore: do not delay that block. Do not redefine `_connected`.**
Instead, keep `_connected` meaning *"media path established"* (unchanged
semantics, unchanged timers) and **add a new, later milestone that owns the
user-visible truth.**

| milestone | fires when | owns |
|---|---|---|
| `transport_connected` | PC connection state connected | telemetry only (exists today) |
| `remote_track_attached` | `onTrack` | **everything `_connected` does today** — timers cancelled, watchdogs started, receptionist aborted, glare cleared. Unchanged. |
| `inbound_audio_ready` | `getStats`: inbound audio **packets/bytes increasing** (never `audioLevel` — a silent caller must still connect) | stop ringback · start talk-time clock · haptics |
| `audio_playout_ready` | audio route/session confirmed ready | — |
| **`connected` (user-visible)** | `inbound_audio_ready && audio_playout_ready` | the "Connected" label and call timer the user reads |

**Blast radius:** no existing timer, watchdog or teardown changes behaviour.
Only three side effects move (ringback stop, talk-time start, haptics), each
moved deliberately, each individually revertable.

**Why talk-time moves:** billing should start when the call is audible, not
when a track object exists. Today that is 12–16 s early — we are over-charging
by our own telemetry's admission.

---

## PART 3 — Telemetry correction (the free latency)

1. **Thread `ExecutionContext`** into the seven `callSfu*` handlers.
2. Replace the ten `await trackUser(...)` with `ctx.waitUntil(trackUser(...))`
   — the send still completes, but no longer sits on the response path of
   join/publish/pull. (This blocking send is mine, added 2026-08-16; it fixed
   dropped events and silently bought latency on every media call.)
3. **Deterministic sampling:** hash the `call_id`, sample successes at a fixed
   rate, **errors always 100 %**. A sampled call keeps its *entire* timeline —
   never sample per-event.
4. **Unsampled breadcrumbs:** one cheap counter per feature entry, always
   emitted, so "did this code path execute at all?" stays answerable once
   successes are sampled. This preserves the rule that caught three
   never-executing features this week.
5. Cache `emailFor` in-isolate with a TTL (KV read per request today).

---

## PART 4 — Video truth events (no optimistic success)

- `local_video_published` — our offer/answer completed.
- `remote_video_track_attached` — peer's track object arrived.
- `remote_video_first_frame` — **receiver** decoded a frame.
- `peer_video_rendered_ack {revision}` — receiver tells the publisher over
  CallRoom; only this may turn the publisher's UI from "Adding video…" to done.

`call_sfu_video_upgraded` as it exists today is a false positive and is retired.

---

## PART 5 — Explicitly NOT in Stage 0

- Pre-pull of caller audio (needs the native fail-closed gate + cost test).
- Any microphone or camera access before Accept — permanently forbidden.
- ICE credentials in the ring payload — dropped.
- The video correctness bundle (mids, negotiation queue, re-entrancy guard,
  camera timeout, seat generation) — that is **Stage 1**, and ships as one
  bundle, not piecemeal.

---

## PART 6 — Stage 0 acceptance (measured, staging first)

1. `connected` (user-visible) and first audible audio differ by **< 300 ms**
   p95. Today: 12–16 s.
2. A **silent** caller still reaches `connected` (proves we did not gate on
   speech energy).
3. No `await` on a telemetry send remains in any SFU media path; join/publish/
   pull server-side `elapsed_ms` drops measurably.
4. Sampling contract: a sampled call has a complete timeline; breadcrumbs
   present for every feature entry at 100 %.
5. Ringback stops exactly when audio becomes audible — no overlap, no gap.

---

## PART 7 — Stage 4 pre-pull: the bar it must clear later

Not authorized. To be reconsidered only with:
1. A **native fail-closed playout gate** established *before* negotiation.
2. Proof of: zero caller-audio leakage pre-Accept · ringtone audible
   throughout · **no switch to communication audio mode before Accept** ·
   atomic ownership handover at Accept.
3. A teardown matrix covering: decline, caller cancel, ring timeout, answered
   on another device, account switch, app death, superseded session.
4. A cost test for speculative media on unanswered calls.
5. Hard block on every pre-Accept audio consumer (recording, translation,
   transcription, AvaBrain, waveform).

If Flutter/WebRTC cannot provide (1), **pre-pull is abandoned** and the audio
win comes from Stages 0–3 alone (truthful state, video correctness, no
polling, fast answer UI, join-only pre-warm).
