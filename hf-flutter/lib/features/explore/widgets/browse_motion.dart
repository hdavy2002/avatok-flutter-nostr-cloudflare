import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../../core/motion/reduced_motion.dart';
import '../../../core/theme/hf_theme.dart';

/// HF-MOTION-B: small motion pieces for the browse screens (Explore / Home, notifications).
///
/// Every piece honours reduced motion: the final state shows at once and nothing stays hidden.

/// A host card (or list row) that fades in, rises [rise] px and grows from 96 % when it FIRST appears.
///
/// The animation lives in this widget's state, so give it a key that follows the item (for example the host
/// slug): rebuilds and scrolling keep the state and do not play it again. [index] staggers the start
/// ([stagger] per item, capped at [maxStaggered] items so late pages do not wait).
class RiseIn extends StatefulWidget {
  const RiseIn({
    super.key,
    required this.child,
    this.index = 0,
    this.stagger = const Duration(milliseconds: 70),
    this.maxStaggered = 5,
    this.duration = const Duration(milliseconds: 420),
    this.rise = 18,
    this.animate = true,
  });

  final Widget child;
  final int index;
  final Duration stagger;
  final int maxStaggered;
  final Duration duration;
  final double rise;

  /// False shows [child] at once (for an item that was already seen).
  final bool animate;

  @override
  State<RiseIn> createState() => _RiseInState();
}

class _RiseInState extends State<RiseIn> with SingleTickerProviderStateMixin {
  late final AnimationController _c;
  late final Animation<double> _t;
  bool _started = false;

  Duration get _delay =>
      widget.stagger * math.min(math.max(0, widget.index), widget.maxStaggered);

  @override
  void initState() {
    super.initState();
    final total = _delay + widget.duration;
    _c = AnimationController(vsync: this, duration: total);
    final start = motionFraction(_delay, total);
    _t = CurvedAnimation(
      parent: _c,
      curve: Interval(start >= 1 ? 0 : start, 1, curve: Curves.easeOutCubic),
    );
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_started) return;
    _started = true;
    if (!widget.animate || hfReduceMotion(context)) {
      _c.value = 1;
    } else {
      _c.forward();
    }
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _t,
      child: widget.child,
      builder: (context, child) {
        final t = _t.value;
        if (t >= 1) return child!;
        return Opacity(
          opacity: t.clamp(0.0, 1.0).toDouble(),
          child: Transform.translate(
            offset: Offset(0, widget.rise * (1 - t)),
            child: Transform.scale(scale: 0.96 + 0.04 * t, child: child),
          ),
        );
      },
    );
  }
}

/// Gives [child] a small springy bounce (down to [depth], then back with a little overshoot) when it is
/// pressed. It only listens to the pointer, so the child's own tap, semantics and 48 dp target are unchanged.
class TapBounce extends StatefulWidget {
  const TapBounce({super.key, required this.child, this.depth = 0.9});

  final Widget child;

  /// Smallest scale during the bounce.
  final double depth;

  @override
  State<TapBounce> createState() => _TapBounceState();
}

class _TapBounceState extends State<TapBounce>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 420),
  );

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  void _bounce(PointerDownEvent _) {
    if (hfReduceMotion(context)) return;
    _c.forward(from: 0);
  }

  /// 1 -> depth in the first 30 %, then back to 1 with an elastic overshoot.
  double _scale(double t) {
    if (t <= 0 || t >= 1) return 1;
    if (t < 0.3) {
      return 1 - (1 - widget.depth) * Curves.easeOut.transform(t / 0.3);
    }
    final back = Curves.elasticOut.transform((t - 0.3) / 0.7);
    return widget.depth + (1 - widget.depth) * back;
  }

  @override
  Widget build(BuildContext context) {
    return Listener(
      onPointerDown: _bounce,
      child: AnimatedBuilder(
        animation: _c,
        child: widget.child,
        builder: (context, child) {
          final s = _scale(_c.value);
          if (s == 1) return child!;
          return Transform.scale(scale: s, child: child);
        },
      ),
    );
  }
}

/// A gentle warm sun glow behind the Explore header: a soft sunshine halo top right and a faint orange one
/// top left, fading in once over 900 ms. It paints behind [child] and never takes taps.
class WarmHeaderGlow extends StatelessWidget {
  const WarmHeaderGlow({super.key, required this.child});

  final Widget child;

  /// Key of the glow layer (for tests).
  static const Key glowKey = ValueKey<String>('explore-warm-glow');

  @override
  Widget build(BuildContext context) {
    final dark = HfBrightness.isDark(context);
    return Stack(
      clipBehavior: Clip.hardEdge,
      children: [
        Positioned.fill(
          child: IgnorePointer(
            child: ExcludeSemantics(
              child: TweenAnimationBuilder<double>(
                key: glowKey,
                tween: Tween<double>(begin: 0, end: 1),
                duration: HfMotion.of(
                  context,
                  const Duration(milliseconds: 900),
                ),
                curve: Curves.easeOut,
                builder: (context, v, _) => RepaintBoundary(
                  child: CustomPaint(
                    painter: _GlowPainter(strength: v * (dark ? 0.45 : 1)),
                  ),
                ),
              ),
            ),
          ),
        ),
        child,
      ],
    );
  }
}

class _GlowPainter extends CustomPainter {
  _GlowPainter({required this.strength});

  final double strength;

  @override
  void paint(Canvas canvas, Size size) {
    if (strength <= 0 || size.isEmpty) return;
    void halo(Offset c, double r, Color color, double alpha) {
      final rect = Rect.fromCircle(center: c, radius: r);
      final paint = Paint()
        ..shader = RadialGradient(
          colors: [
            color.withValues(alpha: alpha * strength),
            color.withValues(alpha: alpha * strength * 0.45),
            color.withValues(alpha: 0),
          ],
          stops: const [0, 0.5, 1],
        ).createShader(rect);
      canvas.drawCircle(c, r, paint);
    }

    final r = math.min(260.0, size.width * 0.75);
    halo(Offset(size.width - r * 0.2, r * 0.05), r, HfColors.sunshine, 0.42);
    halo(Offset(r * 0.05, -r * 0.2), r * 0.8, HfColors.primary, 0.16);
  }

  @override
  bool shouldRepaint(_GlowPainter old) => old.strength != strength;
}
