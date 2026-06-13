// PoseChannel — Dart side of the AvaVision native vision bridge.
//
// INTEROP CHOICE (documented in PHASE-3-GLUE.md): the camera + the on-device
// model run **entirely native** behind a `PlatformView` (Android: CameraX
// preview on a SurfaceView), exactly like AvaLive runs WebRTC natively rather
// than pulling raw frames across the channel. The native side does the heavy
// lifting (MediaPipe Tasks / MoveNet TFLite at ~30 fps) and streams up only:
//   • normalized landmarks (or boxes / mask meta) + scoring inputs  — ~30 fps
//   • a downscaled LOW-res JPEG                                     — ~1 fps (Live)
//   • on demand, one hi-res JPEG                                    — snapshot
// This keeps per-frame pixels off the Dart/Flutter bus (cheap, smooth) and
// matches master §6 "everything on-device, free, never streamed" — only the
// 1 fps LOW frame leaves the device (to Gemini Live) and only on "Analyze" does
// a hi-res frame go to the Worker.
//
// Channels:
//   MethodChannel  avatok/avavision_vision        — control (start/stop/flip/snapshot)
//   EventChannel   avatok/avavision_vision/events  — the per-frame result stream
//
// The PlatformView itself is created by `VisionCameraView` (see overlay stack in
// the screen) with viewType `avatok/avavision_camera` and creation params
// { capability, engine, overlayStyle, lensFacing }.
import 'dart:async';
import 'dart:typed_data';

import 'package:flutter/services.dart';

/// A single tracked point in **normalized** view space (0..1, origin top-left,
/// already mirrored for the front camera by the native layer so painters don't
/// have to). `score` is the per-keypoint confidence (0..1) when the engine
/// provides it (MoveNet/MediaPipe), else 1.0.
class VisionPoint {
  final double x, y, score;
  const VisionPoint(this.x, this.y, [this.score = 1.0]);
}

/// A detection box in normalized space (object / face_detect).
class VisionBox {
  final double x, y, w, h, score;
  final String? label;
  const VisionBox(this.x, this.y, this.w, this.h, {this.score = 1.0, this.label});
}

/// One frame of native vision output. Exactly one of [points] / [boxes] / [mask]
/// is populated depending on the capability/overlay; [scoreInputs] carries any
/// pre-computed angles/measures the native layer chose to surface.
class VisionFrame {
  /// Landmark sets. For multi-instance engines (hands) each inner list is one
  /// instance; for pose/face there is a single list.
  final List<List<VisionPoint>> points;
  final List<VisionBox> boxes;
  /// Segmentation mask: a low-res alpha grid (`maskW`×`maskH`, 0..255) the
  /// painter upsamples. Empty when not a segmentation overlay.
  final Uint8List? mask;
  final int maskW, maskH;
  /// Raw scalar inputs the native model already computed (rare; scoring.dart
  /// normally derives everything from [points] on the Dart side).
  final Map<String, double> scoreInputs;
  final int width, height; // native frame size in px (for aspect math)

  const VisionFrame({
    this.points = const [],
    this.boxes = const [],
    this.mask,
    this.maskW = 0,
    this.maskH = 0,
    this.scoreInputs = const {},
    this.width = 0,
    this.height = 0,
  });

  bool get isEmpty => points.isEmpty && boxes.isEmpty && mask == null;

  static VisionFrame _fromMap(Map<dynamic, dynamic> m) {
    List<VisionPoint> pts(List<dynamic>? raw) => (raw ?? const [])
        .map((p) => VisionPoint(
              ((p as List)[0] as num).toDouble(),
              (p[1] as num).toDouble(),
              p.length > 2 ? (p[2] as num).toDouble() : 1.0,
            ))
        .toList();

    final rawPoints = m['points'] as List<dynamic>?;
    final List<List<VisionPoint>> instances = [];
    if (rawPoints != null) {
      // Either a flat list of [x,y,score] (single instance) or a list of lists.
      if (rawPoints.isNotEmpty && rawPoints.first is List && (rawPoints.first as List).isNotEmpty
          && (rawPoints.first as List).first is List) {
        for (final inst in rawPoints) {
          instances.add(pts(inst as List<dynamic>));
        }
      } else {
        instances.add(pts(rawPoints));
      }
    }

    final rawBoxes = (m['boxes'] as List<dynamic>?) ?? const [];
    final boxes = rawBoxes.map((b) {
      final l = b as List;
      return VisionBox(
        (l[0] as num).toDouble(), (l[1] as num).toDouble(),
        (l[2] as num).toDouble(), (l[3] as num).toDouble(),
        score: l.length > 4 ? (l[4] as num).toDouble() : 1.0,
        label: l.length > 5 ? l[5]?.toString() : null,
      );
    }).toList();

    final si = <String, double>{};
    (m['score_inputs'] as Map?)?.forEach((k, v) {
      if (v is num) si[k.toString()] = v.toDouble();
    });

    return VisionFrame(
      points: instances,
      boxes: boxes,
      mask: m['mask'] is Uint8List ? m['mask'] as Uint8List : null,
      maskW: (m['mask_w'] as num?)?.toInt() ?? 0,
      maskH: (m['mask_h'] as num?)?.toInt() ?? 0,
      scoreInputs: si,
      width: (m['w'] as num?)?.toInt() ?? 0,
      height: (m['h'] as num?)?.toInt() ?? 0,
    );
  }
}

/// A throttled LOW-res JPEG destined for the Gemini Live video stream (~1 fps).
class VisionLiveFrame {
  final Uint8List jpeg;
  const VisionLiveFrame(this.jpeg);
}

class PoseChannel {
  static const MethodChannel _ctrl = MethodChannel('avatok/avavision_vision');
  static const EventChannel _events = EventChannel('avatok/avavision_vision/events');

  /// PlatformView viewType the camera widget instantiates.
  static const String cameraViewType = 'avatok/avavision_camera';

  final _frames = StreamController<VisionFrame>.broadcast();
  final _live = StreamController<VisionLiveFrame>.broadcast();
  StreamSubscription? _eventsSub;
  bool _started = false;

  /// 30 fps landmark/box/mask stream for the overlay + local scoring.
  Stream<VisionFrame> get frames => _frames.stream;

  /// ~1 fps LOW-res JPEGs for the Gemini Live video channel.
  Stream<VisionLiveFrame> get liveFrames => _live.stream;

  /// Start the native camera + model.
  /// [capability]/[engine]/[overlayStyle] per master §6; [lensFacing] 'front'|'back'.
  Future<void> start({
    required String capability,
    required String engine,
    required String overlayStyle,
    String lensFacing = 'front',
  }) async {
    if (_started) return;
    _eventsSub = _events.receiveBroadcastStream().listen(_onEvent, onError: (_) {});
    await _ctrl.invokeMethod('start', {
      'capability': capability,
      'engine': engine,
      'overlay_style': overlayStyle,
      'lens_facing': lensFacing,
    });
    _started = true;
  }

  void _onEvent(dynamic e) {
    if (e is! Map) return;
    switch (e['type']) {
      case 'frame':
        if (!_frames.isClosed) _frames.add(VisionFrame._fromMap(e));
        break;
      case 'live': // 1 fps LOW jpeg
        final j = e['jpeg'];
        if (j is Uint8List && !_live.isClosed) _live.add(VisionLiveFrame(j));
        break;
    }
  }

  /// Flip front/back. Returns the new lens facing.
  Future<String> flipCamera() async {
    final r = await _ctrl.invokeMethod<String>('flip');
    return r ?? 'front';
  }

  /// Pause/resume model inference without tearing down the camera (e.g. when the
  /// consent sheet is up or the app backgrounds).
  Future<void> setInference(bool on) =>
      _ctrl.invokeMethod('setInference', {'on': on});

  /// Capture one HI-RES JPEG for the "Analyze my form" snapshot. Returns the raw
  /// bytes (Dart base64-encodes for the Worker).
  Future<Uint8List?> captureSnapshot() =>
      _ctrl.invokeMethod<Uint8List>('snapshot');

  Future<void> stop() async {
    if (!_started) return;
    _started = false;
    try { await _ctrl.invokeMethod('stop'); } catch (_) {}
    await _eventsSub?.cancel();
    _eventsSub = null;
  }

  void dispose() {
    stop();
    _frames.close();
    _live.close();
  }
}
