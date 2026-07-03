import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:image/image.dart' as img;

import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';

/// Lightweight, dependency-free circular crop editor. The user pans/zooms the
/// picked image inside a circular viewport; we capture exactly that circle,
/// then flatten it onto white and re-encode as a compact JPEG (~512px, q82).
///
/// Why JPEG, not the raw PNG capture: the server re-fetches the avatar and runs
/// it through image moderation *synchronously* inside the /api/profile save, so
/// a fat PNG (0.5–1.5 MB) makes that request blow past the client timeout and
/// the user sees a bogus "check your internet" error. A 512px JPEG is ~40 KB —
/// 15–20× smaller — so moderation finishes well within the timeout. The circle's
/// transparent corners are flattened to white (JPEG has no alpha); avatars are
/// always displayed clipped to a circle, so the corners are never visible.
class AvatarCropScreen extends StatefulWidget {
  final Uint8List imageBytes;
  const AvatarCropScreen({super.key, required this.imageBytes});
  @override
  State<AvatarCropScreen> createState() => _AvatarCropScreenState();
}

class _AvatarCropScreenState extends State<AvatarCropScreen> {
  static const double _box = 300; // logical size of the crop circle
  final _boundaryKey = GlobalKey();
  // Live transform applied to the photo inside the circle: pan (drag),
  // pinch-zoom, AND two-finger rotation. Whatever is framed in the circle is
  // exactly what gets captured, so any rotation is baked into the cropped JPEG.
  Matrix4 _matrix = Matrix4.identity();
  double _prevScale = 1.0;
  double _prevRotation = 0.0;
  bool _busy = false;

  void _onScaleStart(ScaleStartDetails d) {
    _prevScale = 1.0;
    _prevRotation = 0.0;
  }

  void _onScaleUpdate(ScaleUpdateDetails d) {
    // ScaleUpdateDetails.scale/.rotation are cumulative from the gesture start,
    // so track the previous values to apply per-frame deltas.
    final scaleDelta = _prevScale == 0 ? 1.0 : d.scale / _prevScale;
    final rotationDelta = d.rotation - _prevRotation;
    _prevScale = d.scale;
    _prevRotation = d.rotation;
    final f = d.localFocalPoint;
    // Zoom + rotate about the fingers' focal point, then apply the pan delta.
    final step = Matrix4.identity()
      ..translate(f.dx, f.dy)
      ..rotateZ(rotationDelta)
      ..scale(scaleDelta, scaleDelta)
      ..translate(-f.dx, -f.dy);
    final pan =
        Matrix4.translationValues(d.focalPointDelta.dx, d.focalPointDelta.dy, 0);
    final next = pan.multiplied(step).multiplied(_matrix);
    // Soft-clamp overall zoom so the photo can't vanish or blow up off-screen.
    final s = next.getMaxScaleOnAxis();
    if (s < 0.3 || s > 8.0) return;
    setState(() => _matrix = next);
  }

  Future<void> _done() async {
    setState(() => _busy = true);
    try {
      final boundary = _boundaryKey.currentContext!.findRenderObject() as RenderRepaintBoundary;
      final image = await boundary.toImage(pixelRatio: 512 / _box); // ~512px capture
      final data = await image.toByteData(format: ui.ImageByteFormat.png);
      if (!mounted || data == null) { if (mounted) setState(() => _busy = false); return; }
      // Flatten the transparent-corner circle onto white and re-encode as a
      // compact JPEG so the upload (and the server-side moderation that re-fetches
      // it) stays small and fast. See the class doc for the full rationale.
      final jpeg = _toCompactJpeg(data.buffer.asUint8List());
      if (!mounted) return;
      Navigator.pop(context, jpeg);
    } catch (_) {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// Decode the captured PNG, composite it onto an opaque white background
  /// (JPEG has no alpha), clamp to 512×512, and encode JPEG at quality 82.
  /// Falls back to the original bytes if decoding somehow fails.
  Uint8List _toCompactJpeg(Uint8List pngBytes) {
    final decoded = img.decodePng(pngBytes);
    if (decoded == null) return pngBytes;
    final flattened = img.Image(width: decoded.width, height: decoded.height);
    img.fill(flattened, color: img.ColorRgb8(255, 255, 255));
    img.compositeImage(flattened, decoded);
    final sized = (flattened.width != 512 || flattened.height != 512)
        ? img.copyResize(flattened, width: 512, height: 512)
        : flattened;
    return img.encodeJpg(sized, quality: 82);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Zine.paper,
      appBar: const ZineAppBar(title: 'Crop photo', markWord: 'Crop'),
      body: Center(
        child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [
          // Ink ring + hard shadow AROUND the capture boundary (never captured).
          Container(
            decoration: const BoxDecoration(
              shape: BoxShape.circle,
              border: Border.fromBorderSide(BorderSide(color: Zine.ink, width: Zine.bwLg)),
              boxShadow: Zine.shadow,
            ),
            // Captured region = the circle (ClipOval inside the RepaintBoundary).
            child: RepaintBoundary(
              key: _boundaryKey,
              child: ClipOval(
                child: SizedBox(
                  width: _box,
                  height: _box,
                  child: GestureDetector(
                    onScaleStart: _onScaleStart,
                    onScaleUpdate: _onScaleUpdate,
                    child: Transform(
                      transform: _matrix,
                      child: Image.memory(widget.imageBytes, width: _box, height: _box, fit: BoxFit.cover),
                    ),
                  ),
                ),
              ),
            ),
          ),
          const SizedBox(height: 22),
          const ZineSticker('pinch to zoom · drag to move · twist to rotate', kind: ZineStickerKind.hint),
          const SizedBox(height: 26),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 24),
            child: ZineButton(
              label: 'Use this photo',
              fullWidth: true,
              fontSize: 18,
              loading: _busy,
              onPressed: _busy ? null : _done,
            ),
          ),
        ]),
      ),
    );
  }
}
