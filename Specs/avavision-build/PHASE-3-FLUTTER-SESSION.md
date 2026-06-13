# PHASE 3 — Flutter app: the live Vision Session (camera + overlay + score + Live + snapshot). Parallel.

> Carry `MASTER-PROMPT.md`. You build the split-screen session experience and the on-device vision
> engine for **Android** (iOS is a later track). You own a self-contained `session/` subtree so you do
> not collide with Phase 2. **No commit.**

## Pre-flight checklist (do BEFORE writing code)
- [ ] Read `PHASE-1-WORKER-BACKEND.md` **§A** (the `sessions/start|heartbeat|stop|snapshot` shapes, all
      `snake_case`) and **§B** (idempotency — especially: **`stop` is idempotent**, and the snapshot cap
      returns `429 SNAPSHOT_CAP_REACHED` with no charge).
- [ ] Read `app/lib/features/avavoice/call_screen.dart` and mapped its lifecycle state machine
      (`connecting|live|wrapup|ended|error`), 60s heartbeat loop, and **dispose-safety** (fire-and-forget
      stop on swipe-away). Your screen = this + camera/overlay/snapshot.
- [ ] Found the repo's existing Gemini **Live WebSocket** client + audio engine (live-translation feature
      and/or AvaVoice web Phase E) to reuse — do NOT reinvent audio. Note which one you're copying.
- [ ] Checked how the repo already does camera/native interop (`app/lib/features/avalive/`, conference)
      to pick the platform-channel vs native-PlatformView approach; documented the choice.
- [ ] Confirmed the two public symbols you must export unchanged: `VisionSessionScreen(...)`,
      `VisionPreviewPane(...)` (Phase 2 imports them).

## Idempotency & lifecycle safety (critical for this phase)
- **`sessions/stop` may fire twice** (explicit "End" + dispose/`WidgetsBindingObserver` on swipe-away).
  Fire it fire-and-forget and treat any non-`active` response as "already ended" — the server is
  idempotent (§B), so do not block the UI waiting for it and do not re-settle.
- **Heartbeat**: stop the 60s timer the instant state leaves `live`; a late beat returning
  `{ended:true}` must transition to `ended`, not error.
- **Snapshot**: disable the "Analyze" button while a request is in flight (no double-charge / no double
  count) and when the cap is reached; render `429 SNAPSHOT_CAP_REACHED` as a calm "fair-use cap reached".
- **Saved snapshots** are per-account scoped (`scopedKey`) and **off by default**.

## You own (create/edit ONLY these)
- `app/lib/features/avavision/session/vision_session_screen.dart` (NEW — the split-screen UI + lifecycle)
- `app/lib/features/avavision/session/vision_engine.dart` (NEW — camera → overlay + score + 1fps→Live + mic↔audio)
- `app/lib/features/avavision/session/vision_preview_pane.dart` (NEW — the small studio preview widget Phase 2 imports)
- `app/lib/features/avavision/session/overlay_painters.dart` (NEW — skeleton/mesh/box/mask CustomPainters)
- `app/lib/features/avavision/session/scoring.dart` (NEW — geometry scoring adapters per capability)
- `app/lib/features/avavision/session/pose_channel.dart` (NEW — Dart side of the platform channel)
- `app/android/app/src/main/kotlin/.../avavision/` (NEW — native MediaPipe Tasks + MoveNet TFLite bridge)
- `Specs/avavision-build/glue/PHASE-3-GLUE.md` (NEW — your glue note)

**Do NOT create or edit anything in `app/lib/features/avavision/` outside `session/`** (Phase 2 owns
the rest). You expose exactly two public symbols Phase 2 depends on:
`VisionSessionScreen({required VisionAgent agent, required String language, String? bookingId, String? callId})`
and `VisionPreviewPane({required String capability, required String overlayStyle})`.

## Read first (READ ONLY)
- `app/lib/features/avavoice/call_screen.dart` — **copy the whole session lifecycle**: `sessions/start`
  → 60s heartbeats → `sessions/stop`, countdown, mute, dispose-safety (fire-and-forget stop on
  swipe-away), state machine `connecting|live|wrapup|ended|error`. Your screen is this **plus** camera +
  overlay + snapshot.
- `app/lib/core/avavision_api.dart` (Phase 2's client) — for `sessionStart/heartbeat/stop/snapshot`. If
  Phase 2 isn't merged, define a minimal local interface and note it; Phase Z reconciles.
- `app/lib/core/ui/zine.dart` + `zine_widgets.dart` — tokens/widgets.
- `Specs/PROPOSAL-LIVE-TRANSLATION-GEMINI.md` and any existing live-translation web/Flutter work — the
  closest existing example of a Gemini **Live WebSocket** client in this repo. Reuse its WS framing,
  audio capture/playback, and reconnect logic. Do **not** reinvent the audio engine if one exists.
- `Specs/AVAVISION-PROPOSAL.md` §2, §3.4 — the engine + UI spec.

## Engine policy (master §7) — LOCKED
- `capability=pose` → **MoveNet** (TFLite, 17 keypoints) as the default engine on Android. If the
  template sets `engine_upgrade_android_web=mediapipe_pose`, use **MediaPipe Pose** (33 pts) on Android.
- `hand|gesture|face_detect|object|image_class` → **MediaPipe Tasks** (Android AAR).
- `face_landmark(face_mesh)|segmentation|holistic` → MediaPipe Tasks (Android only; these are `ios:false`).
- `gemini_only` → **no on-device model**; overlay off; the Live stream + snapshot do all the seeing.
- Everything on-device, free, never streamed.

## Build steps

### 1. Native bridge (`app/android/.../avavision/`)
There is **no first-party Flutter MediaPipe plugin** — use a platform channel. On the Kotlin side:
- Add the MediaPipe Tasks Vision AAR dependency and a TFLite (MoveNet) dependency to the app's Gradle
  (note exact lines in the glue note; if you cannot edit `app/android/app/build.gradle` because it is
  effectively shared, put the dependency lines in the glue note for Phase Z and code against the API).
- Implement a channel `avatok/avavision_vision` that accepts a capability + engine + camera frames (or,
  simpler and lower-risk: run the camera + model entirely native in a `PlatformView`/`SurfaceView` and
  stream **only landmarks + score + the downscaled 1fps JPEG** up to Dart). Choose the approach that
  matches how this repo already does camera/native interop (check `app/lib/features/avalive/` and the
  conference feature for precedent) and document the choice.
- Emit per-frame: normalized landmarks (or boxes/mask), the chosen scoring inputs, and at ~1 fps a
  LOW-res JPEG for the Live stream and (on demand) a hi-res JPEG for the snapshot.

### 2. `vision_engine.dart`
The orchestrator. Owns: camera start/stop; subscribing to the native landmark/score stream (30fps) for
the overlay; throttling **1 fps LOW-res** frames into the Gemini Live WS; mic capture → Live, Live
audio → speaker; producing a hi-res frame on "Analyze". Exposes streams the screen renders. Reuse the
Live WS + audio plumbing from the live-translation feature.

### 3. `overlay_painters.dart` + `scoring.dart`
- Painters for each `overlay_style`: `skeleton` (MoveNet 17 / MediaPipe 33), `hand_mesh`, `face_mesh`,
  `bounding_box`, `segmentation_mask`, `none`. Draw with `zine` accent colors over the camera texture.
- `scoring.dart`: geometry adapters per capability (e.g. squat depth from knee/hip angles, posture
  from neck/shoulder line). `scoring_mode=geometry` → compute locally; `gemini_qualitative` → score
  comes from the agent (no local compute, badge shows agent-reported); `hybrid` → show local + let the
  agent comment; `none` → no badge. Push `[SYSTEM: <label> <score>, <hint>]` text events into the Live
  session (master §5) at a sane cadence (e.g. every ~3s, debounced).

### 4. `vision_session_screen.dart`
The split-screen UI (proposal §3.4 / requirement 6):
- main = camera + live overlay + transparent **score badge**;
- thumbnail = agent avatar + voice indicator;
- countdown chip + language chip;
- **"Analyze my form"** button (only if `agenticSnapshotEnabled`) → calls `AvaVisionApi.snapshot`,
  shows the returned annotated image + breakdown in a `zine` bottom sheet; disable the button when the
  `free_snapshots_per_session` cap is reached (friendly "cap reached" state, no surprise charge).
- A **camera-consent sheet** before the camera turns on (rulebook/safety, proposal §6); a persistent
  "the agent can see you" indicator while live.
- Full lifecycle copied from `call_screen.dart` (start/heartbeat/stop/billing/dispose-safety).
- Per-account scoping for any saved snapshot (rulebook #1/#3); saved snapshots OFF by default.

### 5. `vision_preview_pane.dart`
A lightweight widget for the studio (Phase 2 imports it): camera + the chosen overlay only, no Live, no
billing — just so a creator sees the overlay before publishing.

## Glue note (`Specs/avavision-build/glue/PHASE-3-GLUE.md`)
- Any `app/android/app/build.gradle` dependency lines needed (MediaPipe Tasks Vision AAR, TFLite/MoveNet
  model asset) — Phase Z applies; list exact coordinates + where the `.tflite`/`.task` model assets go
  (`app/assets/...`) and the `pubspec.yaml` asset entry (pubspec is shared → glue note).
- Any `pubspec.yaml` package additions (e.g. `camera`, `web_socket_channel` if not present) — glue note.
- The exact public symbols you exported for Phase 2.
- Confirmation of which native-interop approach you used and why.

## Acceptance
- [ ] `session/` files created; `VisionSessionScreen` + `VisionPreviewPane` exported as agreed.
- [ ] Android native bridge runs MoveNet (pose) + MediaPipe Tasks (hand/gesture/face/object/seg);
      overlay + score render at ~30fps; 1fps LOW frames + mic go to Live; "Analyze" hits snapshot.
- [ ] Camera consent + "can see you" indicator + snapshot cap UX present; snapshots off by default.
- [ ] No file outside `session/` (and the native dir) created; pubspec/gradle changes in glue note only.
- [ ] Graphiti episode written. **No commit.**
