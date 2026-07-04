# Background Calls + Draggable PiP + Audio-Call Banner — Implementation Plan

**Date:** 2026-07-04 · **Owner decision:** professional in-call multitasking (WhatsApp/Telegram parity)
**Driver:** Google Play review evidence — "start a call, background the app, show the call still connected with mic working (ongoing-call notification visible)". Today the call DIES on background AND on any in-app navigation.

---

## 0. Diagnosis (verified in code — do not re-litigate)

The 1:1 P2P call (`app/lib/features/avatok/call_screen.dart`, 1703 lines) owns EVERYTHING in
widget state: RTCPeerConnection, signaling WebSocket to the CallRoom DO, renderers, timers,
`gLiveCallScreens` counter. Consequences:

1. **In-app navigation kills the call.** No `PopScope`; back / navigating pops the screen →
   `dispose()`/`_end()` tears down PC + WS + stops the foreground service (`call_screen.dart:1272`).
2. **Backgrounding kills the call (pre-connect) and is fragile (post-connect).** The
   foreground service is started only AFTER P2P connects (`call_screen.dart:758`), so a call
   backgrounded while ringing/connecting has no FGS and the OS can kill the process. No
   `didChangeAppLifecycleState` handling for active calls.
3. **Server has zero grace.** `worker/src` CallRoom DO sends `peer-left` to the other peer the
   instant a client WS drops — a 2-second network/lifecycle blip ends the call for both sides.
4. **Gemini Live voice call** (`app/lib/features/avachat/voice_call/voice_call_screen.dart` +
   `live_voice_controller.dart`) has the same disease worse: WS owned by screen state, closed in
   `dispose()` (`live_voice_controller.dart:~540`), never starts the FGS, never sets
   `MODE_IN_COMMUNICATION`, reconnect refuses when `_disposed`.
5. **What already exists (reuse, don't rebuild):** `CallForegroundService.kt` +
   `AvaVoiceAudioPlugin.kt` (`startCallForegroundService`/`stopCallForegroundService`),
   manifest already declares `foregroundServiceType="phoneCall|microphone"` + the three
   FOREGROUND_SERVICE permissions (`AndroidManifest.xml:32-34,118`), `flutter_callkit_incoming`,
   `wakelock_plus`, `NativeVoiceAudio` bridge (`app/lib/core/voice/native_voice_audio.dart:146-160`).

**Note:** Android 12+ shows the green mic dot / status-bar indicator automatically whenever the
mic is recording — including from our FGS in background. We do NOT (and cannot) draw our own
status-bar icon; keeping the mic alive via the FGS is what makes the OS show it. In-app, we add
our own green "ongoing call" pill (Workstream C).

---

## 1. Target behavior

- Start audio or video call → navigate anywhere in the app → call continues. Video shrinks to a
  **draggable floating thumbnail** (snap to edges, tap = return to full call screen, shows remote
  video + mute/end mini-controls). Audio call shows a **green ongoing-call pill/banner** pinned at
  the top of every screen (elapsed time, tap = return, green mic glyph).
- Home button / app switcher → call continues; **ongoing-call notification** (peer name, timer,
  Hang up action, tap = reopen call screen). Android shows its own green mic indicator.
- Back gesture on the call screen = **minimize, not hang up**. Only the red end button (or
  notification Hang up, or peer hangup, or 30 s reconnect failure) ends a call.
- Network/lifecycle blips ≤30 s auto-reconnect (signaling WS re-attach + ICE restart) with a
  "Reconnecting…" state instead of instant death.

---

## 2. Architecture: extract `CallSession` (the one true owner)

New `app/lib/core/calls/call_session.dart` (+ `call_session_manager.dart`):

- `CallSessionManager` — app-level singleton (create in `main.dart`, expose via a
  `ValueListenable<CallSession?> active`). Absorbs the `gInCall`/`gLiveCallScreens`/glare globals
  as its API (keep thin legacy shims so push/busy logic keeps working: `callIsGenuinelyActive()`
  → `manager.active != null`).
- `CallSession` owns: RTCPeerConnection, signaling WS, local/remote `MediaStream`s, renderers,
  mute/speaker/camera state, call timer, telemetry, ringback, CallKit sync, FGS start/stop,
  reconnect state machine. Exposes `ValueNotifier<CallPhase>` (dialing / ringing / connecting /
  connected / reconnecting / ended) and `minimized` flag.
- `CallScreen` becomes a **pure view** over the session: `initState` attaches (or creates) the
  session; `dispose()` only DETACHES — never tears down. `_end()` logic moves into
  `CallSession.hangup()`.
- **Lifecycle:** `CallSessionManager` is a `WidgetsBindingObserver`. On `paused` with an active
  session: ensure FGS is running, keep WS alive, disable local video capture is NOT done (video
  keeps flowing so reviewer sees it), just no renderer painting. On `resumed`: re-sync UI.
- **Per-account:** on account switch, `clearCallState()` → `manager.destroyAll()`.

This workstream is the backbone — everything else depends on it.

---

## 3. Workstreams (parallel-friendly)

### WS-A — `CallSession` extraction (Opus — hard; BLOCKS C & D-client & E)
Files: `app/lib/core/calls/call_session.dart` (new), `call_session_manager.dart` (new),
`app/lib/features/avatok/call_screen.dart` (gut to view), `app/lib/main.dart` (register observer).
Steps:
1. Move all non-UI state/logic out of `_CallScreenState` into `CallSession` verbatim first
   (mechanical), keep behavior identical, screen subscribes via listeners.
2. Replace `dispose()` teardown with detach; route every existing teardown path through
   `CallSession.hangup(reason)` (peer-left, no-answer timeout, busy, CallKit end, notification
   Hang up via method-channel callback).
3. Keep `gActiveCallId`/glare shims delegating to the manager (push handler + busy auto-reply
   must not regress — see `call_screen.dart:33-108` comments; those bugs were painful).
4. Telemetry: add `call_session_extracted`, `call_bg_survived`, `call_minimized`,
   `call_restored`, `call_reconnect_{start,ok,fail}` events (PostHog, include user email).
Acceptance: full-screen call behaves exactly as today; hangup paths all work; no phantom-busy.

### WS-B — Android background survival + ongoing notification (Sonnet — medium; independent)
Files: `CallForegroundService.kt`, `AvaVoiceAudioPlugin.kt`, `AndroidManifest.xml`,
`native_voice_audio.dart`, call-start sites.
1. Start FGS at **call setup** (outgoing dial + incoming accept), not on P2P connect. Move the
   `call_screen.dart:758` call earlier (into `CallSession.start()`); stop only in `hangup()`.
2. Upgrade the notification: `CATEGORY_CALL`, chronometer (`setUsesChronometer`), peer name +
   avatar (optional), **Hang up** action (already partially there at `CallForegroundService.kt:83`
   — wire it through the method channel to `CallSession.hangup()`), `setOngoing(true)`,
   full-screen-intent NOT needed here. Tap → launch MainActivity with `callId` extra → Dart
   routes back to the active call screen (add a launch-intent handler in `MainActivity`/push
   bootstrap).
3. Video calls: add `FOREGROUND_SERVICE_CAMERA` permission + `camera` to
   `foregroundServiceType`, and pass an `isVideo` flag so the service starts with
   `phoneCall|microphone|camera` when video (Android 14 enforces declared types).
4. Add `stopWithTask="false"` review on the service; verify battery-optimization doesn't kill it
   (FGS with phoneCall type is safe).
5. iOS (when it ships): `UIBackgroundModes: audio, voip` — file a stub note only; no iOS dir yet.
Acceptance: dial → home screen while RINGING → call connects and audio flows both ways;
notification visible with running timer; tap returns to call; Hang up works; Android green mic
dot visible while backgrounded.

### WS-C — In-app minimize: draggable video PiP + audio pill (Opus — hard; blocked by A)
Files: new `app/lib/core/calls/call_overlay.dart` (+ `call_pip_thumbnail.dart`,
`call_audio_pill.dart`), root widget in `main.dart`.
1. Global overlay host: wrap the app's `Navigator` (builder on `MaterialApp`) in a `Stack`; when
   `manager.active != null && session.minimized`, show the overlay above ALL routes.
2. **Video PiP thumbnail:** ~110×180 rounded card rendering the remote `RTCVideoRenderer`
   (self-view tiny corner inset optional v2). Draggable (`Positioned` + pan gestures), snaps to
   nearest screen edge with padding + spring animation, persists position in-memory per call.
   Tap → `session.minimized=false` + push `CallScreen` (reuse existing route; guard against
   duplicate screens). Long-press or small buttons: mute + end.
3. **Audio pill:** slim green bar (Zine design system — use `core/ui/zine*.dart` tokens) under
   the status bar: green mic icon, "Ongoing call · 03:24" chronometer, tap to return. Must not
   block touches outside itself; must respect safe areas and keyboard.
4. **Minimize triggers:** `PopScope` on `CallScreen` — back = minimize (`canPop:false`,
   set minimized + pop the route). Add an explicit ⌄ minimize button in the call header. Video
   renderers must survive route pop (owned by session, WS-A guarantees this — verify no
   `renderer.dispose()` in screen dispose).
5. Renderer sharing: one `RTCVideoRenderer` reused between full screen and thumbnail (re-attach
   `srcObject`), don't create a second renderer per view.
Acceptance: during video call, back → thumbnail floats over chat list; drag/snap works; open a
chat thread and send a message while call audio continues; tap thumbnail → full screen resumes
instantly. Audio call: pill visible on every screen, timer live.

### WS-D — Reconnect resilience: DO grace period + client ICE restart (Sonnet — medium)
Server (`worker/src` CallRoom DO — deployable via wrangler, but commit-only per repo rules):
1. On WS close: do NOT emit `peer-left` immediately. Mark peer `away`, start a **30 s** alarm
   (`state.storage.setAlarm`); if the same peer (auth uid + callId) re-attaches within the
   window, cancel and emit `peer-rejoined`; else emit `peer-left` + close room. Explicit
   `hangup` message still ends instantly.
2. Buffer signaling messages (ICE candidates) for an away peer, replay on rejoin (cap ~100).
Client (blocked by A):
3. `CallSession` reconnect state machine: WS drop → phase `reconnecting`, exponential retry
   (0.5/1/2/4 s… up to 30 s), on re-attach do ICE restart (`createOffer({iceRestart:true})` from
   the designated offerer). UI shows "Reconnecting…" overlay on both full screen and PiP.
4. Keepalive ping every 15 s over the signaling WS (hibernation-friendly: use DO
   `setWebSocketAutoResponse` if possible).
Acceptance: toggle airplane mode 5 s mid-call → call recovers on both ends; 35 s → clean
peer-left on the other side.

### WS-E — Gemini Live voice call parity (Sonnet — medium; blocked by A pattern, not code)
Files: `voice_call_screen.dart`, `live_voice_controller.dart`.
1. Promote `LiveVoiceController` to a manager-owned session (same pattern as WS-A; it can
   register as a lightweight `CallSession` variant so the SAME pill/notification work).
2. Start/stop `CallForegroundService` around the Gemini session; set native
   `MODE_IN_COMMUNICATION` via `AvaVoiceAudioPlugin` (P2P path already does).
3. PopScope minimize + audio pill reuse from WS-C.
Acceptance: talk to Ava, back out to home tab, keep talking; background app, keep talking.

### WS-F — Verification + Google review evidence pack (Haiku — trivial, last)
1. Manual test matrix (Android 13 + 15 device): audio bg, video bg, ringing bg, in-app nav
   during audio/video, airplane-mode blip, hangup from notification, account switch mid-call,
   second incoming call while minimized (busy auto-reply still fires), doze/screen-off 5 min.
2. Record the Google reviewer clip: start call → home → show ongoing notification + green mic
   indicator + audible two-way audio → tap notification back into call.
3. PostHog: verify new events arrive for hdavy2005@gmail.com; add annotation; dashboard tile on
   `call_bg_survived` rate. Update Graphiti (`group_id="proj_avaflutterapp"`) with the shipped
   architecture.

---

## 4. Sequencing & parallelism

```
WS-A (backbone) ──┬─▶ WS-C (PiP/pill)
                  ├─▶ WS-D client half (reconnect)   WS-D server half: parallel from day 1
                  └─▶ WS-E (Gemini parity)
WS-B (Android FGS/notification): parallel from day 1 (native + thin Dart hook; final wiring lands after A)
WS-F last.
```
Suggested agents: Opus 4.8 ×2 (A then C; A is the critical path), Sonnet ×3 (B, D, E), Haiku (F).

## 5. Repo rules (every agent MUST follow — from CLAUDE.md)

- **No local builds** (`flutter build/analyze` will fail) — CI builds on final merge only.
- **Commit local only, never push.** One issue per commit via the wrapper WITH explicit paths:
  `python3 scripts/git_safe_commit.py "[CALL-BG-A1] extract CallSession" app/lib/core/calls/... app/lib/features/avatok/call_screen.dart`
  Issue prefixes: `[CALL-BG-A#]` `[CALL-BG-B#]` `[CALL-PIP-C#]` `[CALL-RC-D#]` `[CALL-GLIVE-E#]` `[CALL-QA-F#]`.
- **Per-account scoping** for any new persisted state (`scopedKey`/`AccountScope`).
- Preserve the phantom-busy/glare protections documented in `call_screen.dart:33-108`.
- Worker deploy (WS-D) only when the owner asks; wrangler@4 in /tmp with `secrets/cf_token`.
- Telemetry must include user email; add, never remove existing events.

## 6. Explicit non-goals (this phase)

- Android **native system PiP** (`enterPictureInPictureMode` — video floating over OTHER apps /
  home screen). v2 candidate; the FGS + notification satisfies Google's requirement.
- iOS anything (no ios/ dir yet). CallKit incoming-call UX changes. Group SFU/LiveKit conference
  minimize (apply pattern later). Custom status-bar icons (OS-owned).
