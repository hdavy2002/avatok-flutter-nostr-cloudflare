import 'dart:async';
import 'dart:math' as math;
import 'dart:typed_data';
import 'dart:ui' show Offset, Rect, Size;

import 'package:camera/camera.dart';
import 'package:google_mlkit_face_detection/google_mlkit_face_detection.dart';

/// Liveness V2 — real-time pre-capture quality gate (Specs/LIVENESS-V2-PLAN.md
/// §5A). Consumes the front-camera image stream at ~5 fps, runs ML Kit face
/// detection (classification + tracking + landmarks, fast mode) plus a mean-luma
/// estimate from the Y plane, and emits a [FaceGateStatus] with the individual
/// boolean gates and a single prioritized coaching hint (the FIRST failing
/// check, using the EXACT A-catalog strings from the plan).
///
/// This does NOT own the camera — the caller passes an initialized
/// [CameraController]. [start] attaches the image stream; [dispose] detaches it
/// and closes the ML Kit detector. All heavy work is skipped while a previous
/// frame is still being analysed (no queueing / back-pressure).
class FaceGate {
  FaceGate({required this.controller, this.onStatus});

  final CameraController controller;
  final void Function(FaceGateStatus status)? onStatus;

  final FaceDetector _detector = FaceDetector(
    options: FaceDetectorOptions(
      enableClassification: true, // eye-open + smile probabilities
      enableLandmarks: true, // occlusion / sunglasses heuristics
      enableTracking: true, // stable multi-face count
      performanceMode: FaceDetectorMode.fast,
      minFaceSize: 0.1,
    ),
  );

  bool _busy = false; // a frame is currently being analysed
  bool _running = false;
  int _lastMs = 0; // last frame we processed (for the ~5fps throttle)
  Offset? _lastCenter; // previous bbox center (steadiness)

  static const _minFrameGapMs = 200; // ~5 fps

  FaceGateStatus _status = FaceGateStatus.searching();
  FaceGateStatus get status => _status;

  Future<void> start() async {
    if (_running) return;
    _running = true;
    await controller.startImageStream(_onFrame);
  }

  Future<void> dispose() async {
    _running = false;
    try {
      if (controller.value.isStreamingImages) {
        await controller.stopImageStream();
      }
    } catch (_) {/* controller may already be disposed */}
    try {
      await _detector.close();
    } catch (_) {/* best-effort */}
  }

  void _onFrame(CameraImage image) {
    if (!_running || _busy) return;
    final now = DateTime.now().millisecondsSinceEpoch;
    if (now - _lastMs < _minFrameGapMs) return; // frame skip → never queue
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
      return; // transient decode failure — keep last status
    }
    if (!_running) return;

    final meanLuma = _meanLuma(image);

    if (faces.isEmpty) {
      _lastCenter = null;
      _emit(FaceGateStatus.searching(meanLuma: meanLuma));
      return;
    }

    // Largest face is the subject; the rest count toward "only you".
    faces.sort((a, b) =>
        b.boundingBox.height.compareTo(a.boundingBox.height));
    final face = faces.first;
    final box = face.boundingBox;

    // Camera image is landscape-oriented; the preview height corresponds to the
    // image WIDTH on a portrait phone. Use the shorter axis so the size /
    // center math is orientation-agnostic enough for coaching.
    final frameH = image.height.toDouble();
    final frameW = image.width.toDouble();
    final shortAxis = math.min(frameW, frameH);

    final centerX = box.center.dx / frameW;
    final centerY = box.center.dy / frameH;
    final center = Offset(centerX, centerY);

    final sizeFrac = box.height / shortAxis; // 0..1 of the framed subject
    final z = face.headEulerAngleZ ?? 0;
    final y = face.headEulerAngleY ?? 0;
    final x = face.headEulerAngleX ?? 0;
    final leftEye = face.leftEyeOpenProbability;
    final rightEye = face.rightEyeOpenProbability;

    // Backlit heuristic: sample luma inside the face box vs the whole frame.
    final faceLuma = _regionLuma(image, box);
    final steady = _lastCenter == null
        ? true
        : (center - _lastCenter!).distance < 0.04;
    _lastCenter = center;

    final s = FaceGateStatus(
      faceFound: true,
      singleFace: faces.length == 1,
      sizeOk: sizeFrac >= 0.35 && sizeFrac <= 0.75,
      tooFar: sizeFrac < 0.35,
      tooNear: sizeFrac > 0.75,
      insideOval: centerX > 0.28 &&
          centerX < 0.72 &&
          centerY > 0.24 &&
          centerY < 0.76,
      levelOk: z.abs() < 12,
      facingOk: y.abs() < 12 && x.abs() < 12,
      eyesOpen: (leftEye ?? 1) > 0.4 && (rightEye ?? 1) > 0.4,
      brightOk: meanLuma >= 60 && meanLuma <= 200,
      tooDark: meanLuma < 60,
      overExposed: meanLuma > 200,
      notBacklit: faceLuma >= meanLuma - 25,
      steadyOk: steady,
      mouthNoseVisible: _hasMouthNose(face),
      eyesVisible: _hasEyeLandmarks(face),
      meanLuma: meanLuma,
      eulerY: y,
      eulerX: x,
      eulerZ: z,
      faceRectNorm: Rect.fromLTWH(
        box.left / frameW,
        box.top / frameH,
        box.width / frameW,
        box.height / frameH,
      ),
    );
    _emit(s);
  }

  void _emit(FaceGateStatus s) {
    _status = s;
    onStatus?.call(s);
  }

  // ── ML Kit input conversion ────────────────────────────────────────────────

  InputImage? _toInputImage(CameraImage image) {
    try {
      final rotation = InputImageRotationValue.fromRawValue(
              controller.description.sensorOrientation) ??
          InputImageRotation.rotation0deg;
      final format = InputImageFormatValue.fromRawValue(image.format.raw) ??
          InputImageFormat.nv21;

      // Single-plane path (NV21 on Android / BGRA on iOS): pass bytes directly.
      // Multi-plane YUV_420 also arrives here on some devices; ML Kit accepts the
      // first plane's bytesPerRow with nv21/yuv metadata on modern plugin builds.
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

  // ── Luma estimation (Y plane) ──────────────────────────────────────────────

  /// Mean luma across a sparse sample of the Y plane (0..255). The Y plane is
  /// the first plane in YUV formats; for BGRA (iOS) we approximate from the raw
  /// bytes (green-ish channel dominates), which is close enough for the
  /// dark/bright coaching thresholds.
  double _meanLuma(CameraImage image) {
    final y = image.planes.first.bytes;
    if (y.isEmpty) return 128;
    var sum = 0;
    var n = 0;
    final step = math.max(1, y.length ~/ 2000); // ~2000 samples
    for (var i = 0; i < y.length; i += step) {
      sum += y[i];
      n++;
    }
    return n == 0 ? 128 : sum / n;
  }

  /// Mean luma inside a bounding box (used for the backlit check). Samples the Y
  /// plane over the box region using its stride.
  double _regionLuma(CameraImage image, Rect box) {
    final plane = image.planes.first;
    final bytes = plane.bytes;
    final stride = plane.bytesPerRow;
    if (bytes.isEmpty || stride <= 0) return _meanLuma(image);
    final left = box.left.clamp(0, image.width - 1).toInt();
    final right = box.right.clamp(0, image.width - 1).toInt();
    final top = box.top.clamp(0, image.height - 1).toInt();
    final bottom = box.bottom.clamp(0, image.height - 1).toInt();
    var sum = 0;
    var n = 0;
    final rowStep = math.max(1, (bottom - top) ~/ 24);
    final colStep = math.max(1, (right - left) ~/ 24);
    for (var row = top; row < bottom; row += rowStep) {
      final base = row * stride;
      for (var col = left; col < right; col += colStep) {
        final idx = base + col;
        if (idx >= 0 && idx < bytes.length) {
          sum += bytes[idx];
          n++;
        }
      }
    }
    return n == 0 ? _meanLuma(image) : sum / n;
  }

  // ── Occlusion heuristics ───────────────────────────────────────────────────

  bool _hasMouthNose(Face face) =>
      face.landmarks[FaceLandmarkType.bottomMouth] != null &&
      face.landmarks[FaceLandmarkType.noseBase] != null;

  bool _hasEyeLandmarks(Face face) =>
      face.landmarks[FaceLandmarkType.leftEye] != null &&
      face.landmarks[FaceLandmarkType.rightEye] != null;
}

/// Immutable snapshot of the current pre-capture quality gates. [allPass] is the
/// signal the POSITION step waits on; [hint] is the single coaching line to show
/// (null when everything passes). [hintId] is the A-catalog id for telemetry.
class FaceGateStatus {
  const FaceGateStatus({
    required this.faceFound,
    required this.singleFace,
    required this.sizeOk,
    required this.tooFar,
    required this.tooNear,
    required this.insideOval,
    required this.levelOk,
    required this.facingOk,
    required this.eyesOpen,
    required this.brightOk,
    required this.tooDark,
    required this.overExposed,
    required this.notBacklit,
    required this.steadyOk,
    required this.mouthNoseVisible,
    required this.eyesVisible,
    required this.meanLuma,
    this.eulerY = 0,
    this.eulerX = 0,
    this.eulerZ = 0,
    this.faceRectNorm,
  });

  /// No-face state — everything unmet, hint = A1.
  factory FaceGateStatus.searching({double meanLuma = 128}) => FaceGateStatus(
        faceFound: false,
        singleFace: false,
        sizeOk: false,
        tooFar: false,
        tooNear: false,
        insideOval: false,
        levelOk: false,
        facingOk: false,
        eyesOpen: false,
        brightOk: meanLuma >= 60 && meanLuma <= 200,
        tooDark: meanLuma < 60,
        overExposed: meanLuma > 200,
        notBacklit: true,
        steadyOk: true,
        mouthNoseVisible: false,
        eyesVisible: false,
        meanLuma: meanLuma,
      );

  final bool faceFound;
  final bool singleFace;
  final bool sizeOk;
  final bool tooFar;
  final bool tooNear;
  final bool insideOval;
  final bool levelOk;
  final bool facingOk;
  final bool eyesOpen;
  final bool brightOk;
  final bool tooDark;
  final bool overExposed;
  final bool notBacklit;
  final bool steadyOk;
  final bool mouthNoseVisible;
  final bool eyesVisible;
  final double meanLuma;
  final double eulerY;
  final double eulerX;
  final double eulerZ;
  final Rect? faceRectNorm;

  bool get allPass =>
      faceFound &&
      singleFace &&
      sizeOk &&
      insideOval &&
      levelOk &&
      facingOk &&
      eyesOpen &&
      brightOk &&
      notBacklit &&
      steadyOk &&
      mouthNoseVisible &&
      eyesVisible;

  /// The A-catalog id of the first failing check (for `liveness_coach_hint`
  /// telemetry). null when [allPass].
  String? get hintId => _firstFailure?.id;

  /// The exact coaching string for the first failing check. null when [allPass].
  String? get hint => _firstFailure?.message;

  _Fail? get _firstFailure {
    // Priority order mirrors plan §5A (A1 → A15). Dark/bright come before the
    // face-geometry gates because ML Kit is unreliable in a dark frame.
    if (!faceFound) return const _Fail('A1', 'Place your face in the oval');
    if (!singleFace) {
      return const _Fail('A2', 'Make sure only you are in the frame');
    }
    if (tooDark) {
      return const _Fail('A8', 'Move to a brighter spot / face a light');
    }
    if (!notBacklit) {
      return const _Fail(
          'A9', 'Stand facing the light, not with light behind you');
    }
    if (overExposed) {
      return const _Fail('A10', 'Too bright — angle away from direct light');
    }
    if (tooFar) return const _Fail('A3', 'Move closer');
    if (tooNear) return const _Fail('A4', 'Move back a little');
    if (!insideOval) {
      return const _Fail('A5', 'Center your face in the oval');
    }
    if (!eyesVisible) return const _Fail('A13', 'Remove sunglasses');
    if (!mouthNoseVisible) {
      return const _Fail('A12', 'Remove anything covering your face');
    }
    if (!levelOk) return const _Fail('A6', 'Hold your head straight');
    if (!eyesOpen) return const _Fail('A7', 'Open your eyes');
    if (!facingOk) return const _Fail('A15', 'Look straight at the camera');
    if (!steadyOk) return const _Fail('A11', 'Hold your phone steady');
    return null;
  }
}

class _Fail {
  const _Fail(this.id, this.message);
  final String id;
  final String message;
}
