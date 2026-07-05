import 'dart:typed_data';

import 'package:image/image.dart' as img;

/// [LIVE-COMPRESS-1] Still-frame downscale + JPEG re-encode for liveness upload.
///
/// Rationale: the raw `CameraController.takePicture()` stills at
/// `ResolutionPreset.medium` (720p) come back as ~2–7 MB JPEGs each, and we
/// upload several (expression/profiles/neutral) plus the clip — historically up
/// to ~28 MB total. Server-side liveness (face geometry / LLaVA) does not need
/// more than a ~640 px face crop, so we downscale the long edge to 640 px and
/// re-encode JPEG q75. That takes a single still from ~3 MB to ~60–120 KB, and
/// the whole upload from ~28 MB down toward the ~1.5 MB budget.
///
/// The `image` package (already a direct dependency, pubspec `image: ^4.2.0`)
/// gives us a pure-Dart JPEG decode/encode, so no NEW plugin is added and this
/// works identically on Android/iOS. It is CPU-only and runs off the camera
/// thread (called from `await`ed step transitions, not the ML Kit frame loop).
///
/// Fail-open: if decode fails for any reason we return the ORIGINAL bytes so a
/// verification never breaks just because compression hiccuped — the server
/// still receives a valid (if larger) image.
class CaptureCompress {
  CaptureCompress._();

  /// Max long-edge in px after downscale. 640 keeps the face well above the
  /// resolution the server checks need while slashing bytes.
  static const int maxLongEdge = 640;

  /// JPEG quality for the re-encode. 75 is visually clean for a face frame and
  /// roughly halves size vs q90.
  static const int jpegQuality = 75;

  /// Downscale [bytes] so its long edge ≤ [maxLongEdge] and re-encode as JPEG
  /// q[jpegQuality]. Returns the smaller of (compressed, original) so we never
  /// make a frame BIGGER than it started (e.g. an already-tiny image).
  static Uint8List still(Uint8List bytes) {
    try {
      final decoded = img.decodeImage(bytes);
      if (decoded == null) return bytes;

      final longEdge = decoded.width > decoded.height ? decoded.width : decoded.height;
      final resized = longEdge > maxLongEdge
          ? img.copyResize(
              decoded,
              width: decoded.width >= decoded.height ? maxLongEdge : null,
              height: decoded.height > decoded.width ? maxLongEdge : null,
              interpolation: img.Interpolation.average,
            )
          : decoded;

      final out = Uint8List.fromList(img.encodeJpg(resized, quality: jpegQuality));
      // Guard against pathological cases where re-encode is larger.
      return out.lengthInBytes < bytes.lengthInBytes ? out : bytes;
    } catch (_) {
      return bytes; // fail-open — never block verification on compression
    }
  }
}
