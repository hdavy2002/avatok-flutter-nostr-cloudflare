import 'dart:math' as math;

import 'package:flutter/widgets.dart';

import '../theme/hf_tokens.dart';
import 'confetti.dart';
import 'reduced_motion.dart';

/// A filled circle that pops in, then a tick that draws itself.
///
/// [size] is the circle diameter, [color] its fill and [checkColor] the tick.
/// With [confetti] true a small confetti puff fires when the tick finishes.
/// [semanticLabel] is read by screen readers ("Done" by default). With reduced
/// motion the finished tick is shown at once and no confetti is drawn.
class DrawnCheck extends StatefulWidget {
  const DrawnCheck({
    super.key,
    this.size = 88,
    this.color = HfColors.primary,
    this.checkColor = HfColors.white,
    this.duration = const Duration(milliseconds: 650),
    this.delay = Duration.zero,
    this.confetti = false,
    this.semanticLabel = 'Done',
  });

  final double size;
  final Color color;
  final Color checkColor;
  final Duration duration;
  final Duration delay;
  final bool confetti;
  final String semanticLabel;

  @override
  State<DrawnCheck> createState() => _DrawnCheckState();
}

class _DrawnCheckState extends State<DrawnCheck>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c;
  final ConfettiController _puff = ConfettiController();
  bool _started = false;
  bool _reduced = false;

  @override
  void initState() {
    super.initState();
    _c =
        AnimationController(
          vsync: this,
          duration: widget.delay + widget.duration,
        )..addStatusListener((status) {
          if (status == AnimationStatus.completed &&
              mounted &&
              widget.confetti &&
              !_reduced) {
            _puff.fire();
          }
        });
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _reduced = hfReduceMotion(context);
    if (_started) return;
    _started = true;
    if (_reduced) {
      _c.value = 1;
    } else {
      _c.forward();
    }
  }

  @override
  void dispose() {
    _c.dispose();
    _puff.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final start = motionFraction(
      widget.delay,
      widget.delay + widget.duration,
    );
    Widget check = SizedBox.square(
      dimension: widget.size,
      child: RepaintBoundary(
        child: CustomPaint(
          painter: _CheckPainter(
            animation: _c,
            start: start >= 1 ? 0.0 : start,
            color: widget.color,
            checkColor: widget.checkColor,
          ),
        ),
      ),
    );
    if (widget.confetti) {
      check = ConfettiBurst(
        controller: _puff,
        particleCount: 16,
        power: 0.45,
        origin: Alignment.center,
        duration: const Duration(milliseconds: 900),
        child: check,
      );
    }
    return Semantics(
      label: widget.semanticLabel,
      image: true,
      child: ExcludeSemantics(child: check),
    );
  }
}

class _CheckPainter extends CustomPainter {
  _CheckPainter({
    required this.animation,
    required this.start,
    required this.color,
    required this.checkColor,
  }) : super(repaint: animation);

  final Animation<double> animation;
  final double start;
  final Color color;
  final Color checkColor;

  @override
  void paint(Canvas canvas, Size size) {
    final active = ((animation.value - start) / (1 - start))
        .clamp(0.0, 1.0)
        .toDouble();
    if (active <= 0) return;
    final center = size.center(Offset.zero);
    final circleT = Curves.easeOutBack.transform(
      math.min(1.0, active / 0.4),
    );
    canvas.drawCircle(
      center,
      size.shortestSide / 2 * circleT,
      Paint()..color = color,
    );

    final tickT = ((active - 0.35) / 0.65).clamp(0.0, 1.0).toDouble();
    if (tickT <= 0) return;
    final w = size.width;
    final h = size.height;
    final tick = Path()
      ..moveTo(0.28 * w, 0.52 * h)
      ..lineTo(0.44 * w, 0.67 * h)
      ..lineTo(0.73 * w, 0.36 * h);
    final metrics = tick.computeMetrics().toList();
    if (metrics.isEmpty) return;
    final metric = metrics.first;
    final drawn = metric.extractPath(
      0,
      metric.length * Curves.easeOutCubic.transform(tickT),
    );
    canvas.drawPath(
      drawn,
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = size.shortestSide * 0.09
        ..strokeCap = StrokeCap.round
        ..strokeJoin = StrokeJoin.round
        ..color = checkColor,
    );
  }

  @override
  bool shouldRepaint(_CheckPainter old) =>
      old.animation != animation ||
      old.start != start ||
      old.color != color ||
      old.checkColor != checkColor;
}
