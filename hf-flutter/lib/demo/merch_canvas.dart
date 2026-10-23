import 'dart:math' as math;
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';

import 'theme.dart';

/// [HF-MERCH-APP-1] Drawing for the merch studio: the T-shirt, the art placed on it, and the two PNGs the server wants
/// (the print file at 300 DPI, and a picture of the finished shirt). Pure drawing, no network.

/// How the art is cut. The names are what the server's `placement.frame` takes.
enum MerchFrame { none, square, circle, rect }

extension MerchFrameInfo on MerchFrame {
  String get label => switch (this) {
        MerchFrame.none => 'Whole art',
        MerchFrame.square => 'Square',
        MerchFrame.circle => 'Circle',
        MerchFrame.rect => 'Portrait',
      };

  /// Width divided by height of the cut. null for [MerchFrame.none]: the print has the art's own shape.
  double? get fixedAspect => switch (this) {
        MerchFrame.none => null,
        MerchFrame.square => 1.0,
        MerchFrame.circle => 1.0,
        MerchFrame.rect => 0.8,
      };
}

/// `#rrggbb` from the server as a colour; a soft grey when it cannot be read.
Color merchColour(String hex) {
  final h = hex.replaceAll('#', '').trim();
  final v = int.tryParse(h.length == 6 ? 'FF$h' : h, radix: 16);
  return v == null ? C.sand : Color(v);
}

/// The clip path for a frame inside [r].
Path merchFramePath(MerchFrame f, Rect r) {
  final p = Path();
  if (f == MerchFrame.circle) {
    p.addOval(r);
  } else {
    p.addRect(r);
  }
  return p;
}

/// The part of the picture (in its own pixels) that fills a frame of [aspect] (width / height): a centred "cover" crop.
Rect merchCoverSource(double imageW, double imageH, double aspect) {
  final imageAspect = imageW / imageH;
  if (imageAspect > aspect) {
    final w = imageH * aspect;
    return Rect.fromLTWH((imageW - w) / 2, 0, w, imageH);
  }
  final h = imageW / aspect;
  return Rect.fromLTWH(0, (imageH - h) / 2, imageW, h);
}

/// Decodes picked art no bigger than [maxSide] pixels on its long side (a phone photo can be 12000 px).
Future<ui.Image> merchDecode(Uint8List bytes, {required int width, required int height, required int maxSide}) async {
  final landscape = width >= height;
  final codec = await ui.instantiateImageCodec(
    bytes,
    targetWidth: landscape && width > maxSide ? maxSide : null,
    targetHeight: !landscape && height > maxSide ? maxSide : null,
  );
  try {
    final frame = await codec.getNextFrame();
    return frame.image;
  } finally {
    codec.dispose();
  }
}

/// A T-shirt outline that fits [s].
Path merchShirtPath(Size s, bool back) {
  final w = s.width;
  final h = s.height;
  final neckDip = back ? 0.085 : 0.15;
  final p = Path()
    ..moveTo(w * 0.38, h * 0.06)
    ..lineTo(w * 0.17, h * 0.11)
    ..lineTo(w * 0.02, h * 0.31)
    ..lineTo(w * 0.15, h * 0.38)
    ..lineTo(w * 0.20, h * 0.31)
    ..lineTo(w * 0.20, h * 0.96)
    ..lineTo(w * 0.80, h * 0.96)
    ..lineTo(w * 0.80, h * 0.31)
    ..lineTo(w * 0.85, h * 0.38)
    ..lineTo(w * 0.98, h * 0.31)
    ..lineTo(w * 0.83, h * 0.11)
    ..lineTo(w * 0.62, h * 0.06)
    ..quadraticBezierTo(w * 0.5, h * neckDip, w * 0.38, h * 0.06)
    ..close();
  return p;
}

/// Where the print area and the print sit on a shirt drawn at [size]. One inch is [ppi] pixels (a shirt chest is about 20 in).
class ShirtGeometry {
  const ShirtGeometry(this.size, this.areaW, this.areaH);

  final Size size;
  final double areaW;
  final double areaH;

  double get ppi => size.width * 0.60 / 20;

  Rect get areaRect {
    final w = areaW * ppi;
    final h = areaH * ppi;
    return Rect.fromLTWH((size.width - w) / 2, size.height * 0.17, w, h);
  }

  /// A print of [w] x [h] inches whose top-left corner is [x], [y] inches from the top-left of the print area.
  Rect printRect(double x, double y, double w, double h) {
    final a = areaRect;
    return Rect.fromLTWH(a.left + x * ppi, a.top + y * ppi, w * ppi, h * ppi);
  }
}

/// Everything needed to draw one shirt with art on it.
class ShirtScene {
  const ShirtScene({
    required this.colour,
    required this.back,
    required this.areaW,
    required this.areaH,
    this.art,
    this.source,
    this.frame = MerchFrame.none,
    this.x = 0,
    this.y = 0,
    this.w = 0,
    this.h = 0,
    this.guides = true,
  });

  final Color colour;
  final bool back;
  final double areaW;
  final double areaH;
  final ui.Image? art;

  /// The part of [art] to show, in the picture's own pixels.
  final Rect? source;
  final MerchFrame frame;

  /// The print, in inches from the top-left of the print area.
  final double x;
  final double y;
  final double w;
  final double h;

  /// The dotted print-area box. Off for the picture buyers see.
  final bool guides;
}

class ShirtPainter extends CustomPainter {
  const ShirtPainter(this.scene);

  final ShirtScene scene;

  @override
  void paint(Canvas canvas, Size size) {
    final geo = ShirtGeometry(size, scene.areaW, scene.areaH);
    final body = merchShirtPath(size, scene.back);
    canvas.drawPath(body, Paint()..color = scene.colour);
    canvas.drawPath(
      body,
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 2.5
        ..strokeJoin = StrokeJoin.round
        ..color = C.brass,
    );
    if (scene.guides) {
      canvas.drawRect(
        geo.areaRect,
        Paint()
          ..style = PaintingStyle.stroke
          ..strokeWidth = 1.5
          ..color = C.brass.withValues(alpha: 0.9),
      );
    }
    final art = scene.art;
    final src = scene.source;
    if (art != null && src != null && scene.w > 0 && scene.h > 0) {
      final r = geo.printRect(scene.x, scene.y, scene.w, scene.h);
      canvas.save();
      canvas.clipPath(merchFramePath(scene.frame, r));
      canvas.drawImageRect(art, src, r, Paint()..filterQuality = FilterQuality.medium);
      canvas.restore();
      if (scene.guides) {
        final edge = Paint()
          ..style = PaintingStyle.stroke
          ..strokeWidth = 2
          ..color = C.rani;
        if (scene.frame == MerchFrame.circle) {
          canvas.drawOval(r, edge);
        } else {
          canvas.drawRect(r, edge);
        }
      }
    }
  }

  @override
  bool shouldRepaint(covariant ShirtPainter old) => old.scene != scene;
}

Future<Uint8List> _png(ui.Picture picture, int w, int h) async {
  final image = await picture.toImage(w, h);
  try {
    final data = await image.toByteData(format: ui.ImageByteFormat.png);
    if (data == null) throw StateError('png encode failed');
    return data.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes);
  } finally {
    image.dispose();
    picture.dispose();
  }
}

/// The finished print file: [art] cut to [frame] and drawn at 300 DPI for a print of [wIn] x [hIn] inches (never above 5000 px).
/// The top-left pixel is cleared so the PNG always carries a see-through channel, which the print partner needs.
Future<Uint8List> renderPrintPng({
  required ui.Image art,
  required Rect source,
  required MerchFrame frame,
  required double wIn,
  required double hIn,
}) async {
  final rawW = wIn * 300;
  final rawH = hIn * 300;
  final k = math.min(1.0, 5000 / math.max(rawW, rawH));
  final outW = math.max(1, math.min(5000, (rawW * k).round()));
  final outH = math.max(1, math.min(5000, (rawH * k).round()));
  final dst = Rect.fromLTWH(0, 0, outW.toDouble(), outH.toDouble());
  final recorder = ui.PictureRecorder();
  final canvas = Canvas(recorder, dst);
  canvas.save();
  canvas.clipPath(merchFramePath(frame, dst));
  canvas.drawImageRect(art, source, dst, Paint()..filterQuality = FilterQuality.high);
  canvas.restore();
  canvas.drawRect(Rect.fromLTWH(0, 0, 1, 1), Paint()..blendMode = BlendMode.clear);
  return _png(recorder.endRecording(), outW, outH);
}

/// The picture of the shirt with the art on it that buyers see (no guides). [width] pixels wide, 10:9 tall.
Future<Uint8List> renderMockupPng(ShirtScene scene, {int width = 800}) async {
  final w = width.toDouble();
  final h = (width * 10 / 9).roundToDouble();
  final recorder = ui.PictureRecorder();
  final canvas = Canvas(recorder, Rect.fromLTWH(0, 0, w, h));
  canvas.drawRect(Rect.fromLTWH(0, 0, w, h), Paint()..color = C.ivory);
  ShirtPainter(scene).paint(canvas, Size(w, h));
  return _png(recorder.endRecording(), width, h.round());
}
