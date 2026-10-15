import 'dart:math' as math;

import 'package:flutter/widgets.dart';

import '../theme/hf_tokens.dart';
import 'reduced_motion.dart';

/// Mixin for a looping decoration: runs [loop] while [loopEnabled] and the
/// phone allows animation, otherwise parks it at 0 (the still state).
mixin _LoopingState<T extends StatefulWidget>
    on State<T>, SingleTickerProviderStateMixin<T> {
  late final AnimationController loop;

  Duration get loopPeriod;
  bool get loopEnabled => true;
  bool loopReverse = false;

  bool running = false;

  @override
  void initState() {
    super.initState();
    loop = AnimationController(vsync: this, duration: loopPeriod);
  }

  void syncLoop() {
    loop.duration = loopPeriod;
    final run = loopEnabled && !hfReduceMotion(context);
    if (run) {
      if (!loop.isAnimating) loop.repeat(reverse: loopReverse);
    } else if (loop.isAnimating || loop.value != 0) {
      loop.stop();
      loop.value = 0;
    }
    running = run;
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    syncLoop();
  }

  @override
  void didUpdateWidget(T oldWidget) {
    super.didUpdateWidget(oldWidget);
    syncLoop();
  }

  @override
  void dispose() {
    loop.dispose();
    super.dispose();
  }
}

/// Slow "breathing" scale loop (1 -> [maxScale] -> 1 every [period]).
/// With reduced motion, or [enabled] false, [child] stays still.
class Breathing extends StatefulWidget {
  const Breathing({
    super.key,
    required this.child,
    this.period = const Duration(milliseconds: 2400),
    this.maxScale = 1.03,
    this.enabled = true,
  });

  final Widget child;
  final Duration period;
  final double maxScale;
  final bool enabled;

  @override
  State<Breathing> createState() => _BreathingState();
}

class _BreathingState extends State<Breathing>
    with SingleTickerProviderStateMixin, _LoopingState<Breathing> {
  @override
  Duration get loopPeriod => widget.period;

  @override
  bool get loopEnabled => widget.enabled;

  @override
  Widget build(BuildContext context) {
    if (!running) return widget.child;
    return AnimatedBuilder(
      animation: loop,
      child: widget.child,
      builder: (context, child) {
        final wave = 0.5 - 0.5 * math.cos(2 * math.pi * loop.value);
        return Transform.scale(
          scale: 1 + (widget.maxScale - 1) * wave,
          child: child,
        );
      },
    );
  }
}

/// An "online now" dot with a soft heartbeat halo.
/// With reduced motion only the still dot is drawn.
class PulseDot extends StatefulWidget {
  const PulseDot({
    super.key,
    this.color = HfColors.roseDot,
    this.size = 10,
    this.period = const Duration(milliseconds: 1400),
    this.semanticLabel,
  });

  final Color color;

  /// Diameter of the dot. The widget is 2.4 times wider to leave room for the halo.
  final double size;
  final Duration period;
  final String? semanticLabel;

  @override
  State<PulseDot> createState() => _PulseDotState();
}

class _PulseDotState extends State<PulseDot>
    with SingleTickerProviderStateMixin, _LoopingState<PulseDot> {
  @override
  Duration get loopPeriod => widget.period;

  @override
  Widget build(BuildContext context) {
    final box = widget.size * 2.4;
    final dot = SizedBox.square(
      dimension: box,
      child: RepaintBoundary(
        child: CustomPaint(
          painter: _PulseDotPainter(
            animation: running ? loop : null,
            color: widget.color,
            radius: widget.size / 2,
          ),
        ),
      ),
    );
    final label = widget.semanticLabel;
    if (label == null) return ExcludeSemantics(child: dot);
    return Semantics(label: label, child: ExcludeSemantics(child: dot));
  }
}

class _PulseDotPainter extends CustomPainter {
  _PulseDotPainter({
    required this.animation,
    required this.color,
    required this.radius,
  }) : super(repaint: animation);

  final Animation<double>? animation;
  final Color color;
  final double radius;
  final Paint _paint = Paint();

  @override
  void paint(Canvas canvas, Size size) {
    final center = size.center(Offset.zero);
    final a = animation;
    var r = radius;
    if (a != null) {
      final t = a.value;
      _paint.color = color.withValues(alpha: 0.45 * (1 - t));
      canvas.drawCircle(center, radius * (1 + 1.4 * t), _paint);
      final beat = (t / 0.25).clamp(0.0, 1.0).toDouble();
      r = radius * (1 + 0.12 * math.sin(math.pi * beat));
    }
    _paint.color = color;
    canvas.drawCircle(center, r, _paint);
  }

  @override
  bool shouldRepaint(_PulseDotPainter old) =>
      old.animation != animation ||
      old.color != color ||
      old.radius != radius;
}

/// Expanding, fading rings around [child] (the calling screen).
/// [size] is the square the rings fill. With reduced motion only [child] shows.
class RippleRings extends StatefulWidget {
  const RippleRings({
    super.key,
    required this.child,
    this.size = 240,
    this.ringCount = 3,
    this.period = const Duration(milliseconds: 2400),
    this.colors = const [HfColors.primary, HfColors.sunshine],
    this.enabled = true,
  });

  final Widget child;
  final double size;
  final int ringCount;
  final Duration period;
  final List<Color> colors;
  final bool enabled;

  @override
  State<RippleRings> createState() => _RippleRingsState();
}

class _RippleRingsState extends State<RippleRings>
    with SingleTickerProviderStateMixin, _LoopingState<RippleRings> {
  @override
  Duration get loopPeriod => widget.period;

  @override
  bool get loopEnabled => widget.enabled;

  @override
  Widget build(BuildContext context) {
    return SizedBox.square(
      dimension: widget.size,
      child: Stack(
        alignment: Alignment.center,
        children: [
          if (running)
            Positioned.fill(
              child: IgnorePointer(
                child: RepaintBoundary(
                  child: CustomPaint(
                    painter: _RipplePainter(
                      animation: loop,
                      count: math.max(1, widget.ringCount),
                      colors: widget.colors,
                    ),
                  ),
                ),
              ),
            ),
          widget.child,
        ],
      ),
    );
  }
}

class _RipplePainter extends CustomPainter {
  _RipplePainter({
    required this.animation,
    required this.count,
    required this.colors,
  }) : super(repaint: animation);

  final Animation<double> animation;
  final int count;
  final List<Color> colors;
  final Paint _fill = Paint();
  final Paint _stroke = Paint()
    ..style = PaintingStyle.stroke
    ..strokeWidth = 3;

  @override
  void paint(Canvas canvas, Size size) {
    if (colors.isEmpty) return;
    final center = size.center(Offset.zero);
    final maxR = size.shortestSide / 2;
    final minR = maxR * 0.35;
    for (var i = 0; i < count; i++) {
      final p = (animation.value + i / count) % 1.0;
      final r = minR + (maxR - minR) * p;
      final c = colors[i % colors.length];
      _fill.color = c.withValues(alpha: 0.18 * (1 - p));
      _stroke.color = c.withValues(alpha: 0.6 * (1 - p));
      canvas.drawCircle(center, r, _fill);
      canvas.drawCircle(center, r, _stroke);
    }
  }

  @override
  bool shouldRepaint(_RipplePainter old) =>
      old.animation != animation ||
      old.count != count ||
      old.colors != colors;
}

/// Three bouncing dots (primary, sunshine, deep orange) to use instead of a
/// plain spinner. With reduced motion the dots sit still.
class HfLoader extends StatefulWidget {
  const HfLoader({
    super.key,
    this.dotSize = 10,
    this.semanticLabel = 'Loading',
  });

  final double dotSize;
  final String semanticLabel;

  @override
  State<HfLoader> createState() => _HfLoaderState();
}

class _HfLoaderState extends State<HfLoader>
    with SingleTickerProviderStateMixin, _LoopingState<HfLoader> {
  @override
  Duration get loopPeriod => const Duration(milliseconds: 900);

  @override
  Widget build(BuildContext context) {
    final d = widget.dotSize;
    return Semantics(
      label: widget.semanticLabel,
      child: ExcludeSemantics(
        child: SizedBox(
          width: d * 3 + d * 0.8 * 2,
          height: d * 2.2,
          child: RepaintBoundary(
            child: CustomPaint(
              painter: _LoaderPainter(
                animation: running ? loop : null,
                dot: d,
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _LoaderPainter extends CustomPainter {
  _LoaderPainter({required this.animation, required this.dot})
    : super(repaint: animation);

  static const List<Color> colors = [
    HfColors.primary,
    HfColors.sunshine,
    HfColors.deepOrange,
  ];

  final Animation<double>? animation;
  final double dot;
  final Paint _paint = Paint();

  @override
  void paint(Canvas canvas, Size size) {
    final t = animation?.value;
    final gap = dot * 0.8;
    final rest = size.height - dot / 2;
    for (var i = 0; i < 3; i++) {
      var lift = 0.0;
      if (t != null) {
        final phase = (t - i * 0.15) % 1.0;
        final up = (phase / 0.5).clamp(0.0, 1.0).toDouble();
        lift = phase < 0.5 ? math.sin(math.pi * up) : 0;
      }
      final x = dot / 2 + i * (dot + gap);
      final y = t == null ? size.height / 2 : rest - lift * dot;
      _paint.color = colors[i];
      canvas.drawCircle(Offset(x, y), dot / 2, _paint);
    }
  }

  @override
  bool shouldRepaint(_LoaderPainter old) =>
      old.animation != animation || old.dot != dot;
}
