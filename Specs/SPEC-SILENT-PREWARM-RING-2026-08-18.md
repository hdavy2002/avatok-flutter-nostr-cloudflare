# SPEC — Silent transport pre-warm before the ring

**Date:** 2026-08-18  
**Status:** implemented behind default-off flags; CI and two-phone qualification required before activation  
**Scope:** 1:1 audio calls. No microphone, media track, remote playout, or audio-focus change before Accept.

## 1. User outcome

The caller sees an honest finding/waking state while the other phone prepares. Ringback starts only after the server changes the call from `PREWARMING` to `RINGING`. The callee then sees durable native Accept/Decline and hears the real ring. Accept adds the microphone to the already-connected transport, publishes, pulls the caller, and shows Connected only after playout evidence.

```text
Caller: Call → Finding / waking → real ringback → voice
Callee: silent wake → real ring + instant native actions → Accept → voice
```

Targets after activation:

- Native ring surface: p50 <200 ms and p95 <500 ms from the real-ring intent.
- Accept to `call_audible_ready`: p50 <800 ms and p95 <1,500 ms on the prepared SFU path.
- No microphone/media capture and no remote audio playout before Accept.
- A failed or killed pre-warm still produces an ordinary incoming ring.

## 2. Architecture decision

Cloudflare Realtime maps one Session to one PeerConnection. JOIN-only reserves a seat but is not a transport pre-warm; completed ICE/DTLS requires SDP exchange.

The safe provider path is Cloudflare's data-channel-only negotiation:

1. Authenticated callee joins the call's SFU seat.
2. In a foreground-safe Flutter engine, create the call's canonical `RTCPeerConnection`.
3. Create a data channel and an SDP offer containing only `m=application` (`UDP/DTLS/SCTP webrtc-datachannel`).
4. POST through authenticated `/callsfu/:room/prepare` to Cloudflare `datachannels/establish`.
5. Apply Cloudflare's answer and wait for the PeerConnection to become connected.
6. Mark the exact callee-owned SFU seat/session transport-prepared.
7. Acknowledge `prewarm_ready` with nonce, generation, device id, and prepared session id.

This performs SDP, ICE and DTLS preparation without an audio/video m-line, `MediaStream`, microphone permission, publish, pull, remote renderer, or audio focus.

## 3. Background and foreground split

The Firebase background handler never joins the SFU and never calls `flutter_webrtc`: plugin/engine ownership is not reliable in a killed/background isolate, and a background seat could replace the foreground device's canonical seat on a multi-device account.

The server enables the silent phase only after an Inbox liveness probe proves a main Flutter isolate is connected. It sends `call_prewarm` over that live socket; the foreground owner performs JOIN plus the data-channel handshake. With no live main isolate, the unchanged ordinary ring starts immediately. If the socket disappears after the probe or transport preparation fails, the bounded server deadline still promotes the call to an ordinary cold ring. JOIN-only is never reported as `transport_ready`.

## 4. Server-authoritative lifecycle

```text
ADMITTED → PREWARMING
              ├─ verified prepared callee session → RINGING(reason=ready)
              └─ deadline / failure              → RINGING(reason=fallback)
RINGING → ACCEPTED | DECLINED | TIMEOUT | RECEPTIONIST_HANDOFF | CANCELLED
```

Only `CallRoom` stamps `ring_started_at`, transition sequence, and ring deadline. Readiness proves:

- authenticated user is the persisted callee;
- nonce and generation exactly match the durable lease;
- device id is non-empty;
- session id is the callee's current SFU seat;
- provider prepare succeeded for that exact session.

Atomic lifecycle/storage/socket work stays inside the Durable Object critical section. Push delivery and analytics happen after it.

The normal ring is sent only after the transition. It carries the authoritative sequence/deadline, same nonce/generation, room/action capabilities, and caller identity. Capability expiry covers the silent deadline plus the complete later ring window.

## 5. Caller and Ava timing

- A placement response with `prewarming:true` is not a ring acknowledgement.
- During PREWARMING the caller may publish early, but remains in finding/waking UI; no ringback or local no-answer/Ava timer starts.
- The `call-ringing` server frame supplies `ring_started_at`, sequence, and deadline and releases caller timing.
- Ava/receptionist and the backstop use that same server anchor, never POST `/api/call`, silent FCM send, or local elapsed time.
- Audible ring receipts still count real ring cycles. They refine delivery evidence; they do not invent the anchor.

## 6. Accept and media

Accept is the first point AvaTOK may:

1. acquire the microphone;
2. add audio to the adopted canonical PeerConnection;
3. publish the explicit local audio track through `/publish`;
4. pull and renegotiate through the existing path;
5. attach/enable remote audio playout.

`callPrerollV1` stays permanently disabled. A prepared session is never attached to a second PeerConnection.

## 7. Race, teardown, and recovery

- Nonce + generation + absolute expiry reject stale/replayed FCM and intents.
- Native Accept/Decline is durable, but a local tap is provisional until server resolution.
- Existing CallRoom FSM is first-answer-wins. Losing devices reconcile and close their prepared PC/session.
- Cancel, decline, timeout, remote answer, expiry, superseding generation, and teardown explicitly close data channel, PC and SFU seat.
- Network identity change invalidates the prepared transport. Close it and mint fresh; never adopt ICE/DTLS across interfaces.
- After Accept, normal ICE restart/reconnect remains owned by `CallSession`. Before Accept, failure degrades to cold ring/accept.
- Every wait is bounded. No optimisation may suppress the real ring.

## 8. Native and audible state

Android holds a default-off durable record keyed by exact call id, nonce and generation. It shows the native ring only for a newer server-authoritative RINGING sequence. Actions survive Flutter death; remote terminal/winner state reconciles optimistic local action. The bridge performs no WebRTC or audio work.

Transport readiness is not audible readiness. `call_audible_ready` remains based on playout progress (`totalSamplesReceived`, with `jitterBufferEmittedCount` fallback, requiring consecutive increases). Until then the UI says `Connecting audio…`; timer and connected haptic wait.

## 9. Flags and rollout

- `callSilentTransportPrewarmV1`: master flag, default `false`.
- `callSilentPrewarmDeadlineMs`: silent deadline, default 12,000 ms.
- Native bridge mirrors the master flag and fails closed.
- `callPrerollV1` remains hard-disabled.

Rollout: merge dark → CI → production backend dark → internal Android build → locked/process-killed and foreground two-phone tests → small cohort → monitor → expand. Server flag rollback restores the existing ring path without a client release.

## 10. Telemetry and release gates

Required signals:

- `call_prewarm_started`: trigger, call id, generation.
- `call_prewarm_joined`: result and elapsed time.
- `call_prewarm_transport_ready`: prepared session, ICE/DTLS elapsed time, network class; only after connected PC state.
- `call_prewarm_failed` / `call_prewarm_discarded`: bounded reason.
- `call_silent_prewarm_ring_started`: `reason=ready|fallback`, server anchor, generation, device/session.
- `call_native_ring_shown`: milliseconds from authoritative ring intent.
- `caller_waiting_room`: `phase=finding|waking|ringing`.
- `call_audible_ready` / `call_audible_timeout`: playout evidence and Accept-to-audible latency.

Watch ready/fallback rate by app state/network; join/prepare/ICE-DTLS/Accept-audible p50/p95; stale rejects; adoption success; seat leaks; losing-device cleanup; ring-to-audible-receipt; pre-Accept media acquisition (target zero); and cold/P2P/reconnect rates.

No stage is successful until a real two-device call on the new build produces these success values. Code merged behind false flags is shipped dark, not user-validated.
