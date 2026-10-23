import 'dart:math' as math;
import 'dart:ui';

import 'contract.dart';
import 'fonts.dart';
import 'silhouettes.dart';

/// [HF-MERCH-STUDIO-2] How one layer is drawn. The on-screen stage and the print export both call [paintLayer], so the print is
/// exactly what the owner saw. Positions are inches on the print area; [ppi] = pixels per inch of the target canvas.

const double kRadPerDeg = math.pi / 180;

TextAlign _align(String a) => switch (a) {
      'left' => TextAlign.left,
      'right' => TextAlign.right,
      _ => TextAlign.center,
    };

/// A text layer laid out as paragraphs: [fill] on top, optional [stroke] (outline) underneath.
class TextShape {
  TextShape(this.fill, this.stroke, this.w, this.h);
  final Paragraph fill;
  final Paragraph? stroke;
  final double w;
  final double h;

  void dispose() {
    fill.dispose();
    stroke?.dispose();
  }
}

Paragraph _make(TextDesignLayer l, double fs, {Paint? foreground, Color? color, List<Shadow>? shadows, double? width}) {
  final family = MerchFonts.flutterFamily(l.font);
  final b = ParagraphBuilder(ParagraphStyle(textAlign: _align(l.align), fontFamily: family, fontSize: fs, height: l.lineHeight));
  b.pushStyle(TextStyle(
    color: foreground == null ? color : null,
    foreground: foreground,
    fontFamily: family,
    fontSize: fs,
    height: l.lineHeight,
    letterSpacing: l.letterSpacing * fs,
    shadows: shadows,
  ));
  b.addText(l.text.isEmpty ? ' ' : l.text);
  final p = b.build();
  p.layout(ParagraphConstraints(width: width ?? double.infinity));
  return p;
}

/// Lays out a text layer for a canvas of [ppi] pixels per inch. Call [TextShape.dispose] when done.
TextShape buildText(TextDesignLayer l, double ppi, {bool withStroke = true}) {
  final fs = math.max(2.0, l.sizeIn * ppi);
  final probe = _make(l, fs, color: const Color(0xFF000000));
  final width = probe.maxIntrinsicWidth.ceilToDouble() + 2;
  probe.dispose();
  final hasStroke = withStroke && l.stroke != null && l.strokeIn > 0;
  final shadows = l.shadow
      ? <Shadow>[Shadow(color: const Color(0x80000000), offset: Offset(fs * 0.05, fs * 0.06), blurRadius: fs * 0.12)]
      : null;
  Paragraph? stroke;
  if (hasStroke) {
    final paint = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = math.max(0.5, l.strokeIn * ppi)
      ..strokeJoin = StrokeJoin.round
      ..color = colourFromHex(l.stroke!);
    stroke = _make(l, fs, foreground: paint, shadows: shadows, width: width);
  }
  final fill = _make(l, fs, color: colourFromHex(l.fill), shadows: hasStroke ? null : shadows, width: width);
  return TextShape(fill, stroke, width, fill.height);
}

final Map<String, Size> _measured = <String, Size>{};

/// Size in inches of a text layer (measured with the font if it is loaded, else with the stand-in font).
Size measureTextIn(TextDesignLayer l) {
  final key = '${l.text}|${l.font}|${l.sizeIn}|${l.letterSpacing}|${l.lineHeight}|${MerchFonts.isLoaded(l.font)}';
  final hit = _measured[key];
  if (hit != null) return hit;
  final s = buildText(l, 100, withStroke: false);
  final r = Size(s.w / 100, s.h / 100);
  s.dispose();
  if (_measured.length > 300) _measured.clear();
  _measured[key] = r;
  return r;
}

/// Size in inches of any layer, before rotation.
Size layerSizeIn(DesignLayer l) => switch (l) {
      final ImageDesignLayer i => Size(i.w, i.h),
      final TextDesignLayer t => measureTextIn(t),
    };

/// Extra room around a layer for its outline and shadow, in inches.
double layerPadIn(DesignLayer l) => switch (l) {
      ImageDesignLayer() => 0,
      final TextDesignLayer t => (t.stroke != null ? t.strokeIn / 2 : 0.0) + (t.shadow ? t.sizeIn * 0.2 : 0.0),
    };

/// Axis-aligned box of a layer on the print area in inches (rotation included).
Rect layerBoundsIn(DesignLayer l) {
  final s = layerSizeIn(l);
  final pad = layerPadIn(l);
  final w = s.width + pad * 2, h = s.height + pad * 2;
  final a = l.rotation * kRadPerDeg;
  final bw = (w * math.cos(a)).abs() + (h * math.sin(a)).abs();
  final bh = (w * math.sin(a)).abs() + (h * math.cos(a)).abs();
  return Rect.fromLTRB(l.x - bw / 2, l.y - bh / 2, l.x + bw / 2, l.y + bh / 2);
}

/// Union of all visible layers clipped to the print area, in inches. Null when nothing visible lies inside.
Rect? designBounds(List<DesignLayer> layers, double areaW, double areaH) {
  var l0 = double.infinity, t0 = double.infinity, r0 = -double.infinity, b0 = -double.infinity;
  for (final l in layers) {
    if (!l.visible || l.opacity <= 0.01) continue;
    final b = layerBoundsIn(l);
    l0 = math.min(l0, b.left);
    t0 = math.min(t0, b.top);
    r0 = math.max(r0, b.right);
    b0 = math.max(b0, b.bottom);
  }
  if (!l0.isFinite) return null;
  final left = math.max(0.0, l0), top = math.max(0.0, t0);
  final right = math.min(areaW, r0), bottom = math.min(areaH, b0);
  if (right - left < 0.05 || bottom - top < 0.05) return null;
  return Rect.fromLTRB(left, top, right, bottom);
}

/// Draws [l] onto [canvas]. [origin] is where the print-area's top-left lands on the canvas. [image] is the decoded picture for
/// an image layer (null draws a soft placeholder while it loads). [fade] multiplies the layer opacity.
void paintLayer(Canvas canvas, DesignLayer l, {required double ppi, required Offset origin, Image? image, double fade = 1}) {
  if (!l.visible) return;
  final op = math.max(0.0, math.min(1.0, l.opacity * fade));
  if (op <= 0.003) return;
  canvas.save();
  canvas.translate(origin.dx + l.x * ppi, origin.dy + l.y * ppi);
  if (l.rotation != 0) canvas.rotate(l.rotation * kRadPerDeg);
  if (l.flipX || l.flipY) canvas.scale(l.flipX ? -1.0 : 1.0, l.flipY ? -1.0 : 1.0);
  switch (l) {
    case final ImageDesignLayer il:
      final dst = Rect.fromCenter(center: Offset.zero, width: il.w * ppi, height: il.h * ppi);
      if (image == null) {
        canvas.drawRRect(RRect.fromRectAndRadius(dst, Radius.circular(math.min(dst.width, dst.height) * 0.05)),
            Paint()..color = Color.fromRGBO(216, 27, 114, 0.12 * op));
      } else {
        final src = Rect.fromLTWH(0, 0, image.width.toDouble(), image.height.toDouble());
        final shrink = image.width / math.max(1.0, dst.width);
        canvas.drawImageRect(
          image,
          src,
          dst,
          Paint()
            ..isAntiAlias = true
            ..filterQuality = shrink > 1.5 ? FilterQuality.medium : FilterQuality.high
            ..color = Color.fromRGBO(255, 255, 255, op),
        );
      }
    case final TextDesignLayer tl:
      final shape = buildText(tl, ppi);
      final box = Rect.fromLTWH(-shape.w / 2, -shape.h / 2, shape.w, shape.h);
      final fade2 = op < 0.995;
      if (fade2) {
        canvas.saveLayer(box.inflate(math.max(shape.w, shape.h) * 0.5), Paint()..color = Color.fromRGBO(255, 255, 255, op));
      }
      final st = shape.stroke;
      if (st != null) canvas.drawParagraph(st, box.topLeft);
      canvas.drawParagraph(shape.fill, box.topLeft);
      if (fade2) canvas.restore();
      shape.dispose();
  }
  canvas.restore();
}
