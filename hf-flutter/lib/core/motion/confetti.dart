import 'dart:math' as math;

import 'package:flutter/widgets.dart';

import '../theme/hf_tokens.dart';
import 'reduced_motion.dart';

/// Fires a [ConfettiBurst]. Create one in a State, pass it to the burst,
/// call [fire] whenever there is something to celebrate, dispose it with the
/// State.
class ConfettiController extends ChangeNotifier {
  int _shots = 0;

  /// How many times [fire] has been called.
  int get shots => _shots;

  /// Starts a new burst (fire-and-forget).
  void fire() {
    _shots++;
    notifyListeners();
  }
}

/// Paints a one-shot confetti burst over [child] each time [controller]
/// fires: [particleCount] rounded rectangles and circles in the confetti
/// palette that fly out from [origin], spin, fall and fade over [duration].
///
/// Nothing is drawn with reduced motion. The confetti never takes touches.
class ConfettiBurst extends StatefulWidget {
  const ConfettiBurst({
    super.key,
    required this.controller,
    required this.child,
    this.particleCount = 50,
    this.duration = const Duration(milliseconds: 1400),
    this.origin = const Alignment(0, -0.2),
    this.power = 1,
    this.colors = HfConfetti.palette,
  });

  /// Key of the confetti layer while a burst is in the air (for tests).
  static const Key paintKey = ValueKey<String>('hf-confetti-paint');

  final ConfettiController controller;
  final Widget child;

  /// 40 to 60 looks right full screen; about 16 for a small puff.
  final int particleCount;
  final Duration duration;

  /// Where the burst starts, inside this widget.
  final Alignment origin;

  /// Speed multiplier: 1 for full screen, about 0.45 for a small puff.
  final double power;
  final List<Color> colors;

  @override
  State<ConfettiBurst> createState() => _ConfettiBurstState();
}

class _ConfettiBurstState extends State<ConfettiBurst>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c;
  final math.Random _random = math.Random();
  List<_Particle> _particles = const [];
  bool _bursting = false;

  @override
  void initState() {
    super.initState();
    _c = AnimationController(vsync: this, duration: widget.duration)
      ..addStatusListener(_onStatus);
    widget.controller.addListener(_fire);
  }

  @override
  void didUpdateWidget(ConfettiBurst oldWidget) {
    super.didUpdateWidget(oldWidget);
    _c.duration = widget.duration;
    if (oldWidget.controller != widget.controller) {
      oldWidget.controller.removeListener(_fire);
      widget.controller.addListener(_fire);
    }
  }

  @override
  void dispose() {
    widget.controller.removeListener(_fire);
    _c.dispose();
    super.dispose();
  }

  void _fire() {
    if (!mounted || hfReduceMotion(context) || widget.colors.isEmpty) return;
    setState(() {
      _particles = List<_Particle>.generate(
        widget.particleCount,
        (_) => _Particle.random(_random, widget.colors, widget.power),
      );
      _bursting = true;
    });
    _c.forward(from: 0);
  }

  void _onStatus(AnimationStatus status) {
    if (status == AnimationStatus.completed && mounted) {
      setState(() {
        _bursting = false;
        _particles = const [];
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final show = _bursting && !hfReduceMotion(context);
    return Stack(
      clipBehavior: Clip.none,
      children: [
        widget.child,
        if (show)
          Positioned.fill(
            child: IgnorePointer(
              child: RepaintBoundary(
                child: CustomPaint(
                  key: ConfettiBurst.paintKey,
                  painter: _ConfettiPainter(
                    animation: _c,
                    particles: _particles,
                    origin: widget.origin,
                    seconds: widget.duration.inMilliseconds / 1000,
                  ),
                ),
              ),
            ),
          ),
      ],
    );
  }
}

class _Particle {
  const _Particle({
    required this.vx,
    required this.vy,
    required this.spin,
    required this.rotation,
    required this.color,
    required this.circle,
    required this.size,
  });

  factory _Particle.random(math.Random r, List<Color> colors, double power) {
    final angle = -math.pi / 2 + (r.nextDouble() * 2 - 1) * math.pi * 0.42;
    final speed = (260 + r.nextDouble() * 420) * power;
    return _Particle(
      vx: math.cos(angle) * speed,
      vy: math.sin(angle) * speed,
      spin: (r.nextDouble() * 2 - 1) * 10,
      rotation: r.nextDouble() * math.pi * 2,
      color: colors[r.nextInt(colors.length)],
      circle: r.nextDouble() < 0.35,
      size: (5 + r.nextDouble() * 5) * math.max(0.6, math.min(1.0, power)),
    );
  }

  final double vx;
  final double vy;
  final double spin;
  final double rotation;
  final Color color;
  final bool circle;
  final double size;
}

class _ConfettiPainter extends CustomPainter {
  _ConfettiPainter({
    required this.animation,
    required this.particles,
    required this.origin,
    required this.seconds,
  }) : super(repaint: animation);

  static const double _gravity = 900;

  final Animation<double> animation;
  final List<_Particle> particles;
  final Alignment origin;
  final double seconds;
  final Paint _paint = Paint();

  @override
  void paint(Canvas canvas, Size size) {
    final v = animation.value;
    final t = v * seconds;
    final start = origin.alongSize(size);
    final fade = v < 0.6 ? 1.0 : (1 - (v - 0.6) / 0.4).clamp(0.0, 1.0);
    for (final p in particles) {
      final x = start.dx + p.vx * t;
      final y = start.dy + p.vy * t + 0.5 * _gravity * t * t;
      _paint.color = p.color.withValues(alpha: fade.toDouble());
      canvas.save();
      canvas.translate(x, y);
      canvas.rotate(p.rotation + p.spin * t);
      if (p.circle) {
        canvas.drawCircle(Offset.zero, p.size * 0.4, _paint);
      } else {
        canvas.drawRRect(
          RRect.fromRectAndRadius(
            Rect.fromCenter(
              center: Offset.zero,
              width: p.size,
              height: p.size * 0.6,
            ),
            const Radius.circular(1.5),
          ),
          _paint,
        );
      }
      canvas.restore();
    }
  }

  @override
  bool shouldRepaint(_ConfettiPainter old) =>
      old.animation != animation ||
      old.particles != particles ||
      old.origin != origin;
}
