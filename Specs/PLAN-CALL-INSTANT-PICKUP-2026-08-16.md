# PLAN — Instant pickup (WhatsApp-grade answer experience)

Owner report (2026-08-16): incoming call → pick up → blank screen → late
"connecting" UI → connects → seconds of silence → voice. WhatsApp delivers
voice at the moment of pickup. This plan closes that gap.

## Why AvaTOK is slow today (measured, 2026-08-16 calls)

The entire media stack is built only AFTER the callee accepts, serially, on
both phones at once:

| span (callee, accept→) | today | cause |
|---|---|---|
| blank screen | uninstrumented (~1–2s cold start) | Flutter engine boots only on accept; native FSI screen hands off with no continuity |
| renderers+mic+ICE | 0.1–1.3s | already parallelized (CALL-DEADAIR-1) |
| audio session | 0.6–2.0s | serial before WS |
| WS open→welcome | 0.6–1.4s | starts only after audio session |
| SFU join/publish | ~2s | starts only after BOTH phones are in the room WS (transport election on peer-join) |
| wait for peer's track + pull | 2–4s | CALLER also only joins after accept → mutual wait |
| **accept → voice** | **~6.5s wifi / ~9s cell** | |

WhatsApp's trick is none of this work happens at pickup: both sides build
their media path DURING THE RING, and accept only unmutes.

## The plan (three phases, each independently shippable + flagged)

### P1 — Callee pre-warm during ring  (`callPrewarmOnRingV1`, default false)
While the incoming screen is ringing (user deciding), pre-run: renderers,
getUserMedia (mic ONLY — camera stays off until accept for privacy), ICE
fetch, audio session begin, room WS connect, and `/callsfu/join`. Accept
then only: publish + pull. Decline/timeout tears the pre-warm down and
closes the seat (`/callsfu/close`) — the seat lease is the backstop.
Privacy rule: the mic TRACK stays disabled (`track.enabled=false`) until
accept; capture without consent never leaves the device (nothing is
published pre-accept, and publish happens only post-accept anyway).
Expected: accept→voice ≈ 1.5–2s.

### P2 — Caller pre-join + publish during ring  (`callerPrejoinOnRingV1`)
The caller already consented (they placed the call). At ring start the
caller joins the SFU and PUBLISHES audio (track live — same as today's
behavior during "connecting", nobody is pulling it yet). The transport
election shortcut: ring carries `media:sfu` so both sides skip the
peer-join election when the flag is on (falls back to today's ladder when
either side lacks the build). Callee's pull then finds the track on the
FIRST attempt. Expected: accept→voice ≈ sub-1s — WhatsApp territory.
Cost: an SFU seat for unanswered calls (~30s ring, closed on
cancel/timeout via existing lease expiry + explicit close).

### P3 — Kill the blank screen
1. Instrument the missing span: native accept timestamp
   (SystemClock.elapsedRealtime at FSI/notification accept) passed as an
   extra → Dart emits `call_accept_native_tap_ms` so the cold-start cost
   becomes a number.
2. Native continuity: the branded incoming-call activity stays visible
   showing "Connecting…" until the Flutter call screen posts its first
   frame (signal via method channel), instead of handing off to a blank
   engine.
3. If the measured span justifies it: pre-warm the Flutter engine when the
   ring push arrives (Android `FlutterEngineCache`), so accept attaches to
   a warm engine.

## Order + gating
P1 ships first (callee-only, no protocol change, flagged). P2 next (adds
`media:sfu` hint to ring payload — additive, ignored by old builds). P3.1
(instrumentation) can ride with P1; P3.2/3.3 after numbers.

Each phase: implement → two-phone verify per ship-gate rules (assert
`stage_first_audio_bytes` drop in `call_first_audio_ms`, both emails) →
flag on for testers → widen.

## Ship-gate success values
- P1: callee `ms_from_connected` < 1500 and accept→first_audio < 2500ms on
  wifi, both testers on the new build.
- P2: caller+callee `stage_sfu_pull_audio - stage_sfu_publish` < 700ms
  (mutual wait gone).
- P3: `call_accept_native_tap_ms` present; tap→first-frame < 800ms warm,
  < 2000ms cold.
