import 'dart:async';
import 'dart:io';
import 'dart:math' as math;
import 'dart:typed_data';

import 'package:camera/camera.dart';
import 'package:flutter/material.dart';
import 'package:google_mlkit_face_detection/google_mlkit_face_detection.dart';

import '../../../core/analytics.dart';
import '../../../core/ui/avatok_dark.dart';

/// Liveness V2 — HEAD-CIRCLE challenge step (Specs/LIVENESS-V2-PLAN.md §4 step
/// 4a). "Move your head slowly to complete the circle": a 12-segment progress
/// ring around the face oval. ML Kit head Euler angles (Y = left/right,
/// X = up/down) are mapped to the segment the head currently points at; a
/// segment lights when the user points at it with |angle| ≥ 15°. When ALL 12
/// segments are lit the step completes.
///
/// While sweeping we auto-capture stills at the four extremes (max-left,
/// max-right, max-up, max-down), tagged `profile_left/right/up/down`, via
/// [CameraController.takePicture] (same pattern as V1 `_still()`).
///
/// NO fixed-duration auto-advance: the ONLY way forward is lighting all 12
/// segments. Face lost > 1s pauses the ring and coaches "Come back into the
/// oval". A 20s step timeout offers a per-step retry that resets ONLY this ring
/// (never the whole flow).
///
/// LIVE-V2 NOTE: this step attaches an ML Kit image stream to the SAME
/// controller the orchestrator has put into video-recording mode. On most
/// Android/iOS devices `startImageStream` + active `startVideoRecording` can
/// coexist for the detection we need; where a device refuses the stream we fail
/// safe — the ring simply never advances and the 20s timeout surfaces a retry,
/// and the neutral-frame/clip evidence still uploads for server verification.
class HeadCircleStep extends StatefulWidget {
  const HeadCircleStep({
    super.key,
    required this.controller,
    required this.onComplete,
    required this.onFaceLost,
    required this.onFaceBack,
    required this.onSecondFace,
    this.leftRight = false,
    this.onProgress,
    this.onTurnCaptured,
    this.hideBuiltInChrome = false,
  });

  final CameraController controller;

  /// [LIVE-UI-3] When true, the challenge simplifies to "turn LEFT, then RIGHT"
  /// (the new design has no 12-segment circle): the step completes once the head
  /// has cleared the left extreme AND the right extreme. Head Euler-Y detection
  /// is unchanged; only the completion condition + capture set differ (we grab
  /// the two profiles, up/down are left null).
  final bool leftRight;

  /// [LIVE-UI-3] Reports (leftDone, rightDone) so a parent can render the new
  /// design's caret arrows + status pills. Fires only in [leftRight] mode.
  final void Function(bool leftDone, bool rightDone)? onProgress;

  /// [LIVE-DEVAUTH-1] Reports the head Euler-Y at the moment each turn extreme is
  /// captured (`side` = 'left' | 'right', `eulerY` = the device-frame angle), so
  /// the orchestrator can record representative ml_kit scores for the
  /// device_report. Fires only in [leftRight] mode.
  final void Function(String side, double eulerY)? onTurnCaptured;

  /// [LIVE-UI-3] When true, this step paints ONLY its CustomPaint overlay (or
  /// nothing) and lets the parent own all headings/pills/chrome — used by the
  /// new dark stage which draws the arrows itself.
  final bool hideBuiltInChrome;

  /// Fired once the challenge completes. Delivers the captured profile stills
  /// (any of the four may be null if capture failed at that extreme).
  final void Function(
    Uint8List? profileLeft,
    Uint8List? profileRight,
    Uint8List? profileUp,
    Uint8List? profileDown,
  ) onComplete;

  /// Continuous guards, surfaced to the orchestrator's overlay.
  final VoidCallback onFaceLost;
  final VoidCallback onFaceBack;
  final VoidCallback onSecondFace;

  @override
  State<HeadCircleStep> createState() => _HeadCircleStepState();
}

class _HeadCircleStepState extends State<HeadCircleStep> {
  static const _segments = 12;
  static const _threshold = 15.0; // |angle| ≥ 15° lights a segment
  static const _extreme = 22.0; // beyond this we consider it an "extreme" for capture
  static const _minFrameGapMs = 150;
  static const _stepTimeoutMs = 20000;

  final FaceDetector _detector = FaceDetector(
    options: FaceDetectorOptions(
      enableClassification: false,
      enableLandmarks: false,
      enableTracking: true,
      performanceMode: FaceDetectorMode.fast,
      minFaceSize: 0.1,
    ),
  );

  final List<bool> _lit = List<bool>.filled(_segments, false);
  bool _busy = false;
  bool _running = false;
  bool _capturing = false; // guards concurrent takePicture calls
  int _lastMs = 0;
  int _faceLostAtMs = 0;
  bool _faceIsLost = false;

  // Captured extreme stills.
  Uint8List? _left, _right, _up, _down;

  // [LIVE-UI-3] left/right-mode progress. In leftRight mode we require the head
  // to clear the left extreme, THEN the right extreme (order enforced so the
  // pills read "Turn left" → "✓ Left" → "Turn right").
  bool _leftReached = false;
  bool _rightReached = false;

  int _startMs = DateTime.now().millisecondsSinceEpoch;
  int _retries = 0;
  Timer? _timeout;
  bool _timedOut = false;
  bool _completed = false;

  @override
  void initState() {
    super.initState();
    _startSweep();
  }

  Future<void> _startSweep() async {
    _timedOut = false;
    _timeout?.cancel();
    _timeout = Timer(const Duration(milliseconds: _stepTimeoutMs), _onTimeout);
    _running = true;
    try {
      if (!widget.controller.value.isStreamingImages) {
        await widget.controller.startImageStream(_onFrame);
      }
    } catch (_) {/* fail safe — timeout will offer retry */}
  }

  void _onTimeout() {
    if (!mounted || _completed) return;
    Analytics.capture('liveness_step', {
      'step': 'head_circle',
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
      for (var i = 0; i < _segments; i++) {
        _lit[i] = false;
      }
      _left = _right = _up = _down = null;
      _leftReached = _rightReached = false;
      _startMs = DateTime.now().millisecondsSinceEpoch;
    });
    widget.onProgress?.call(false, false);
    _startSweep();
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
    if (faces.length > 1) {
      widget.onSecondFace();
    }
    _handleFaceBack();

    faces.sort((a, b) => b.boundingBox.height.compareTo(a.boundingBox.height));
    final face = faces.first;
    final y = face.headEulerAngleY ?? 0; // + = user's right, − = user's left (device frame)
    final x = face.headEulerAngleX ?? 0; // + = up, − = down (approx)

    if (widget.leftRight) {
      // [LIVE-UI-3] Simplified LEFT-then-RIGHT gating. Head Euler-Y: negative =
      // user's left, positive = user's right (device frame, as documented above).
      if (!_leftReached && y <= -_extreme) {
        _leftReached = true;
        _left ??= await _still();
        widget.onTurnCaptured?.call('left', y);
        widget.onProgress?.call(_leftReached, _rightReached);
      } else if (_leftReached && !_rightReached && y >= _extreme) {
        _rightReached = true;
        _right ??= await _still();
        widget.onTurnCaptured?.call('right', y);
        widget.onProgress?.call(_leftReached, _rightReached);
      }
      if (mounted) setState(() {});
      if (_leftReached && _rightReached) _finish();
      return;
    }

    _lightSegmentFor(y, x);
    _maybeCaptureExtreme(y, x);

    if (mounted) setState(() {});
    if (_lit.every((s) => s)) _finish();
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

  /// Map current head direction to a segment index (0 = right, clockwise) and
  /// light it when the sweep magnitude clears the threshold.
  void _lightSegmentFor(double y, double x) {
    final mag = math.sqrt(y * y + x * x);
    if (mag < _threshold) return;
    // atan2(up, right): y drives horizontal, x drives vertical.
    final angle = math.atan2(x, y); // −pi..pi
    var seg = ((angle / (2 * math.pi)) * _segments).round() % _segments;
    if (seg < 0) seg += _segments;
    _lit[seg] = true;
  }

  Future<void> _maybeCaptureExtreme(double y, double x) async {
    if (_capturing) return;
    // Capture each of the four cardinal extremes exactly once.
    if (_left == null && y <= -_extreme) {
      _left = await _still();
    } else if (_right == null && y >= _extreme) {
      _right = await _still();
    } else if (_up == null && x >= _extreme) {
      _up = await _still();
    } else if (_down == null && x <= -_extreme) {
      _down = await _still();
    }
  }

  /// Capture a still during recording (same fallback-to-null pattern as V1).
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

  Future<void> _finish() async {
    if (_completed) return;
    _completed = true;
    _running = false;
    _timeout?.cancel();
    Analytics.capture('liveness_step', {
      'step': 'head_circle',
      'outcome': 'passed',
      'ms': DateTime.now().millisecondsSinceEpoch - _startMs,
      'retries': _retries,
    });
    // Our dispose() detaches the image-stream callback so the next step can
    // bind its own; video recording keeps running across the handoff.
    if (!mounted) return;
    widget.onComplete(_left, _right, _up, _down);
  }

  @override
  void dispose() {
    _running = false;
    _timeout?.cancel();
    // Detach OUR image-stream callback so the next challenge step can register
    // its own (CameraController.startImageStream only binds one callback, and it
    // is a no-op if a stream is already running). Video recording continues.
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
    // [LIVE-UI-3] In the new dark stage the parent draws all chrome/arrows and
    // gates detection; this step becomes headless (just runs the ML Kit loop),
    // only surfacing the timeout-retry card so the flow can never dead-end.
    if (widget.hideBuiltInChrome) {
      if (!_timedOut) return const SizedBox.expand();
      return Center(child: _timeoutCard());
    }
    final done = _lit.where((s) => s).length;
    return Stack(
      fit: StackFit.expand,
      children: [
        CustomPaint(painter: _RingPainter(lit: _lit)),
        Positioned(
          left: 0,
          right: 0,
          bottom: 44,
          child: Column(
            children: [
              Container(
                margin: const EdgeInsets.symmetric(horizontal: 24),
                padding: const EdgeInsets.all(16),
                decoration: BoxDecoration(
                  color: const Color(0xE60B0B0D), // AD.bg @90%
                  borderRadius: BorderRadius.circular(AD.rDialog),
                  border: Border.all(color: AD.primaryBadge, width: 1),
                ),
                child: Text(
                  'Move your head slowly in a circle',
                  textAlign: TextAlign.center,
                  style: TextStyle(
                    fontFamily: ADText.family,
                    fontWeight: FontWeight.w800,
                    fontSize: 20,
                    color: AD.textPrimary,
                  ),
                ),
              ),
              const SizedBox(height: 8),
              Text('$done / $_segments',
                  style: TextStyle(
                    fontFamily: ADText.family,
                    fontWeight: FontWeight.w800,
                    fontSize: 16,
                    color: AD.textPrimary,
                  )),
            ],
          ),
        ),
        if (_timedOut) Center(child: _timeoutCard()),
      ],
    );
  }

  Widget _timeoutCard() => Container(
        margin: const EdgeInsets.symmetric(horizontal: 32),
        padding: const EdgeInsets.all(20),
        decoration: BoxDecoration(
          color: AD.popover,
          borderRadius: BorderRadius.circular(AD.rDialog),
          border: Border.all(color: AD.borderControl, width: 1),
          boxShadow: const [],
        ),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Text("Let's try that again",
              textAlign: TextAlign.center, style: ADText.appTitle().copyWith(fontSize: 20)),
          const SizedBox(height: 8),
          Text(
              widget.leftRight
                  ? 'Turn your head left, then right — nice and slow.'
                  : 'Move your head slowly so the whole circle fills.',
              textAlign: TextAlign.center,
              style: TextStyle(
                fontFamily: ADText.family,
                fontWeight: FontWeight.w600,
                fontSize: 14,
                height: 1.42,
                color: AD.textSecondary,
              )),
          const SizedBox(height: 16),
          SizedBox(
            width: 200,
            child: AdButton(label: 'Retry', fullWidth: true, onPressed: _retry),
          ),
        ]),
      );

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

/// Draws the 12-segment ring; lit segments glow lime, the next empty one pulses.
class _RingPainter extends CustomPainter {
  _RingPainter({required this.lit});

  final List<bool> lit;

  @override
  void paint(Canvas canvas, Size size) {
    final center = Offset(size.width / 2, size.height * 0.42);
    final radius = math.min(size.width, size.height) * 0.34;
    final segAngle = 2 * math.pi / lit.length;
    final gap = segAngle * 0.16;

    // Find the first empty segment to pulse (hint an order).
    final nextEmpty = lit.indexWhere((s) => !s);

    for (var i = 0; i < lit.length; i++) {
      final start = -math.pi / 2 + i * segAngle + gap / 2;
      final sweep = segAngle - gap;
      final isNext = i == nextEmpty;
      final paint = Paint()
        ..style = PaintingStyle.stroke
        ..strokeCap = StrokeCap.round
        ..strokeWidth = lit[i] ? 10 : (isNext ? 8 : 5)
        ..color = lit[i]
            ? AD.primaryBadge
            : (isNext ? AD.textPrimary : AD.textPrimary.withValues(alpha: .4));
      canvas.drawArc(
        Rect.fromCircle(center: center, radius: radius),
        start,
        sweep,
        false,
        paint,
      );
    }
  }

  @override
  bool shouldRepaint(_RingPainter old) => true;
}
