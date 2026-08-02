# Call delivery invariants

Status: production contract. Owner decision: 2026-08-02.

This file is the release gate for AvaTOK 1:1 call delivery. Feature work may
change presentation, but it must not weaken these invariants.

## Ring invitation

1. A ring invitation is valid for exactly 45 seconds from server admission.
2. Every transport carries `callId`, `ts`, `tokenExpiresAt`, and the same receipt
   token. The WebSocket and FCM payloads are copies of one invitation.
3. The push consumer drops an invitation that is expired or whose authoritative
   CallRoom is terminal before contacting FCM.
4. Android FCM retention is bounded to the invitation's remaining lifetime.
5. Ring and call-status messages share `collapse_key = callId`, so a queued
   cancel replaces an obsolete queued ring.
6. The client checks expiry again before opening CallKit or the branded screen.
   Transport delivery is never permission to resurrect an expired call.

## Delivery acknowledgement

`device-ringing` means a user-visible ring surface was successfully raised. It
must be emitted from the shared `_showIncoming` path after CallKit/branded UI
succeeds. A WebSocket callback, FCM callback, or FCM 200 response is not a
device-ringing acknowledgement.

All three client routes (`ws`, `fcm_bg`, `fcm_fg`) emit the same receipt and the
same `call_incoming_received`/`call_incoming_shown` telemetry semantics.

## Receptionist handoff

1. Human-call cancel, accept, timeout, and receptionist handoff compete in the
   CallRoom state machine. There is no separate client-owned outcome.
2. Automatic receptionist start first commits `handoff_to_receptionist` through
   CallRoom. A completed call is immutable and returns `call_terminal`.
3. Handoff clears the human-ring deadline. The old alarm must never terminate
   the receptionist leg.
4. The caller does not send `bye` or `cancel_call` as part of handoff. Those are
   terminal human actions, not transport cleanup.
5. The client publishes its pending `ReceptionistCall` before any asynchronous
   start request. Teardown must be able to cancel an in-flight start.
6. The server checks terminal state again immediately before returning RTC
   credentials. The client also checks cancellation after `/start` and calls
   `/finish` if a session was created after local hangup.
7. Teardown awaits receptionist shutdown and detaches native callbacks.

## Regression gates

- Worker reducer tests prove server handoff is allowed only while the aggregate
  is live and cannot revive a cancelled call.
- Consumer tests prove expiry, bounded TTL, reserved-key safety, and shared
  collapse keys for ring/cancel.
- Flutter tests prove explicit expiry and legacy timestamp fallback.
- Production monitoring must compare these stages per `call_id`: enqueue, FCM
  accepted, incoming received, incoming shown, device-ringing, and terminal.
  Alert on any late ring, any receipt without `shown=true`, or receptionist start
  after a terminal transition.

## Release order

Deploy Worker first, then consumer. The app fix ships in the next explicitly
requested production Android build. Older apps benefit immediately from bounded
FCM retention and authoritative handoff; the app build adds the final on-device
expiry and pending-start backstops.
