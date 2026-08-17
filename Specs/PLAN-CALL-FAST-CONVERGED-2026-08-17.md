# CONVERGED PLAN — fast audio answering, correct video switching, 1M calls/min

**Date:** 2026-08-17 · **Status:** agreed design after three-way review
**Primary goal (owner):** *audio* calls answer and speak fast, like WhatsApp.
Video switching must stop freezing. Video is a correctness problem; audio is a
latency problem. **Both are in scope; audio leads.**

---

## PART 1 — Review response: what I concede, what I keep

| # | Reviewer finding | My call |
|---|---|---|
| 1 | `server-events` is not a track-ready feed | **CONCEDED — I was wrong.** Verified in Cloudflare's DataChannels docs: channels are *publisher → subscriber*, application data only, "Subscribers cannot send data back". No server-generated track announcements exist. Track discovery stays on our CallRoom WebSocket. |
| 2 | Caller media is not known before ringing | **CONCEDED in part.** Session/track exist only after join+publish, so they cannot be in the ring payload. **Kept:** TURN/ICE credentials are minted server-side independently of any session, so the *ring payload can carry ICE* with no added ring latency. The caller's track name arrives via a WS push instead (finding 4). **Ringing is never delayed for media work.** |
| 3 | Pre-roll must not open the microphone | **CONCEDED, fully.** My earlier pre-roll captured the mic during the ring. Wrong on privacy and on Android policy. New rule: **no mic, no camera before Accept — ever.** |
| 4 | One-RTT accept path unproven | **CONCEDED.** Cloudflare's pull returns an SFU offer answered via `renegotiate`; that is ≥2 RTT. **So instead of collapsing it, we move it off the accept path entirely** (Part 2). No RTT claim enters an SLO until measured in staging. |
| 5 | `tracks/update` for first video enable needs validation | **CONCEDED.** Prototype the four cases before committing. |
| 6 | Navigator loop doesn't explain 5.6 s | **CONCEDED.** The 250 ms poll contributes ≤250 ms of rounding; the bulk is Flutter cold start + native→Dart handoff. My "~100 ms" was unevidenced. Instrument the five milestones first. |
| 7 | `readConfig` already memoised (10 s/isolate) | **CONCEDED.** Only `emailFor` (KV read per request) is a real target. |
| 8 | Don't gate "connected" on `audioLevel` | **CONCEDED — important.** A silent caller would never connect. Gate on **inbound packets/bytes increasing + audio route ready**. Speech energy is a separate metric. |

**One point I press back on:** the reviewer suggests polling is only "bounded
jitter". Per call it is; at fleet scale it is not. 250 ms × up to 32 polls ×
2 legs is up to 64 requests per call — at 1M calls/min that is tens of millions
of avoidable requests/min hitting a Durable Object. It stays a P1 for cost and
DO throughput, not for per-call latency.

**Agreed with the reviewer's correction on the freeze:** the hard-coded mid is
*a* trigger, not *the* fix. Mid + negotiation queue + SFU re-entrancy guard +
seat generation **ship together or not at all.**

---

## PART 2 — The audio design (the owner's actual goal)

**Constraint accepted:** the callee's microphone opens only after Accept.
So the question becomes: *what can legitimately be finished before Accept?*

Answer: **everything except our own microphone** — including **pulling the
caller's audio**, as long as playout stays disabled.

```
caller taps dial
  └─ place call  ─────────────────► ring is sent IMMEDIATELY (never delayed)
  └─ in parallel: join + publish (caller's mic is already open — they dialled)
                     └─ CallRoom WS ──► "peer_track_ready {session, track, rev}"

callee, during the ring (NO mic, NO camera):
  • session + PeerConnection + ICE (ICE creds arrive in the ring payload)
  • stable transceivers created once: audio sendrecv, video sendrecv (no track)
  • PULL the caller's audio  →  receiver track.enabled = false  (silent)

callee taps ACCEPT:
  • getUserMedia (~65 ms, measured)
  • enable remote receiver  →  CALLER IS AUDIBLE ~IMMEDIATELY
  • publish own audio       →  caller hears callee ~1 RTT later
```

**Why this is the right shape:** the expensive part (join + pull + ICE +
renegotiation) depends only on the *caller*, who has already consented and is
already publishing. None of it waits on the person who is being called. My
previous pre-roll failed precisely because it waited on a caller who had not
published yet — this ordering removes that dependency instead of racing it.

**Expected (to be proven, not promised):** Accept → *hearing the caller* is
dominated by `getUserMedia` + enabling a receiver, not by any network round
trip. Accept → *caller hears you* is one publish. Both must be measured in
staging before any number goes into an SLO.

**Asymmetry is fine and matches WhatsApp's feel:** the answerer hears the
caller first; the caller hears the answerer a beat later.

---

## PART 3 — The video design (correctness)

One session, one PeerConnection, one negotiation owner. Video is *not* a new
connection or a new session — it is a track swap on a transceiver that already
exists:

1. Video transceiver created at PC construction, empty.
2. Camera on = `replaceTrack` on that sender + `PUT tracks/update` (validate
   per finding 5) — **audio is never renegotiated, so speech never breaks.**
3. Real mids read from the transceiver after `setLocalDescription`. The `'1'`
   literal is deleted.
4. All of publish / pull / video-on / recovery / repull / reconnect go through
   **one serialized queue** with operation ids + generations.
5. UI shows "Adding video…" until the **first decoded frame**; no optimistic
   success, camera acquisition has a timeout and a complete state rollback.

---

## PART 4 — Delivery order (converged with the reviewer, one change)

**Stage 0 — Truth + free latency (hours, near-zero risk).**
- Connected = inbound audio bytes/packets increasing + route ready.
- `call_sfu_video_upgraded` only after a decoded frame.
- Move successful telemetry to `ctx.waitUntil` (removes the blocking queue send
  I added yesterday from every join/publish/pull); sample successes, keep
  errors at 100%.
- Cache `emailFor` in-isolate.
*Why first:* it makes every later measurement honest **and** it is the only
latency work that costs nothing and risks nothing. The reviewer put telemetry
at #5; I move it to Stage 0 because it speeds up **audio calls today** and the
change is three lines per site.

**Stage 1 — Video correctness, shipped as ONE bundle.**
Real mids · negotiation queue · SFU re-entrancy guard · camera timeout +
rollback · `tracks/update` (after the 4-case prototype) · seat generation with
stale-write rejection and track clearing on session change.

**Stage 2 — Kill the polling.** CallRoom pushes `peer_track_ready` over the
WebSocket both phones already hold; polling drops to a 1 s fallback.

**Stage 3 — The pre-Accept 5.6 s (biggest audio win before the tap).**
Instrument the five milestones (native intent → Dart handler → navigator ready
→ route pushed → screen painted), then fix what they show: native answer UI
and/or engine pre-warm at ring receipt. Move join-only pre-warm to the earliest
ring receipt.

**Stage 4 — The post-Accept path (biggest audio win after the tap).**
Caller pre-publish gated on `place_ok` → CallRoom `peer_track_ready` → callee
pre-pull with playout disabled → Accept enables playout and publishes.
Ship behind flags, one step at a time, each verified by its own event.

**Stage 5 — Scale.** Sampling, Cloudflare quota planning, multi-region load
tests, overload behaviour, SLO dashboards, progressive rollout.

---

## PART 5 — Acceptance criteria (measured, per stage)

| Stage | Must prove |
|---|---|
| 0 | Gap between `call_connected` and first audio ≈ 0 (today: 12–16 s of a false state). No blocking telemetry on the media path. |
| 1 | Video switch < 1.5 s p95, **audio uninterrupted across the switch**, zero `video_upgraded` without a decoded frame, no freeze under rapid toggling. |
| 2 | `/peer` requests per call drop from ≤64 to ≈0; track discovery latency ≤ 250 ms. |
| 3 | Ring→answer-screen p95 well under 1 s (from 5.6 s), measured per milestone. |
| 4 | **Accept → caller audible < 1 s p95 on wifi**; caller → callee audible < 1.5 s p95. No mic access before Accept (verified by the OS privacy indicator staying off while ringing). |
| 5 | Load test at target concurrency with defined overload behaviour. |

**Rule carried from today's failures:** nothing is "done" until its event is
observed in production. A PostHog "event not found" means the code never ran —
three features shipped this week that never executed once.

---

## PART 6 — Open experiments (staging, not commitments)

1. `tracks/update` on a never-published video transceiver — 4 cases.
2. Whether publish+pull can share one negotiation (would cut the caller's path
   too). **Experiment only** — no SLO depends on it.
3. Whether pre-pull with a disabled receiver holds across ICE restart and
   WiFi↔cellular handover.

`.avatok-target` is currently `staging` — all of the above lands there first.
