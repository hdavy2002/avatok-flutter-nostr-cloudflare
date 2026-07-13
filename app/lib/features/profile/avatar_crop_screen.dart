import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:image/image.dart' as img;

import '../../core/ui/avatok_dark.dart';

/// Lightweight, dependency-free circular crop editor. The user pans/zooms/rotates
/// the picked image inside a circular viewport; we capture exactly that circle,
/// flatten it onto white, downscale to a 320px master and re-encode as a tiny
/// JPEG (~10–18 KB) toward a byte budget.
///
/// Why so small: avatars never display larger than ~96pt (≈288px @3x) and are
/// always served through Cloudflare's per-size /cdn-cgi/image transform (a 100px
/// icon is delivered as ~5 KB AVIF), so the stored master only needs to cover the
/// biggest on-screen size. Keeping it tiny also matters because the server
/// re-fetches the avatar and runs image moderation *synchronously* inside the
/// /api/profile save — a fat PNG (0.5–1.5 MB) made that request blow past the
/// client timeout and users saw a bogus "check your internet" error. The circle's
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

  static const int _masterPx = 320; // stored avatar size; CDN downsizes per display
  static const int _byteBudget = 18 * 1024; // aim for a ~10–18 KB master

  /// Decode the captured PNG, composite it onto an opaque white background
  /// (JPEG has no alpha), downscale to a 320px master, and encode JPEG toward a
  /// small byte budget — stepping quality down for busy photos so even detailed
  /// images stay tiny. Falls back to the original bytes if decoding fails.
  Uint8List _toCompactJpeg(Uint8List pngBytes) {
    final decoded = img.decodePng(pngBytes);
    if (decoded == null) return pngBytes;
    final flattened = img.Image(width: decoded.width, height: decoded.height);
    img.fill(flattened, color: img.ColorRgb8(255, 255, 255));
    img.compositeImage(flattened, decoded);
    final sized = img.copyResize(flattened, width: _masterPx, height: _masterPx);
    var out = Uint8List.fromList(img.encodeJpg(sized, quality: 80));
    // If a detailed photo overshoots the budget, drop quality until it fits
    // (floor ~45 so faces never turn to mush).
    for (var q = 72; out.length > _byteBudget && q >= 45; q -= 9) {
      out = Uint8List.fromList(img.encodeJpg(sized, quality: q));
    }
    return out;
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AD.bg,
      appBar: PreferredSize(
        preferredSize: const Size.fromHeight(76),
        child: Container(
          decoration: const BoxDecoration(
            color: AD.headerFooter,
            border: Border(bottom: BorderSide(color: AD.borderHairline, width: 1)),
          ),
          child: SafeArea(
            bottom: false,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(10, 8, 18, 12),
              child: Row(children: [
                const AdBackButton(),
                const SizedBox(width: 14),
                Expanded(
                  child: Text.rich(
                    const TextSpan(children: [
                      TextSpan(text: 'Crop', style: TextStyle(color: AD.primaryBadge)),
                      TextSpan(text: ' photo'),
                    ]),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: ADText.appTitle().copyWith(height: 1.08),
                  ),
                ),
              ]),
            ),
          ),
        ),
      ),
      body: Center(
        child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [
          // Soft-ringed circle AROUND the capture boundary (never captured).
          Container(
            decoration: const BoxDecoration(
              shape: BoxShape.circle,
              border: Border.fromBorderSide(BorderSide(color: AD.borderAvatar, width: 2)),
              boxShadow: AD.overlayShadow,
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
          const AdSticker('pinch to zoom · drag to move · twist to rotate', kind: AdStickerKind.hint),
          const SizedBox(height: 26),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 24),
            child: AdButton(
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
