import 'dart:async';
import 'dart:typed_data';

import 'package:camera/camera.dart';
import 'package:image/image.dart' as img;

import 'active_checks.dart';

/// Liveness V3 — INTERIM CLIENT FRAME CAPTURE (Specs/LIVENESS-V3-VOICE-GUIDED-
/// PLAN-DRAFT.md §0-C "Interim frame path").
///
/// WHY THIS EXISTS: Cloudflare Workers cannot decode H.264/MP4 in-process, and the
/// long-term server-side `MEDIA_EXTRACT` service binding does not exist yet. Until
/// it does, every verify hits EXTRACTION_FAILED → REVIEW and no PASS is producible.
/// As a stopgap the client grabs still JPEG frames from the SAME ML Kit camera
/// stream the coach already decodes — at the session's server-designated
/// `capture_offsets` (fractions of the face stage) — and uploads them in the verify
/// body as `frames: [{t_offset_ms, jpeg_b64}]`. The server uses them as the frame
/// set and skips MEDIA_EXTRACT (frame_source:"client"), then falls back to the
/// server extractor when frames are absent.
///
/// SECURITY (interim trust tradeoff, documented server-side too): client frames
/// are attacker-controllable pre-attestation. Mitigations live on the server —
/// per-frame content-hash dedupe, CompareFaces consistency across frames + vs the
/// account proof, the avatar-defense signals, and (future) Play Integrity. This
/// class only does the capture + encode.
///
/// ENCODING: we do NOT call `takePicture` (it interrupts/So competes with the
/// active video recording on several camera plugins). Instead we convert the YUV
/// `CameraImage` the stream already gives us to RGB, downscale to ≤[_maxDim]px on
/// the long edge, and JPEG-encode at quality ~[_quality]. Each encoded frame is
/// kept only if ≤[_maxFrameBytes]; the set is capped at [_maxFrames].
class FrameCapture {
  FrameCapture({
    required this.captureOffsets,
    required this.sensorOrientation,
    this.lensDirection = CameraLensDirection.front,
  });

  /// Server-designated sample points as FRACTIONS (0..1) of the expected face
  /// stage. Sorted ascending by the server.
  final List<double> captureOffsets;

  /// Camera sensor orientation (degrees) — used to rotate the encoded still upright
  /// so the server-side face detector/CompareFaces see a normally-oriented face.
  final int sensorOrientation;

  final CameraLensDirection lensDirection;

  static const int _maxFrames = 6; // matches server MAX_CLIENT_FRAMES
  static const int _maxDim = 640; // ≤640px long edge (plan §1)
  static const int _quality = 80; // JPEG quality ~80 (plan §1)
  static const int _maxFrameBytes = 200 * 1024; // ≤200KB per frame (plan §1)

  /// Planned absolute capture times (ms from record start), derived from the
  /// offsets × the expected clip duration. We grab the first stream frame at/after
  /// each planned time.
  final List<int> _plannedMs = [];
  int _nextPlan = 0;
  int _recordStartMs = 0;
  bool _armed = false;

  final List<CapturedFrame> _frames = [];
  bool _encoding = false;

  /// Arm capture for a recording that will run ~[expectedClipMs]. Call once when
  /// recording starts. Offsets are mapped onto the expected duration; if the clip
  /// ends early some late offsets simply won't fire (best-effort — the server
  /// tolerates <6 frames).
  void arm({required int recordStartMs, required int expectedClipMs}) {
    _recordStartMs = recordStartMs;
    _plannedMs.clear();
    final offs = List<double>.of(captureOffsets)..sort();
    for (final o in offs) {
      if (_plannedMs.length >= _maxFrames) break;
      final t = (o.clamp(0.0, 1.0) * expectedClipMs).round();
      _plannedMs.add(t);
    }
    // Fallback: if the server sent no offsets, spread [_maxFrames] evenly.
    if (_plannedMs.isEmpty) {
      for (var i = 1; i <= _maxFrames; i++) {
        _plannedMs.add((expectedClipMs * i / (_maxFrames + 1)).round());
      }
    }
    _nextPlan = 0;
    _armed = true;
  }

  /// Offer a stream frame. Non-blocking: if this frame is at/after the next planned
  /// capture time and we're not already encoding, encode it off the critical path.
  /// The coach keeps running; a dropped frame just means we grab the next one.
  void offer(CameraImage image) {
    if (!_armed || _encoding || _nextPlan >= _plannedMs.length) return;
    if (_frames.length >= _maxFrames) {
      _armed = false;
      return;
    }
    final t = DateTime.now().millisecondsSinceEpoch - _recordStartMs;
    if (t < _plannedMs[_nextPlan]) return; // not time for the next planned frame yet
    final targetMs = _plannedMs[_nextPlan];
    _nextPlan++;
    _encoding = true;
    // Encode on a microtask so we never block the camera stream isolate callback.
    unawaited(_encode(image, t < 0 ? 0 : t, targetMs));
  }

  Future<void> _encode(CameraImage image, int actualMs, int targetMs) async {
    try {
      final jpeg = _yuvToJpeg(image);
      if (jpeg != null && jpeg.lengthInBytes <= _maxFrameBytes) {
        _frames.add(CapturedFrame(tOffsetMs: actualMs, jpeg: jpeg));
      }
    } catch (_) {
      // Encoding failure on this frame — skip it; re-arm this plan slot so the next
      // stream frame after the same target can be tried.
      if (_nextPlan > 0) _nextPlan--;
    } finally {
      _encoding = false;
    }
  }

  /// The captured frames as the verify-body payload:
  /// `[{t_offset_ms, jpeg_b64}]`, ≤[_maxFrames]. Empty when nothing was captured
  /// (the server then falls back to the extractor).
  List<CapturedFrame> get frames => List.unmodifiable(_frames);

  int get count => _frames.length;

  void reset() {
    _frames.clear();
    _plannedMs.clear();
    _nextPlan = 0;
    _recordStartMs = 0;
    _armed = false;
    _encoding = false;
  }

  // ── YUV → JPEG (pure Dart via the `image` package). ─────────────────────────
  // Handles the two shapes the camera plugin delivers: single-plane NV21/BGRA
  // (Android format 17 / iOS) and tri-plane YUV420. Downscales to ≤_maxDim on the
  // long edge and rotates upright per the sensor orientation. Returns null on an
  // unrecognized format so the caller just skips the frame.
  Uint8List? _yuvToJpeg(CameraImage image) {
    img.Image? rgb;
    final w = image.width;
    final h = image.height;
    if (image.planes.length >= 3) {
      rgb = _yuv420ToImage(image, w, h);
    } else if (image.planes.length == 1) {
      // Single plane: could be BGRA8888 (iOS) or NV21 packed. Heuristic on stride.
      final plane = image.planes.first;
      final bytesPerPixel = plane.bytesPerPixel ?? (plane.bytesPerRow ~/ (w == 0 ? 1 : w));
      if (bytesPerPixel >= 4) {
        rgb = _bgraToImage(plane.bytes, w, h, plane.bytesPerRow);
      } else {
        rgb = _nv21ToImage(plane.bytes, w, h);
      }
    }
    if (rgb == null) return null;

    // Downscale to ≤_maxDim on the long edge.
    final longEdge = rgb.width > rgb.height ? rgb.width : rgb.height;
    if (longEdge > _maxDim) {
      final scale = _maxDim / longEdge;
      rgb = img.copyResize(
        rgb,
        width: (rgb.width * scale).round(),
        height: (rgb.height * scale).round(),
        interpolation: img.Interpolation.average,
      );
    }

    // Rotate upright for the server (sensor orientation). Front camera preview is
    // mirrored, but a horizontal flip doesn't affect face detection / CompareFaces,
    // so we only correct rotation.
    final rot = ((sensorOrientation % 360) + 360) % 360;
    if (rot != 0) rgb = img.copyRotate(rgb, angle: rot);

    return Uint8List.fromList(img.encodeJpg(rgb, quality: _quality));
  }

  img.Image _bgraToImage(Uint8List bytes, int w, int h, int bytesPerRow) {
    final out = img.Image(width: w, height: h);
    for (var y = 0; y < h; y++) {
      final rowStart = y * bytesPerRow;
      for (var x = 0; x < w; x++) {
        final i = rowStart + x * 4;
        if (i + 3 >= bytes.length) continue;
        // Camera plugin delivers BGRA on iOS.
        final b = bytes[i], g = bytes[i + 1], r = bytes[i + 2];
        out.setPixelRgb(x, y, r, g, b);
      }
    }
    return out;
  }

  img.Image _nv21ToImage(Uint8List bytes, int w, int h) {
    final out = img.Image(width: w, height: h);
    final frameSize = w * h;
    for (var y = 0; y < h; y++) {
      final uvRow = frameSize + (y >> 1) * w;
      for (var x = 0; x < w; x++) {
        final yVal = bytes[y * w + x] & 0xff;
        final uvIndex = uvRow + (x & ~1);
        final v = (uvIndex < bytes.length ? bytes[uvIndex] : 128) & 0xff;
        final u = (uvIndex + 1 < bytes.length ? bytes[uvIndex + 1] : 128) & 0xff;
        out.setPixelRgb(x, y, _clip(yVal + 1.370705 * (v - 128)),
            _clip(yVal - 0.337633 * (u - 128) - 0.698001 * (v - 128)),
            _clip(yVal + 1.732446 * (u - 128)));
      }
    }
    return out;
  }

  img.Image _yuv420ToImage(CameraImage image, int w, int h) {
    final out = img.Image(width: w, height: h);
    final yP = image.planes[0];
    final uP = image.planes[1];
    final vP = image.planes[2];
    final uvRowStride = uP.bytesPerRow;
    final uvPixelStride = uP.bytesPerPixel ?? 1;
    for (var y = 0; y < h; y++) {
      final yRow = y * yP.bytesPerRow;
      final uvRow = (y >> 1) * uvRowStride;
      for (var x = 0; x < w; x++) {
        final yi = yRow + x;
        final uvi = uvRow + (x >> 1) * uvPixelStride;
        final yVal = yi < yP.bytes.length ? (yP.bytes[yi] & 0xff) : 0;
        final u = uvi < uP.bytes.length ? (uP.bytes[uvi] & 0xff) : 128;
        final v = uvi < vP.bytes.length ? (vP.bytes[uvi] & 0xff) : 128;
        out.setPixelRgb(x, y, _clip(yVal + 1.370705 * (v - 128)),
            _clip(yVal - 0.337633 * (u - 128) - 0.698001 * (v - 128)),
            _clip(yVal + 1.732446 * (u - 128)));
      }
    }
    return out;
  }

  static int _clip(double v) => v < 0 ? 0 : (v > 255 ? 255 : v.round());
}

/// One captured still: its actual offset (ms from record start) and the JPEG bytes.
class CapturedFrame {
  const CapturedFrame({required this.tOffsetMs, required this.jpeg});
  final int tOffsetMs;
  final Uint8List jpeg;
}
