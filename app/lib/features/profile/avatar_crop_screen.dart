import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';

import '../../core/theme.dart';

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
      backgroundColor: Colors.black,
      appBar: AppBar(
        backgroundColor: Colors.black,
        foregroundColor: Colors.white,
        elevation: 0,
        title: const Text('Crop photo'),
        actions: [
          TextButton(
            onPressed: _busy ? null : _done,
            child: _busy
                ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2, color: AvaColors.brand))
                : const Text('Use', style: TextStyle(color: AvaColors.brand, fontWeight: FontWeight.w800, fontSize: 16)),
          ),
        ],
      ),
      body: Center(
        child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [
          // Captured region = the circle (ClipOval inside the RepaintBoundary).
          RepaintBoundary(
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
          const SizedBox(height: 20),
          const Text('Pinch to zoom · drag to position',
              style: TextStyle(color: Colors.white70, fontSize: 13)),
        ]),
      ),
    );
  }
}
