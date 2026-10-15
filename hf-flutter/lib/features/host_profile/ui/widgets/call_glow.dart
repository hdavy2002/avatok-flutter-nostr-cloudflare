import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../../../core/motion/loops.dart';
import '../../../../core/motion/reduced_motion.dart';
import '../../../../core/theme/hf_theme.dart';

/// HF-MOTION-B: makes the profile's Call button feel alive. It breathes slowly ([Breathing], 1 -> 1.025), a
/// soft orange glow swells and settles around it, and a light shine sweeps across it once per [period].
///
/// Decoration only: taps, semantics and size of [child] are unchanged (the glow and shine never take taps).
/// With reduced motion it is the still button with a calm, fixed glow.
class CallGlow extends StatefulWidget {
  const CallGlow({
    super.key,
    required this.child,
    this.radius = HfRadius.tile,
    this.period = const Duration(milliseconds: 2800),
  });

  final Widget child;
  final double radius;
  final Duration period;

  /// Key of the glow wrapper (for tests).
  static const Key glowKey = ValueKey<String>('call-glow');

  @override
  State<CallGlow> createState() => _CallGlowState();
}

class _CallGlowState extends State<CallGlow>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(
    vsync: this,
    duration: widget.period,
  );

  void _sync() {
    if (hfReduceMotion(context)) {
      if (_c.isAnimating) _c.stop();
      _c.value = 0;
    } else if (!_c.isAnimating) {
      _c.repeat();
    }
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _sync();
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  BoxDecoration _glow(double g) => BoxDecoration(
    borderRadius: BorderRadius.circular(widget.radius),
    boxShadow: [
      BoxShadow(
        color: HfColors.primary.withValues(alpha: 0.22 + 0.22 * g),
        blurRadius: 10 + 12 * g,
        spreadRadius: 1.5 * g,
        offset: const Offset(0, 4),
      ),
    ],
  );

  @override
  Widget build(BuildContext context) {
    final radius = BorderRadius.circular(widget.radius);
    if (hfReduceMotion(context)) {
      return DecoratedBox(
        key: CallGlow.glowKey,
        decoration: _glow(0.4),
        child: widget.child,
      );
    }
    return Breathing(
      maxScale: 1.025,
      period: widget.period,
      child: AnimatedBuilder(
        animation: _c,
        child: widget.child,
        builder: (context, child) {
          final t = _c.value;
          final g = 0.5 - 0.5 * math.cos(2 * math.pi * t);
          return DecoratedBox(
            key: CallGlow.glowKey,
            decoration: _glow(g),
            child: Stack(
              children: [
                child!,
                Positioned.fill(
                  child: IgnorePointer(
                    child: ClipRRect(
                      borderRadius: radius,
                      child: CustomPaint(painter: _ShinePainter(t)),
                    ),
                  ),
                ),
              ],
            ),
          );
        },
      ),
    );
  }
}

/// A slanted soft white band that crosses the button during the first 40 % of the loop, then rests.
class _ShinePainter extends CustomPainter {
  _ShinePainter(this.t);

  final double t;

  @override
  void paint(Canvas canvas, Size size) {
    if (t >= 0.4 || size.isEmpty) return;
    final p = Curves.easeInOut.transform(t / 0.4);
    final band = size.width * 0.28;
    final x = -band + (size.width + 2 * band) * p;
    final rect = Rect.fromLTWH(x - band / 2, 0, band, size.height);
    final paint = Paint()
      ..shader = LinearGradient(
        colors: [
          HfColors.white.withValues(alpha: 0),
          HfColors.white.withValues(alpha: 0.32),
          HfColors.white.withValues(alpha: 0),
        ],
      ).createShader(rect);
    canvas.save();
    // Lean the band like light on a rounded pill.
    canvas.translate(rect.center.dx, rect.center.dy);
    canvas.skew(-0.35, 0);
    canvas.translate(-rect.center.dx, -rect.center.dy);
    canvas.drawRect(rect.inflate(size.height), paint);
    canvas.restore();
  }

  @override
  bool shouldRepaint(_ShinePainter old) => old.t != t;
}
