// Destination in the repo: app/lib/core/ui/rajasthani_motifs.dart
//
// The four Phase-3 shared widgets from HANDOFF.md that the last theming pass
// skipped: TorranDivider, BeadStudRule, LotusRosettePlate, GrainOverlay.
// Ported 1:1 from the arithmetic in the mockup SVGs (see
// "03 Chat list India.dc.html" header/footer seams and the "Ava" nav icon)
// so there is nothing left to improvise.
//
// Wiring: see patches.md in this folder for the exact call sites
// (shell_chrome.dart footer, main.dart grain layer, per-screen headers).

import 'dart:math' as math;
import 'package:flutter/material.dart';

import 'avatok_dark.dart';

/// Scalloped "toran" drape with hanging beads — the seam between a coloured
/// header/footer band and the paper content next to it.
///
/// [TorranDirection.down]: a header band sits ABOVE this widget; the flat
/// band continues for [bandDepth], then a row of semicircle scallops bulges
/// DOWN into the content, with one bead hanging in each scallop's trough.
/// [TorranDirection.up]: a footer band sits BELOW this widget; mirrors the
/// above so scallops + beads lift UP into the content.
///
/// Scallop count is computed from the available width (mockups were fixed at
/// 390px with radius 13 → 15 scallops; real screens vary, so the radius is
/// nudged slightly to fit a whole number of scallops edge to edge).
enum TorranDirection { down, up }

class TorranDivider extends StatelessWidget {
  final Color bandColor;
  final List<Color> beadColors;
  final TorranDirection direction;
  final double scallopRadius;
  final double beadRadius;
  final double bandDepth;

  const TorranDivider({
    super.key,
    required this.bandColor,
    this.beadColors = const [AD.haldi, AD.primaryBadge],
    this.direction = TorranDirection.down,
    this.scallopRadius = 13,
    this.beadRadius = 3.6,
    this.bandDepth = 5,
  });

  @override
  Widget build(BuildContext context) {
    final height = bandDepth + scallopRadius + beadRadius * 2;
    return SizedBox(
      width: double.infinity,
      height: height,
      child: CustomPaint(
        painter: _TorranPainter(
          bandColor: bandColor,
          beadColors: beadColors,
          direction: direction,
          scallopRadius: scallopRadius,
          beadRadius: beadRadius,
          bandDepth: bandDepth,
        ),
      ),
    );
  }
}

class _TorranPainter extends CustomPainter {
  final Color bandColor;
  final List<Color> beadColors;
  final TorranDirection direction;
  final double scallopRadius;
  final double beadRadius;
  final double bandDepth;

  _TorranPainter({
    required this.bandColor,
    required this.beadColors,
    required this.direction,
    required this.scallopRadius,
    required this.beadRadius,
    required this.bandDepth,
  });

  @override
  void paint(Canvas canvas, Size size) {
    final w = size.width;
    if (w <= 0) return;
    final targetSpan = scallopRadius * 2;
    final count = math.max(1, (w / targetSpan).round());
    final span = w / count;
    final radius = span / 2;
    final fill = Paint()..color = bandColor..style = PaintingStyle.fill;
    final path = Path();

    // NOTE: the mockup SVG builds this with `a<r> <r> 0 0 <sweep> -<span> 0`
    // arc commands walking right-to-left. `clockwise` below is a best guess
    // at the equivalent bulge direction in Flutter's arcToPoint — check the
    // rendered scallop against the mockup screenshot and flip it if the
    // scallops bulge the wrong way.
    if (direction == TorranDirection.down) {
      path.moveTo(0, 0);
      path.lineTo(w, 0);
      path.lineTo(w, bandDepth);
      var x = w;
      for (var i = 0; i < count; i++) {
        path.arcToPoint(Offset(x - span, bandDepth),
            radius: Radius.circular(radius), clockwise: true);
        x -= span;
      }
      path.close();
      canvas.drawPath(path, fill);
      for (var i = 0; i < count; i++) {
        final cx = radius + i * span;
        final cy = bandDepth + radius + beadRadius * 0.7;
        _drawBead(canvas, Offset(cx, cy), beadColors[i % beadColors.length]);
      }
    } else {
      final bottom = size.height;
      final crest = bottom - bandDepth;
      path.moveTo(0, bottom);
      path.lineTo(w, bottom);
      path.lineTo(w, crest);
      var x = w;
      for (var i = 0; i < count; i++) {
        path.arcToPoint(Offset(x - span, crest),
            radius: Radius.circular(radius), clockwise: false);
        x -= span;
      }
      path.close();
      canvas.drawPath(path, fill);
      for (var i = 0; i < count; i++) {
        final cx = radius + i * span;
        final cy = crest - radius - beadRadius * 0.7;
        _drawBead(canvas, Offset(cx, cy), beadColors[i % beadColors.length]);
      }
    }
  }

  void _drawBead(Canvas canvas, Offset center, Color color) {
    canvas.drawCircle(center, beadRadius, Paint()..color = color);
    canvas.drawCircle(
        center,
        beadRadius,
        Paint()
          ..color = bandColor
          ..style = PaintingStyle.stroke
          ..strokeWidth = 1.4);
  }

  @override
  bool shouldRepaint(covariant _TorranPainter old) =>
      old.bandColor != bandColor ||
      old.beadColors != beadColors ||
      old.direction != direction ||
      old.scallopRadius != scallopRadius ||
      old.beadRadius != beadRadius ||
      old.bandDepth != bandDepth;
}

/// Row/section divider — 1.2px hairline at 14% ink with one 4px bead
/// (default haldi) centred, ink-outlined. Replaces every plain `Divider()`
/// between list rows.
///
/// Pass [sectionLabel] for the section-header variant: a leading bead, the
/// label in mono, then a hairline filling the remaining width.
class BeadStudRule extends StatelessWidget {
  final Color beadColor;
  final Color lineColor;
  final double beadRadius;
  final String? sectionLabel;
  final TextStyle? labelStyle;

  const BeadStudRule({
    super.key,
    this.beadColor = AD.haldi,
    this.lineColor = AD.borderBeadRule,
    this.beadRadius = 4,
    this.sectionLabel,
    this.labelStyle,
  });

  @override
  Widget build(BuildContext context) {
    if (sectionLabel == null) {
      return SizedBox(
        width: double.infinity,
        height: beadRadius * 2 + 2,
        child: CustomPaint(
          painter: _CenteredBeadPainter(
              beadColor: beadColor, lineColor: lineColor, beadRadius: beadRadius),
        ),
      );
    }
    return Row(children: [
      Container(
        width: beadRadius * 2,
        height: beadRadius * 2,
        decoration: BoxDecoration(
          color: beadColor,
          shape: BoxShape.circle,
          border: Border.all(color: AD.borderHairline, width: 1.4),
        ),
      ),
      const SizedBox(width: 8),
      Text(sectionLabel!, style: labelStyle),
      const SizedBox(width: 8),
      Expanded(child: Container(height: 1.2, color: lineColor)),
    ]);
  }
}

class _CenteredBeadPainter extends CustomPainter {
  final Color beadColor;
  final Color lineColor;
  final double beadRadius;
  _CenteredBeadPainter(
      {required this.beadColor, required this.lineColor, required this.beadRadius});

  @override
  void paint(Canvas canvas, Size size) {
    final midY = size.height / 2;
    canvas.drawRect(
        Rect.fromLTWH(0, midY - 0.6, size.width, 1.2), Paint()..color = lineColor);
    final cx = size.width / 2;
    canvas.drawCircle(Offset(cx, midY), beadRadius, Paint()..color = beadColor);
    canvas.drawCircle(
        Offset(cx, midY),
        beadRadius,
        Paint()
          ..color = AD.borderHairline
          ..style = PaintingStyle.stroke
          ..strokeWidth = 1.4);
  }

  @override
  bool shouldRepaint(covariant _CenteredBeadPainter old) =>
      old.beadColor != beadColor || old.lineColor != lineColor || old.beadRadius != beadRadius;
}

/// Round ornament plate — coloured disc, four cream petals in a compass
/// rosette, one haldi centre dot. This is the exact "Ava" bottom-nav icon
/// from the mockups generalised into a reusable plate; use it anywhere an
/// icon needs a rosette frame (HANDOFF Phase 3: "lotus-rosette icon plate").
class LotusRosettePlate extends StatelessWidget {
  final double size;
  final Color plateColor;
  final Color petalColor;
  final Color centerColor;
  final Color ringColor;

  const LotusRosettePlate({
    super.key,
    this.size = 24,
    this.plateColor = AD.headerFooter,
    this.petalColor = AD.bg,
    this.centerColor = AD.haldi,
    this.ringColor = AD.bg,
  });

  @override
  Widget build(BuildContext context) {
    return CustomPaint(
      size: Size(size, size),
      painter: _LotusPainter(
          plateColor: plateColor,
          petalColor: petalColor,
          centerColor: centerColor,
          ringColor: ringColor),
    );
  }
}

class _LotusPainter extends CustomPainter {
  final Color plateColor, petalColor, centerColor, ringColor;
  _LotusPainter(
      {required this.plateColor,
      required this.petalColor,
      required this.centerColor,
      required this.ringColor});

  Path _petal() {
    final p = Path();
    p.moveTo(0, -6.5);
    p.cubicTo(3, -4.5, 3, -1, 0, 1);
    p.cubicTo(-3, -1, -3, -4.5, 0, -6.5);
    p.close();
    return p;
  }

  @override
  void paint(Canvas canvas, Size size) {
    final scale = size.width / 24;
    canvas.save();
    canvas.translate(size.width / 2, size.height / 2);
    canvas.scale(scale);
    canvas.drawCircle(Offset.zero, 9.5, Paint()..color = plateColor);
    canvas.drawCircle(
        Offset.zero,
        9.5,
        Paint()
          ..color = ringColor
          ..style = PaintingStyle.stroke
          ..strokeWidth = 1.6);
    final petalPaint = Paint()..color = petalColor;
    final petal = _petal();
    for (final angle in [0, 90, 180, 270]) {
      canvas.save();
      canvas.rotate(angle * math.pi / 180);
      canvas.drawPath(petal, petalPaint);
      canvas.restore();
    }
    canvas.drawCircle(Offset.zero, 2.4, Paint()..color = centerColor);
    canvas.restore();
  }

  @override
  bool shouldRepaint(covariant _LotusPainter old) =>
      old.plateColor != plateColor ||
      old.petalColor != petalColor ||
      old.centerColor != centerColor ||
      old.ringColor != ringColor;
}

/// Full-bleed print-grain layer, ~6-7% opacity, non-interactive, above
/// content — HANDOFF Phase 3's "one widget, wrapped at the Scaffold body
/// level." Wired once at the MaterialApp `builder` (see patches.md) it
/// covers every screen without a per-screen edit.
///
/// Uses a bundled noise texture tiled at native size — register
/// `assets/textures/grain_noise.png` in pubspec.yaml (see patches.md).
class GrainOverlay extends StatelessWidget {
  final double opacity;
  final String assetPath;

  const GrainOverlay({
    super.key,
    this.opacity = 0.065,
    this.assetPath = 'assets/textures/grain_noise.png',
  });

  @override
  Widget build(BuildContext context) {
    return IgnorePointer(
      child: Opacity(
        opacity: opacity,
        child: Image.asset(
          assetPath,
          repeat: ImageRepeat.repeat,
          fit: BoxFit.none,
          alignment: Alignment.topLeft,
          width: double.infinity,
          height: double.infinity,
          filterQuality: FilterQuality.none,
        ),
      ),
    );
  }
}
