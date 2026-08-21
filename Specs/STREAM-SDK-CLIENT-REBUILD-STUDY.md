# Stream Video SDK — Full Client Calling Rebuild Study

Date: 2026-08-21 · Owner decision pending · Scope: rip out the ENTIRE client call stack and rebuild on Stream Video Flutter SDK. Design (screens/look) stays. Nothing from the old logic is kept.

---

## 1. What PostHog says is wrong today (hdavy2002@gmail.com, last 14 days)

- **Mic stays on after calls — confirmed, chronic.** `call_fgs_started` = 88 vs `call_fgs_stopped` = 80 device-wide, and per-call analysis found **20+ calls where the microphone foreground service started and NEVER stopped** (e.g. `avatok-92539cc0` on 2026-08-21, `avatok-c352298c` on 2026-08-20). That foreground service holds `foregroundServiceType="phoneCall|microphone|camera"` — this IS the "mic is still on" symptom.
- **Call teardown tears.** Several calls emit `call_ended` TWICE (`avatok-7cae77c3`, `avatok-c352298c`, `avatok-9033df4c`…) — double-terminal races in `call_session.dart`'s hand-rolled teardown.
- **Incoming calls failing.** 553 `call_failure_shown` against only 80 `call_started`: **482 = `no_answer`**, 59 = `failed`. Plus `call_os_ring_suppressed` (16) and `call_duplicate_push_ignored` (16) — the ring path itself is unreliable.
- 453 `$exception` events in the window (mostly scrubbed client exceptions; one `Bad state: Cloudflare Realtime peer connection disconnected`, one `IllegalStateException: Reply already submitted`).

Conclusion: the failure classes are exactly the things Stream's SDK owns end-to-end (ring delivery, teardown, track/device release).

---

## 2. What gets ripped out (the surface)

All client-side; Android-only app (no ios/ dir):

| Area | Lines (approx) |
|---|---|
| `core/calls/` incl. `call_session.dart` (11,945 alone) + `rtc/` seam | ~17,400 |
| `core/call_recording/` | 3,340 |
| Call-adjacent core (`receptionist_call`, `call_telemetry`, `native_voice_audio`, `ringback_player`, `audio_tuning`, `ice_cache`, …) | ~4,800 |
| `push/push_service.dart` call portions (CallKit ring, FSI, glare globals) | part of 6,793 |
| 1:1 call UI + chat-thread wiring (design kept, logic replaced) | ~7,700 |
| `features/conference/` (Cloudflare SFU group calls) | 4,241 |
| In-call translation plumbing (`call_translation_*`) | ~3,700 |
| Android native: `AvaVoiceAudioPlugin`, `CallForegroundService`, `CallRecorderPlugin`, `CallTranslationAudioPlugin`, prewarm/decline bridges | ~6,300 |

NOT touched: AvaDial PSTN (Android Telecom, separate product), AI voice-agent audio path (`features/avachat/voice_call` — not WebRTC peer).

**Owner decision 2026-08-21: AvaLive and consult rooms ALSO move to Stream.** AvaLive host/viewer (`features/avalive/`, ~1,500 lines, WHIP/WHEP + `flutter_webrtc`) rebuilds on the `livestream` call type (host publishes via SDK, viewers via `LivestreamPlayer`-equivalent custom UI or HLS egress; RTMP/WHIP ingest still available server-side). Consult rooms (`features/consult/`, ~820 lines, RealtimeKit) rebuild as `default` calls with booking-scoped ids. This removes the `flutter_webrtc`-coexistence problem entirely and lets `realtimekit_core` be deleted too.

**Head start that already exists:** `packages/stream_call_bridge/` (1,010 lines) — a native GetStream pilot behind `RemoteConfig.streamCallPilotEnabled`, plus `core/calls/rtc/stream_call_provider.dart` (881) and `stream_call_api.dart` (server-side provider decision + Stream token mint at `/api/call...`). The Stream account/token plumbing is partially built. The rebuild supersedes the pilot: the pilot wraps Stream's *native Android* SDK over a MethodChannel; the rebuild uses the official **Flutter** SDK directly in Dart — simpler and fully supported.

---

## 3. What Stream replaces it with

Packages: `stream_video` + `stream_video_flutter` + `stream_video_push_notification`, all v1.4.3 (actively released; docs updated 2026-08-20). Underlying WebRTC is Stream's fork `stream_webrtc_flutter` — our `flutter_webrtc` must be REMOVED in the same change (native lib conflict), which forces AvaLive/consult onto their own plan (see risks).

- **Client init:** one `StreamVideo(apiKey, user, tokenLoader: ...)` singleton; `tokenLoader` hits our Worker, which mints the JWT with `@stream-io/node-sdk` (`client.generateUserToken({user_id})`). API secret never leaves the Worker. The Node SDK is fetch-based → runs in a Cloudflare Worker.
- **Outgoing call:** `makeCall(callType: default, id: <our call id>)` → `getOrCreate(memberIds:, ringing: true, video: false, custom: {display_name})` → `join()`. **Stream's backend sends the ring push itself** (FCM data message) — our entire CallRoom-DO ring/receipt/FCM fanout, prewarm, glare arbitration, busy logic, ring-cycle machinery goes away.
- **Incoming call:** `stream_video_push_notification` handles foreground ring, background/killed (`vm:entry-point` handler + `StreamVideo.create` from stored creds), full-screen intent on Android 14+, missed-call notification with callback button, accept-from-terminated (`consumeAndAcceptActiveCall`). Replaces `flutter_callkit_incoming` + our FSI/branded-ring code in `push_service.dart`.
- **Teardown — the mic fix:** the SDK owns track lifecycle. `call.leave()`/disconnect releases mic/camera; `dropIfAloneInRingingFlow` auto-ends the call when one participant remains (the exact "callee hung up, caller's mic stays hot" bug class); every disconnect surfaces as typed `DisconnectReason`. No app-managed foreground service for the mic — the SDK manages its own.
- **Our design, their engine:** headless layer is first-class — `call.state` (`CallState`, `CallParticipantState` with `videoTrack/audioLevel/isSpeaking/connectionQuality`) + `StreamVideoRenderer` (our `RTCVideoView` equivalent). We rebuild `CallScreen`, `IncomingBusinessCallScreen`, conference screen pixel-identical on top of these. `StreamCallContainer` never used.
- **Group calls:** same `default` call type with N members — the entire mesh/SFU/escalation/migration codebase (4,241 lines + `call_sfu_transport`) collapses into `call.addMembers()`. 25-cap enforced via call-type max-participants setting server-side.
- **Audio rooms / livestream:** `audio_room` and `livestream` call types with backstage, `goLive()`, permission requests (`requestPermissions([CallPermission.sendAudio])`), HLS egress + RTMP ingest — available later for AvaLive if wanted.
- **Device control:** `setMicrophoneEnabled/setCameraEnabled/flipCamera`, `setAudioOutputDevice` + `RtcMediaDeviceNotifier` (speaker/earpiece/BT). Proximity sensor is NOT in the SDK — keep a slice of `AvaVoiceAudioPlugin` (sensor + screen-off only, no audio ownership).
- **Recording & transcription:** server-side products (composite/individual-track/audio-only recording, transcription, captions) — can replace our 3,340-line client recording stack + native recorder, with storage to our R2 (custom storage supported). Billed per call-minute as add-ons.
- **TWO-LANE DESIGN (owner decision 2026-08-21): Stream is ONLY for in-app a/v.** Lane 1 — Stream: 1:1 calls, group calls, livestream (AvaLive), consult rooms — anywhere an AvaTOK app is on at least one end. Lane 2 — DID/receptionist: NO Stream in the path. DID number → carrier (Twilio/Telnyx) streams audio directly to the Ava container → Gemini Live listens/speaks → recording + transcript to the user's inbox (SAME pipeline as today). Cost per DID minute: Gemini only (~$0.01–0.02) + carrier minutes; zero Stream charge. Missed in-app calls likewise keep the existing record-to-inbox receptionist flow. **Live transfer is IN SCOPE (owner decision 2026-08-21, not future/optional):** Ava says "let me transfer you" → Worker creates a Stream call and rings the owner's app (normal Stream incoming call) → the DID caller is bridged into that call via Stream's SIP inbound trunk → owner accepts and talks to the caller live; Ava leaves (or stays to whisper-summarize first). If the owner declines/doesn't answer, Ava resumes and takes a message to the inbox as usual. Stream billing applies only for the bridged minutes of that one call. Lands with the receptionist phase (P3).
- **Receptionist scaling + scope (owner Qs 2026-08-21):** Ava joins only invited calls (no-answer timer, DID forwarded to reception, or on-demand) — never regular user-to-user calls — so AI cost scales with concurrent receptionist conversations, not users. Agent runtime: Vision Agents (Python) with the first-party **Gemini Live plugin** (Ava stays on Gemini), deployed on **Cloudflare Containers** with autoscaling/scale-to-zero (~30–50 concurrent Ava sessions per small container).
- **Receptionist/AI — CONFIRMED viable on Stream (owner asked 2026-08-21).** The agent joins the call as a server-side participant via Stream's official `connectOpenAi` (`@stream-io/openai-realtime-api`, OpenAI Realtime voice): caller stays in the same call, agent hears/speaks/runs tools, full transcript available. Trigger: `call.ring` webhook + no-answer timer in the Worker → Worker tells the agent service to join+accept. Constraint: `connectOpenAi` holds a live audio session, so it needs a small always-on Node service (Cloudflare Container / Fly / Cloud Run, ~200 lines) — the Worker keeps all rules/billing/transcript logic. Cost: agent bills as one audio participant + LLM voice-API usage. Current receptionist path keeps working through P1–P2; Stream version lands in P3.
- **In-call translation:** biggest open question. Today it taps call audio natively (`CallTranslationAudioPlugin`). With Stream, options: per-participant audio via SDK tracks, server-side transcription/captions as the text source, or a translation bot participant. Needs its own spike; phase-gated.

## 4. Backend changes (Worker)

1. `POST /api/stream/token` — Clerk-authenticated, mints Stream user token (+ `upsertUsers` on first mint). Partially exists via `stream_call_api.dart`'s endpoints — verify and finish.
2. **Webhooks → billing:** Stream fires `call.session_started`, participant joined/left, `call.ended` to our Worker — per-minute token (₹) billing moves server-side off webhook truth instead of client reports. Also feeds call history/missed-call records.
3. Call-type config in Dashboard: `default` audio/video settings, max participants 25, push providers (upload FCM service-account JSON), missed-call template, roles.
4. Decommission (after cutover): CallRoom DO, mesh DO, `/api/call*` signalling routes, SFU/callrtk routes, ICE route, ring FCM senders, receptionist ring-timeout triggers. Keep call-history, contact-policy, quick-reply, paid-call quote routes (re-pointed at Stream call ids).

## 5. Cost

Audio-only: **$0.30 per 1,000 participant-minutes**; 480p video $0.75, 720p $1.50. A 2-person 10-min audio call ≈ $0.006. **$100/month free credit ≈ 333k audio participant-minutes** — at current usage this is effectively free for a long time. Recording/transcription/noise-cancellation are separate per-minute add-ons.

## 6. Risks

1. ~~`stream_webrtc_flutter` vs `flutter_webrtc` coexistence~~ — RESOLVED by owner decision: AvaLive and consult move to Stream too, so `flutter_webrtc` and `realtimekit_core` are both deleted at cutover. Until their Stream rebuilds land, AvaLive/consult are flag-gated off on the Stream builds.
2. Receptionist needs a small always-on Node agent service (see §3) — new infra piece, but thin; Worker remains the brain.
3. Translation still needs a spike — ship the core call swap without degrading it, behind flags.
4. Old↔new client interop: a Stream-client caller cannot ring an old-build callee. Mitigation: version-gate via `latestAppBuild` + a `streamCallsEnabled` flag declared in `config.ts` `DEFAULTS` (a REAL flag, per the fake-flag rule), and force-update the Closed Alpha group — small tester base makes a hard cutover feasible.
5. CI-only compile net (no local toolchain): 40–80 min per iteration. Mitigate with small phased PRs on `staging` and the existing `stream_call_provider_test.dart` seam tests.
6. Vendor lock + India latency: Stream runs a global edge network; run their connection test from India before committing.

## 7. Proposed phases (all built on `staging`, shipped per ship-gate rules)

1. **P0 — Account & backend:** Dashboard app, push provider, token route, webhook route + billing shadow-write (no user impact).
2. **P1 — New call engine behind `streamCallsEnabled`:** 1:1 audio/video on Stream SDK, existing screens rebuilt on `call.state` + `StreamVideoRenderer`, incoming via `stream_video_push_notification`. Old stack still in tree, flag-selected. Two-phone verification per ship-gate (success events: `stream_call_connected`, `stream_call_ended` with `mic_released=true`).
3. **P2 — Group calls** (addMembers, cap 25) + consult rooms as `default` calls + call history/billing on webhooks.
4. **P3 — Receptionist agent service (`connectOpenAi`) + AvaLive on `livestream` call type + recording/transcription server-side; translation spike lands.**
5. **P4 — The rip:** delete `core/calls/`, conference, avalive/consult legacy, native audio/recording plugins, `flutter_webrtc`, `realtimekit_core`, `flutter_callkit_incoming`, call parts of `push_service.dart`; flags removed.

Rough size: P1 is the big one (~3–4 focused PR waves); total deletion at P4 ≈ 35–40k lines replaced by an estimated 6–8k.

---

## 8. IMPLEMENTATION STATUS — dark lane landed 2026-08-21 `[STREAM-LANE-1]`

**Owner directive: do NOT rip the old stack — keep it live and default; build the new Stream lane dark/archived alongside it so revert is trivial.** Implemented as follows:

**Worker (live, harmless):** `streamCallsEnabled` (bool, default false) declared in `config.ts` PlatformConfig + DEFAULTS — a REAL flag. `GET /api/stream-video/token` now also mints when `streamCallsEnabled` is on (pilot gates untouched). Existing `stream_video_calls.ts` already had token/prepare/webhook (call.ring/accepted/rejected/missed/session_started/session_ended/ended, HMAC-verified, idempotent). Known gap: `call.session_participant_joined/left` unhandled (needs a CallEvent enum addition — deferred). NOT yet deployed.

**App (dark by construction):**
- `app/lib/streamlane/` — `stream_lane.dart.dark` (StreamVideo client bootstrap, tokenLoader → `/api/stream-video/token`, per-account scoped credential persistence, incoming-call listener), `stream_call_service.dart.dark` (place/accept/leave + `stream_lane_*` telemetry incl. `mic_released` on ended), `stream_call_screen.dart.dark` + `stream_incoming_screen.dart.dark` (AD.*/Phosphor UI mirroring existing design). `.dart.dark` extension = not compiled, not analyzed. All Stream SDK symbols verified/corrected against the SDK source + dogfooding app (GetStream/stream-video-flutter@main); remaining flagged risk: `StreamCallContent` in the video branch would double-render controls — swap to pure `StreamVideoRenderer` grid at activation.
- LIVE but inert: `stream_push_glue.dart` (pure, SDK-free discriminator; push_service.dart fg/bg handlers early-exit ONLY when sender=='stream.video' AND flag on — returns false today, old lane byte-identical), `remote_config.dart` getter, unit test `app/test/streamlane/stream_push_glue_test.dart`.
- DORMANT (commented, marked `STREAM-LANE-ACTIVATE`): pubspec deps `stream_video_flutter`/`stream_video_push_notification` ^1.4.3, `main.dart` StreamLane.init() block, `place_1to1_call.dart` dial delegation block.

**Why dormant, not live-but-flagged:** `stream_webrtc_flutter` (io.getstream:stream-video-webrtc-android 145.x) and `flutter_webrtc` (io.github.webrtc-sdk:android 144.x) both ship the `org.webrtc.*` namespace + same native .so — linking both into one APK is a probable duplicate-class/symbol failure. Verify in a throwaway CI branch; the clean path is retiring `flutter_webrtc` (P4) or testing coexistence first.

**ACTIVATION CHECKLIST (mechanical):**
1. Stream Dashboard: create app, upload FCM service-account JSON as push provider named `avatok-fcm` (must match `stream_lane.dart`), enable missed-call template. Set `STREAM_VIDEO_API_KEY/SECRET` (already bound) if rotating.
2. Throwaway CI branch: uncomment the 2 pubspec lines only → does the Android build link? If not, WebRTC coexistence blocks activation until `flutter_webrtc` is retired.
3. Rename `app/lib/streamlane/*.dart.dark` → `.dart`; uncomment the `STREAM-LANE-ACTIVATE` blocks in `main.dart` + `place_1to1_call.dart`; implement the SDK background-recovery step in push glue (see its library comment); resolve the `StreamCallContent` double-controls note.
4. Write real `success[]` assertions into `tool/ship_manifest.json` STREAM-LANE-1 (events exist in `stream_call_service.dart`), deploy worker, flip `streamCallsEnabled` for testers only, two-phone verify per ship-gate.
**REVERT = flip `streamCallsEnabled` off.** Old lane was never modified.

---

Sources: PostHog project 139917 (events, 2026-08-07→21); repo inventory 2026-08-21; getstream.io Flutter + server API docs (fetched 2026-08-21; append `.md` to any docs URL for clean markdown).
