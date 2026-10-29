import 'dart:async';
import 'dart:math' as math;
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';

import '../../data/repos/my_photos_repo.dart';
import '../../data/telemetry.dart';
import '../channel_pop_kit.dart';
import '../theme.dart';

/// [HF-PHOTO-CROP-APP] "Adjust your photo": the full-screen editor that opens after a photo is picked or a selfie is taken, before
/// anything is uploaded. Pure Dart (no native cropper): drag to move, pinch or slider or − / + to zoom, Reset, then "Use this photo".
/// The photo always covers the frame (it cannot be dragged or zoomed out past its edges).
///
/// Frame: profile = a square (shown with a circle mask); cover = 3 : 1, the shape the cover has on the Me card.

/// What the editor answers: the visible area as fractions of the picture (0..1), or a request to choose another picture.
class PhotoCropResult {
  const PhotoCropResult.use({required this.left, required this.top, required this.right, required this.bottom, required this.zoom}) : another = false;
  const PhotoCropResult.another()
      : left = 0,
        top = 0,
        right = 1,
        bottom = 1,
        zoom = 1,
        another = true;

  final double left;
  final double top;
  final double right;
  final double bottom;
  final double zoom;

  /// True when she tapped "Choose another".
  final bool another;
}

/// The pan and zoom arithmetic, kept apart from the widget so it can be tested. [zoom] 1 = the photo just covers the frame.
class CropMath {
  CropMath({required this.imageW, required this.imageH, required this.frameW, required this.frameH, this.maxZoom = 6})
      : cx = imageW / 2,
        cy = imageH / 2;

  final double imageW;
  final double imageH;
  final double frameW;
  final double frameH;
  final double maxZoom;

  /// Point of the picture (in its own pixels) shown at the middle of the frame.
  double cx;
  double cy;
  double zoom = 1;

  /// Screen pixels per picture pixel at zoom 1: the cover-fit.
  double get minScale => math.max(frameW / imageW, frameH / imageH);
  double get scale => minScale * zoom;

  /// Size of the visible window, in picture pixels.
  double get visW => frameW / scale;
  double get visH => frameH / scale;

  void setZoom(double z) {
    zoom = math.min(math.max(z, 1.0), maxZoom);
    _clamp();
  }

  /// Moves the picture by [dx], [dy] screen pixels (the picture follows the finger).
  void pan(double dx, double dy) {
    cx -= dx / scale;
    cy -= dy / scale;
    _clamp();
  }

  void reset() {
    zoom = 1;
    cx = imageW / 2;
    cy = imageH / 2;
  }

  void _clamp() {
    final loX = visW / 2;
    final hiX = imageW - visW / 2;
    final loY = visH / 2;
    final hiY = imageH - visH / 2;
    cx = hiX < loX ? imageW / 2 : math.min(math.max(cx, loX), hiX);
    cy = hiY < loY ? imageH / 2 : math.min(math.max(cy, loY), hiY);
  }

  /// The visible window in picture pixels.
  Rect get src => Rect.fromCenter(center: Offset(cx, cy), width: visW, height: visH);

  double get left => math.max(0, src.left / imageW);
  double get top => math.max(0, src.top / imageH);
  double get right => math.min(1, src.right / imageW);
  double get bottom => math.min(1, src.bottom / imageH);
}

/// Big pill button for the new photo screens: 56 px tall, 18 px label, never squashed.
class PhotoButton extends StatelessWidget {
  const PhotoButton(this.label, {super.key, required this.onTap, this.icon, this.primary = true, this.expand = true});

  final String label;
  final VoidCallback? onTap;
  final IconData? icon;
  final bool primary;
  final bool expand;

  @override
  Widget build(BuildContext context) {
    final off = onTap == null;
    final fg = off ? C.muted : (primary ? C.white : C.maroon);
    return Semantics(
      button: true,
      enabled: !off,
      child: Material(
        color: C.clear,
        child: InkWell(
          borderRadius: BorderRadius.circular(999),
          onTap: onTap,
          child: Container(
            constraints: const BoxConstraints(minHeight: 56),
            padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 10),
            decoration: BoxDecoration(
              color: off ? const Color(0xFFE8DDE6) : (primary ? C.maroon : C.white),
              borderRadius: BorderRadius.circular(999),
              border: primary || off ? null : Border.all(color: C.line, width: 1.5),
            ),
            child: Row(
              mainAxisSize: expand ? MainAxisSize.max : MainAxisSize.min,
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                if (icon != null) ...[Icon(icon, size: 22, color: fg), const SizedBox(width: 8)],
                Flexible(child: Text(label, textAlign: TextAlign.center, style: t(18, color: fg, w: FontWeight.w800))),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// The editor screen. Push it with [kind] and the picture's bytes; it pops a [PhotoCropResult] (or null when she backs out).
class PhotoCropEditor extends StatefulWidget {
  const PhotoCropEditor({super.key, required this.bytes, required this.kind});

  final Uint8List bytes;
  final PhotoKind kind;

  @override
  State<PhotoCropEditor> createState() => _PhotoCropEditorState();
}

class _PhotoCropEditorState extends State<PhotoCropEditor> {
  ui.Image? _image;
  bool _failed = false;
  CropMath? _m;
  Size? _frame;
  double _startZoom = 1;
  final Stopwatch _sw = Stopwatch()..start();

  bool get _profile => widget.kind == PhotoKind.profile;

  @override
  void initState() {
    super.initState();
    unawaited(_decode());
  }

  @override
  void dispose() {
    _image?.dispose();
    super.dispose();
  }

  Future<void> _decode() async {
    try {
      final codec = await ui.instantiateImageCodec(widget.bytes);
      final frame = await codec.getNextFrame();
      codec.dispose();
      if (!mounted) {
        frame.image.dispose();
        return;
      }
      setState(() => _image = frame.image);
    } catch (_) {
      if (mounted) setState(() => _failed = true);
    }
  }

  /// The smallest picture the server takes.
  bool get _tooSmall {
    final i = _image;
    if (i == null) return false;
    return _profile ? (i.width < PhotoLimits.profileMin || i.height < PhotoLimits.profileMin) : (i.width < PhotoLimits.coverMinW || i.height < PhotoLimits.coverMinH);
  }

  CropMath _mathFor(Size frame) {
    final i = _image!;
    final cur = _m;
    if (cur != null && _frame == frame) return cur;
    _frame = frame;
    return _m = CropMath(imageW: i.width.toDouble(), imageH: i.height.toDouble(), frameW: frame.width, frameH: frame.height);
  }

  void _use() {
    final m = _m;
    if (m == null) return;
    Telemetry.event('hf_photo_crop', {'kind': widget.kind.name, 'zoom': double.parse(m.zoom.toStringAsFixed(2)), 'ms': _sw.elapsedMilliseconds});
    Navigator.of(context).pop(PhotoCropResult.use(left: m.left, top: m.top, right: m.right, bottom: m.bottom, zoom: m.zoom));
  }

  void _another() => Navigator.of(context).pop(const PhotoCropResult.another());

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: C.page,
      body: Column(children: [
        const GpHeader(title: 'Adjust your photo', bag: false),
        Expanded(child: _body()),
      ]),
    );
  }

  Widget _body() {
    if (_failed) return _message('That picture could not be opened. Please choose another one.');
    if (_image == null) return const Center(child: CircularProgressIndicator(color: C.maroon));
    if (_tooSmall) {
      return _message(_profile
          ? 'That photo is too small. Please choose one that is at least 200 by 200 pixels.'
          : 'That photo is too small for a cover. Please choose a wider one, at least 640 by 200 pixels.');
    }
    return LayoutBuilder(builder: (context, c) {
      final availW = math.max(120.0, c.maxWidth - 32);
      final frame = _profile ? Size.square(math.min(availW, 340)) : Size(availW, availW / 3);
      final m = _mathFor(frame);
      return SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(16, 16, 16, 28),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text(
            _profile ? 'Move and zoom so your face is in the circle.' : 'Move and zoom to pick the part you want.',
            textAlign: TextAlign.center,
            style: t(17, w: FontWeight.w700, h: 1.4),
          ),
          const SizedBox(height: 14),
          Center(
            child: Semantics(
              label: 'Photo editor. Drag to move the photo, pinch to zoom.',
              child: ClipRRect(
                borderRadius: BorderRadius.circular(_profile ? 24 : 16),
                child: GestureDetector(
                  onScaleStart: (_) => _startZoom = m.zoom,
                  onScaleUpdate: (d) => setState(() {
                    m.setZoom(_startZoom * d.scale);
                    m.pan(d.focalPointDelta.dx, d.focalPointDelta.dy);
                  }),
                  child: SizedBox(
                    width: frame.width,
                    height: frame.height,
                    child: CustomPaint(painter: _CropPainter(_image!, m.src, _profile)),
                  ),
                ),
              ),
            ),
          ),
          const SizedBox(height: 16),
          Row(children: [
            _RoundStep(icon: Icons.remove_rounded, label: 'Zoom out', onTap: () => setState(() => m.setZoom(m.zoom - 0.5))),
            Expanded(
              child: Semantics(
                label: 'Zoom',
                child: Slider(
                  value: m.zoom,
                  min: 1,
                  max: m.maxZoom,
                  activeColor: C.maroon,
                  inactiveColor: C.line,
                  onChanged: (v) => setState(() => m.setZoom(v)),
                ),
              ),
            ),
            _RoundStep(icon: Icons.add_rounded, label: 'Zoom in', onTap: () => setState(() => m.setZoom(m.zoom + 0.5))),
          ]),
          const SizedBox(height: 4),
          Center(child: PhotoButton('Reset', icon: Icons.refresh_rounded, primary: false, expand: false, onTap: () => setState(m.reset))),
          const SizedBox(height: 20),
          PhotoButton('Use this photo', icon: Icons.check_rounded, onTap: _use),
          const SizedBox(height: 12),
          PhotoButton('Choose another', primary: false, onTap: _another),
        ]),
      );
    });
  }

  Widget _message(String text) {
    return ListView(padding: const EdgeInsets.fromLTRB(16, 20, 16, 28), children: [
      Container(
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(color: const Color(0xFFFFF0F1), borderRadius: BorderRadius.circular(20), border: Border.all(color: const Color(0xFFF2C0C4), width: 2)),
        child: Text(text, style: t(16, color: const Color(0xFF5B2A2E), w: FontWeight.w700, h: 1.5)),
      ),
      const SizedBox(height: 16),
      PhotoButton('Choose another', onTap: _another),
    ]);
  }
}

/// Round − / + button (56 px, so it is easy to hit).
class _RoundStep extends StatelessWidget {
  const _RoundStep({required this.icon, required this.label, required this.onTap});

  final IconData icon;
  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      label: label,
      child: Material(
        color: C.white,
        shape: const CircleBorder(side: BorderSide(color: C.line, width: 1.5)),
        child: InkWell(
          customBorder: const CircleBorder(),
          onTap: onTap,
          child: SizedBox(width: 56, height: 56, child: ExcludeSemantics(child: Icon(icon, size: 26, color: C.maroon))),
        ),
      ),
    );
  }
}

/// Draws the visible window of the picture, and for a profile photo a dark veil with a circular hole.
class _CropPainter extends CustomPainter {
  const _CropPainter(this.image, this.src, this.circle);

  final ui.Image image;
  final Rect src;
  final bool circle;

  @override
  void paint(Canvas canvas, Size size) {
    final dst = Offset.zero & size;
    canvas.drawImageRect(image, src, dst, Paint()..filterQuality = FilterQuality.medium);
    if (circle) {
      final hole = Rect.fromCircle(center: dst.center, radius: size.shortestSide / 2 - 6);
      final veil = Path()
        ..fillType = PathFillType.evenOdd
        ..addRect(dst)
        ..addOval(hole);
      canvas.drawPath(veil, Paint()..color = C.deep.withValues(alpha: .6));
      canvas.drawOval(hole, Paint()..style = PaintingStyle.stroke..strokeWidth = 3..color = C.white);
    } else {
      canvas.drawRect(dst.deflate(1.5), Paint()..style = PaintingStyle.stroke..strokeWidth = 3..color = C.white);
    }
  }

  @override
  bool shouldRepaint(covariant _CropPainter old) => old.src != src || old.image != image || old.circle != circle;
}
