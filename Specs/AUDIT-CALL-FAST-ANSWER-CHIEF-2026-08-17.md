# CHIEF ENGINEER AUDIT — fast answer, smooth video switch, 1M calls/min

**Date:** 2026-08-17 · **Method:** every claim below re-verified against the
code or Cloudflare's live docs. Claims I could not verify are labelled UNKNOWN.

---

## PART 1 — Verdict on the second AI's audit

It is a **strong audit** and its central architectural call is right: *one
session, one peer connection, one serialized signalling owner per phone*.
I verified its findings line by line.

| # | Its claim | My verdict | Evidence |
|---|---|---|---|
| 1 | Video upgrade publishes hard-coded mid `"1"` | **CONFIRMED — likely the freeze** | `call_sfu_transport.dart` `publishVideo` sends `{'mid': '1', 'kind':'video'}` literally, after remote audio may already own mid 1 |
| 2 | Concurrent renegotiation, unawaited pull | **CONFIRMED** | same function ends with `unawaited(_pull('video'))`; no negotiation lock anywhere |
| 3 | SFU path bypasses `_videoRenegoInFlight` | **CONFIRMED** | `if (_sfuActive) { await _enableSfuVideo(); return; }` sits **above** the guard |
| 4 | UI claims success before it succeeds | **CONFIRMED** | `videoActive/cameraOn/speakerOn` set `true` before any async work; no camera timeout |
| 5 | Remote audio overwritten by remote video (`srcObject`) | **MOSTLY WRONG** | in flutter_webrtc remote **audio plays through the audio device, not the renderer**. The code's own comment says receiver-level disable is used *because* the renderer is repointed. **Residual real bug:** `_applyRemoteAudioEnabled`'s secondary path reads `remoteRenderer.srcObject` audio tracks — that half silently misses after a repoint. Not the freeze cause. |
| 6 | Seat keeps stale track names across session change | **CONFIRMED, and worse than stated** | `/sfu-seat` falls back to `previous?.audio_track / video_track / mids` **even when `sessionId` differs** → peer pulls an old track name against a new session |
| 7 | Polling will not scale | **CONFIRMED** | `_peerPoll = 250ms`, `_peerWait = 6s` (8s overlapped) → up to ~32 polls/leg |
| 8 | `PUT /sessions/{id}/tracks/update` exists | **CONFIRMED** | Cloudflare Connection API: *"Update Tracks: Changes tracks by reusing existing transceivers"* |
| 9 | Reject a second SFU session (my P3) | **AGREED — I withdraw it** | Cloudflare defines a session as the API representation of one peer connection. My §5.3 failure already proved two PCs on one session collide; two sessions is the mirror of the same mistake |

**Where I think it is incomplete:** it treats the 5.6s answer-screen delay as
"instrument it". I already know the likely cause (Part 2.1). And it misses the
three items in Part 2 — one of which I caused yesterday.

---

## PART 2 — What BOTH audits missed

### 2.1 The 5.6s answer screen is a navigator wait loop, not a mystery
`_routeToBrandedIncoming` contains:

```dart
for (var i = 0; i < 40; i++) {        // ~10s max
  final nav = navigatorKey.currentState;
  if (nav != null) { ...push the ring screen...; return; }
  await Future.delayed(const Duration(milliseconds: 250));
}
```

It **polls for the Flutter navigator every 250 ms**. The measured 5.61 s ≈ 22
iterations — i.e. the ring screen is waiting for the Flutter engine to finish
booting, then rounds up to the next 250 ms tick. So this is **Flutter cold
start on the ring path**, and the 250 ms granularity adds avoidable jitter.
No new instrumentation is needed to start fixing it; instrumentation only
confirms the split between engine-boot and tick-rounding.

**Fix:** render the incoming-call UI **natively** (Kotlin) so Accept is on
screen in ~100 ms, and/or warm a `FlutterEngine` at ring receipt. Also replace
the 250 ms poll with a completer the engine signals.

### 2.2 I put blocking telemetry on the SFU critical path yesterday
`[CALL-SFU-TELEM-AWAIT-1]` made **10 `await trackUser(...)` calls** in
`routes/call_sfu.ts` — including one immediately **before** the `join`,
`publish` and `pull` responses return. I did that because unawaited sends were
being dropped by workerd. It fixed the drop and **added a queue round trip to
the latency of every media operation**.

**Correct fix:** `ctx.waitUntil(trackUser(...))` — the send completes after the
response is sent, without blocking it, and without being cancelled. Plus
sampling (100% errors, ~10% successes) before scale.

Also on every SFU request: `emailFor(uid)` is a **KV read per request** (cached
in KV, not in-isolate). At 1M calls/min this is ~8M KV reads/min for telemetry
enrichment alone. Cache per isolate with a TTL.

### 2.3 Cloudflare has a server-events DataChannel — nobody proposed using it
The Connection API lists:
`POST /sessions/{sessionId}/datachannels/establish` — *"Pulls the
`server-events` channel to establish DataChannel transport."*

This is a **provider-native event lane**. Combined with the `CallRoom`
WebSocket we already hold open to both phones, there is **no reason to poll
`/peer` at all**.

### 2.4 The ring payload should carry what the callee needs (protocol fix)
Today the callee learns ICE servers only from `/join`, and the caller's track
name only from `/peer`. Both are known **before the ring is sent**.

**Put ICE servers + the caller's session/track name into the ring payload.**
The callee can then build its peer connection and know exactly what to pull
**without a single round trip** before Accept. This removes the dependency
that made my pre-roll attempt race (§5.3 of the earlier spec) — the callee no
longer waits to *discover* the caller's track, it is told.

---

## PART 3 — Target architecture (my recommendation)

**Invariant: one SFU session, one PeerConnection, one negotiation owner per
phone per call. Transceivers are created once and reused forever.**

1. **Create both transceivers up front** (audio `sendrecv`, video `sendrecv`)
   at PC construction. Video starts with no track / disabled.
2. **Never guess a mid.** Read the real mid from the transceiver after
   `setLocalDescription`, and send that. Delete the `'1'` literal.
3. **Video on/off = `replaceTrack` on the existing video transceiver** plus
   `PUT tracks/update`. Audio is never renegotiated, so the switch cannot
   disturb the conversation.
4. **One negotiation queue** (a serialized async mutex with an operation id and
   a generation) owning: publish, pull, video upgrade, ICE recovery, repull,
   reconnect. Everything else enqueues.
5. **Event-driven track discovery.** `CallRoom` pushes `peer_track_ready
   {session_id, track, revision}` over the existing WebSocket the instant a
   seat is written. Polling remains only as a degraded fallback (and at 1 s,
   not 250 ms).
6. **Seat writes are generation-aware.** Changing `session_id` **clears**
   track names/mids; updates carry a monotonic revision and are rejected if
   stale (compare-and-swap), killing the last-write-wins hazard.
7. **"Connected" means audible.** Gate the connected state on
   `getStats` inbound audio (`bytesReceived`/`audioLevel` increasing), not on
   `onTrack`. Same for video: "Adding video…" until the first decoded frame.
   This alone removes the false 12–16 s "connected" the owner sees.
8. **Collapse the accept-path round trips.** With ICE + caller track in the
   ring payload, and one Worker endpoint that does `sessions/new` +
   `tracks/new` server-side, the callee's accept path becomes **one round
   trip** (publish+pull in a single negotiation) instead of four.

### The ordering that makes pre-roll actually work
My earlier pre-roll failed because the callee waited for a caller track that
did not exist yet. Correct order:

```
caller dials → caller publishes during its OWN boot (no peer dependency)
            → ring payload carries ICE + caller's track name
            → callee pre-builds PC, pre-publishes (silent), pre-pulls (muted)
            → ACCEPT = enable local track + enable remote track
```
Every step depends only on things that already exist. Nothing waits on a human.

---

## PART 4 — 1M calls/min (2M legs/min) — the numbers

Current per-leg cost on the accept path:

| operation | client→Worker RTs | upstream calls |
|---|---|---|
| join | 1 | `sessions/new` + ICE mint + DO seat write |
| publish | 1 | `tracks/new` + DO seat write |
| peer discovery | **up to 32** | DO read each |
| pull | 1 | DO read + `tracks/new` |
| renegotiate | 1 | `renegotiate` |

At 2M legs/min the polling alone is **20–60M requests/min of pure waste**.

**Scale actions, in order of impact:**
1. **Delete polling** (§3.5) → removes tens of millions of requests/min.
2. **`waitUntil` + sample telemetry** (§2.2) → removes ~10M blocking queue
   sends/min and cuts media-path latency now.
3. **In-isolate cache for `emailFor`/config** → removes ~8M KV reads/min.
4. **Collapse join+publish** (§3.8) → ~2M fewer requests/min and −1 RTT on
   every answer.
5. **Quota + load plan:** Cloudflare Realtime concurrency limits, DO
   per-object throughput (one DO per call is fine; the alarm cadence is the
   thing to watch), and a multi-region soak test. This is explicit capacity
   planning, not a client optimisation — the second AI is right about that.

---

## PART 5 — Delivery order (what I would actually do)

**Stage 1 — Correctness (fixes the freeze; no latency work).**
Real mids · negotiation queue · SFU honours the re-entrancy guard · camera
timeout with full state rollback · `tracks/update` for video · seat generation
+ clearing on session change.
*Success:* video switch < 1.5 s p95, audio never interrupted, no
`call_sfu_video_upgraded` without a decoded frame.

**Stage 2 — Truthful state.**
Connected = inbound audio observed. "Adding video…" until first frame.
*Success:* the gap between `call_connected` and first audio collapses to ~0;
today it is 12–16 s of a lie.

**Stage 3 — Latency, cheapest first.**
`waitUntil` telemetry · isolate caches · native/pre-warmed answer UI (the
5.6 s) · pre-warm moved to earliest ring receipt.

**Stage 4 — Protocol.**
ICE + caller track in the ring payload · WebSocket `peer_track_ready` ·
collapse join+publish · then re-enable caller pre-publish, then callee
pre-roll — **in that order**, each verified by its own event before the next.

**Stage 5 — Scale.** Sampling, load tests, SLO dashboards, progressive rollout.

---

## PART 6 — Honest notes on my own record here

- My pre-roll made calls **3× worse** (18.2 s vs 6.4 s) and I rolled it back.
  Root cause: it waited on the peer, and it shared one SFU session with the
  live session. Both are design errors, not bugs.
- My awaited-telemetry fix (§2.2) traded latency for reliability without
  saying so. `waitUntil` gives both.
- Three features shipped that **never executed** (wrong ring lane, wrong
  intent action). Rule now enforced: nothing is "shipped" until its event is
  observed in production; PostHog "event not found" means the code never ran.

**Current production flags:** `callSfuV1` ON · `callPrewarmOnRingV1` ON ·
`callerPrejoinOnRingV1` OFF · `callPrerollV1` OFF. Build 10569 carries all the
code; the OFF flags make it inert. Note `.avatok-target` is currently
`staging`.
