// Destination in the repo: app/lib/core/ui/rajasthani_motifs.dart
//
// Shared theme widgets. The toran drape was REPLACED (owner decision) by five
// Gen-Z seam styles picked from the "Seam styles — GenZ picks" mockup:
//   1B SquiggleSeam    2C DoubleWaveSeam    2A BubbleCloudSeam
//   2D PillMorseStrip  2E FlowerChainSeam
// Which screen gets which seam + band colour is in patches.md §5-6.
// BeadStudRule, LotusRosettePlate and GrainOverlay are unchanged from the
// earlier package. All geometry is ported 1:1 from the mockup SVGs.
//
// Every seam takes `flip: true` to mirror vertically for FOOTER use
// (band below, seam pointing up into content).

import 'dart:math' as math;
import 'package:flutter/material.dart';

import 'avatok_dark.dart';

// [RAJ-SEAMS-1] The handoff file declared these four as raw hex consts. They
// are re-pointed at the AD tokens (identical values) because
// tool/check_design_guard.py fails the build on any raw colour literal under
// app/lib, and because a second copy of the palette is a second thing to drift.
const _ink = AD.textPrimary;      // 0xFF16110D
const _haldi = AD.haldi;          // 0xFFE9A227
const _rani = AD.primaryBadge;    // 0xFFC9316E
const _indigo = AD.tabCalls;      // 0xFF2E4A8C
const _cream = AD.bg;             // 0xFFFBF3E2

void _maybeFlip(Canvas canvas, Size size, bool flip) {
  if (flip) {
    canvas.translate(0, size.height);
    canvas.scale(1, -1);
  }
}

// ---------------------------------------------------------------- 1B Squiggle
/// Hand-drawn wave: band colour fills down to a wavy edge, a fat 3.4px ink
/// stroke rides the wave. Half-period ~50px, amplitude 12, mid-line at y10.
class SquiggleSeam extends StatelessWidget {
  final Color bandColor;
  final bool flip;
  const SquiggleSeam({super.key, required this.bandColor, this.flip = false});

  @override
  Widget build(BuildContext context) => SizedBox(
        width: double.infinity,
        height: 26,
        child: CustomPaint(painter: _SquigglePainter(bandColor, flip)),
      );
}

class _SquigglePainter extends CustomPainter {
  final Color bandColor;
  final bool flip;
  _SquigglePainter(this.bandColor, this.flip);

  @override
  void paint(Canvas canvas, Size size) {
    final w = size.width;
    if (w <= 0) return;
    canvas.save();
    _maybeFlip(canvas, size, flip);
    const midY = 10.0, amp = 12.0;
    final n = math.max(2, (w / 50).round());
    final half = w / n;

    Path wave() {
      final p = Path()..moveTo(w, midY);
      var x = w;
      var sign = 1.0;
      for (var i = 0; i < n; i++) {
        p.cubicTo(x - half * 0.3, midY + amp * sign, x - half * 0.7,
            midY + amp * sign, x - half, midY);
        x -= half;
        sign = -sign;
      }
      return p;
    }

    final fill = Path()
      ..moveTo(0, 0)
      ..lineTo(w, 0)
      ..lineTo(w, midY)
      ..addPath(wave(), Offset.zero)
      ..lineTo(0, 0)
      ..close();
    canvas.drawPath(fill, Paint()..color = bandColor);
    canvas.drawPath(
        wave(),
        Paint()
          ..color = _ink
          ..style = PaintingStyle.stroke
          ..strokeWidth = 3.4);
    canvas.restore();
  }

  @override
  bool shouldRepaint(covariant _SquigglePainter old) =>
      old.bandColor != bandColor || old.flip != flip;
}

// ------------------------------------------------------------- 2C Double wave
/// Two stacked waves, offset phase: a deeper accent wave (default haldi)
/// behind, the band-colour wave in front. No ink stroke.
class DoubleWaveSeam extends StatelessWidget {
  final Color bandColor;
  final Color backColor;
  final bool flip;
  const DoubleWaveSeam(
      {super.key, required this.bandColor, this.backColor = _haldi, this.flip = false});

  @override
  Widget build(BuildContext context) => SizedBox(
        width: double.infinity,
        height: 36,
        child: CustomPaint(painter: _DoubleWavePainter(bandColor, backColor, flip)),
      );
}

class _DoubleWavePainter extends CustomPainter {
  final Color bandColor;
  final Color backColor;
  final bool flip;
  _DoubleWavePainter(this.bandColor, this.backColor, this.flip);

  Path _fill(double w, double midY, double amp, double startSign) {
    final n = math.max(2, (w / 60).round());
    final half = w / n;
    final p = Path()
      ..moveTo(0, 0)
      ..lineTo(w, 0)
      ..lineTo(w, midY);
    var x = w;
    var sign = startSign;
    for (var i = 0; i < n; i++) {
      p.cubicTo(x - half * 0.3, midY + amp * sign, x - half * 0.7,
          midY + amp * sign, x - half, midY);
      x -= half;
      sign = -sign;
    }
    p.close();
    return p;
  }

  @override
  void paint(Canvas canvas, Size size) {
    final w = size.width;
    if (w <= 0) return;
    canvas.save();
    _maybeFlip(canvas, size, flip);
    canvas.drawPath(_fill(w, 16, 12, 1), Paint()..color = backColor);
    canvas.drawPath(_fill(w, 8, 12, 1), Paint()..color = bandColor);
    canvas.restore();
  }

  @override
  bool shouldRepaint(covariant _DoubleWavePainter old) =>
      old.bandColor != bandColor || old.backColor != backColor || old.flip != flip;
}

// ------------------------------------------------------------ 2A Bubble cloud
/// Chunky uneven blobs: semicircle bumps of irregular radii hang off the
/// band. Radii pattern from the mockup, scaled to the available width.
class BubbleCloudSeam extends StatelessWidget {
  final Color bandColor;
  final bool flip;
  const BubbleCloudSeam({super.key, required this.bandColor, this.flip = false});

  @override
  Widget build(BuildContext context) => SizedBox(
        width: double.infinity,
        height: 32,
        child: CustomPaint(painter: _BubbleCloudPainter(bandColor, flip)),
      );
}

class _BubbleCloudPainter extends CustomPainter {
  final Color bandColor;
  final bool flip;
  _BubbleCloudPainter(this.bandColor, this.flip);

  // Mockup pattern (sum of diameters = 390).
  // [RAJ-SEAMS-1] Explicitly List<double>. Written as a bare literal this
  // infers List<num> (one 20.0 among ints), and `num` is not assignable to
  // the `double` that Radius.circular/width want.
  static const List<double> _radii = [20, 14, 24, 12, 19, 25, 13, 22, 15, 17, 14];

  @override
  void paint(Canvas canvas, Size size) {
    final w = size.width;
    if (w <= 0) return;
    canvas.save();
    _maybeFlip(canvas, size, flip);
    final scale = w / 390;
    const edgeY = 6.0;
    final p = Path()
      ..moveTo(0, 0)
      ..lineTo(w, 0)
      ..lineTo(w, edgeY);
    var x = w;
    var i = 0;
    while (x > 0.5) {
      final r = math.min(_radii[i % _radii.length] * scale, x / 2);
      p.arcToPoint(Offset(x - 2 * r, edgeY),
          radius: Radius.circular(r), clockwise: true);
      x -= 2 * r;
      i++;
    }
    p.close();
    canvas.drawPath(p, Paint()..color = bandColor);
    canvas.restore();
  }

  @override
  bool shouldRepaint(covariant _BubbleCloudPainter old) =>
      old.bandColor != bandColor || old.flip != flip;
}

// -------------------------------------------------------------- 2D Pill morse
/// Dash-dot strip of ink-outlined pills in the three accents, sitting on
/// paper BELOW a hard-edged band. The band itself keeps a 3px ink bottom
/// border (top border when used above a footer); this widget is just the
/// strip — give it 9px vertical padding from the band edge.
class PillMorseStrip extends StatelessWidget {
  final List<Color> colors;
  const PillMorseStrip({super.key, this.colors = const [_haldi, _rani, _indigo]});

  // [RAJ-SEAMS-1] Explicitly List<double> — same List<num> inference trap as
  // _radii above.
  static const List<double> _widths = [34, 10, 22, 10, 46, 10, 28, 10, 38, 10];

  @override
  Widget build(BuildContext context) {
    // [RAJ-SEAMS-1] The pills are PROPORTIONAL (Expanded with a flex taken from
    // the mockup's widths), not fixed pixels.
    //
    // As literal widths they summed to 218px plus 70px of gaps = 288px, which
    // overflows a 320dp screen (280px of usable width after the 20px insets) by
    // exactly 8px — a yellow-and-black striped bar across the header, caught by
    // settings_screen_overflow_test at 320x568. Flex keeps the mockup's dash-dot
    // rhythm at any width and cannot overflow: only the fixed 7px gaps consume
    // hard space, and they total 63px.
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 20),
      child: Row(children: [
        for (var i = 0; i < _widths.length; i++) ...[
          if (i > 0) const SizedBox(width: 7),
          Expanded(
            flex: _widths[i].round(),
            child: Container(
              height: 10,
              decoration: BoxDecoration(
                color: colors[i % colors.length],
                borderRadius: BorderRadius.circular(999),
                border: Border.all(color: _ink, width: 2),
              ),
            ),
          ),
        ],
      ]),
    );
  }
}

// ------------------------------------------------------------ 2E Flower chain
/// Y2K daisies straddling a hard 3px ink seam — the band keeps its ink
/// border; the flowers overlap it. Layer it, don't stack it:
///   Stack(clipBehavior: Clip.none, children: [
///     headerContainer, // with 3px ink bottom border
///     Positioned(left: 0, right: 0, bottom: -15, child: FlowerChainSeam()),
///   ])
/// Petal pairs alternate haldi/rani per flower, centre is the opposite hue.
class FlowerChainSeam extends StatelessWidget {
  final Color petalA;
  final Color petalB;
  const FlowerChainSeam({super.key, this.petalA = _haldi, this.petalB = _rani});

  @override
  Widget build(BuildContext context) => SizedBox(
        width: double.infinity,
        height: 30,
        child: CustomPaint(painter: _FlowerChainPainter(petalA, petalB)),
      );
}

class _FlowerChainPainter extends CustomPainter {
  final Color petalA;
  final Color petalB;
  _FlowerChainPainter(this.petalA, this.petalB);

  @override
  void paint(Canvas canvas, Size size) {
    final w = size.width;
    if (w <= 0) return;
    final n = math.max(2, (w / 100).round());
    final spacing = w / n;
    final midY = size.height / 2;
    final stroke = Paint()
      ..color = _ink
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.8;
    for (var i = 0; i < n; i++) {
      final cx = spacing / 2 + i * spacing;
      final petal = i.isEven ? petalA : petalB;
      final centre = i.isEven ? petalB : petalA;
      final petalFill = Paint()..color = petal;
      for (final o in const [Offset(0, -7), Offset(7, 0), Offset(0, 7), Offset(-7, 0)]) {
        canvas.drawCircle(Offset(cx, midY) + o, 5, petalFill);
        canvas.drawCircle(Offset(cx, midY) + o, 5, stroke);
      }
      canvas.drawCircle(Offset(cx, midY), 4, Paint()..color = centre);
      canvas.drawCircle(Offset(cx, midY), 4, stroke);
    }
  }

  @override
  bool shouldRepaint(covariant _FlowerChainPainter old) =>
      old.petalA != petalA || old.petalB != petalB;
}

// ----------------------------------------------------------- bead-stud rule
/// Row/section divider — 1.2px hairline at 14% ink with one 4px bead
/// (default haldi) centred, ink-outlined. Replaces every plain `Divider()`.
/// Pass [sectionLabel] for the header variant: leading bead + mono label +
/// hairline filling the remaining width.
class BeadStudRule extends StatelessWidget {
  final Color beadColor;
  final Color lineColor;
  final double beadRadius;
  final String? sectionLabel;
  final TextStyle? labelStyle;

  const BeadStudRule({
    super.key,
    this.beadColor = _haldi,
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
          painter: _CenteredBeadPainter(beadColor, lineColor, beadRadius),
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
          border: Border.all(color: _ink, width: 1.4),
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
  _CenteredBeadPainter(this.beadColor, this.lineColor, this.beadRadius);

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
          ..color = _ink
          ..style = PaintingStyle.stroke
          ..strokeWidth = 1.4);
  }

  @override
  bool shouldRepaint(covariant _CenteredBeadPainter old) =>
      old.beadColor != beadColor || old.lineColor != lineColor || old.beadRadius != beadRadius;
}

// ------------------------------------------------------- lotus rosette plate
/// Round ornament plate — coloured disc, four cream petals, haldi centre dot.
/// The exact "Ava" bottom-nav icon from the mockups, generalised.
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
    this.petalColor = _cream,
    this.centerColor = _haldi,
    this.ringColor = _cream,
  });

  @override
  Widget build(BuildContext context) => CustomPaint(
        size: Size(size, size),
        painter: _LotusPainter(plateColor, petalColor, centerColor, ringColor),
      );
}

class _LotusPainter extends CustomPainter {
  final Color plateColor, petalColor, centerColor, ringColor;
  _LotusPainter(this.plateColor, this.petalColor, this.centerColor, this.ringColor);

  Path _petal() => Path()
    ..moveTo(0, -6.5)
    ..cubicTo(3, -4.5, 3, -1, 0, 1)
    ..cubicTo(-3, -1, -3, -4.5, 0, -6.5)
    ..close();

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

// ------------------------------------------------------------- grain overlay
/// Full-bleed print-grain layer, ~6-7% opacity, non-interactive, above
/// content. Wire once at MaterialApp `builder` (patches.md §4). Register
/// `assets/textures/grain_noise.png` in pubspec.yaml.
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
