# TECH BREAKDOWN — everything coded for fast call answering (not yet shipped)

**Date:** 2026-08-18 · **Status:** code complete, committed, **NOT built, NOT
in any user's hands.** Awaiting review before one single production build.
**Reviewer note:** all six changes below are on `main`; the two behaviour flags
that are ON are server-side only and affect the CURRENT build's behaviour where
that build already contains the code (marked per item).

---

## 0. The problem, measured (prod call `avatok-1204d417`, both phones build 10569)

| t (UTC) | Δ | what happened |
|---|---|---|
| 15:06:54.814 | — | caller taps dial |
| 15:06:56.881 | +2.07s | caller's phone finishes booting media |
| 15:06:57.190 | +0.31s | ring sent |
| 15:06:58.216 | **+1.03s** | callee receives ring — **transit is fast, not the problem** |
| 15:06:58.241 | +0.03s | OS notification surface up |
| **15:07:03.847** | **+5.61s** | **AvaTOK's own answer screen finally appears** |
| 15:07:06.423 | +2.58s | user accepts |
| 15:07:12.671 | +6.25s | UI says "connected" |
| ~15:07:24.6 | +11.9s | **actual audio arrives** |

Two distinct failures: **5.61s before Accept is reachable**, and **~18s from
Accept to audio** on that call (a healthy baseline is ~6.4s; that call was
inflated by a pre-roll experiment since rolled back).

Owner's experience, verbatim: *"it says connected, I see the meter started, I
do not hear the other person and I keep saying hello and hello, then eventually
the voice comes."*

---

## 1. `[CALL-STAGE0A-1]` — telemetry and identity off the media path
**Type:** server only · **Live in production now** (worker `740b9fd8`)

`routes/call_sfu.ts` `await`ed a PostHog queue send before returning the
response on **every** join / publish / pull — a change I made on 2026-08-16 to
stop workerd dropping unawaited sends. It fixed the drop and silently put a
queue round trip on the critical path of answering a call.

- `ExecutionContext` threaded into all 7 `callSfu*` handlers + `guard()`.
- All 12 sends now `ctx.waitUntil(...)` — still guaranteed to complete, no
  longer blocking the response.
- The telemetry-only `emailFor()` lookup **moved out of `guard()` into the
  deferred work**. (A reviewer correctly caught that merely caching it left a
  KV read — and a possible Clerk call — in front of every media operation. My
  first attempt only cached it; that claim was false until this change.)
- `emailFor` also gains a bounded in-isolate memo (60s TTL, 500 entries).
- Deterministic **per-call** sampling (FNV-1a over `call_id`) at rate 1.0 —
  mechanism only, nothing dropped yet. Errors are never sampled.

**Risk:** low. Server-side, reverts with one redeploy.
**Proof to look for:** `call_sfu_joined/published/pulled` `elapsed_ms` falls
while `sfu_ms` stays flat.

---

## 2. `[CALL-VIDEO-FIX-1]` — the audio→video freeze
**Type:** client · **needs the build**

Three faults, fixed together (any one alone leaves the freeze reachable):

1. **Wrong media slot.** `publishVideo` sent a hard-coded mid `'1'`. After
   remote audio has been pulled, slot 1 usually belongs to the *incoming audio*
   transceiver, so video was registered against the wrong media section. Now
   the real mid is resolved from `pc.getTransceivers()` by matching
   `sender.track.id`, and the upgrade **aborts rather than guessing** if it
   cannot be resolved.
2. **Two concurrent negotiations.** It ended with `unawaited(_pull('video'))`.
   Now awaited.
3. **No serialization.** Added a negotiation queue (`_serialize`, 15s per-op
   timeout) covering `connectPublish`, `connectPull`, `publishVideo`, `_pull`,
   `pullPeerVideo`, `pullPeerAudio`.

**I added a fourth guard the implementer missed:** Dart's `.timeout()` does not
cancel work. A timed-out negotiation keeps running and would write
`_pc`/`_sessionId` *after* its successor. Each queued body now carries a
generation stamp (`_ownsNegotiation`) and abandons its writes if superseded.
This is the same defect class as an earlier bug where a pre-join connection
overwrote live call state.

Also: `toggleCamera`'s re-entrancy guard now covers the SFU path (it only
covered P2P), optimistic `videoActive/cameraOn/speakerOn` replaced by a
`videoUpgrading` state, 8s camera timeout with full rollback, and the
optimistic `call_sfu_video_upgraded` retired in favour of
`local_video_published` → `remote_video_track_attached` →
`remote_video_first_frame`.

**Note:** the *initial* connect publish deliberately keeps mids `'0'/'1'` —
tracks are added audio-then-video before the first offer with nothing else on
the connection, so they are correct by construction.

**Risk:** medium — touches the media negotiation core.
**Unverified:** `onFirstFrameRendered` could not be compile-checked against the
pinned flutter_webrtc.

---

## 3. `[CALL-VIDEO-FIX-3]` — stale tracks across a session change
**Type:** server · **live in production now**

`CallRoom /sfu-seat` carried `audio_track` / `video_track` / mids forward from
the previous seat **even when `session_id` changed**. A reconnect or pre-warm
swap therefore advertised a *new* session paired with *dead* track names, and
the peer pulled a track that no longer existed — silent one-way audio that
would look random forever. Carry-forward is now scoped to the same session id.

**Risk:** low. **Proof:** after `call_sfu_reconnected`, the next pull succeeds
with no `peer_track_not_published` storm.

---

## 4. `[CALL-PREJOIN-2]` — caller publishes during the ring
**Type:** client · **needs the build** · flag `callerPrejoinOnRingV1` **ON**

This is the main fix for *"connected, meter running, hello? hello?"*.

Today both phones start publishing only after Accept, then each waits for the
other's audio before it can pull it — a 3–4s mutual wait. Now the **caller
publishes while the callee's phone is still ringing**, so the callee's first
pull finds a live track.

This was tried before and rolled back twice, for two distinct reasons, both now
fixed:
- **It faked "connected".** The pre-join connection was built by the session's
  own `_newPC`, which assigns `_pc` and installs `onTrack` — so a track on it
  ran the whole connect ladder and the caller's UI said "connected" **7.3s
  before the callee accepted**. Fixed by an isolation mode
  (`[CALL-PREJOIN-ISOLATE-1]`) that withholds `_pc`, `onTrack` and playout
  baselines until an explicit promotion at adoption, replaying any track that
  arrived during the ring.
- **It raced call placement.** It fired from the socket's `welcome` frame, so
  the seat write could arrive before the server had recorded the call →
  **403 `not_a_participant`**. It now fires on a **positive ring-ack**, which
  the server can only send for a call it has already recorded with both uids.

**Risk:** medium-high (it is the change with the worst history).
**Instant rollback:** flip `callerPrejoinOnRingV1` off, no rebuild.
**Regression to watch:** the caller's `call_connected` must be **after** the
callee's accept, never before.

---

## 5. `[CALL-AUDIBLE-1]` — stop the UI lying about "connected"
**Type:** client · **needs the build** · flag `callAudibleStateV1` **ON**

`_connected` today means "a remote track object exists", not "you can hear
them" — which is why the meter runs while you say hello into silence.

`_connected` is load-bearing (it stops the ringback, starts talk time, cancels
four timers, starts the media watchdog and playout sampler, aborts the
receptionist, clears glare state, gates `onConnectionState`), so it is
**deliberately untouched**. A new, later, purely presentational milestone
`audibleReady` was added instead:

- Driven by the **existing** first-audio-bytes probe — reused, not duplicated.
- **Never** gated on `audioLevel`: a silent caller must still connect.
- While connected but not audible, the call screen and the minimized pill show
  **"Connecting audio…"** and hide the timer. The connection haptic moved here.
- Paths without stats (RealtimeKit) use its `trackAdded` evidence plus a 4s
  safety timer, so no call can be stuck on "Connecting audio…" forever.
- New events `call_audible_ready {ms_from_connected}` and
  `call_audible_timeout` — `ms_from_connected` **is** the size of the lie
  (12–16s today).

**Risk:** low-medium, user-visible. Rollback is a flag flip.

---

## 6. `[CALL-NATIVE-ANSWER-1]` — kill the 5.6s answer-screen delay
**Type:** client (Kotlin) · **needs the build** · flag `callNativeAnswerV1`
**OFF** (deliberately — see below)

Root cause confirmed in code: `_routeToBrandedIncoming` polls
`navigatorKey.currentState` every 250ms for up to 10s — it is **waiting for the
Flutter engine to cold-start**. The 250ms poll adds bounded rounding on top.

`MainActivity` now paints an **interactive native ring screen** (caller name,
Decline / Accept, 72dp targets, no image assets) synchronously on the
`avatok.incoming_call_tap` launch — before Flutter exists. Accept swaps it for
the existing passive "Connecting…" overlay.

**All real logic still ends in the existing Dart paths.** The native screen is
a surface only: taps are held in a static and drained by Dart through the same
`pendingIncomingTap` / `getPending` idiom already used on that channel, then
routed into `PushService.acceptRingingCall` / `declineIncomingCall`. No second
accept path exists.

Details that matter:
- Native cannot read `RemoteConfig`, so the flag is mirrored to a small JSON
  file in `filesDir` by `RemoteConfig.refresh()` and read **fail-closed** (any
  doubt → OFF → today's behaviour).
- `_brandedRouteGate` is marked on native action so the independent FCM/WS ring
  lane cannot stack a duplicate branded screen on top.
- The two native surfaces are mutually exclusive; the 6s failsafe is retained.
- New event `call_native_ring_shown {ms_from_intent}` — the number that proves
  5610ms → ~100ms.

**Why this one ships OFF:** it is brand-new native UI on the most important
screen in the product, written without a compiler. I want it in the build so it
can be switched on in seconds, but not enabled blind on the same call where
four other changes are being judged.

**Risk:** highest of the six, hence the flag.

---

## 7. Current flag state (production KV, verified cache-busted)

| flag | state | effect |
|---|---|---|
| `callSfuV1` | ON | media via Cloudflare Realtime (unchanged) |
| `callPrewarmOnRingV1` | ON | callee claims its SFU seat during the ring |
| `callerPrejoinOnRingV1` | **ON** | caller publishes during the ring (§4) |
| `callAudibleStateV1` | **ON** | honest "Connecting audio…" (§5) |
| `callNativeAnswerV1` | **OFF** | native ring screen (§6) — opt-in after one good call |
| `callPrerollV1` | OFF | withdrawn: made calls 3× worse, and pre-Accept mic is now forbidden |

---

## 8. What we expect the next call to look like

- **Ring → Accept reachable:** unchanged (~5.6s) **until** `callNativeAnswerV1`
  is switched on; then ~0.1s.
- **Accept → hearing the other person:** the mutual publish wait (3–4s) should
  disappear because the caller published during the ring.
- **The UI should stop lying:** "Connecting audio…" until audio genuinely
  arrives, then "Connected" + timer.
- **Video switch:** should not freeze, and audio must not break across it.

---

## 9. Honest position on verification

No device has run any of this. There is no staging build, so the owner's two
phones are the first test — his explicit decision, taken knowingly. Every risky
item is behind a flag that reverts in seconds without a rebuild.

Standing rule from this week (three features shipped that never executed once):
**nothing is "shipped" until its event is observed in production.** Watch for
`call_prejoin_published`, `call_audible_ready`, `call_native_ring_shown`,
`local_video_published`, `remote_video_first_frame`. A missing event means the
code did not run, not that it worked quietly.

## 10. Questions worth asking a reviewer

1. Is firing the caller's pre-publish on **ring-ack** sufficient, or is there a
   window where the server has acked but the seat write can still 403?
2. `audibleReady` reuses the first-audio probe. Is there a path (receptionist /
   Ava, RealtimeKit, relay migration) where that probe never resolves and the
   UI would sit on "Connecting audio…"?
3. The native ring screen duplicates *presentation* only. Is the pending/drain
   hand-off robust against the app being killed between the native tap and
   Dart starting?
4. Anything in §2's negotiation queue that could deadlock or starve under a
   reconnect storm?

---

## 11. REVIEW ROUND 2 — responses (2026-08-18)

### P0 — negotiation queue was not actually safe. **CONFIRMED, FIXED.**
All three sub-faults were real, verified in the code:
1. The generation was bumped **on enqueue**, so queuing a *different* operation
   invalidated an older queued one — which then threw an **uncaught
   `StateError`** out of the chain.
2. A timeout released the queue but did **not** invalidate the abandoned work,
   which kept running and could still write `_pc` / `_sessionId`.
3. The body read the **global** counter at start instead of holding its own
   token, so "am I current?" was answered by a value anyone could move.

**Fix `[CALL-VIDEO-FIX-4]`:** replaced the counter with a per-operation
`_NegotiationToken`. Strict FIFO — each op waits for the previous to FINISH and
is **never** invalidated merely because something queued behind it. A token is
invalidated only by (a) its own timeout, via `onTimeout` which sets
`token.live = false` **before** giving up, or (b) `dispose()`, which now calls
`_cancelAllNegotiations()` first. `_ownsNegotiation(token)` gates every shared
write. No uncaught error path remains.

### P1 — pre-join triggered too late. **CONFIRMED, FIXED.**
The reviewer's sequencing is right: the backend records both participants
before the WebSocket ring, while the FCM ack only lands after token fan-out —
so an online callee can accept **before** the ack. **Fix `[CALL-PREJOIN-3]`:**
the primary trigger moved to `notePlaceResult(reachable: true)` (a 200 from
`/api/call` = participants recorded = the exact precondition the seat write
checks). Ring-ack remains as an idempotent backstop and keeps owning
reachability and the no-answer window.

### Accepted, NOT yet fixed — must be judged before shipping
- **`onFirstFrameRendered` exists** in the pinned version — uncertainty closed,
  thank you.
- **Initial publish still assumes mids `0/1`.** Safe by construction today
  (tracks added before the first offer, nothing else on the connection) but it
  is an assumption, not a proof. Should be resolved from transceivers too.
- **`videoUpgrading` has no visible "Adding video…" UI** — wired, not rendered.
- **Native accept/decline is still process-memory only.** A process death
  between the tap and Dart draining it loses the answer; the 6s failsafe can
  also clear the surface while Flutter is still absent. Needs atomic disk
  persistence with call id, timestamp, expiry and a one-time nonce.
- **"First audio" proves RTP arrival, not playout.** Should move to
  jitter-buffer / `totalSamplesReceived` plus route confirmation. The
  RealtimeKit `trackAdded` path does not distinguish audio from video (latent —
  that transport is off).
- **Fallback/recovery as a latency fault** — the 12–16s call also showed SFU
  fallback and transport recovery. Pre-join alone will not make it
  WhatsApp-fast; that needs its own investigation.
- **Sampling at 1.0 is not viable at target scale** — mechanism is in place;
  unsampled health counters must land before turning it down.
- **Wording corrected:** the native surface is installed after
  `super.onCreate`, i.e. before Flutter's first *frame*, not "before Flutter
  exists".

### Rollout hazard the reviewer raised — acknowledged
`callerPrejoinOnRingV1`, `callPrewarmOnRingV1` and `callAudibleStateV1` are
already ON in production config, so a new build activates them the moment it
lands. Options: ship with those three flipped OFF and enable one at a time, or
ship as-is with instant flag rollback. **Owner's call.**
