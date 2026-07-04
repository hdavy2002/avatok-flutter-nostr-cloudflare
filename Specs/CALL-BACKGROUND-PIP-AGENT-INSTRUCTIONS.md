# Multi-Agent Fan-Out Instructions — Background Calls + PiP + Audio Pill

**Companion to:** `Specs/CALL-BACKGROUND-PIP-PLAN.md` (the plan — every agent MUST read it first).
**Date:** 2026-07-04. **Orchestrator:** paste Section 2 to spawn agents; per-agent prompts in Section 3 are self-contained and copy-paste ready.

---

## 1. Orchestration rules (for the coordinating AI)

- **Wave 1 (start immediately, in parallel):** Agent A (CallSession extraction), Agent B (Android FGS/notification), Agent D-server (CallRoom DO grace period).
- **Wave 2 (start ONLY after Agent A commits its final `[CALL-BG-A*]` commit):** Agent C (PiP + pill), Agent D-client (reconnect), Agent E (Gemini Live parity).
- **Wave 3 (after all of Wave 2):** Agent F (QA + review evidence).
- Model assignment (owner rule — conserve Fable credits): A and C → **Opus 4.8**; B, D, E → **Sonnet**; F → **Haiku**.
- Each agent works ONLY in its listed files. If an agent believes it must touch another agent's file, it STOPS and reports back instead of editing.
- Agent A must publish the `CallSession` public API (a short `Specs/CALL-SESSION-API.md`) as its FIRST commit so C/D/E can code against the interface while A finishes internals.
- On completion each agent reports: commits made (hashes + messages), files touched, acceptance criteria met/unmet, anything deferred.
- Orchestrator merges nothing and pushes nothing. All commits stay local. The owner triggers the CI build.

## 2. Shared contract — PREPEND to every agent prompt

```
CONTEXT
You are working in the repo /Users/davy/Documents/websites/avaTOK-2-Flutter (Flutter app in app/,
Cloudflare Worker in worker/). Read these files BEFORE writing any code:
1. CLAUDE.md (repo rules — binding)
2. Specs/CALL-BACKGROUND-PIP-PLAN.md (the plan; your workstream is defined there)
3. app/lib/features/avatok/call_screen.dart (the current 1:1 P2P call — study the header
   comments at lines 33–108: the phantom-busy and call-glare protections are hard-won bug
   fixes and MUST NOT regress)

HARD RULES (violations = task failure)
- NO local builds or analysis: never run flutter build / flutter analyze / npm build. CI builds on merge.
- Commit locally only. NEVER git push. Never disable the pre-push hook.
- All commits via the wrapper WITH explicit paths (never raw git add/commit, never git add -A):
  python3 scripts/git_safe_commit.py "[<ISSUE-ID>] <summary>" <path1> <path2> ...
- One issue per commit; message starts with your issue prefix (given below).
- Per-account scoping is MANDATORY for any new persisted local state: use scopedKey()/readScoped()
  (app/lib/core/account_storage.dart) or a per-account subdir via AccountScope.id.
- Do NOT re-introduce Nostr anything. Do NOT touch the CallRoom 2-peer cap.
- Telemetry: add PostHog events for your new code paths; include the user's email property;
  never remove existing events.
- Design system: any new UI uses the Zine components/tokens (app/lib/core/ui/zine*.dart).
- If blocked or if the code contradicts the plan, STOP and report; do not improvise architecture.

WHEN DONE
Report: commit hashes+messages, files touched, acceptance criteria status, deferred items.
```

---

## 3. Per-agent prompts

### Agent A — `[CALL-BG-A#]` — Extract CallSession (Opus 4.8, Wave 1, CRITICAL PATH)

```
TASK: Workstream WS-A of Specs/CALL-BACKGROUND-PIP-PLAN.md. Extract all call state/logic out of
the CallScreen widget into an app-level singleton so a 1:1 P2P call survives navigation and
backgrounding.

BUILD
1. app/lib/core/calls/call_session.dart — CallSession class owning: RTCPeerConnection, the
   signaling WebSocket to the CallRoom DO, local/remote MediaStreams, RTCVideoRenderers,
   mute/speaker/camera state, call timer, ringback, CallKit sync, foreground-service start/stop,
   telemetry. Expose ValueNotifier<CallPhase> {dialing, ringing, connecting, connected,
   reconnecting, ended} and ValueNotifier<bool> minimized. All teardown goes through
   hangup(String reason) — the ONLY method that destroys resources.
2. app/lib/core/calls/call_session_manager.dart — singleton, WidgetsBindingObserver, holds
   ValueListenable<CallSession?> active. On AppLifecycleState.paused with an active session:
   ensure the FGS is running and keep the WS alive (do NOT stop video capture). On account
   switch, clearCallState() must call manager.destroyAll().
3. Gut app/lib/features/avatok/call_screen.dart into a pure view: initState attaches to (or asks
   the manager to create) a session; dispose() ONLY detaches listeners — it must not close the
   WS, PC, renderers, or stop the FGS. Move the logic currently in _end() and around lines 758
   (FGS start) and 1272 (FGS stop) into CallSession.
4. Keep gInCall / gActiveCallId / gLiveCallScreens / callIsGenuinelyActive() / the glare globals
   (gOutgoingCallTo etc.) working as thin shims delegating to the manager — the push handler and
   busy auto-reply depend on them.
5. Wire every existing end path through hangup(): red button, peer-left, no-answer timeout,
   busy, CallKit end, account switch.
6. Register the manager in app/lib/main.dart.
7. Telemetry events: call_session_extracted (once per call), call_bg_survived (app resumed with
   call still connected), call_restored.

FIRST COMMIT: Specs/CALL-SESSION-API.md documenting the public API of CallSession +
CallSessionManager (class/field/method signatures + phase semantics) so parallel agents can code
against it. Commit as [CALL-BG-A0].

DO NOT: build any PiP/overlay UI (Agent C), change the Android notification (Agent B), add
reconnect logic beyond today's behavior (Agent D), or touch the Gemini Live files (Agent E).

FILES: app/lib/core/calls/* (new), app/lib/features/avatok/call_screen.dart, app/lib/main.dart,
Specs/CALL-SESSION-API.md. Nothing else.

ACCEPTANCE: a full-screen call behaves exactly as today; all hangup paths work; navigating away
no longer destroys the session (screen detach ≠ teardown); no phantom-busy regression.
```

### Agent B — `[CALL-BG-B#]` — Android FGS + ongoing-call notification (Sonnet, Wave 1)

```
TASK: Workstream WS-B of Specs/CALL-BACKGROUND-PIP-PLAN.md. Make Android keep the call alive in
background with a proper ongoing-call notification — this is the Google Play review evidence.

BUILD (native side is yours; final Dart call-site wiring may land after Agent A — code the Dart
hooks in app/lib/core/voice/native_voice_audio.dart and document the two calls Agent A must make)
1. Start timing: the FGS must start at CALL SETUP (outgoing dial placed / incoming call accepted),
   not on P2P connect. Today it starts at call_screen.dart:758 — expose
   NativeVoiceAudio.startCallForegroundService(callId, peerName, isVideo) and note in
   Specs/CALL-SESSION-API.md (append a "WS-B integration" section) that CallSession.start() must
   call it and CallSession.hangup() must stop it.
2. Upgrade CallForegroundService.kt notification: CATEGORY_CALL, setOngoing(true),
   setUsesChronometer(true) with call start time, peer name, a "Hang up" action (the intent
   plumbing partially exists at line 83 — finish it: service → AvaVoiceAudioPlugin method-channel
   event → Dart callback onNotificationHangup, which Agent A wires to hangup()).
3. Notification tap: launch MainActivity with extras {callId, from:"call_notification"}; add
   intent handling so Dart can route back to the active call screen (emit via the same method
   channel: onNotificationTapReturnToCall(callId)).
4. Video: add FOREGROUND_SERVICE_CAMERA permission and camera to the service's
   foregroundServiceType in AndroidManifest.xml; pass isVideo through so ServiceCompat.startForeground
   uses phoneCall|microphone(|camera) correctly on Android 14+.
5. Verify android:stopWithTask is false for the service.
6. Telemetry: call_fgs_started {isVideo, at:"dial"|"accept"}, call_fgs_stopped {reason},
   call_notification_hangup, call_notification_tap.

FILES: app/android/app/src/main/kotlin/ai/avatok/avavoiceaudio/CallForegroundService.kt,
AvaVoiceAudioPlugin.kt, app/android/app/src/main/AndroidManifest.xml, MainActivity (same kotlin
dir), app/lib/core/voice/native_voice_audio.dart, Specs/CALL-SESSION-API.md (append only).

ACCEPTANCE (device test done by Agent F; your bar is code-complete + documented): FGS starts on
dial/accept with correct types; notification shows name + running timer + working Hang up; tap
returns to the call; service stops exactly once on hangup.
```

### Agent D-server — `[CALL-RC-D#]` — CallRoom DO grace period (Sonnet, Wave 1)

```
TASK: Server half of Workstream WS-D of Specs/CALL-BACKGROUND-PIP-PLAN.md. Give the CallRoom
Durable Object a reconnect grace window instead of instantly ending calls on WS drop.

BUILD (worker/src — find the CallRoom DO)
1. On webSocketClose/webSocketError for a peer: do NOT send peer-left immediately. Mark the peer
   "away" (persist {uid, callId, awaySince} in DO storage), notify the other peer with a new
   message type {type:"peer-away"}, and set a DO alarm for 30 s.
2. If the SAME peer (same auth uid + callId) re-attaches within the window: cancel/ignore the
   alarm, send {type:"peer-rejoined"} to the other peer, and replay any buffered signaling
   messages (buffer ICE candidates/offers addressed to the away peer, cap 100, drop oldest).
3. Alarm fires with peer still away → send peer-left and close the room (today's behavior).
4. An explicit hangup message still ends the call immediately for both — no grace.
5. Keepalive: enable WebSocket auto-response ping/pong (state.setWebSocketAutoResponse) so
   hibernated sockets answer client pings without waking the DO.
6. Backward compatible: old clients that never reconnect see identical behavior 30 s later.
   Do NOT touch the 2-peer cap or the conference/LiveKit routes.
7. Commit only — do NOT deploy. The owner deploys.

FILES: worker/src/** (CallRoom DO + its message types only).

ACCEPTANCE: unit-reasoned message flow documented in the commit message; peer-away/peer-rejoined/
peer-left semantics exactly as above; explicit hangup unaffected.
```

### Agent C — `[CALL-PIP-C#]` — Draggable video PiP + green audio pill (Opus 4.8, Wave 2 — after A)

```
TASK: Workstream WS-C of Specs/CALL-BACKGROUND-PIP-PLAN.md. In-app minimize: video calls shrink
to a draggable floating thumbnail; audio calls show a persistent green pill. Read
Specs/CALL-SESSION-API.md and code strictly against CallSessionManager/CallSession.

BUILD
1. Global overlay host: in app/lib/main.dart wrap the MaterialApp navigator (builder:) in a
   Stack; when manager.active != null && session.minimized, render the overlay ABOVE all routes.
   New files: app/lib/core/calls/call_overlay.dart, call_pip_thumbnail.dart, call_audio_pill.dart.
2. Video thumbnail: ~110×180 rounded card showing the remote RTCVideoRenderer (REUSE the
   session's renderer — re-attach srcObject; never create a second renderer or dispose the
   session's). Pan-draggable, snaps to nearest horizontal edge with padding + spring animation,
   avoids status bar/keyboard/safe areas; position kept in-memory for the call's lifetime.
   Tap → session.minimized=false and push the CallScreen route (guard: never two CallScreens —
   check gLiveCallScreens/manager state). Mini controls on the card: mute toggle + red end.
3. Audio pill: slim green bar below the status bar on every screen: green mic icon, "Ongoing
   call · MM:SS" live chronometer from session state, tap = return to call. Hit-test only itself.
   Zine design tokens.
4. Minimize triggers: PopScope on CallScreen (canPop:false; back = set minimized + pop) and an
   explicit minimize (⌄) button in the call header. Verify CallScreen.dispose() disposes NO
   session resources (Agent A guarantees; if violated, STOP and report).
5. "Reconnecting…" visual state on both thumbnail and pill when phase == reconnecting.
6. Telemetry: call_minimized {video}, call_pip_dragged, call_restored {from:"pip"|"pill"|"notification"}.

FILES: app/lib/core/calls/call_overlay.dart|call_pip_thumbnail.dart|call_audio_pill.dart (new),
app/lib/main.dart (overlay host only), app/lib/features/avatok/call_screen.dart (PopScope +
minimize button only).

ACCEPTANCE: back during video call → floating thumbnail over any screen, drag+snap smooth, chat
usable while call audio continues, tap restores full screen instantly; audio call → pill with
live timer on every screen; end button works from the thumbnail.
```

### Agent D-client — `[CALL-RC-D#]` — Client reconnect + ICE restart (Sonnet, Wave 2 — after A)

```
TASK: Client half of Workstream WS-D of Specs/CALL-BACKGROUND-PIP-PLAN.md. Survive ≤30 s network/
lifecycle blips. Read Specs/CALL-SESSION-API.md; all work goes inside CallSession.

BUILD
1. Reconnect state machine in app/lib/core/calls/call_session.dart: on signaling-WS drop while
   phase==connected → phase=reconnecting; retry connect at 0.5/1/2/4/8/… s up to 30 s total; on
   re-attach handle {type:"peer-rejoined"} and buffered messages (server sends peer-away/
   peer-rejoined — see Agent D-server's commit for exact types).
2. ICE restart on rejoin: the designated offerer (keep the existing offerer rule from the old
   call_screen logic) calls createOffer({iceRestart:true}) and re-signals; answerer responds.
3. 15 s client ping over the signaling WS (matches the DO auto-response).
4. Give-up path: 30 s elapsed → hangup("reconnect_failed").
5. Handle peer-away → show phase info the UI can render ("Peer reconnecting…" — expose a
   peerAway flag; Agent C renders it if landed, else no-op).
6. Telemetry: call_reconnect_start, call_reconnect_ok {ms}, call_reconnect_fail.

FILES: app/lib/core/calls/call_session.dart (+ call_session_manager.dart if needed). Nothing else.

ACCEPTANCE: logic handles WS drop mid-call with exponential retry + ICE restart; explicit hangup
paths untouched; no timers left running after hangup.
```

### Agent E — `[CALL-GLIVE-E#]` — Gemini Live voice-call parity (Sonnet, Wave 2 — after A)

```
TASK: Workstream WS-E of Specs/CALL-BACKGROUND-PIP-PLAN.md. Make the Gemini Live "call Ava"
feature survive navigation + backgrounding using the same infrastructure.

BUILD
1. Move ownership of the Gemini WS/session out of VoiceCallScreenState
   (app/lib/features/avachat/voice_call/voice_call_screen.dart) and LiveVoiceController's
   screen-tied lifecycle (live_voice_controller.dart — dispose() closes _ws around line 540).
   Register the live session with CallSessionManager as a session variant (audio-only) so the
   SAME audio pill and FGS notification apply. Follow Specs/CALL-SESSION-API.md.
2. Start/stop CallForegroundService around the Gemini session (peerName "Ava", isVideo:false)
   via NativeVoiceAudio.
3. Set native communication audio mode for the session via AvaVoiceAudioPlugin (the P2P path
   already does this — mirror it) instead of only Helper.setSpeakerphoneOn.
4. PopScope on the voice call screen: back = minimize (pill appears), not end. dispose() only
   detaches.
5. Fix the reconnect guard: _disposed must not block reconnection when the session is merely
   minimized/backgrounded.
6. Telemetry: glive_bg_survived, glive_minimized, glive_restored.

FILES: app/lib/features/avachat/voice_call/voice_call_screen.dart, live_voice_controller.dart,
plus a small session-variant class under app/lib/core/calls/ if needed (do not modify Agent A's
classes — extend/implement).

ACCEPTANCE: talk to Ava → back to home tab → conversation continues with pill visible; app
backgrounded → audio continues + FGS notification shown; ending from pill/notification works.
```

### Agent F — `[CALL-QA-F#]` — Verification + Google review evidence (Haiku, Wave 3)

```
TASK: Workstream WS-F of Specs/CALL-BACKGROUND-PIP-PLAN.md. Verify everything and produce the
Google Play review evidence pack. No production code changes.

BUILD
1. Specs/CALL-BG-TEST-MATRIX.md — step-by-step manual tests for a physical Android device:
   audio call backgrounded; video call backgrounded; backgrounded WHILE RINGING; in-app
   navigation during audio and video (pill/thumbnail); drag+snap; airplane-mode 5 s (recovers)
   and 40 s (clean peer-left); hangup from notification; notification tap return; account switch
   mid-call; second incoming call while minimized (busy auto-reply must still fire); screen off
   5 min; Gemini Live variants. Each test: steps, expected result, telemetry event to verify.
2. Specs/GOOGLE-REVIEW-CALL-EVIDENCE.md — the exact recording script for the reviewer clip:
   start call → press home → show ongoing-call notification + Android green mic indicator +
   audible two-way audio → tap notification to return. Include what to narrate/show on screen.
3. Static verification pass over all [CALL-*] commits: every new persisted key uses per-account
   scoping; no git push occurred; each commit is single-issue with correct prefix; hangup() is
   the only teardown path; no leftover timers. Report discrepancies — do not fix other agents' code.
4. Confirm the new PostHog events exist in code and list them; note that a dashboard tile for
   call_bg_survived should be added after first device run.

FILES: Specs/CALL-BG-TEST-MATRIX.md, Specs/GOOGLE-REVIEW-CALL-EVIDENCE.md (new only).
```

---

## 4. Success definition (whole effort)

Google reviewer clip is recordable: call stays connected with working mic when backgrounded,
ongoing notification visible. In-app: video → draggable thumbnail, audio → green pill, back
never hangs up, ≤30 s blips auto-recover. No regression to busy/glare handling. All commits
local, prefixed, single-issue.
