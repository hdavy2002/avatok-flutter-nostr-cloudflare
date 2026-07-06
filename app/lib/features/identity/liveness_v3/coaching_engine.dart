import 'dart:async';
import 'dart:math' as math;
import 'dart:typed_data';
import 'dart:ui' show Offset, Rect, Size;

import 'package:camera/camera.dart';
import 'package:google_mlkit_face_detection/google_mlkit_face_detection.dart';

import 'voice_packs.dart';

/// Liveness V3 — ON-DEVICE COACHING ENGINE (Specs/LIVENESS-V3-VOICE-GUIDED-PLAN-
/// DRAFT.md §1 + §3). Consumes the front-camera image stream at ~30 fps, runs ML
/// Kit face detection (classification + landmarks + tracking, fast mode) plus a
/// mean-luma estimate, and maps the DETERMINISTIC frame state to exactly one
/// [LivenessInstruction] (plan §4-A.4). Zero per-check cost, offline, no LLM.
///
/// This is the V3 successor to V2's [FaceGate]: same ML Kit input-conversion +
/// luma math, but instead of a boolean "all pass" gate it emits a coaching state
/// (moveCloser / lowLight / holdStill / …) that the flow speaks (voice pack) and
/// shows (on-screen hint). It does NOT own the camera — the caller passes an
/// initialized [CameraController].
///
/// Coaching rules (plan §3):
///   • no face                → faceNotFound
///   • brightness low         → lowLight
///   • >1 face                → onlyOnePerson
///   • no eye landmarks       → removeGlasses (sunglasses heuristic)
///   • face size ratio too small → moveCloser; too large → moveBack
///   • off-centre / tilted    → face-left/right/up/down nudges toward centre
///   • stable + framed ≥2s    → holdStill (the caller starts/continues recording)
class CoachingEngine {
  CoachingEngine({required this.controller, this.onState, this.onLuma});

  final CameraController controller;

  /// Fired on every processed frame with the current coaching snapshot.
  final void Function(CoachState state)? onState;

  /// Fired on every processed frame with the frame's mean luminance (0..255).
  /// Feeds the V3 active-checks `luma_timeline` so the screen doesn't need a
  /// second image stream — the coach already decodes each frame. Best-effort;
  /// the collector downsamples to ≤60 samples for the verify body.
  final void Function(double meanLuma)? onLuma;

  final FaceDetector _detector = FaceDetector(
    options: FaceDetectorOptions(
      enableClassification: true,
      enableLandmarks: true,
      enableTracking: true,
      performanceMode: FaceDetectorMode.fast,
      minFaceSize: 0.1,
    ),
  );

  bool _busy = false;
  bool _running = false;
  int _lastMs = 0;
  Offset? _lastCenter;

  // ~30 fps target; ML Kit fast-mode comfortably keeps up on a single face and we
  // never queue (a frame is dropped while the previous one is still analysing).
  static const _minFrameGapMs = 33;

  // How long the face must stay framed + steady before we call it holdStill (and
  // the caller begins recording). Plan §3: "stable+framed 2s".
  static const _stableHoldMs = 2000;
  int _framedSinceMs = 0;

  CoachState _state = const CoachState.searching();
  CoachState get state => _state;

  Future<void> start() async {
    if (_running) return;
    _running = true;
    try {
      if (!controller.value.isStreamingImages) {
        await controller.startImageStream(_onFrame);
      }
    } catch (_) {/* preview still shows; coaching just won't update */}
  }

  Future<void> dispose() async {
    _running = false;
    try {
      if (controller.value.isStreamingImages) {
        await controller.stopImageStream();
      }
    } catch (_) {}
    try {
      await _detector.close();
    } catch (_) {}
  }

  void _onFrame(CameraImage image) {
    if (!_running || _busy) return;
    final now = DateTime.now().millisecondsSinceEpoch;
    if (now - _lastMs < _minFrameGapMs) return;
    _lastMs = now;
    _busy = true;
    _analyse(image).whenComplete(() => _busy = false);
  }

  Future<void> _analyse(CameraImage image) async {
    final input = _toInputImage(image);
    if (input == null) return;
    List<Face> faces;
    try {
      faces = await _detector.processImage(input);
    } catch (_) {
      return;
    }
    if (!_running) return;

    final meanLuma = _meanLuma(image);
    // Feed the active-checks luma timeline (flash detection) on every frame,
    // face or not — a flash wash raises luma regardless of detection state.
    onLuma?.call(meanLuma);

    if (faces.isEmpty) {
      _lastCenter = null;
      _framedSinceMs = 0;
      // Distinguish "too dark to see" from "no face": dark takes priority because
      // ML Kit can't find a face in a black frame anyway.
      _emit(meanLuma < 60
          ? const CoachState(instruction: LivenessInstruction.lowLight, faceFound: false)
          : const CoachState.searching());
      return;
    }

    faces.sort((a, b) => b.boundingBox.height.compareTo(a.boundingBox.height));
    final multi = faces.length > 1;
    final face = faces.first;
    final box = face.boundingBox;

    final frameH = image.height.toDouble();
    final frameW = image.width.toDouble();
    final shortAxis = math.min(frameW, frameH);

    final centerX = box.center.dx / frameW;
    final centerY = box.center.dy / frameH;
    final center = Offset(centerX, centerY);
    final sizeFrac = box.height / shortAxis;

    final z = face.headEulerAngleZ ?? 0;
    final y = face.headEulerAngleY ?? 0;
    final x = face.headEulerAngleX ?? 0;
    final leftEye = face.leftEyeOpenProbability;
    final rightEye = face.rightEyeOpenProbability;
    final eyesLandmarked = _hasEyeLandmarks(face);
    final mouthNose = _hasMouthNose(face);

    final steady = _lastCenter == null ? true : (center - _lastCenter!).distance < 0.03;
    _lastCenter = center;

    final now = DateTime.now().millisecondsSinceEpoch;

    // ── Deterministic instruction selection (priority order, plan §3) ──────────
    final instruction = _pick(
      multi: multi,
      meanLuma: meanLuma,
      eyesLandmarked: eyesLandmarked,
      mouthNose: mouthNose,
      sizeFrac: sizeFrac,
      centerX: centerX,
      centerY: centerY,
      z: z,
      steady: steady,
    );

    // Track "framed + steady" duration for the holdStill / recording trigger.
    final framedOk = instruction == LivenessInstruction.good;
    if (framedOk && steady) {
      _framedSinceMs = _framedSinceMs == 0 ? now : _framedSinceMs;
    } else {
      _framedSinceMs = 0;
    }
    final heldMs = _framedSinceMs == 0 ? 0 : now - _framedSinceMs;
    final readyToRecord = heldMs >= _stableHoldMs;

    _emit(CoachState(
      instruction: readyToRecord ? LivenessInstruction.holdStill : instruction,
      faceFound: true,
      singleFace: !multi,
      sizeFrac: sizeFrac,
      centerX: centerX,
      centerY: centerY,
      eulerY: y,
      eulerX: x,
      eulerZ: z,
      meanLuma: meanLuma,
      eyeOpenProb: (leftEye != null || rightEye != null)
          ? math.min(leftEye ?? 1, rightEye ?? 1)
          : null,
      readyToRecord: readyToRecord,
      framedHoldMs: heldMs,
      faceRectNorm: Rect.fromLTWH(
        box.left / frameW, box.top / frameH, box.width / frameW, box.height / frameH),
    ));
  }

  /// Pure rule mapping: the single most-important thing to fix right now. `good`
  /// means framing is acceptable (the caller then times the steady hold).
  LivenessInstruction _pick({
    required bool multi,
    required double meanLuma,
    required bool eyesLandmarked,
    required bool mouthNose,
    required double sizeFrac,
    required double centerX,
    required double centerY,
    required double z,
    required bool steady,
  }) {
    if (multi) return LivenessInstruction.onlyOnePerson;
    if (meanLuma < 60) return LivenessInstruction.lowLight;
    if (!mouthNose) return LivenessInstruction.cameraBlocked; // face partly covered
    if (!eyesLandmarked) return LivenessInstruction.removeGlasses;
    if (sizeFrac < 0.34) return LivenessInstruction.moveCloser;
    if (sizeFrac > 0.78) return LivenessInstruction.moveBack;
    // Off-centre nudges: horizontal first, then vertical.
    if (centerX < 0.30) return LivenessInstruction.faceRight; // face is left → move right
    if (centerX > 0.70) return LivenessInstruction.faceLeft;
    if (centerY < 0.26) return LivenessInstruction.lookDown; // face high → look down
    if (centerY > 0.74) return LivenessInstruction.lookUp;
    return LivenessInstruction.good;
  }

  void _emit(CoachState s) {
    _state = s;
    onState?.call(s);
  }

  // ── ML Kit input conversion (mirrors liveness_v2/face_gate.dart) ────────────

  InputImage? _toInputImage(CameraImage image) {
    try {
      final rotation = InputImageRotationValue.fromRawValue(
              controller.description.sensorOrientation) ??
          InputImageRotation.rotation0deg;
      final format = InputImageFormatValue.fromRawValue(image.format.raw) ??
          InputImageFormat.nv21;
      final plane = image.planes.first;
      final bytes = _concatPlanes(image);
      return InputImage.fromBytes(
        bytes: bytes,
        metadata: InputImageMetadata(
          size: Size(image.width.toDouble(), image.height.toDouble()),
          rotation: rotation,
          format: format,
          bytesPerRow: plane.bytesPerRow,
        ),
      );
    } catch (_) {
      return null;
    }
  }

  Uint8List _concatPlanes(CameraImage image) {
    if (image.planes.length == 1) return image.planes.first.bytes;
    final builder = BytesBuilder(copy: false);
    for (final p in image.planes) {
      builder.add(p.bytes);
    }
    return builder.toBytes();
  }

  double _meanLuma(CameraImage image) {
    final y = image.planes.first.bytes;
    if (y.isEmpty) return 128;
    var sum = 0;
    var n = 0;
    final step = math.max(1, y.length ~/ 2000);
    for (var i = 0; i < y.length; i += step) {
      sum += y[i];
      n++;
    }
    return n == 0 ? 128 : sum / n;
  }

  bool _hasMouthNose(Face face) =>
      face.landmarks[FaceLandmarkType.bottomMouth] != null &&
      face.landmarks[FaceLandmarkType.noseBase] != null;

  bool _hasEyeLandmarks(Face face) =>
      face.landmarks[FaceLandmarkType.leftEye] != null &&
      face.landmarks[FaceLandmarkType.rightEye] != null;
}

/// Immutable coaching snapshot emitted per frame. [instruction] is the single
/// thing to voice/show; [readyToRecord] flips true once the face has been framed
/// and steady for ~2s (the caller starts/continues recording on that edge).
class CoachState {
  const CoachState({
    required this.instruction,
    this.faceFound = false,
    this.singleFace = false,
    this.sizeFrac = 0,
    this.centerX = 0.5,
    this.centerY = 0.5,
    this.eulerY = 0,
    this.eulerX = 0,
    this.eulerZ = 0,
    this.meanLuma = 128,
    this.eyeOpenProb,
    this.readyToRecord = false,
    this.framedHoldMs = 0,
    this.faceRectNorm,
  });

  const CoachState.searching()
      : instruction = LivenessInstruction.faceNotFound,
        faceFound = false,
        singleFace = false,
        sizeFrac = 0,
        centerX = 0.5,
        centerY = 0.5,
        eulerY = 0,
        eulerX = 0,
        eulerZ = 0,
        meanLuma = 128,
        eyeOpenProb = null,
        readyToRecord = false,
        framedHoldMs = 0,
        faceRectNorm = null;

  final LivenessInstruction instruction;
  final bool faceFound;
  final bool singleFace;
  final double sizeFrac;
  final double centerX;
  final double centerY;
  final double eulerY;
  final double eulerX;
  final double eulerZ;
  final double meanLuma;
  final double? eyeOpenProb;
  final bool readyToRecord;
  final int framedHoldMs;
  final Rect? faceRectNorm;

  /// Face size ratio (0..1 of the framed subject) — capture-quality telemetry.
  double get faceRatio => sizeFrac;

  /// Brightness 0..255 — capture-quality telemetry.
  double get brightness => meanLuma;
}
