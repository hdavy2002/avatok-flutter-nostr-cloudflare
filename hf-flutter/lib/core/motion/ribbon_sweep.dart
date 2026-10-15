import 'dart:math' as math;
import 'dart:ui' show PathMetric;

import 'package:flutter/widgets.dart';

import '../theme/hf_tokens.dart';
import 'reduced_motion.dart';

/// A thick orange-to-deep-orange ribbon that sweeps across its area once
/// ("Nice work" style), over [duration] (900 ms), when it first appears.
///
/// With [stay] true (default) the ribbon stays drawn; with false its tail
/// follows the head and it leaves the screen. [child] (for example a
/// headline) is drawn on top, centred. [onComplete] runs when the sweep ends.
/// Give it a bounded size (Positioned.fill, SizedBox...). With reduced motion
/// the final state is shown at once.
class RibbonSweep extends StatefulWidget {
  const RibbonSweep({
    super.key,
    this.thickness = 56,
    this.duration = const Duration(milliseconds: 900),
    this.stay = true,
    this.onComplete,
    this.child,
  });

  final double thickness;
  final Duration duration;
  final bool stay;
  final VoidCallback? onComplete;
  final Widget? child;

  @override
  State<RibbonSweep> createState() => _RibbonSweepState();
}

class _RibbonSweepState extends State<RibbonSweep>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c;
  bool _started = false;

  @override
  void initState() {
    super.initState();
    _c = AnimationController(vsync: this, duration: widget.duration)
      ..addStatusListener((status) {
        if (status == AnimationStatus.completed && mounted) {
          widget.onComplete?.call();
        }
      });
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_started) return;
    _started = true;
    if (hfReduceMotion(context)) {
      _c.value = 1;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) widget.onComplete?.call();
      });
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
    final child = widget.child;
    return RepaintBoundary(
      child: CustomPaint(
        painter: _RibbonPainter(
          animation: _c,
          thickness: widget.thickness,
          stay: widget.stay,
        ),
        child: child == null ? const SizedBox.expand() : Center(child: child),
      ),
    );
  }
}

class _RibbonPainter extends CustomPainter {
  _RibbonPainter({
    required this.animation,
    required this.thickness,
    required this.stay,
  }) : super(repaint: animation);

  final Animation<double> animation;
  final double thickness;
  final bool stay;

  Size? _cachedSize;
  PathMetric? _metric;

  PathMetric? _metricFor(Size size) {
    if (_cachedSize == size) return _metric;
    final w = size.width;
    final h = size.height;
    final path = Path()
      ..moveTo(-0.1 * w, 0.68 * h)
      ..cubicTo(0.3 * w, 0.2 * h, 0.62 * w, 0.82 * h, 1.1 * w, 0.32 * h);
    final metrics = path.computeMetrics().toList();
    _cachedSize = size;
    _metric = metrics.isEmpty ? null : metrics.first;
    return _metric;
  }

  @override
  void paint(Canvas canvas, Size size) {
    if (size.isEmpty) return;
    final metric = _metricFor(size);
    if (metric == null) return;
    final v = animation.value;
    final length = metric.length;
    final head = length * Curves.easeInOutCubic.transform(v);
    final tailT = stay ? 0.0 : math.max(0.0, (v - 0.35) / 0.65);
    final tail =
        length * Curves.easeInCubic.transform(math.min(1.0, tailT));
    if (head - tail <= 0.5) return;
    final paint = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = thickness
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round
      ..shader = HfGradients.sunDeep.createShader(Offset.zero & size);
    canvas.drawPath(metric.extractPath(tail, head), paint);
  }

  @override
  bool shouldRepaint(_RibbonPainter old) =>
      old.animation != animation ||
      old.thickness != thickness ||
      old.stay != stay;
}
