# Stream 1:1 audio pilot — native Android phase

Status: production-capable Android implementation, disabled by default and
awaiting Stream credentials plus the first CI release build.

Staging requires an explicit `STREAM_VIDEO_PILOT_UIDS` allowlist. Production
requires valid Stream credentials plus `streamCallPilotEnabled=true` and the
configured rollout percentage. The retained "pilot" names are compatibility
names for the reversible rollout seam.

## What is included in this dark foundation

- `RemoteConfig.streamCallPilotEnabled` is a real client kill-switch with a
  compile-time gate (`STREAM_CALL_PILOT_COMPILED`). Both must be on before a
  Stream call can start.
- `StreamRtcProvider` implements AvaTOK's existing provider-neutral RTC seam.
  Call screens do not import Stream types.
- `stream_call_api.dart` parses the server's `provider=stream` response into a
  typed, per-call decision. A successful Stream decision is sticky in memory;
  unavailable/invalid responses select Cloudflare before the ring starts.
- `CallScreen`/`CallSessionConfig` carry the immutable provider decision and
  typed Stream ticket without changing any existing launch site or visual UI.
- `StreamCallClient` talks to a local Android plugin. Ordinary builds compile a
  fail-closed stub; only a build explicitly created with
  `stream_pilot=true` compiles Stream's native SDK.
- The pilot pins Stream Android 1.9.2 and its WebRTC 1.3.8 dependency. That ABI
  matches the M125-era methods used by AvaTOK's existing Flutter WebRTC plugin
  far more closely than current Stream M145 releases, preserving the ability to
  exercise Cloudflare group calls and the rollback path in the same pilot APK.
- Ring ownership is explicit: a payload with `provider=stream` is never handed
  to AvaTOK's legacy CallKit ring. A client with both gates on can hand it to
  Stream; an unsupported/disabled client rejects it, which avoids silently
  switching transports after the server made a sticky Stream decision. Missing
  provider data remains the legacy Cloudflare ring.
- Stream credentials are encrypted in Android storage and scoped to the active
  Stream user. The 30-day background user token lets `Application.onCreate()`
  restore Stream before Flutter/Clerk starts; it is refreshed on app use and
  cleared on logout/account switch. Server-authority tokens remain 15 minutes.
- This phase is audio-only. Camera/video commands fail closed. Recording,
  screenshare, server mute, and multi-party Stream calls remain unsupported.
- Stream users and calls are created with a short-lived server JWT. Only a
  short-lived user JWT is returned to the authenticated app account.
- Human AvaTOK communication remains free under the current product rule. This
  Stream transport pilot adds no wallet, quota, or participant-minute gate.

## Why Stream is behind a build-time switch

AvaTOK currently includes `flutter_webrtc: ^0.12.5` and
`realtimekit_core: 0.1.6`. Stream's Flutter SDK uses its own native WebRTC
build/fork. Adding it directly to this app without a CI Android/iOS dependency
spike can produce duplicate `org.webrtc` classes, conflicting audio-session
ownership, or incompatible Gradle transitive dependencies. The repository also
targets Dart 3.9, while newer Stream package releases require Dart 3.10.

The safe experiment is an isolated local plugin with two Android source sets.
Normal APKs include only the stub and the existing Cloudflare WebRTC artifact.
The staging pilot APK excludes that artifact and uses Stream's compatible
WebRTC artifact as the single `org.webrtc` implementation. The call screens
remain provider-neutral.

## Integration contract for the next workstream

1. The server chooses `provider` before ringing and keeps that choice sticky for
   the call. `worker/src/routes/stream_video_calls.ts` applies these gates:

   - production, or the explicit staging allowlist;
   - `streamCallPilotEnabled=true` in server KV;
   - both accounts in `STREAM_VIDEO_PILOT_UIDS`;
   - `streamCallPilotPercent` (0..100), selected by a deterministic call-id
     bucket; and
   - an explicit `stream_capable=true` client capability.

   The selected provider record is persisted in `DB_META` before admission can
   reach a ring or the Stream API. Repeating the same call id cannot switch
   providers if the percentage or flag changes mid-request. A flag rollback
   affects only new calls; an existing Stream call may still refresh its
   short-lived token by presenting its call id. The client never creates a
   Stream token.

   `scope=group` is part of the provider-selection contract but is currently
   hard-blocked to Cloudflare. Stream remains a 1:1 pilot until a
   separate group SDK/capability review is complete.
2. For `provider=stream`, Stream's push/CallKit implementation is the only
   incoming-ring owner. The existing FCM/`flutter_callkit_incoming` path must
   skip that call id. The Flutter FCM path now checks this ownership boundary.
   For `provider=cloudflare` or a missing/expired flag, the
   existing AvaTOK ring remains the only owner.
3. A Stream call must never fall back from a half-started Stream media session
   into Cloudflare during the same call. If Stream fails before ringing, choose
   legacy for the next call; if it fails after ringing, end the call and let the
   server reconcile it.
4. AvaTOK's existing CallRoom deadline remains the receptionist authority.
   Stream `call.missed` is telemetry/reconciliation only and can never start a
   Vobiz/Ava leg, preventing a duplicate receptionist handoff.
5. The native bridge emits push receipt, Accept, Join, connection, rejection,
   reconnection, remote-track, and first non-zero decoded-audio milestones. A
   bounded native backlog preserves cold-start events until PostHog is ready.

Before enabling the staging pilot, apply
`worker/migrations/2026-08-19-stream-video-webhooks.sql` to staging `DB_META`,
configure the Stream webhook, add the two test account ids to
`STREAM_VIDEO_PILOT_UIDS`, and complete the isolated SDK/CI compatibility
spike. None of those operations is performed merely by landing this dark
foundation.

The existing `/api/call` route remains the complete Cloudflare admission,
CallRoom, InboxDO, FCM, receptionist, and Vobiz boundary for old clients. It
has one explicit early opt-in branch: only a request with `stream_capable=true`
can enter the server selector, and that branch runs after admission and after
glare/routing has completed, but before any Cloudflare ring side effect. A
provider decision of `cloudflare`, a
disabled flag, or an unavailable Stream control plane continues through the
existing Cloudflare code. This is the rollback seam and requires no client
rebuild for an operator flag flip; Stream failures after its provider call are
returned and are never dual-rung into Cloudflare.

## Remaining steps before a real pilot call

1. Run the opt-in Android CI build and prove there is exactly one WebRTC runtime
   plus one Firebase messaging owner in the merged app.
2. Configure the staging Stream Firebase provider/webhook and allowlist two
   test accounts.
3. Test two physical Android phones: foreground, background, killed app,
   decline, caller cancel, no answer to Ava, Wi-Fi/mobile handoff, poor network,
   expired credential, account switch, and instant flag rollback.
4. Keep all group calls on Cloudflare. Stream group work is a separate phase.
5. Add the equivalent iOS native push/CallKit bridge only after Android audio
   acceptance passes.

## Pilot telemetry

The adapter records native FCM receipt/handling, native Accept and Join spans,
connection/reconnection, track arrival, first non-zero decoded audio, reject,
end, and sanitized quality fields. It never records tokens, API keys, SDP, ICE
addresses, raw provider payloads, caller identity, or media content.

## Ava Receptionist and Vobiz boundary

- Vobiz/PSTN and `VobizAgentRoom` stay exactly as they are. Stream is only a
  candidate transport for authenticated human AvaTOK-to-AvaTOK calls.
- The existing `ReceptionRoom` remains the AI receptionist media service.
  Stream must not replace it or send its audio through Vobiz.
- A future provider-neutral call record must map the AvaTOK call id to the
  Stream call id and store caller, recipient, provider, and terminal outcome.
- Verified Stream `call.missed` events are stored idempotently and mapped to
  telemetry only. They never issue a receptionist command.
- The existing AvaTOK/CallRoom ring deadline and its established idempotency
  remain the only path allowed to start Ava Receptionist, so changing the media
  provider cannot create two AI legs.
