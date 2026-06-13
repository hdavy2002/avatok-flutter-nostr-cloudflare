# AvaVision on-device vision models

These free, on-device model files are loaded by the Android native analyzers
(`ai/avatok/avavision/*Analyzer.kt`) via `flutter_assets/assets/models/<file>`.
They are **not** checked into git (large binaries). Drop them here before a
release build, or fetch them in CI:

- `movenet_singlepose_lightning.tflite`  (MoveNet — default pose, all platforms)
- `pose_landmarker_lite.task`            (MediaPipe Pose 33 — Android/Web upgrade)
- `hand_landmarker.task`                 (hand / gesture)
- `face_landmarker.task`                 (face_landmark / face mesh)
- `blaze_face_short_range.tflite`        (face_detect)
- `efficientdet_lite0.tflite`            (object / image_class)
- `selfie_segmenter.tflite`              (segmentation / holistic)

Sources: MediaPipe model cards (https://ai.google.dev/edge/mediapipe/solutions)
and the MoveNet model page. Until present, vision sessions will start but the
on-device overlay/score will be inactive (the Live voice coach still works).
This README keeps the `assets/models/` asset dir resolvable so the APK builds.
