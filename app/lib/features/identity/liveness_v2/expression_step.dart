import 'dart:async';
import 'dart:io';
import 'dart:math' as math;
import 'dart:typed_data';

import 'package:camera/camera.dart';
import 'package:flutter/material.dart';
import 'package:google_mlkit_face_detection/google_mlkit_face_detection.dart';

import '../../../core/analytics.dart';
import '../../../core/ui/zine.dart';
import '../../../core/ui/zine_widgets.dart';

/// Liveness V2 — EXPRESSION challenge step (Specs/LIVENESS-V2-PLAN.md §4 step
/// 4b). ONE random expression from the server challenge list is asked; ML Kit
/// confirms it CLIENT-side (no timer advance), the frame is captured at the
/// detection peak, and the server re-verifies with LLaVA.
///
/// Supported expressions (server ids): `smile`, `blink_twice`, `mouth_open`,
/// `eyebrows_raised`. A 15s step timeout offers a per-step retry that resets
/// ONLY this step.
class ExpressionStep extends StatefulWidget {
  const ExpressionStep({
    super.key,
    required this.controller,
    required this.expression,
    required this.onComplete,
    required this.onFaceLost,
    required this.onFaceBack,
    required this.onSecondFace,
  });

  final CameraController controller;

  /// The single expression id chosen for this session (from the server
  /// challenge). Unknown/turn ids fall back to `smile`.
  final String expression;

  /// Delivers the peak frame (may be null if capture failed) + the id.
  final void Function(String id, Uint8List? frame) onComplete;

  final VoidCallback onFaceLost;
  final VoidCallback onFaceBack;
  final VoidCallback onSecondFace;

  @override
  State<ExpressionStep> createState() => _ExpressionStepState();
}

class _ExpressionStepState extends State<ExpressionStep> {
  static const _minFrameGapMs = 120;
  static const _stepTimeoutMs = 15000;

  final FaceDetector _detector = FaceDetector(
    options: FaceDetectorOptions(
      enableClassification: true, // smile + eye-open probabilities
      enableLandmarks: true, // mouth/eyebrow geometry heuristics
      enableTracking: true,
      performanceMode: FaceDetectorMode.fast,
      minFaceSize: 0.1,
    ),
  );

  bool _busy = false;
  bool _running = false;
  bool _capturing = false;
  bool _completed = false;
  int _lastMs = 0;

  int _faceLostAtMs = 0;
  bool _faceIsLost = false;

  // smile: sustained-hold tracking.
  int _smileSinceMs = 0;
  // blink_twice: transition state machine within a 4s window.
  int _blinkCount = 0;
  bool _eyesWereOpen = true;
  int _blinkWindowStartMs = 0;
  // mouth_open / eyebrows_raised: baseline geometry.
  double? _baselineMouth;
  double? _baselineBrow;
  int _baselineSamples = 0;

  int _startMs = DateTime.now().millisecondsSinceEpoch;
  int _retries = 0;
  Timer? _timeout;
  bool _timedOut = false;

  String get _id {
    switch (widget.expression) {
      case 'smile':
      case 'blink_twice':
      case 'mouth_open':
      case 'eyebrows_raised':
        return widget.expression;
      default:
        return 'smile'; // turn_* or unknown → default expression
    }
  }

  String get _prompt {
    switch (_id) {
      case 'blink_twice':
        return 'Blink twice';
      case 'mouth_open':
        return 'Open your mouth wide';
      case 'eyebrows_raised':
        return 'Raise your eyebrows';
      case 'smile':
      default:
        return 'Give us a big smile';
    }
  }

  @override
  void initState() {
    super.initState();
    _start();
  }

  Future<void> _start() async {
    _timedOut = false;
    _timeout?.cancel();
    _timeout = Timer(const Duration(milliseconds: _stepTimeoutMs), _onTimeout);
    _running = true;
    _blinkWindowStartMs = DateTime.now().millisecondsSinceEpoch;
    try {
      if (!widget.controller.value.isStreamingImages) {
        await widget.controller.startImageStream(_onFrame);
      }
    } catch (_) {/* timeout offers retry */}
  }

  void _onTimeout() {
    if (!mounted || _completed) return;
    Analytics.capture('liveness_step', {
      'step': 'expression',
      'outcome': 'timeout',
      'ms': DateTime.now().millisecondsSinceEpoch - _startMs,
      'retries': _retries,
    });
    setState(() => _timedOut = true);
  }

  void _retry() {
    setState(() {
      _timedOut = false;
      _retries++;
      _smileSinceMs = 0;
      _blinkCount = 0;
      _eyesWereOpen = true;
      _baselineMouth = null;
      _baselineBrow = null;
      _baselineSamples = 0;
      _startMs = DateTime.now().millisecondsSinceEpoch;
    });
    _start();
  }

  void _onFrame(CameraImage image) {
    if (!_running || _busy || _timedOut || _completed) return;
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
    if (!_running || !mounted) return;

    if (faces.isEmpty) {
      _handleFaceLost();
      return;
    }
    if (faces.length > 1) widget.onSecondFace();
    _handleFaceBack();

    faces.sort((a, b) => b.boundingBox.height.compareTo(a.boundingBox.height));
    final face = faces.first;

    final detected = switch (_id) {
      'smile' => _detectSmile(face),
      'blink_twice' => _detectBlinkTwice(face),
      'mouth_open' => _detectMouthOpen(face),
      'eyebrows_raised' => _detectEyebrows(face),
      _ => false,
    };
    if (detected) _finish();
  }

  void _handleFaceLost() {
    final now = DateTime.now().millisecondsSinceEpoch;
    if (_faceLostAtMs == 0) _faceLostAtMs = now;
    if (!_faceIsLost && now - _faceLostAtMs > 1000) {
      _faceIsLost = true;
      widget.onFaceLost();
    }
  }

  void _handleFaceBack() {
    _faceLostAtMs = 0;
    if (_faceIsLost) {
      _faceIsLost = false;
      widget.onFaceBack();
    }
  }

  // ── Detectors ─────────────────────────────────────────────────────────────

  /// smile: `smilingProbability > .8` held 500ms.
  bool _detectSmile(Face face) {
    final p = face.smilingProbability ?? 0;
    final now = DateTime.now().millisecondsSinceEpoch;
    if (p > 0.8) {
      if (_smileSinceMs == 0) _smileSinceMs = now;
      return now - _smileSinceMs >= 500;
    }
    _smileSinceMs = 0;
    return false;
  }

  /// blink_twice: two eyesOpen→closed(<.2)→open transitions within a 4s window.
  bool _detectBlinkTwice(Face face) {
    final now = DateTime.now().millisecondsSinceEpoch;
    if (now - _blinkWindowStartMs > 4000) {
      // window elapsed — reset and start fresh (does not fail the step).
      _blinkWindowStartMs = now;
      _blinkCount = 0;
      _eyesWereOpen = true;
    }
    final l = face.leftEyeOpenProbability ?? 1;
    final r = face.rightEyeOpenProbability ?? 1;
    final closed = l < 0.2 && r < 0.2;
    final open = l > 0.6 && r > 0.6;
    if (_eyesWereOpen && closed) {
      _eyesWereOpen = false;
    } else if (!_eyesWereOpen && open) {
      _eyesWereOpen = true;
      _blinkCount++;
    }
    return _blinkCount >= 2;
  }

  // LIVE-V2 NOTE: ML Kit has no mouth-open / eyebrows-raised classifier, so we
  // detect them from landmark geometry, normalised by the face-box height to be
  // scale-invariant. Thresholds are deliberately conservative; the server
  // re-verifies the captured frame with LLaVA (ACTIONS prompts), so a client
  // false-positive is still caught server-side.

  /// mouth_open: normalised distance bottomMouth↔noseBase grows > 35% vs the
  /// user's neutral baseline (first ~8 samples).
  bool _detectMouthOpen(Face face) {
    final bottom = face.landmarks[FaceLandmarkType.bottomMouth]?.position;
    final nose = face.landmarks[FaceLandmarkType.noseBase]?.position;
    if (bottom == null || nose == null) return false;
    final h = face.boundingBox.height;
    if (h <= 0) return false;
    final d = _dist(bottom, nose) / h; // normalised
    if (_baselineSamples < 8) {
      _baselineMouth = ((_baselineMouth ?? d) * _baselineSamples + d) /
          (_baselineSamples + 1);
      _baselineSamples++;
      return false;
    }
    final base = _baselineMouth ?? d;
    return d > base * 1.35;
  }

  /// eyebrows_raised: the gap between the eye line and the face-box top grows
  /// (brows lift the visible forehead), normalised by face height, > 18% vs
  /// baseline. Uses eye landmarks vs bbox top.
  bool _detectEyebrows(Face face) {
    final le = face.landmarks[FaceLandmarkType.leftEye]?.position;
    final re = face.landmarks[FaceLandmarkType.rightEye]?.position;
    if (le == null || re == null) return false;
    final h = face.boundingBox.height;
    if (h <= 0) return false;
    final eyeY = (le.y + re.y) / 2.0;
    final gap = (eyeY - face.boundingBox.top) / h; // normalised forehead
    if (_baselineSamples < 8) {
      _baselineBrow = ((_baselineBrow ?? gap) * _baselineSamples + gap) /
          (_baselineSamples + 1);
      _baselineSamples++;
      return false;
    }
    final base = _baselineBrow ?? gap;
    return gap > base * 1.18;
  }

  double _dist(math.Point<int> a, math.Point<int> b) {
    final dx = (a.x - b.x).toDouble();
    final dy = (a.y - b.y).toDouble();
    return math.sqrt(dx * dx + dy * dy);
  }

  Future<void> _finish() async {
    if (_completed) return;
    _completed = true;
    _running = false;
    _timeout?.cancel();
    final frame = await _still();
    Analytics.capture('liveness_step', {
      'step': 'expression',
      'outcome': 'passed',
      'ms': DateTime.now().millisecondsSinceEpoch - _startMs,
      'retries': _retries,
    });
    if (!mounted) return;
    widget.onComplete(_id, frame);
  }

  Future<Uint8List?> _still() async {
    if (_capturing) return null;
    _capturing = true;
    try {
      final xf = await widget.controller.takePicture();
      final b = await xf.readAsBytes();
      try {
        await File(xf.path).delete();
      } catch (_) {}
      return b;
    } catch (_) {
      return null;
    } finally {
      _capturing = false;
    }
  }

  @override
  void dispose() {
    _running = false;
    _timeout?.cancel();
    // Detach OUR image-stream callback (see HeadCircleStep.dispose) so any later
    // step can rebind; video recording continues underneath.
    try {
      if (widget.controller.value.isStreamingImages) {
        widget.controller.stopImageStream();
      }
    } catch (_) {/* controller may be gone */}
    _detector.close();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Stack(
      fit: StackFit.expand,
      children: [
        Positioned(
          left: 0,
          right: 0,
          bottom: 44,
          child: Container(
            margin: const EdgeInsets.symmetric(horizontal: 24),
            padding: const EdgeInsets.all(18),
            decoration: BoxDecoration(
              color: Zine.ink.withValues(alpha: .72),
              borderRadius: BorderRadius.circular(Zine.rSm),
              border: Border.all(color: Zine.lime, width: Zine.bw),
            ),
            child: Text(
              _prompt,
              textAlign: TextAlign.center,
              style: ZineText.cardTitle(size: 24, color: Zine.paper),
            ),
          ),
        ),
        if (_timedOut)
          Center(
            child: Container(
              margin: const EdgeInsets.symmetric(horizontal: 32),
              padding: const EdgeInsets.all(20),
              decoration: BoxDecoration(
                color: Zine.paper,
                borderRadius: BorderRadius.circular(Zine.rSm),
                border: Border.all(color: Zine.ink, width: Zine.bwLg),
                boxShadow: Zine.shadow,
              ),
              child: Column(mainAxisSize: MainAxisSize.min, children: [
                Text('Nearly there', textAlign: TextAlign.center, style: ZineText.hero(size: 20)),
                const SizedBox(height: 8),
                Text(_prompt, textAlign: TextAlign.center, style: ZineText.sub(size: 14)),
                const SizedBox(height: 16),
                SizedBox(
                  width: 200,
                  child: ZineButton(label: 'Retry', fullWidth: true, onPressed: _retry),
                ),
              ]),
            ),
          ),
      ],
    );
  }

  // ── ML Kit input conversion (mirrors face_gate.dart) ──────────────────────

  InputImage? _toInputImage(CameraImage image) {
    try {
      final rotation = InputImageRotationValue.fromRawValue(
              widget.controller.description.sensorOrientation) ??
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
}
