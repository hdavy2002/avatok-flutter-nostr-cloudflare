# PHASE-3 GLUE — Flutter live Vision Session + Android MediaPipe/MoveNet bridge

Phase 3 owns `app/lib/features/avavision/session/**` and the Android native
`ai/avatok/avavision/` package. **No commit** (per master rule 2). This note lists
every shared-file change Phase Z must apply, plus the cross-phase contracts relied on.

## Files created (Phase 3, all uncommitted)

Flutter (`app/lib/features/avavision/session/`):
- `vision_session_screen.dart` — split-screen live session UI + full lifecycle.
- `vision_engine.dart` — orchestrator (camera→overlay, 1fps→Live, mic↔audio, snapshot, SYSTEM cues).
- `vision_preview_pane.dart` — `VisionPreviewPane` (studio preview) + `VisionCameraView` (shared native surface).
- `overlay_painters.dart` — CustomPainters: skeleton / hand_mesh / face_mesh / bounding_box / segmentation_mask / none.
- `scoring.dart` — geometry scoring adapters (MoveNet 17 / MediaPipe 33), technique-only (safety §10).
- `pose_channel.dart` — Dart side of the platform channel (MethodChannel + EventChannel + PlatformView viewType).
- `vision_api_stub.dart` — **⚠️ DELETE in Phase Z** (see Reconcile below).

Android (`app/android/app/src/main/kotlin/ai/avatok/avavision/`):
- `AvaVisionPlugin.kt` — FlutterPlugin/ActivityAware; registers the two channels + the PlatformView factory.
- `VisionCameraView.kt` — CameraX `PreviewView` PlatformView; ImageAnalysis → analyzer; 1fps LOW JPEG; hi-res snapshot.
- `VisionAnalyzer.kt` — `VisionResult`/`DetectionBox` + `VisionAnalyzer` interface + `AnalyzerFactory`.
- `MoveNetAnalyzer.kt` — TFLite MoveNet single-pose Lightning (17 kp), default pose engine.
- `MediaPipeAnalyzers.kt` — `MediaPipePoseAnalyzer` (33) + `MediaPipeTasksAnalyzer` (hand/gesture/face/object/seg).

## Interop choice (documented per phase pre-flight)

**Native PlatformView**, not frame-marshalling. The camera + model run entirely
native behind `avatok/avavision_camera` (CameraX `PreviewView`), and only
normalized landmarks/boxes/mask + score inputs (~30fps), a LOW-res JPEG (~1fps,
for Gemini Live), and an on-demand hi-res JPEG (snapshot) cross the channel. This
mirrors how AvaLive runs WebRTC natively (precedent in `app/lib/features/avalive/`)
and honors master §6 "everything on-device, free, never streamed" — the only
bytes that leave the device are the 1fps LOW frame (→ Gemini Live) and a hi-res
frame on "Analyze" (→ Worker `/snapshot`).

## Exported public symbols (Phase 2 depends on these — unchanged)

```dart
// app/lib/features/avavision/session/vision_session_screen.dart
VisionSessionScreen({required VisionAgent agent, required String language,
    String? bookingId, String? callId})

// app/lib/features/avavision/session/vision_preview_pane.dart
VisionPreviewPane({required String capability, required String overlayStyle})
```

## ⚠️ Reconcile with Phase 2 (Phase Z)

Phase 2 owns the canonical `app/lib/core/avavision_api.dart` (`VisionAgent` +
`AvaVisionApi`). Phase 3 compiled in isolation against a local mirror
`session/vision_api_stub.dart`. To reconcile:

1. **Delete** `app/lib/features/avavision/session/vision_api_stub.dart`.
2. Repoint the import `import 'vision_api_stub.dart';` →
   `import '../../../core/avavision_api.dart';` in the two files that use it:
   `vision_engine.dart` and `vision_session_screen.dart`. (`vision_preview_pane.dart`
   does NOT import the stub.)
3. Ensure Phase 2's `VisionAgent` exposes the fields the session reads:
   `id, name, role, avatarUrl, capability, overlayStyle, scoringMode, scoreLabel,
   engineUpgradeAndroidWeb, ratePerHourCoins, sessionLimitMin,
   freeSnapshotsPerSession, agenticSnapshotEnabled, saveSnapshots, isFreeForCallers`
   and the helpers `fmtCoins`, `perMinuteCoins`, `kMaxSessionMinutes`. The stub's
   field/JSON names were chosen to match master §4/§6 so the swap is import-only.
4. Ensure Phase 2's `AvaVisionApi` exposes: `sessionStart`, `sessionHeartbeat`,
   `sessionStop`, `sessionToken`, `snapshot` (signatures in the stub).

## Shared-file changes Phase Z must apply

### 1. Android — register the embedded plugin (MainActivity, shared)
`app/android/app/src/main/kotlin/ai/avatok/avatok_call/MainActivity.kt`:
```kotlin
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine

class MainActivity : FlutterActivity() {
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        flutterEngine.plugins.add(ai.avatok.avavision.AvaVisionPlugin())
    }
}
```

### 2. Android Gradle deps (`app/android/app/build.gradle`, shared/effectively-shared)
Add to `dependencies { }` (versions known-good as of 2026-06; Phase Z confirms in CI):
```gradle
// CameraX (preview + image analysis) — VisionCameraView
implementation "androidx.camera:camera-core:1.4.0"
implementation "androidx.camera:camera-camera2:1.4.0"
implementation "androidx.camera:camera-lifecycle:1.4.0"
implementation "androidx.camera:camera-view:1.4.0"
// MediaPipe Tasks Vision (pose33 / hand / face / object / segmentation)
implementation "com.google.mediapipe:tasks-vision:0.10.14"
// TFLite (MoveNet single-pose Lightning)
implementation "org.tensorflow:tensorflow-lite:2.16.1"
implementation "org.tensorflow:tensorflow-lite-support:0.4.4"
```
Also ensure `compileSdk`/`minSdk` ≥ what CameraX 1.4 needs (minSdk 21 fine; tasks-vision wants minSdk 24 — bump `minSdkVersion` to 24 if currently lower). `ImageProxy.toBitmap()` requires `camera-core` ≥ 1.3 (1.4.0 satisfies).

### 3. Model assets + pubspec (`app/pubspec.yaml`, shared)
Drop the model files under `app/assets/models/` and add the asset dir:
```yaml
flutter:
  assets:
    - assets/models/
```
Required model files (free, on-device — fetch from the MediaPipe/MoveNet model pages):
- `assets/models/movenet_singlepose_lightning.tflite`  (MoveNet, default pose)
- `assets/models/pose_landmarker_lite.task`            (MediaPipe Pose 33 upgrade)
- `assets/models/hand_landmarker.task`                 (hand / gesture)
- `assets/models/face_landmarker.task`                 (face_landmark / face mesh)
- `assets/models/blaze_face_short_range.tflite`        (face_detect)
- `assets/models/efficientdet_lite0.tflite`            (object / image_class)
- `assets/models/selfie_segmenter.tflite`              (segmentation / holistic)

The Kotlin analyzers load these via `flutter_assets/assets/models/<file>` (Flutter
bundles `assets/` under `flutter_assets/` in the Android APK).

### 4. pubspec packages — NONE NEW NEEDED
`camera` (unused here — native owns the camera, but present), `web_socket_channel`,
`record`, `flutter_pcm_sound`, `permission_handler`, `path_provider`,
`phosphor_flutter` are **already** in `app/pubspec.yaml`. No additions.

### 5. Android permissions (`app/android/app/src/main/AndroidManifest.xml`, shared)
Confirm these exist (AvaLive already needs camera+mic — likely present; add if not):
```xml
<uses-permission android:name="android.permission.CAMERA"/>
<uses-permission android:name="android.permission.RECORD_AUDIO"/>
<uses-feature android:name="android.hardware.camera" android:required="false"/>
```

## Cross-phase contracts relied on / drift

- **`POST /api/avavision/sessions/token`** (mint a fresh ephemeral token for an
  active session) is used by the engine's ~10-min Live reconnect. Master §4 lists
  start/heartbeat/stop/snapshot but not an explicit per-session token refresh; the
  translation feature has a `token` route precedent (`translate.ts`). **ACTION
  (Phase 1/Z):** add `sessions/token` to `avavision.ts` mirroring `translate.ts`’s
  `mintToken`, or confirm the reconnect should call `sessions/start` semantics. If
  it must not exist, the engine should fall back to ending the session on socket
  drop — flag at integration.
- **Snapshot 429** is rendered as a calm "fair-use cap reached" with no charge
  (master idempotency §B). The screen also locks the Analyze button locally once
  `snapshot_calls >= free_snapshots_per_session`.
- **Engine policy** (master §6/§7): pose→MoveNet default, `mediapipe_pose` upgrade
  when the template sets `engine_upgrade_android_web`; others→MediaPipe Tasks;
  `gemini_only`→no model, overlay off.
- **Saved snapshots** are OFF by default and per-account scoped (rulebook #1/#3):
  written to `getApplicationSupportDirectory()/avavision_snapshots/<AccountScope.id>/`
  only when the user flips the in-sheet toggle.
- **Deviation from "owned files ONLY" list:** added `session/vision_api_stub.dart`
  (one extra file, inside the owned `session/` dir) so the slice compiles without
  Phase 2. Phase Z deletes it (see Reconcile).

## Isolated-build / test results

- No local Flutter/Android toolchain in this session (project memory: APK builds
  via GitHub Actions on push; do not run `flutter build/analyze` locally). Dart
  files were self-reviewed for imports/symbols against the real `zine`, `ava_log`,
  `identity` (`AccountScope`), `api_auth`, `config`, `avatar` APIs; Kotlin written
  against CameraX 1.4 + MediaPipe Tasks 0.10.x + TFLite 2.16 APIs.
- **Phase Z must run the CI build** after applying §1–§5 (deps + MainActivity
  registration + assets) and confirm `tasks-vision` minSdk. Expected analyzer
  state pre-reconcile: clean within `session/` against the stub; post-reconcile,
  the stub import swap is the only change.
