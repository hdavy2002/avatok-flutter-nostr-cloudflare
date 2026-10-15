import 'package:flutter/material.dart';

import '../theme/hf_tokens.dart';

/// Warm background: a cream sky with an orange (HfGradients.sun) hill rising
/// from the bottom, edged by a soft yellow glow.
///
/// [riseTo] is how high the top of the hill reaches, as a fraction of the
/// height (0 = no hill, 1 = the whole screen). Changing it animates the hill
/// over [duration]; pass [riseFrom] to animate on first build too (splash
/// "breath", call-connected fill). With reduced motion the hill jumps to
/// [riseTo]. [child] is drawn on top; without a child the hill fills its
/// parent.
class SunHill extends StatelessWidget {
  const SunHill({
    super.key,
    this.riseTo = 0.32,
    this.riseFrom,
    this.duration = const Duration(milliseconds: 900),
    this.curve = Curves.easeOutCubic,
    this.background,
    this.child,
  });

  final double riseTo;
  final double? riseFrom;
  final Duration duration;
  final Curve curve;

  /// Sky colour. Defaults to the cream page (black in dark mode).
  final Color? background;
  final Widget? child;

  @override
  Widget build(BuildContext context) {
    final dark = Theme.of(context).brightness == Brightness.dark;
    final sky = background ?? (dark ? HfColors.darkBg : null);
    return Stack(
      children: [
        Positioned.fill(
          child: RepaintBoundary(
            child: TweenAnimationBuilder<double>(
              tween: Tween<double>(begin: riseFrom ?? riseTo, end: riseTo),
              duration: HfMotion.of(context, duration),
              curve: curve,
              builder: (context, rise, _) => CustomPaint(
                painter: SunHillPainter(rise: rise, sky: sky),
              ),
            ),
          ),
        ),
        child ?? const SizedBox.expand(),
      ],
    );
  }
}

/// The painter behind [SunHill], public so a screen can draw the same hill
/// inside its own CustomPaint.
class SunHillPainter extends CustomPainter {
  SunHillPainter({required this.rise, this.sky});

  final double rise;

  /// Solid sky colour; null paints the cream page-to-butter gradient.
  final Color? sky;

  @override
  void paint(Canvas canvas, Size size) {
    final rect = Offset.zero & size;
    final skyPaint = Paint();
    final s = sky;
    if (s != null) {
      skyPaint.color = s;
    } else {
      skyPaint.shader = const LinearGradient(
        begin: Alignment.topCenter,
        end: Alignment.bottomCenter,
        colors: [HfColors.page, HfColors.butter],
      ).createShader(rect);
    }
    canvas.drawRect(rect, skyPaint);

    final r = rise.clamp(0.0, 1.2).toDouble();
    if (r <= 0) return;
    final w = size.width;
    final h = size.height;
    final crest = h * (1 - r);
    final edge = crest + h * 0.07;
    final hill = Path()
      ..moveTo(0, edge)
      ..quadraticBezierTo(w / 2, crest - h * 0.07, w, edge)
      ..lineTo(w, h)
      ..lineTo(0, h)
      ..close();

    canvas.drawPath(
      hill,
      Paint()
        ..color = HfColors.sunshine.withValues(alpha: 0.55)
        ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 18),
    );
    canvas.drawPath(
      hill,
      Paint()
        ..shader = HfGradients.sun.createShader(
          Rect.fromLTRB(0, crest, w, h),
        ),
    );
  }

  @override
  bool shouldRepaint(SunHillPainter old) =>
      old.rise != rise || old.sky != sky;
}
