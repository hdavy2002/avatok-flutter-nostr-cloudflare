import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';

import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';

/// Lightweight, dependency-free circular crop editor. The user pans/zooms the
/// picked image inside a circular viewport; we capture exactly that circle
/// (transparent corners) as PNG bytes — a perfect-circle crop ready to upload.
class AvatarCropScreen extends StatefulWidget {
  final Uint8List imageBytes;
  const AvatarCropScreen({super.key, required this.imageBytes});
  @override
  State<AvatarCropScreen> createState() => _AvatarCropScreenState();
}

class _AvatarCropScreenState extends State<AvatarCropScreen> {
  static const double _box = 300; // logical size of the crop circle
  final _boundaryKey = GlobalKey();
  final _tc = TransformationController();
  bool _busy = false;

  Future<void> _done() async {
    setState(() => _busy = true);
    try {
      final boundary = _boundaryKey.currentContext!.findRenderObject() as RenderRepaintBoundary;
      final image = await boundary.toImage(pixelRatio: 512 / _box); // ~512px output
      final data = await image.toByteData(format: ui.ImageByteFormat.png);
      if (!mounted) return;
      Navigator.pop(context, data?.buffer.asUint8List());
    } catch (_) {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  void dispose() {
    _tc.dispose();
    super.dispose();
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
                  child: InteractiveViewer(
                    transformationController: _tc,
                    minScale: 0.5,
                    maxScale: 6,
                    clipBehavior: Clip.none,
                    child: Image.memory(widget.imageBytes, width: _box, height: _box, fit: BoxFit.cover),
                  ),
                ),
              ),
            ),
          ),
          const SizedBox(height: 22),
          const ZineSticker('pinch to zoom · drag to position', kind: ZineStickerKind.hint),
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
