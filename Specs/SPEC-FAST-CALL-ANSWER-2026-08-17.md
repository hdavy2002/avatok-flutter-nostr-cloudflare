# SPEC — Fast call answering (WhatsApp parity) for AvaTOK

**Status:** open problem, seeking second opinion
**Date:** 2026-08-17
**Author:** engineering agent (Claude), from production telemetry
**Audience:** a reviewing engineer/AI who has NOT seen this codebase

Everything numeric below is measured from production PostHog events on
2026-08-17 with both testers on build 10569. No estimates, no memory. Where
something is unknown it is labelled UNKNOWN.

---

## 1. The product problem, in the owner's words

> "When a call comes in, I pick up, then the screen has no UI of AvaTOK, then
> after a while a UI pops up that shows it's connecting, then after a few
> seconds it connects but no voice is flowing, then the voice starts. In
> WhatsApp, as soon as I pick up, I can hear the other guy."

## 2. Goal

From the callee tapping **Accept** to hearing the caller's voice: **≤ 1s**,
with no blank screen at any point. Secondary: reduce the delay *before* Accept
is even possible.

Non-goals: video call optimisation, group calls, changing the media provider.

---

## 3. System architecture (facts a reviewer needs)

- **Client:** Flutter (Dart) app, Android focus. Native Kotlin plugins for call
  audio, CallKit-style incoming UI, call recording.
- **Signalling:** a Cloudflare **Durable Object** per call (`CallRoom`).
  Clients connect to it over WebSocket. It owns call state (`caller_uid`,
  `callee_uid`), ring/accept/decline, and an "SFU seat" registry.
- **Media:** **Cloudflare Realtime (SFU)** for 1:1 calls, behind flag
  `callSfuV1` (ON in prod). The client talks to the SFU **through our Worker**
  (`/api/callsfu/:room/{join,publish,peer,pull,renegotiate,close}`), which
  proxies to `rtc.live.cloudflare.com`. P2P and a RealtimeKit path exist as
  fallbacks; a transport "election" between them happens on peer-join.
- **SFU contract asymmetry (Cloudflare's, not ours):** on **publish** the
  client offers and the SFU answers; on **pull** the SFU offers and the client
  answers via a separate `/renegotiate` call. There is no client-initiated
  re-offer.
- **Seat lease:** `CallRoom.SFU_LEASE_MS = 45_000`. A seat with no heartbeat
  expires after 45s. Heartbeats only start after a full `connect()`.
- **Seat authorisation:** `POST /sfu-seat` returns **403 `not_a_participant`**
  unless the uid equals `caller_uid` or `callee_uid` **already recorded in the
  DO**. This matters: a client that claims a seat *before* call placement has
  completed gets a 403.
- **Ring delivery:** two lanes in parallel — a live WebSocket ring (InboxDO)
  and FCM push. Android shows a CallKit-style notification/full-screen intent;
  tapping it launches `MainActivity` with a custom action
  (`avatok.incoming_call_tap`), which routes to a Flutter screen
  (`IncomingBusinessCallScreen`, "the branded ring screen") carrying the Accept
  button. **Accept is a Dart-side action**, not a native CallKit accept.

### Hard platform constraints
- **Android 12+ background microphone acquisition can hang forever** (observed;
  the code carries an 8s `getUserMedia` timeout because of it). Mic capture is
  only safe once a foreground surface exists.
- No local Flutter/Android toolchain on the owner's machine (disk). **CI is the
  only compile check**; a build round trip is ~30–45 minutes. This makes
  speculative refactors expensive and is why verification discipline matters.

---

## 4. Measured baseline — one real call (`avatok-1204d417`)

Caller = Tiger (wifi), callee = owner (wifi), both build 10569.

| t (UTC) | Δ | Event |
|---|---|---|
| 15:06:54.814 | — | caller taps call (`call_started`) |
| 15:06:56.881 | +2.07s | `call_created` (caller boot: renderers, mic, audio session) |
| 15:06:57.190 | +0.31s | ring sent (`call_ws_ring_sent` + `call_push_sent`) |
| 15:06:58.216 | **+1.03s** | callee `call_incoming_received` — **ring transit is fast** |
| 15:06:58.241 | +0.03s | callee `call_incoming_shown` (OS notification surface) |
| **15:07:03.847** | **+5.61s** | callee `call_branded_fsi_routed` — **the AvaTOK answer screen finally appears** |
| 15:07:06.423 | +2.58s | callee accepts (`call_started`) |
| 15:07:07.925 | +1.50s | callee `call_sfu_published` |
| 15:07:09.169 | +1.24s | callee `call_sfu_pulled` |
| 15:07:12.671 | +3.50s | callee `call_connected` |
| ~15:07:24.6 | +11.9s | callee first audio (`call_first_audio_ms.ms_from_start` = 18182ms) |

### Callee accept→audio stage breakdown (typical, pre-experiment, ~6.4s total)
Measured across 6 calls on 2026-08-16, wifi:

| stage | cost | note |
|---|---|---|
| renderers init | ~167ms | |
| **mic (`getUserMedia`)** | **~65ms** | **not a bottleneck — an early assumption of mine was wrong** |
| audio session (`MODE_IN_COMMUNICATION` + focus) | ~426ms | |
| room WebSocket open + welcome | ~500ms | |
| **SFU join** | **~1.8s** | our Worker → Cloudflare `sessions/new` + ICE mint + DO seat write |
| **SFU publish** | **~1.0s** | offer → `tracks/new` → answer |
| peer seat wait | ~170ms | |
| **pull → first audio** | **~1.5–2.2s** | SFU offers, client answers, `/renegotiate` |

**So ~4.5s of the ~6.4s is three sequential server round-trip phases: join,
publish, pull.** All three happen *after* Accept.

---

## 5. What I already tried (and the exact failure of each)

This section exists so the reviewer does not re-propose a dead end.

### 5.1 Callee pre-warm — claim the SFU seat during the ring (`callPrewarmOnRingV1`)
Fetch ICE + `POST /callsfu/join` when the ring appears; adopt at Accept, so the
1.8s join is off the accept path.
- **Attempt 1 failed silently:** hooked into one ring lane (`_showIncoming`),
  but production rings arrive via a different lane (native tap →
  `_routeToBrandedIncoming`). **Zero `call_prewarm_*` events existed in the
  project's entire history** — the feature had never once executed.
- **Attempt 2 (current, ON in prod):** hook moved to the branded ring screen's
  `initState`. It now fires — but see §6.2: it fires **5.4s late**.
- **Verdict:** sound idea, safe (join-only, no media, no mic). Currently gives
  far less than its theoretical 1.8s because of when it starts.

### 5.2 Caller pre-join + publish during ring (`callerPrejoinOnRingV1`) — ROLLED BACK
Caller joins the SFU and publishes audio while the callee's phone rings, so the
callee's pull finds a live track instantly.
- **Failure A (fixed):** the pre-join's `RTCPeerConnection` was built by the
  session's own `_newPC()`, which assigns `_pc` and installs `onTrack` as a side
  effect. So a track arriving on the pre-join connection ran the whole connect
  ladder: **the caller's UI said "connected" and stopped the ringback 7.3s
  before the callee accepted**, then sat silent. Fixed by an `isolated` mode
  that suppresses `_pc` assignment + `onTrack` + playout baselines, with an
  explicit promotion step at adoption that replays cached tracks.
- **Failure B (open):** the pre-join fires from the WebSocket `welcome` handler,
  which can precede **call placement** completing. On one production call the
  seat write returned **403 `not_a_participant`** because the DO did not yet
  know the caller. That call ultimately failed for an unrelated network reason,
  so the 403 was a symptom — but the ordering flaw is real.
- **Status:** OFF in prod pending the ordering fix.

### 5.3 Callee full pre-roll — mic + publish + pull during ring (`callPrerollV1`) — ROLLED BACK, MADE IT 3× WORSE
Acquire mic (muted), build an isolated PC, publish silently, pull the caller's
audio muted; at Accept just enable two tracks.
- **Measured result: accept→audio went from 6.4s to 18.2s.**
- **Why:** the pre-roll's `connectPull` **waits for the caller's track to
  exist**. With the caller's pre-join disabled/failing, that track only appears
  after the callee accepts — so the pre-roll took **12.9s** and completed
  **4.3s after the user had already accepted**. It therefore never got adopted
  (`hasFullPreroll` false, `call_preroll_adopted` never fired) — but it was
  still running, and both it and the real session were publishing/pulling **on
  the same SFU session id** (the one the pre-warm claimed). Two peer
  connections on one session id = renegotiation conflict = ~12s of broken
  audio.
- **Lessons:** (a) any pre-roll that must *wait for the peer* loses the race
  against a human pressing Accept in ~2.5s; (b) an SFU session id must have
  exactly one peer connection, ever.

### 5.4 Native "Connecting…" overlay (blank-screen fix)
A native dark screen with "Connecting…" until Flutter's first frame.
- **Failed silently:** triggered on the CallKit `ACTION_CALL_ACCEPT` intent,
  which this app does not use (it uses its own `avatok.incoming_call_tap`).
  `call_accept_first_frame_ms` **never fired once**. Trigger fixed; it now
  fires (measured `ms=0, cold=false` on a warm launch).

### 5.5 Meta-lesson (cost me three cycles)
**A hook placed on a code path production does not take is indistinguishable
from a feature that does not exist.** PostHog reporting "event not found in
taxonomy" is a first-class diagnostic: it means the code never ran. Nothing may
be called "shipped" until its event is observed in production.

---

## 6. The problem, restated with the evidence

### 6.1 After Accept: three sequential server phases (~4.5s)
`join → publish → pull`, each a Worker→Cloudflare round trip, all after Accept.
Pre-doing them is the only way to remove them, and §5.3 shows pre-doing the
*pull* is racy because it depends on the peer.

### 6.2 Before Accept: 5.6s to draw the answer screen (previously unmeasured)
`call_incoming_shown` → `call_branded_fsi_routed` = **5.61s**. The OS
notification is up at ~1s, but AvaTOK's own Accept UI takes 5.6s more. This is
the delay the owner describes as "it took forever", and **no work so far has
addressed it**. It also delays the pre-warm (§5.1), which is hooked to that
screen, leaving it only ~2.6s of head start before Accept.
**Root cause UNKNOWN** — candidates: Flutter engine cold start, the branded
route's navigator-wait retry loop (it polls up to ~10s for a navigator), route
gating, or FCM→isolate handoff. Needs instrumentation.

### 6.3 Structural asymmetry
WhatsApp's model is that **both** endpoints have media ready before Accept, so
Accept is a state flip. AvaTOK builds the callee's media *after* Accept and the
caller's media *after* the callee accepts. Any solution must break that
dependency without letting either side believe the call is live early (§5.2A)
or letting two connections share a session (§5.3).

---

## 7. My proposed solution (for critique)

Ordered by (value ÷ risk). Each is independently flagged and reversible.

### P0 — Instrument and fix the 5.6s answer-screen delay
Add timestamps for: FCM/WS ring receipt → isolate handoff → navigator ready →
branded route pushed → first frame. Then fix what it shows. Options if it is
engine cold start: pre-warm a `FlutterEngine` at ring receipt
(`FlutterEngineCache`), or render the Accept UI **natively** (Kotlin) so it
appears in ~100ms and hand off to Flutter after Accept.
*Why first:* biggest single measured cost, zero interaction with media, and it
also unblocks P1's head start.

### P1 — Keep pre-warm (join only), but start it at ring receipt
Move the trigger from the branded screen's `initState` to the earliest common
ring-ingest point (before any UI decision), so it gets ~5s instead of ~2.6s.
Removes the 1.8s join from the accept path. **Already ON**, needs re-siting.
*Risk:* low — no mic, no media, seat lease covers cleanup.

### P2 — Caller publishes during ring, gated on placement
Re-enable the caller pre-join **after** making it wait for `call_place_ok` (so
no 403), with the §5.2A isolation fix already in place. This makes the caller's
audio exist before Accept, which is the precondition that makes any callee
pre-pull viable.
*Risk:* medium. Must not resurrect premature "connected".

### P3 — Callee pre-publish only (never pre-pull), on its own connection
During ring: mic (muted) + **publish only** on a **dedicated SFU session** —
explicitly NOT the session the pre-warm claimed (§5.3 lesson). At Accept:
enable the local track and do only the **pull** (~1.5s). Never wait for the
peer during the ring, so the race in §5.3 cannot recur.
*Open question:* is a second SFU session per call acceptable to Cloudflare
billing/limits, and does the DO seat registry model allow it?

### P4 — Only if P0–P3 leave a gap: "lurker" WebSocket
Let the callee connect to `CallRoom` during the ring **without** being
announced as a peer (a `?prewarm=1` mode; the DO withholds peer-join until an
explicit join frame at Accept). Removes the ~500ms WS cost and lets signalling
be ready. Requires a DO change and careful handling of the transport election.
*Risk:* touches shared signalling; only worth it if the last ~500ms matters.

### Expected outcome if P0–P3 land
Accept → audio ≈ **pull only ≈ 1.0–1.5s**, and Accept becomes reachable ~5s
sooner. That is WhatsApp-comparable but **not proven**; each step must be
verified by its own event before the next is enabled.

---

## 8. Specific questions for the second opinion

1. **Is the SFU the right shape for 1:1 at all?** P2P has no join/publish/pull
   ladder; the SFU was adopted because 1:1 P2P calls did not survive
   WiFi↔cellular handover (12/12 failures on 2026-08-05). Is there a hybrid —
   start P2P for speed, migrate to SFU on network change — or is that worse?
2. **Can the three SFU phases be collapsed?** Is there a Cloudflare Realtime
   pattern where a client publishes and pulls in **one** negotiation instead of
   publish → peer-wait → pull → renegotiate?
3. **Is pre-publishing on a second SFU session (P3) sound**, or is there a
   supported way to hand an existing session id to a new peer connection?
4. **Is a native Accept UI (P0) the right call**, or is pre-warming a Flutter
   engine at ring time sufficient and less duplicative?
5. **What am I not measuring?** The 5.6s in §6.2 is the delay I only found
   after three failed optimisations aimed elsewhere. What else here is
   assumption rather than measurement?
6. **Ordering:** is fixing the pre-Accept 5.6s (P0) genuinely more valuable
   than the post-Accept 4.5s (P1–P3), given the user's complaint mixes both?

---

## 9. Current production state (as of writing)

| Flag | State | Meaning |
|---|---|---|
| `callSfuV1` | **ON** | 1:1 media via Cloudflare Realtime |
| `callPrewarmOnRingV1` | **ON** | callee claims SFU seat during ring (join only) |
| `callerPrejoinOnRingV1` | **OFF** | rolled back (§5.2B ordering flaw) |
| `callPrerollV1` | **OFF** | rolled back (§5.3, made calls 3× worse) |

Build 10569 contains all the code; the two OFF flags make it inert.
Rollback of anything here is a flag flip, no rebuild.
