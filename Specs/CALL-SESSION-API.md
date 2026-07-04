# CALL-SESSION-API — public surface of `CallSession` + `CallSessionManager`

**Owner:** WS-A (Agent A, `[CALL-BG-A#]`). **Status:** authoritative for Wave 2 agents
(C = PiP/pill, D-client = reconnect, E = Gemini parity). This documents the SEAMS that
Wave 2 codes against. If the code diverges from this doc, the code is the bug — tell A.

**Context:** the 1:1 P2P call logic that used to live inside `_CallScreenState`
(`app/lib/features/avatok/call_screen.dart`) is extracted into an app-level singleton so a
call survives in-app navigation and backgrounding. `CallScreen` is now a **pure view** over
a `CallSession`; the session is the one true owner of PC / WS / renderers / timers / FGS.

---

## Files

- `app/lib/core/calls/call_session.dart` — `CallSession`, `CallSessionConfig`, `CallPhase`.
- `app/lib/core/calls/call_session_manager.dart` — `CallSessionManager` singleton + observer.
- `app/lib/features/avatok/call_screen.dart` — view only + legacy global shims (unchanged
  constructor signature, so the 7 launch sites need no edits).
- `app/lib/main.dart` — registers the manager as a `WidgetsBindingObserver`.

---

## `CallPhase` (enum)

Drives all UI. Exposed via `ValueNotifier<CallPhase> CallSession.phase`.

```
enum CallPhase { dialing, ringing, connecting, connected, reconnecting, ended }
```

Phase semantics (what each means to a view):

| phase        | meaning                                                             | who sets it |
|--------------|--------------------------------------------------------------------|-------------|
| `dialing`    | outgoing call, media acquired, placing the call (pre-ring)         | session start |
| `ringing`    | outgoing, waiting for the callee to answer (ringback playing)      | session start (outgoing) |
| `connecting` | incoming call being set up, or offer/answer in flight              | session start (incoming) |
| `connected`  | first remote track arrived; P2P media is live                      | onTrack |
| `reconnecting` | signaling WS dropped / transport blip; recovering (WS-D owns the machine; today it's a transient label, cleared back to `connected` on recovery) | WS-D |
| `ended`      | teardown complete (any reason). Terminal.                          | `hangup()` |

**Ava-receptionist sub-states** are NOT in `CallPhase` — they are a separate legacy string
`ValueNotifier<String> CallSession.uiPhase` (values: `ringing`, `connecting`, `connected`,
`declined`, `busy`, `no-answer`, `ava-countdown`, `receptionist-connecting`, `receptionist`,
`receptionist-wrapup`, `ended`, …). The view reads `uiPhase` for its status label/sticker
exactly as `_phase` did before. `phase` (the enum) is the COARSE lifecycle for C/D/E; `uiPhase`
is the FINE-GRAINED label for the full-screen view. Both are kept in sync by the session.

> Wave 2 rule of thumb: PiP/pill (C) and reconnect (D) key off the **enum** `phase`.
> Only the full call view needs `uiPhase`.

---

## `CallSessionConfig` (immutable)

Mirrors the old `CallScreen` widget fields verbatim, so the session is constructed from the
same inputs the 7 launch sites already pass.

```dart
class CallSessionConfig {
  final String room;        // signaling room id == call id (gActiveCallId)
  final String title;       // peer display name
  final String seed;        // peer uid/seed (address the server resolves)
  final bool video;         // video call vs audio
  final bool outgoing;      // caller (ringback + no-answer timeout) vs callee
  final String avatarUrl;   // peer photo ('' = initials)
  final String ringbackUrl; // callee's ringtone, played caller-side while ringing
  final String? teamId;     // Team IVR warm-transfer tag (null for ordinary 1:1)
  final int? teamSlot;
  const CallSessionConfig({required this.room, required this.title, required this.seed,
    required this.video, this.outgoing = true, this.avatarUrl = '', this.ringbackUrl = '',
    this.teamId, this.teamSlot});
}
```

---

## `CallSession`

The one true owner. **`hangup(reason)` is the ONLY method that destroys resources.**
A view attaching/detaching must NEVER close the WS/PC/renderers or stop the FGS.

### Construction / identity
- `CallSession(this.config)` — created by the manager only. Callers use
  `CallSessionManager.instance.attach(config)`, never `new CallSession(...)` directly.
- `final CallSessionConfig config;`
- `String get room => config.room;`  · `bool get video => config.video;` · `bool get outgoing`

### Renderers (owned; survive view detach — do NOT dispose in a view)
- `final RTCVideoRenderer localRenderer;`
- `final RTCVideoRenderer remoteRenderer;`
  Initialized in `start()`; disposed only in `hangup()`. C reuses THESE renderers for the PiP
  thumbnail (re-attach in a second `RTCVideoView`, do not construct a third renderer).

### Notifiers (listen; never dispose from a view)
- `final ValueNotifier<CallPhase> phase;`            // coarse lifecycle (C/D/E)
- `final ValueNotifier<String> uiPhase;`             // fine-grained label (full view)
- `final ValueNotifier<bool> minimized;`             // true when shown as PiP/pill (C sets it)
- `final ValueNotifier<int> elapsedSeconds;`         // call timer, 1 Hz once connected
- `final ValueNotifier<bool> muted;`
- `final ValueNotifier<bool> speakerOn;`
- `final ValueNotifier<bool> cameraOn;`
- `final ValueNotifier<bool> videoActive;`           // audio→video upgrade flips this true
- `final ValueNotifier<bool> onCellularHold;`        // GSM call interrupt banner
- `final ValueNotifier<bool> peerAway;`              // SEAM for D/C: true while the peer's
      // signaling socket is gone but media may still flow (today: set on `peer-left`, cleared
      // on reconnect/`welcome`; drives the "Reconnecting…"/peer-away hint). Placeholder value
      // in A — D wires the grace-period semantics.
- `ReceptionistCall? get receptionist;`              // non-null while Ava is on the line
- `String get myName; String get myAvatar; String get mySeed;` // for the receptionist duo UI

### Lifecycle
- `Future<void> start();`
  Idempotent (guarded so re-attach can't re-run it). Acquires mic/cam, opens the signaling WS,
  starts timers/ringback, sets `gInCall`/`gActiveCallId`/glare globals, starts the FGS at call
  SETUP (not on connect — WS-B moves it here). Fires `call_session_extracted` once.
- `Future<void> hangup(String reason);`
  **The single teardown path.** Idempotent. Sends `bye` + durable `ended` status, ends CallKit,
  stops FGS/audio modes/wakelock, cancels timers, stops tracks, closes PC + WS, drops renderer
  srcObjects, disposes the MediaStream, disposes renderers, updates the globals, emits final
  telemetry. Sets `phase = ended`. Every end path (red button, peer-left bye, no-answer, busy,
  CallKit end, account switch, RTC-failed) routes through here with a taxonomy reason:
  `local-hangup | remote-bye | peer-left | decline | busy | socket-lost | rtc-failed |
  rtc-disconnected | timeout-ringing | glare-yield | remote-ended-push | media-denied |
  place-call-timeout | receptionist-done | account-switch`.
- `bool get isEnded;`

### View-facing controls (the red/mute/speaker/camera buttons call these)
- `void toggleMute();`
- `void toggleSpeaker();`
- `void toggleCamera();`   // also performs the audio→video upgrade + renegotiation
- `Future<void> endByUser();` // red button / notification "Hang up" → `hangup('local-hangup')`
  + navigation cleanup (pops the route if mounted via the manager).

### View attach/detach (called by `CallScreen` and by C's PiP)
- The **view does not own the session**. `CallScreen.initState` gets the session from the
  manager; `dispose()` only removes its own listeners. There is nothing to call on the session
  at detach — detaching a view MUST NOT touch session resources.

### CallKit / notification hang-up seam (WS-B)
- WS-B's native "Hang up" action / launch intent routes to
  `CallSessionManager.instance.hangupActive('local-hangup')` (see below). The session exposes
  `endByUser()` for the in-app red button; both converge on `hangup()`.

---

## `CallSessionManager`

App-level singleton and `WidgetsBindingObserver` (registered in `main.dart`).

### Access
- `static final CallSessionManager instance = CallSessionManager._();`
- `final ValueListenable<CallSession?> active;`  // current session or null (C/D listen to this)
- `CallSession? get current => active.value;`

### Session lifecycle
- `CallSession attach(CallSessionConfig config);`
  Called from `CallScreen.initState`. If a session for `config.room` already exists (re-entry
  after minimize→reopen), returns it WITHOUT restarting. Otherwise creates one, sets it
  `active`, calls `start()`, returns it. This is the ONLY way a `CallSession` is created.
- `Future<void> hangupActive(String reason);`   // ends `current` via `hangup(reason)`; safe if null
- `Future<void> destroyAll();`
  Ends every live session (there is at most one 1:1 today) via `hangup('account-switch')` and
  clears `active`. `clearCallState()` (account switch / logout) calls this.

### Lifecycle observer (backgrounding survival)
- `void didChangeAppLifecycleState(AppLifecycleState state)`:
  - `paused` with an active session → ensure the FGS is running and keep the WS alive; do NOT
    stop video capture, do NOT tear down. Fires `call_bg_survived` on the next `resumed` if the
    call is still `connected` (tracked via a "was backgrounded while connected" flag).
  - `resumed` → re-sync UI (renderers already hold their streams). Fires `call_restored`.

### Legacy global shims (kept in `call_screen.dart`, unchanged for callers)
These stay as top-level symbols exported from `call_screen.dart` so `push_service.dart`,
`chat_thread.dart`, `account_switcher.dart` need NO edits. They remain the busy/glare source of
truth and are driven by the session's start/hangup exactly as before:
`gInCall`, `gActiveCallId`, `gInCallSince`, `gLiveCallScreens`, `callIsGenuinelyActive()`,
`gOutgoingCallTo`, `gOutgoingCallId`, `gOutgoingSince`, `hasPendingOutgoingTo(peer)`,
`clearCallState()` (now delegates to `CallSessionManager.instance.destroyAll()` + resets globals).
`gIncomingRingingFrom` / `gIncomingRingingCallId` remain declared in `push_service.dart`
(unchanged). **Phantom-busy / glare protections (call_screen.dart:33–108) are preserved
verbatim** — `gLiveCallScreens` is still the ground truth, incremented when a session starts and
decremented in `hangup()`.

---

## Telemetry events added by WS-A (all carry the user email via the Analytics envelope)
- `call_session_extracted` — once per call, at `start()` (proves the new path ran).
- `call_bg_survived` — app resumed with the call still `connected` after a background stint.
- `call_restored` — call view / UI re-synced on resume.
- (`call_minimized`, `call_reconnect_{start,ok,fail}` are owned by C and D respectively.)

## What Wave 2 must NOT do
- C/D/E must never call `start()`, close the WS/PC, or dispose the renderers — only `hangup()`
  (via `hangupActive`) tears down. Reuse `localRenderer`/`remoteRenderer`. Key off `phase`
  (enum) + `minimized` + `peerAway`. Do not touch the CallRoom 2-peer cap or re-introduce Nostr.
