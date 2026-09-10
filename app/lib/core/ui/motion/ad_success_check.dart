import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../avatok_dark.dart';
import '../messenger_theme.dart';

/// A success tick: fades in, rotates upright from 80°, settles with a small
/// vertical bob, and draws its stroke as a dash-progress sweep rather than
/// popping in fully formed.
///
/// This replaces an existing ID-verification tick built on
/// [Curves.elasticOut] — the exact curve the August audit called cartoonish.
/// Every stage here uses [Msg.settle] (no overshoot); what reads as
/// "success" is the composition — rotation clearing before the stroke
/// finishes drawing, plus the bob — not a spring. [Msg.event] because a
/// confirmed action is exactly the class of moment that duration exists for.
class AdSuccessCheck extends StatefulWidget {
  const AdSuccessCheck({
    super.key,
    this.size = 48,
    this.color = AD.online,
    this.strokeWidth = 3.5,
  });

  final double size;
  final Color color;
  final double strokeWidth;

  @override
  State<AdSuccessCheck> createState() => _AdSuccessCheckState();
}

class _AdSuccessCheckState extends State<AdSuccessCheck>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(vsync: this, duration: Msg.event);
    final reduce = MediaQuery.of(context).disableAnimations;
    if (reduce) {
      _controller.value = 1;
    } else {
      _controller.forward();
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  double _bob(double t) {
    // A small dip-and-settle — down then back to rest, not a bounce curve.
    if (t <= 0.5) return -4 * (t / 0.5);
    return -4 * (1 - (t - 0.5) / 0.5);
  }

  @override
  Widget build(BuildContext context) {
    final reduce = MediaQuery.of(context).disableAnimations;
    return AnimatedBuilder(
      animation: _controller,
      builder: (context, _) {
        final t = (reduce ? 1.0 : _controller.value).clamp(0.0, 1.0);
        final opacity = const Interval(0.0, 0.3, curve: Msg.settle).transform(t);
        final rotationT = const Interval(0.0, 0.6, curve: Msg.settle).transform(t);
        final angle = (1 - rotationT) * 80 * math.pi / 180;
        final dashT = const Interval(0.3, 1.0, curve: Msg.settle).transform(t);
        final bobT = const Interval(0.5, 1.0, curve: Msg.settle).transform(t);

        return Opacity(
          opacity: opacity,
          child: Transform.translate(
            offset: Offset(0, _bob(bobT)),
            child: Transform.rotate(
              angle: angle,
              child: CustomPaint(
                size: Size.square(widget.size),
                painter: _CheckPainter(
                  progress: dashT,
                  color: widget.color,
                  strokeWidth: widget.strokeWidth,
                ),
              ),
            ),
          ),
        );
      },
    );
  }
}

class _CheckPainter extends CustomPainter {
  const _CheckPainter({
    required this.progress,
    required this.color,
    required this.strokeWidth,
  });

  final double progress;
  final Color color;
  final double strokeWidth;

  @override
  void paint(Canvas canvas, Size size) {
    final backing = Paint()
      ..color = color.withOpacity(0.12)
      ..style = PaintingStyle.fill;
    canvas.drawCircle(size.center(Offset.zero), size.shortestSide / 2, backing);

    final strokePaint = Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = strokeWidth
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round;

    final w = size.width;
    final h = size.height;
    final tick = Path()
      ..moveTo(w * 0.28, h * 0.52)
      ..lineTo(w * 0.44, h * 0.68)
      ..lineTo(w * 0.74, h * 0.32);

    final drawn = Path();
    for (final metric in tick.computeMetrics()) {
      drawn.addPath(metric.extractPath(0, metric.length * progress), Offset.zero);
    }
    canvas.drawPath(drawn, strokePaint);
  }

  @override
  bool shouldRepaint(covariant _CheckPainter oldDelegate) {
    return oldDelegate.progress != progress ||
        oldDelegate.color != color ||
        oldDelegate.strokeWidth != strokeWidth;
  }
}
