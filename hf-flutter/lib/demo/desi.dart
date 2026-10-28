import 'dart:math' as math;

import 'package:flutter/material.dart';

import 'theme.dart';

/// [HF-APP-DESI-1] The website dashboard's look (web/src/styles/hf-dash3.css + the admin desi kit) for the app:
/// coloured tone cards with flowers in the corners, plum hero numbers, tinted KPI tiles, multi-colour chips, a red
/// "Aaj ki khabar" ticker, bank-slip cards for money, bahi-khata ruled paper, lotus empty states, jasmine dividers.
/// Owner rules: no text under 14 sp, no green except the Online state, Nunito, touch targets >= 48 dp.

enum DesiTone { white, plum, rani, lav, tea, gold, saffron, cream }

enum DesiCorner { none, marigold, yellow, hibiscus, jasmine }

enum DesiPattern { none, dots, stripes, bahi }

/// Accent (strong) colour of a tone: used for numbers, icons and chip text.
Color desiInk(DesiTone t) => switch (t) {
      DesiTone.plum => C.white,
      DesiTone.rani => C.rani,
      DesiTone.lav => C.lav,
      DesiTone.tea => C.peacock,
      DesiTone.gold => C.amber,
      DesiTone.saffron => const Color(0xFF3B1600),
      DesiTone.white || DesiTone.cream => C.maroon,
    };

/// Pale tint of a tone: icon squares, chip fills.
Color desiTint(DesiTone t) => switch (t) {
      DesiTone.plum => const Color(0x29FFFFFF),
      DesiTone.rani => C.blush,
      DesiTone.lav => C.lavtint,
      DesiTone.tea => C.teatint,
      DesiTone.gold => C.goldtint,
      DesiTone.saffron => const Color(0x4DFFFFFF),
      DesiTone.white || DesiTone.cream => C.sand,
    };

Gradient desiFill(DesiTone t) => switch (t) {
      DesiTone.plum => const LinearGradient(
          begin: Alignment.topLeft, end: Alignment.bottomRight, colors: [Color(0xFF4A1747), Color(0xFF7A2470), Color(0xFFB0216F)], stops: [0, .6, 1]),
      DesiTone.saffron => const LinearGradient(
          begin: Alignment.topLeft, end: Alignment.bottomRight, colors: [Color(0xFFEA6A12), Color(0xFFF59E0B), Color(0xFFFBBF24)], stops: [0, .6, 1]),
      DesiTone.white => const LinearGradient(colors: [C.white, C.white]),
      DesiTone.cream => const LinearGradient(colors: [C.cream, C.cream]),
      _ => LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight, colors: [C.white, desiTint(t)], stops: const [.35, 1]),
    };

Color desiBorder(DesiTone t) => switch (t) {
      DesiTone.plum || DesiTone.saffron => C.clear,
      DesiTone.lav => const Color(0xFFE4DAFC),
      DesiTone.tea => const Color(0xFFCFE9EB),
      DesiTone.gold => const Color(0xFFF3DFB3),
      DesiTone.rani => const Color(0xFFF8D3E2),
      _ => C.line,
    };

List<BoxShadow> get desiShadow => const [
      BoxShadow(color: Color(0x0A4A1747), offset: Offset(0, 1)),
      BoxShadow(color: Color(0x2E4A1747), offset: Offset(0, 10), blurRadius: 24, spreadRadius: -12),
    ];

// ─── flowers ────────────────────────────────────────────────────────────────

class Marigold extends StatelessWidget {
  const Marigold({super.key, this.size = 48, this.yellow = false});
  final double size;
  final bool yellow;
  @override
  Widget build(BuildContext context) => ExcludeSemantics(child: CustomPaint(size: Size.square(size), painter: _MarigoldPainter(yellow)));
}

class _MarigoldPainter extends CustomPainter {
  _MarigoldPainter(this.yellow);
  final bool yellow;
  @override
  void paint(Canvas canvas, Size size) {
    final s = size.width / 90;
    canvas.translate(size.width / 2, size.height / 2);
    canvas.scale(s);
    final rings = yellow
        ? const [(40.0, 18, Color(0xFFF59E0B)), (31.0, 16, Color(0xFFFBBF24)), (21.0, 13, Color(0xFFFCD34D)), (12.0, 9, Color(0xFFF59E0B))]
        : const [(40.0, 18, Color(0xFFEA6A12)), (31.0, 16, Color(0xFFF59E0B)), (21.0, 13, Color(0xFFFB923C)), (12.0, 9, Color(0xFFF97316))];
    final stroke = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = .9
      ..color = const Color(0x47823200);
    for (var ri = 0; ri < rings.length; ri++) {
      final (r, n, c) = rings[ri];
      final fill = Paint()..color = c;
      for (var i = 0; i < n; i++) {
        canvas.save();
        canvas.rotate((i * 360 / n + ri * 9) * math.pi / 180);
        final rect = Rect.fromCenter(center: Offset(0, -r * .55), width: r * .42, height: r);
        canvas.drawOval(rect, fill);
        canvas.drawOval(rect, stroke);
        canvas.restore();
      }
    }
    canvas.drawCircle(Offset.zero, 5, Paint()..color = const Color(0xFF9A3412));
  }

  @override
  bool shouldRepaint(_MarigoldPainter old) => old.yellow != yellow;
}

class Hibiscus extends StatelessWidget {
  const Hibiscus({super.key, this.size = 50});
  final double size;
  @override
  Widget build(BuildContext context) => ExcludeSemantics(child: CustomPaint(size: Size.square(size), painter: _HibiscusPainter()));
}

class _HibiscusPainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    canvas.translate(size.width / 2, size.height / 2);
    canvas.scale(size.width / 96);
    final petal = Path()
      ..moveTo(0, 0)
      ..cubicTo(-20, -14, -22, -40, 0, -44)
      ..cubicTo(22, -40, 20, -14, 0, 0)
      ..close();
    final fill = Paint()..color = const Color(0xFFDC2626);
    final edge = Paint()
      ..style = PaintingStyle.stroke
      ..color = const Color(0xFF991B1B);
    for (var i = 0; i < 5; i++) {
      canvas.save();
      canvas.rotate(i * 72 * math.pi / 180);
      canvas.drawPath(petal, fill);
      canvas.drawPath(petal, edge);
      canvas.restore();
    }
    canvas.drawCircle(Offset.zero, 9, Paint()..color = const Color(0xFF7F1D1D));
    canvas.drawLine(Offset.zero, const Offset(18, -26), Paint()
      ..color = const Color(0xFFFDE047)
      ..strokeWidth = 3
      ..strokeCap = StrokeCap.round);
    canvas.drawCircle(const Offset(19, -28), 4, Paint()..color = const Color(0xFFFDE047));
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}

class Jasmine extends StatelessWidget {
  const Jasmine({super.key, this.size = 22});
  final double size;
  @override
  Widget build(BuildContext context) => ExcludeSemantics(child: CustomPaint(size: Size.square(size), painter: _JasminePainter()));
}

class _JasminePainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    canvas.translate(size.width / 2, size.height / 2);
    canvas.scale(size.width / 40);
    final fill = Paint()..color = C.white;
    final edge = Paint()
      ..style = PaintingStyle.stroke
      ..color = const Color(0xFFE7D9C9);
    for (var i = 0; i < 5; i++) {
      canvas.save();
      canvas.rotate(i * 72 * math.pi / 180);
      final r = Rect.fromCenter(center: const Offset(0, -9), width: 10, height: 18);
      canvas.drawOval(r, fill);
      canvas.drawOval(r, edge);
      canvas.restore();
    }
    canvas.drawCircle(Offset.zero, 3.4, Paint()..color = const Color(0xFFFBBF24));
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}

class Lotus extends StatelessWidget {
  const Lotus({super.key, this.size = 84});
  final double size;
  @override
  Widget build(BuildContext context) => ExcludeSemantics(child: CustomPaint(size: Size(size, size * .67), painter: _LotusPainter()));
}

class _LotusPainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    final s = size.width / 120;
    canvas.translate(size.width / 2, size.height * (62 / 80));
    canvas.scale(s);
    final petal = Path()
      ..moveTo(0, 0)
      ..cubicTo(-12, -18, -10, -40, 0, -54)
      ..cubicTo(10, -40, 12, -18, 0, 0)
      ..close();
    final edge = Paint()
      ..style = PaintingStyle.stroke
      ..color = const Color(0xFFBE185D);
    void p(double rot, Color c, double sc) {
      canvas.save();
      canvas.rotate(rot * math.pi / 180);
      canvas.scale(sc);
      canvas.drawPath(petal, Paint()..color = c);
      canvas.drawPath(petal, edge);
      canvas.restore();
    }

    p(-62, const Color(0xFFFBCFE8), .8);
    p(62, const Color(0xFFFBCFE8), .8);
    p(-34, const Color(0xFFF9A8D4), .92);
    p(34, const Color(0xFFF9A8D4), .92);
    p(0, const Color(0xFFF472B6), 1);
    canvas.drawOval(Rect.fromCenter(center: const Offset(0, 4), width: 80, height: 14), Paint()..color = const Color(0xFF3F8F3A));
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}

Widget _cornerArt(DesiCorner c, double size) => switch (c) {
      DesiCorner.marigold => Marigold(size: size),
      DesiCorner.yellow => Marigold(size: size, yellow: true),
      DesiCorner.hibiscus => Hibiscus(size: size * .8),
      DesiCorner.jasmine => Jasmine(size: size * .5),
      DesiCorner.none => const SizedBox.shrink(),
    };

// ─── patterns ───────────────────────────────────────────────────────────────

class _PatternPainter extends CustomPainter {
  _PatternPainter(this.pattern);
  final DesiPattern pattern;
  @override
  void paint(Canvas canvas, Size size) {
    switch (pattern) {
      case DesiPattern.dots:
        final p = Paint()..color = const Color(0x1FD81B72);
        for (double y = 11; y < size.height; y += 22) {
          for (double x = 11; x < size.width; x += 22) {
            canvas.drawCircle(Offset(x, y), 1.7, p);
          }
        }
      case DesiPattern.stripes:
        final p = Paint()
          ..color = const Color(0xFFFFF4DF)
          ..strokeWidth = 18;
        for (double x = -size.height; x < size.width; x += 36) {
          canvas.drawLine(Offset(x, size.height), Offset(x + size.height, 0), p);
        }
      case DesiPattern.bahi:
        final line = Paint()
          ..color = const Color(0xFFF1DFC6)
          ..strokeWidth = 1;
        for (double y = 37; y < size.height; y += 38) {
          canvas.drawLine(Offset(0, y), Offset(size.width, y), line);
        }
        canvas.drawLine(const Offset(30, 0), Offset(30, size.height), Paint()
          ..color = const Color(0xFFF29AB9)
          ..strokeWidth = 2);
      case DesiPattern.none:
        break;
    }
  }

  @override
  bool shouldRepaint(_PatternPainter old) => old.pattern != pattern;
}

// ─── building blocks ────────────────────────────────────────────────────────

/// Section title with its marigold, like "✿ Calendar" on the dashboard.
class DesiTitle extends StatelessWidget {
  const DesiTitle(this.text, {super.key, this.color = C.deep, this.yellow = false, this.size = 19});
  final String text;
  final Color color;
  final bool yellow;
  final double size;
  @override
  Widget build(BuildContext context) => Row(children: [
        Marigold(size: size + 2, yellow: yellow),
        const SizedBox(width: 8),
        Flexible(child: Text(text, style: t(size, color: color, w: FontWeight.w800))),
      ]);
}

/// The workhorse card: tone wash, optional flower corner, optional texture, title row with an action.
class DesiCard extends StatelessWidget {
  const DesiCard({
    super.key,
    this.title,
    this.note,
    this.action,
    this.tone = DesiTone.white,
    this.corner = DesiCorner.none,
    this.pattern = DesiPattern.none,
    this.padding = const EdgeInsets.all(18),
    this.radius = 24,
    this.onTap,
    required this.child,
  });
  final String? title;
  final String? note;
  final Widget? action;
  final DesiTone tone;
  final DesiCorner corner;
  final DesiPattern pattern;
  final EdgeInsets padding;
  final double radius;
  final VoidCallback? onTap;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final dark = tone == DesiTone.plum;
    final head = (title != null || action != null)
        ? Padding(
            padding: EdgeInsets.only(bottom: 12, right: corner == DesiCorner.none ? 0 : 30),
            child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  if (title != null) DesiTitle(title!, color: dark ? C.white : C.deep, yellow: dark),
                  if (note != null)
                    Padding(
                      padding: const EdgeInsets.only(top: 2, left: 29),
                      child: Text(note!, style: t(14, color: dark ? const Color(0xD9FFFFFF) : C.muted, w: FontWeight.w600)),
                    ),
                ]),
              ),
              if (action != null) action!,
            ]),
          )
        : const SizedBox.shrink();
    final body = Container(
      decoration: BoxDecoration(
        gradient: desiFill(tone),
        borderRadius: BorderRadius.circular(radius),
        border: pattern == DesiPattern.stripes
            ? Border.all(color: C.marigold, width: 2)
            : Border.all(color: desiBorder(tone)),
        boxShadow: desiShadow,
      ),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(radius),
        child: Stack(children: [
          if (pattern != DesiPattern.none) Positioned.fill(child: CustomPaint(painter: _PatternPainter(pattern))),
          if (corner != DesiCorner.none) Positioned(right: -16, top: -18, child: _cornerArt(corner, 78)),
          Padding(
            padding: pattern == DesiPattern.bahi ? padding.copyWith(left: padding.left + 26) : padding,
            child: DefaultTextStyle.merge(
              style: TextStyle(color: dark ? C.white : C.deep),
              child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: [head, child]),
            ),
          ),
        ]),
      ),
    );
    if (onTap == null) return body;
    return Material(color: C.clear, child: InkWell(borderRadius: BorderRadius.circular(radius), onTap: onTap, child: body));
  }
}

/// Coloured number tile. The headline tile on a screen is tone plum with a yellow marigold corner.
class DesiKpi extends StatelessWidget {
  const DesiKpi({super.key, required this.label, required this.value, this.sub, this.tone = DesiTone.rani, this.icon, this.onTap, this.corner});
  final String label;
  final String value;
  final String? sub;
  final DesiTone tone;
  final IconData? icon;
  final VoidCallback? onTap;
  final bool? corner;

  @override
  Widget build(BuildContext context) {
    final dark = tone == DesiTone.plum;
    final ink = desiInk(tone);
    final showCorner = corner ?? dark;
    final tile = Container(
      constraints: const BoxConstraints(minHeight: 128),
      decoration: BoxDecoration(
        gradient: dark
            ? const LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight, colors: [Color(0xFF4A1747), Color(0xFF8A2B7D)])
            : desiFill(tone),
        borderRadius: BorderRadius.circular(22),
        border: Border.all(color: desiBorder(tone)),
        boxShadow: desiShadow,
      ),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(22),
        child: Stack(children: [
          if (showCorner) Positioned(right: -12, top: -14, child: Marigold(size: 60, yellow: dark)),
          Padding(
            padding: const EdgeInsets.fromLTRB(14, 14, 14, 12),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              if (icon != null)
                Container(
                  width: 40,
                  height: 40,
                  margin: const EdgeInsets.only(bottom: 6),
                  decoration: BoxDecoration(color: desiTint(tone), borderRadius: BorderRadius.circular(13)),
                  child: Icon(icon, size: 21, color: dark ? C.white : ink),
                ),
              Text(label, style: t(14, color: dark ? const Color(0xDBFFFFFF) : C.muted, w: FontWeight.w700)),
              const SizedBox(height: 2),
              FittedBox(
                fit: BoxFit.scaleDown,
                alignment: Alignment.centerLeft,
                child: Text(value, style: t(28, color: dark ? C.white : ink, w: FontWeight.w800, h: 1.05)),
              ),
              if (sub != null) ...[
                const SizedBox(height: 2),
                Text(sub!, style: t(14, color: dark ? const Color(0xDBFFFFFF) : C.muted, w: FontWeight.w600)),
              ],
            ]),
          ),
        ]),
      ),
    );
    if (onTap == null) return tile;
    return Semantics(button: true, child: Material(color: C.clear, child: InkWell(borderRadius: BorderRadius.circular(22), onTap: onTap, child: tile)));
  }
}

/// Two tiles per row on a phone, more on a tablet.
class DesiKpiGrid extends StatelessWidget {
  const DesiKpiGrid({super.key, required this.children, this.gap = 10});
  final List<Widget> children;
  final double gap;
  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(builder: (context, c) {
      final cols = c.maxWidth > 600 ? 4 : 2;
      final w = (c.maxWidth - gap * (cols - 1)) / cols;
      return Wrap(spacing: gap, runSpacing: gap, children: [for (final k in children) SizedBox(width: w, child: k)]);
    });
  }
}

class DesiChip extends StatelessWidget {
  const DesiChip(this.text, {super.key, this.tone = DesiTone.tea, this.icon});
  final String text;
  final DesiTone tone;
  final IconData? icon;
  @override
  Widget build(BuildContext context) {
    final bg = tone == DesiTone.plum ? C.maroon : desiTint(tone);
    final fg = tone == DesiTone.plum ? C.white : desiInk(tone);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 4),
      decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(999)),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        if (icon != null) ...[Icon(icon, size: 15, color: fg), const SizedBox(width: 4)],
        Text(text, style: t(14, color: fg, w: FontWeight.w800)),
      ]),
    );
  }
}

/// Lotus empty state.
class DesiEmpty extends StatelessWidget {
  const DesiEmpty({super.key, required this.text, this.child});
  final String text;
  final Widget? child;
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 24, horizontal: 12),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          const Lotus(size: 84),
          const SizedBox(height: 8),
          Text(text, textAlign: TextAlign.center, style: t(16, color: C.muted, w: FontWeight.w700)),
          if (child != null) ...[const SizedBox(height: 12), child!],
        ]),
      );
}

/// A row of jasmine with a marigold every fourth.
class DesiMogra extends StatelessWidget {
  const DesiMogra({super.key, this.n = 11});
  final int n;
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 10),
        child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
          for (var i = 0; i < n; i++)
            Padding(padding: const EdgeInsets.symmetric(horizontal: 1), child: i % 4 == 3 ? const Marigold(size: 18, yellow: true) : const Jasmine(size: 18)),
        ]),
      );
}

/// Red "breaking news" strip from the dashboard. The lane scrolls slowly; reduced motion keeps it still.
class DesiTicker extends StatefulWidget {
  const DesiTicker({super.key, required this.items, this.label = 'Aaj ki khabar'});
  final List<String> items;
  final String label;
  @override
  State<DesiTicker> createState() => _DesiTickerState();
}

class _DesiTickerState extends State<DesiTicker> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(vsync: this, duration: const Duration(seconds: 28));

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (MediaQuery.of(context).disableAnimations) {
      _c.stop();
    } else if (!_c.isAnimating) {
      _c.repeat();
    }
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (widget.items.isEmpty) return const SizedBox.shrink();
    final text = widget.items.map((s) => '✿ $s').join('      ');
    return Semantics(
      label: '${widget.label}: ${widget.items.join('. ')}',
      child: ExcludeSemantics(
        child: Container(
          height: 44,
          decoration: BoxDecoration(
            color: const Color(0xFFFFF7CC),
            borderRadius: BorderRadius.circular(14),
            border: Border.all(color: const Color(0xFFB3001B), width: 2),
          ),
          child: ClipRRect(
            borderRadius: BorderRadius.circular(12),
            child: Row(children: [
              Container(
                color: const Color(0xFFD1001F),
                padding: const EdgeInsets.symmetric(horizontal: 12),
                alignment: Alignment.center,
                child: Text(widget.label.toUpperCase(), style: t(14, color: C.white, w: FontWeight.w800, ls: .05)),
              ),
              Expanded(
                child: LayoutBuilder(builder: (context, c) {
                  return AnimatedBuilder(
                    animation: _c,
                    builder: (context, _) {
                      final w = text.length * 8.4 + c.maxWidth;
                      final dx = c.maxWidth - _c.value * w;
                      return ClipRect(
                        child: OverflowBox(
                          maxWidth: double.infinity,
                          alignment: Alignment.centerLeft,
                          child: Transform.translate(
                            offset: Offset(dx, 0),
                            child: Text(text, maxLines: 1, softWrap: false, style: t(15, color: const Color(0xFF1A1A1A), w: FontWeight.w800)),
                          ),
                        ),
                      );
                    },
                  );
                }),
              ),
            ]),
          ),
        ),
      ),
    );
  }
}

/// Screen hero, like the dashboard's: tone wash, giant outline word behind, flowers, art on the right.
class DesiHero extends StatelessWidget {
  const DesiHero({
    super.key,
    required this.eyebrow,
    required this.title,
    this.sub,
    this.ghost,
    this.tone = DesiTone.saffron,
    this.art,
    this.child,
    this.minHeight = 190,
  });
  final String eyebrow;
  final String title;
  final String? sub;
  final String? ghost;

  /// saffron (peach+pink), rani, lav, tea, gold or plum (dark).
  final DesiTone tone;
  final Widget? art;
  final Widget? child;
  final double minHeight;

  @override
  Widget build(BuildContext context) {
    final dark = tone == DesiTone.plum;
    final (a, b, c1, c2, g) = switch (tone) {
      DesiTone.rani => (const Color(0xFFFFC9DF), const Color(0xFFFFE2B8), const Color(0xFFFFF0F6), const Color(0xFFFFF6EA), const Color(0x2ED81B72)),
      DesiTone.lav => (const Color(0xFFFFD9E8), const Color(0xFFE3DAFE), const Color(0xFFF7F3FF), const Color(0xFFFFF8F0), const Color(0x336D4FD0)),
      DesiTone.tea => (const Color(0xFFC9ECEF), const Color(0xFFFFE2B8), const Color(0xFFEFFAFB), const Color(0xFFFFF8EF), const Color(0x330E7C86)),
      DesiTone.gold => (const Color(0xFFFFE08A), const Color(0xFFFFD3E6), const Color(0xFFFFF6DC), const Color(0xFFFFF1F6), const Color(0x33B45309)),
      DesiTone.plum => (const Color(0x8CF59E0B), const Color(0x73D81B72), const Color(0xFF4A1747), const Color(0xFF8A2B7D), const Color(0x29FFFFFF)),
      _ => (const Color(0xFFFFD7A8), const Color(0xFFFFD3E6), const Color(0xFFFFF3E2), const Color(0xFFFBEEFE), const Color(0x2BD81B72)),
    };
    return Container(
      constraints: BoxConstraints(minHeight: minHeight),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(26),
        border: Border.all(color: dark ? C.clear : C.line),
        gradient: LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight, colors: [c1, c2]),
      ),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(26),
        child: Stack(children: [
          Positioned(right: -60, top: -60, child: _Glow(color: a, size: 260)),
          Positioned(left: -70, bottom: -70, child: _Glow(color: b, size: 240)),
          if (ghost != null)
            Positioned(
              left: 12,
              bottom: -14,
              child: ExcludeSemantics(child: Text(ghost!.toUpperCase(), maxLines: 1, style: tOutline(84, color: g, stroke: 2, ls: -.01))),
            ),
          Positioned(right: -14, top: -16, child: const Marigold(size: 74)),
          Positioned(right: 52, top: 10, child: const Marigold(size: 40, yellow: true)),
          if (art != null) Positioned(right: 8, bottom: 6, child: art!),
          Padding(
            padding: EdgeInsets.fromLTRB(18, 18, art != null ? 128 : 60, 18),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
              Text(eyebrow.toUpperCase(), style: t(14, color: dark ? const Color(0xFFFFD3E6) : C.rani, w: FontWeight.w800, ls: .06)),
              const SizedBox(height: 4),
              Text(title, style: t(30, color: dark ? C.white : C.deep, w: FontWeight.w800, h: 1.06)),
              if (sub != null) ...[
                const SizedBox(height: 8),
                Text(sub!, style: t(15, color: dark ? const Color(0xE6FFFFFF) : C.deep, w: FontWeight.w600, h: 1.4)),
              ],
              if (child != null) ...[const SizedBox(height: 14), child!],
            ]),
          ),
        ]),
      ),
    );
  }
}

class _Glow extends StatelessWidget {
  const _Glow({required this.color, required this.size});
  final Color color;
  final double size;
  @override
  Widget build(BuildContext context) => IgnorePointer(
        child: Container(
          width: size,
          height: size,
          decoration: BoxDecoration(shape: BoxShape.circle, gradient: RadialGradient(colors: [color, color.withValues(alpha: 0)])),
        ),
      );
}

/// Bank slip / receipt: striped header strip, punched sides, body, actions. For money items.
class DesiSlip extends StatelessWidget {
  const DesiSlip({super.key, required this.strip, this.stripRight, this.tone = DesiTone.gold, required this.child, this.actions});
  final String strip;
  final Widget? stripRight;
  final DesiTone tone;
  final Widget child;
  final List<Widget>? actions;

  @override
  Widget build(BuildContext context) {
    final (sa, sb, line, ink) = switch (tone) {
      DesiTone.tea => (const Color(0xFFE3F5F6), const Color(0xFFD2EEF0), const Color(0xFF9FD3D8), C.peacock),
      DesiTone.rani => (const Color(0xFFFFE6EF), const Color(0xFFFFD6E5), const Color(0xFFF2A9C8), C.rani),
      DesiTone.lav => (const Color(0xFFF1EBFF), const Color(0xFFE6DCFF), const Color(0xFFC7B6F5), C.lav),
      _ => (const Color(0xFFFFF1D6), const Color(0xFFFFE8BD), const Color(0xFFE9C98D), C.amber),
    };
    return Container(
      decoration: BoxDecoration(color: C.white, borderRadius: BorderRadius.circular(22), border: Border.all(color: C.line), boxShadow: desiShadow),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(22),
        child: Stack(children: [
          Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            CustomPaint(
              painter: _StripPainter(sa, sb, line),
              child: Padding(
                padding: const EdgeInsets.fromLTRB(16, 10, 12, 10),
                child: Row(children: [
                  Expanded(child: Text(strip.toUpperCase(), style: t(14, color: ink, w: FontWeight.w800, ls: .04))),
                  if (stripRight != null) stripRight!,
                ]),
              ),
            ),
            Padding(padding: const EdgeInsets.fromLTRB(18, 14, 18, 14), child: child),
            if (actions != null && actions!.isNotEmpty)
              Padding(
                padding: const EdgeInsets.fromLTRB(14, 0, 14, 14),
                child: Wrap(alignment: WrapAlignment.end, spacing: 8, runSpacing: 8, children: actions!),
              ),
          ]),
          const Positioned(left: -13, top: 70, child: _Punch()),
          const Positioned(right: -13, top: 70, child: _Punch()),
        ]),
      ),
    );
  }
}

class _Punch extends StatelessWidget {
  const _Punch();
  @override
  Widget build(BuildContext context) => Container(
        width: 26,
        height: 26,
        decoration: BoxDecoration(color: C.ivory, shape: BoxShape.circle, border: Border.all(color: C.line)),
      );
}

class _StripPainter extends CustomPainter {
  _StripPainter(this.a, this.b, this.line);
  final Color a, b, line;
  @override
  void paint(Canvas canvas, Size size) {
    canvas.drawRect(Offset.zero & size, Paint()..color = a);
    final p = Paint()
      ..color = b
      ..strokeWidth = 14;
    for (double x = -size.height; x < size.width + size.height; x += 28) {
      canvas.drawLine(Offset(x, size.height), Offset(x + size.height, 0), p);
    }
    final dash = Paint()
      ..color = line
      ..strokeWidth = 2;
    for (double x = 0; x < size.width; x += 10) {
      canvas.drawLine(Offset(x, size.height - 1), Offset(x + 5, size.height - 1), dash);
    }
  }

  @override
  bool shouldRepaint(_StripPainter old) => old.a != a || old.b != b;
}

/// Big plum number block (wallet balance, ready to withdraw).
class DesiCounter extends StatelessWidget {
  const DesiCounter({super.key, required this.label, required this.value, this.sub, this.child, this.tone = DesiTone.plum});
  final String label;
  final String value;
  final String? sub;
  final Widget? child;
  final DesiTone tone;
  @override
  Widget build(BuildContext context) {
    final colors = tone == DesiTone.tea
        ? const [Color(0xFF0A5C63), Color(0xFF0E7C86)]
        : tone == DesiTone.rani
            ? const [Color(0xFFA0124F), Color(0xFFD81B72)]
            : const [Color(0xFF4A1747), Color(0xFF7A2470), Color(0xFFB0216F)];
    return Container(
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(26),
        gradient: LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight, colors: colors),
        boxShadow: desiShadow,
      ),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(26),
        child: Stack(children: [
          const Positioned(right: -60, top: -60, child: _Glow(color: Color(0x8CF59E0B), size: 220)),
          const Positioned(right: -22, top: -26, child: Marigold(size: 96)),
          const Positioned(right: 64, top: 12, child: Marigold(size: 34, yellow: true)),
          const Positioned(left: -14, bottom: -18, child: Hibiscus(size: 64)),
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 18, 20, 18),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(label.toUpperCase(), style: t(14, color: const Color(0xFFFFD3E6), w: FontWeight.w800, ls: .06)),
              const SizedBox(height: 4),
              FittedBox(
                fit: BoxFit.scaleDown,
                alignment: Alignment.centerLeft,
                child: Text(value, style: t(46, color: const Color(0xFFFFD166), w: FontWeight.w800, h: 1.05)),
              ),
              if (sub != null) Text(sub!, style: t(15, color: const Color(0xE6FFFFFF), w: FontWeight.w600)),
              if (child != null) ...[const SizedBox(height: 14), child!],
            ]),
          ),
        ]),
      ),
    );
  }
}

/// Pill button in dashboard style.
class DesiButton extends StatelessWidget {
  const DesiButton(this.label, {super.key, required this.onTap, this.icon, this.kind = DesiButtonKind.plum, this.expand = false});
  final String label;
  final VoidCallback? onTap;
  final IconData? icon;
  final DesiButtonKind kind;
  final bool expand;
  @override
  Widget build(BuildContext context) {
    final (Gradient? g, Color bg, Color fg, Color? border) = switch (kind) {
      DesiButtonKind.rani => (const LinearGradient(colors: [Color(0xFFD81B72), Color(0xFFF0408F)]), C.rani, C.white, null),
      DesiButtonKind.gold => (const LinearGradient(colors: [Color(0xFFF59E0B), Color(0xFFEA6A12)]), C.marigold, const Color(0xFF3B1600), null),
      DesiButtonKind.tea => (const LinearGradient(colors: [Color(0xFF0E7C86), Color(0xFF16A3AD)]), C.peacock, C.white, null),
      DesiButtonKind.ghost => (null, C.white, C.maroon, C.line),
      DesiButtonKind.danger => (null, C.white, C.rani, const Color(0xFFF6C2D8)),
      DesiButtonKind.plum => (null, C.maroon, C.white, null),
    };
    final child = Container(
      constraints: const BoxConstraints(minHeight: 48),
      padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 10),
      decoration: BoxDecoration(
        gradient: onTap == null ? null : g,
        color: onTap == null ? const Color(0xFFE8DDE6) : (g == null ? bg : null),
        borderRadius: BorderRadius.circular(999),
        border: border == null ? null : Border.all(color: border, width: 1.5),
      ),
      child: Row(mainAxisSize: expand ? MainAxisSize.max : MainAxisSize.min, mainAxisAlignment: MainAxisAlignment.center, children: [
        if (icon != null) ...[Icon(icon, size: 19, color: onTap == null ? C.muted : fg), const SizedBox(width: 8)],
        Flexible(child: Text(label, textAlign: TextAlign.center, style: t(16, color: onTap == null ? C.muted : fg, w: FontWeight.w800))),
      ]),
    );
    return Semantics(
      button: true,
      enabled: onTap != null,
      child: Material(color: C.clear, child: InkWell(borderRadius: BorderRadius.circular(999), onTap: onTap, child: child)),
    );
  }
}

enum DesiButtonKind { plum, rani, gold, tea, ghost, danger }

/// Round menu row icon in a tinted square, for list rows (Me, Settings).
class DesiIconSquare extends StatelessWidget {
  const DesiIconSquare(this.icon, {super.key, this.tone = DesiTone.lav, this.size = 42});
  final IconData icon;
  final DesiTone tone;
  final double size;
  @override
  Widget build(BuildContext context) => Container(
        width: size,
        height: size,
        decoration: BoxDecoration(color: desiTint(tone), borderRadius: BorderRadius.circular(14)),
        child: Icon(icon, size: size * .5, color: desiInk(tone)),
      );
}

// ─── gota-patti buttons ([HF-DESI-ONB]) ─────────────────────────────────────
// Owner rule 2026-10-28: buttons are SOLID colours, no gradients. The main button is solid saffron with a thin dashed
// inner line (like gota-patti trim) and a small marigold at each end of the label.

/// Dashed outline of a rounded rectangle, inset by [inset] from the widget's edges.
class DesiDashedRRectPainter extends CustomPainter {
  const DesiDashedRRectPainter({required this.color, required this.radius, this.width = 1.5, this.inset = 0, this.dash = 6, this.gap = 4});
  final Color color;
  final double radius;
  final double width;
  final double inset;
  final double dash;
  final double gap;

  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = width;
    final e = inset + width / 2;
    if (size.width <= e * 2 || size.height <= e * 2) return;
    final rect = Rect.fromLTWH(e, e, size.width - e * 2, size.height - e * 2);
    final r = math.min(math.max(radius - inset, 0.0), rect.shortestSide / 2);
    final path = Path()..addRRect(RRect.fromRectAndRadius(rect, Radius.circular(r)));
    for (final metric in path.computeMetrics()) {
      var d = 0.0;
      while (d < metric.length) {
        canvas.drawPath(metric.extractPath(d, math.min(d + dash, metric.length)), paint);
        d += dash + gap;
      }
    }
  }

  @override
  bool shouldRepaint(covariant DesiDashedRRectPainter old) =>
      old.color != color || old.radius != radius || old.width != width || old.inset != inset || old.dash != dash || old.gap != gap;
}

/// Colours of the gota-patti design.
abstract final class Gota {
  static const saffron = Color(0xFFF59E0B); // solid main button
  static const onSaffron = Color(0xFF3B1600); // text on it
  static const trim = Color(0xFFFFF7E6); // the dashed inner line
  static const shadow = Color(0x80B45309);
  static const plum = Color(0xFF4A1747);
  static const line = Color(0xFFD8C5A9);
  static const darkFill = Color(0xCC3A1238); // translucent plum on a video
  static const gold = Color(0xFFFBBF24);
}

enum GotaKind { saffron, ghost, dark }

/// Pill button: [GotaKind.saffron] solid saffron + dashed inner line + a marigold at each end of the label (the one main
/// button of a screen); [GotaKind.ghost] white with a sand border and plum text; [GotaKind.dark] translucent plum with a
/// gold border and white text (for use on top of a video).
class GotaButton extends StatelessWidget {
  const GotaButton({
    super.key,
    required this.label,
    required this.onTap,
    this.kind = GotaKind.saffron,
    this.height = 58,
    this.fontSize = 18,
    this.flowers,
    this.enabled = true,
    this.busy = false,
    this.inkKey,
  });
  final String label;
  final VoidCallback? onTap;
  final GotaKind kind;
  final double height;
  final double fontSize;

  /// Marigolds at the ends of the label. Defaults to on for [GotaKind.saffron].
  final bool? flowers;
  final bool enabled;
  final bool busy;

  /// Key put on the tappable InkWell (tests find buttons by it).
  final Key? inkKey;

  @override
  Widget build(BuildContext context) {
    final active = enabled && !busy && onTap != null;
    final saffron = kind == GotaKind.saffron;
    final (Color bg, Color fg, Color? border) = switch (kind) {
      GotaKind.saffron => (Gota.saffron, Gota.onSaffron, null),
      GotaKind.ghost => (C.white, Gota.plum, Gota.line),
      GotaKind.dark => (Gota.darkFill, C.white, Gota.gold),
    };
    final showFlowers = (flowers ?? saffron) && !busy;
    final flower = height >= 50 ? 26.0 : 20.0;
    final text = Text(label, maxLines: 1, softWrap: false, textAlign: TextAlign.center, style: t(fontSize, color: fg, w: FontWeight.w800));
    return Semantics(
      button: true,
      enabled: active,
      label: busy ? '$label, please wait' : label,
      onTap: active ? onTap : null,
      excludeSemantics: true,
      child: Opacity(
        opacity: enabled ? 1 : 0.5,
        child: Container(
          height: height,
          decoration: BoxDecoration(
            color: bg,
            borderRadius: BorderRadius.circular(999),
            border: border == null ? null : Border.all(color: border, width: kind == GotaKind.dark ? 2 : 1.5),
            boxShadow: saffron ? const [BoxShadow(color: Gota.shadow, offset: Offset(0, 6), blurRadius: 14, spreadRadius: -8)] : null,
          ),
          child: CustomPaint(
            foregroundPainter: saffron ? const DesiDashedRRectPainter(color: Gota.trim, radius: 999, inset: 4) : null,
            child: Material(
              color: C.clear,
              child: InkWell(
                key: inkKey,
                customBorder: const StadiumBorder(),
                onTap: active ? onTap : null,
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 14),
                  child: Center(
                    child: busy
                        ? SizedBox(width: 24, height: 24, child: CircularProgressIndicator(strokeWidth: 3, color: fg))
                        : Row(mainAxisSize: MainAxisSize.min, children: [
                            if (showFlowers) ...[Marigold(size: flower), const SizedBox(width: 10)],
                            Flexible(child: FittedBox(fit: BoxFit.scaleDown, child: text)),
                            if (showFlowers) ...[const SizedBox(width: 10), Marigold(size: flower)],
                          ]),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// Small solid saffron pill with the dashed inner line ("Log in", "Open").
class GotaPill extends StatelessWidget {
  const GotaPill({super.key, required this.label, required this.onTap, this.busy = false, this.semanticLabel, this.inkKey});
  final String label;
  final VoidCallback? onTap;
  final bool busy;
  final String? semanticLabel;
  final Key? inkKey;

  @override
  Widget build(BuildContext context) => Semantics(
        button: true,
        enabled: onTap != null && !busy,
        label: semanticLabel ?? label,
        onTap: busy ? null : onTap,
        excludeSemantics: true,
        child: Opacity(
          opacity: busy ? 0.6 : 1,
          child: Container(
            constraints: const BoxConstraints(minWidth: 76, minHeight: 48),
            decoration: BoxDecoration(
              color: Gota.saffron,
              borderRadius: BorderRadius.circular(999),
              boxShadow: const [BoxShadow(color: Gota.shadow, offset: Offset(0, 4), blurRadius: 10, spreadRadius: -6)],
            ),
            child: CustomPaint(
              foregroundPainter: const DesiDashedRRectPainter(color: Gota.trim, radius: 999, width: 1.2, inset: 3, dash: 5, gap: 3),
              child: Material(
                color: C.clear,
                child: InkWell(
                  key: inkKey,
                  customBorder: const StadiumBorder(),
                  onTap: busy ? null : onTap,
                  child: Center(
                    child: busy
                        ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2.5, color: Gota.onSaffron))
                        : Padding(padding: const EdgeInsets.symmetric(horizontal: 16), child: Text(label, style: t(15, color: Gota.onSaffron, w: FontWeight.w800))),
                  ),
                ),
              ),
            ),
          ),
        ),
      );
}

/// Rangoli step number: a gold disc with a plum number and a dotted rani ring just outside it. [done] shows a tick.
class RangoliNumber extends StatelessWidget {
  const RangoliNumber(this.n, {super.key, this.done = false, this.size = 32});
  final String n;
  final bool done;
  final double size;

  @override
  Widget build(BuildContext context) => ExcludeSemantics(
        child: SizedBox(
          width: size + 10,
          height: size + 10,
          child: CustomPaint(
            painter: const _DottedRingPainter(),
            child: Center(
              child: Container(
                width: size,
                height: size,
                alignment: Alignment.center,
                decoration: const BoxDecoration(
                  shape: BoxShape.circle,
                  gradient: RadialGradient(center: Alignment(-.3, -.4), colors: [Color(0xFFFDE68A), Color(0xFFF59E0B), Color(0xFFEA6A12)], stops: [0, .6, 1]),
                ),
                child: done
                    ? Icon(Icons.check_rounded, size: size * .6, color: Gota.plum)
                    : Text(n, style: t(size * .47, color: Gota.plum, w: FontWeight.w800, h: 1)),
              ),
            ),
          ),
        ),
      );
}

class _DottedRingPainter extends CustomPainter {
  const _DottedRingPainter();
  @override
  void paint(Canvas canvas, Size size) {
    final c = size.center(Offset.zero);
    final r = size.shortestSide / 2 - 1.5;
    final p = Paint()..color = C.rani;
    final n = (2 * math.pi * r / 4.5).floor();
    for (var i = 0; i < n; i++) {
      final a = i * 2 * math.pi / n;
      canvas.drawCircle(c + Offset(math.cos(a) * r, math.sin(a) * r), 1.1, p);
    }
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}
