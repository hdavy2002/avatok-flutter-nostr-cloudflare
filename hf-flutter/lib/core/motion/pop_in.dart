import 'dart:math' as math;

import 'package:flutter/widgets.dart';

import 'reduced_motion.dart';

/// Shows [child] with a scale + fade pop when it first appears.
///
/// [delay] waits before the pop, [duration] is the pop itself, [beginScale]
/// is the starting size (0.85 = 85 %). With reduced motion [child] is shown at
/// once, full size.
class PopIn extends StatefulWidget {
  const PopIn({
    super.key,
    required this.child,
    this.delay = Duration.zero,
    this.duration = const Duration(milliseconds: 320),
    this.beginScale = 0.85,
    this.curve = Curves.easeOutBack,
    this.alignment = Alignment.center,
  });

  final Widget child;
  final Duration delay;
  final Duration duration;
  final double beginScale;
  final Curve curve;
  final Alignment alignment;

  @override
  State<PopIn> createState() => _PopInState();
}

class _PopInState extends State<PopIn> with SingleTickerProviderStateMixin {
  late final AnimationController _c;
  late final Animation<double> _scale;
  late final Animation<double> _fade;
  bool _started = false;

  @override
  void initState() {
    super.initState();
    final total = widget.delay + widget.duration;
    _c = AnimationController(vsync: this, duration: total);
    var start = motionFraction(widget.delay, total);
    if (start >= 1) start = 0;
    _scale = Tween<double>(begin: widget.beginScale, end: 1).animate(
      CurvedAnimation(
        parent: _c,
        curve: Interval(start, 1, curve: widget.curve),
      ),
    );
    _fade = CurvedAnimation(
      parent: _c,
      curve: Interval(start, 1, curve: Curves.easeOut),
    );
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_started) return;
    _started = true;
    if (hfReduceMotion(context)) {
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
    if (hfReduceMotion(context)) return widget.child;
    return FadeTransition(
      opacity: _fade,
      child: ScaleTransition(
        scale: _scale,
        alignment: widget.alignment,
        child: widget.child,
      ),
    );
  }
}

/// A column whose [children] fade in and rise [rise] px one after another.
///
/// Each child takes [itemDuration] (280 ms); the next starts [stagger]
/// (60 ms) later. With reduced motion every child is shown at once.
class StaggeredReveal extends StatefulWidget {
  const StaggeredReveal({
    super.key,
    required this.children,
    this.stagger = const Duration(milliseconds: 60),
    this.itemDuration = const Duration(milliseconds: 280),
    this.delay = Duration.zero,
    this.rise = 12,
    this.spacing = 0,
    this.crossAxisAlignment = CrossAxisAlignment.stretch,
    this.mainAxisSize = MainAxisSize.min,
  });

  final List<Widget> children;
  final Duration stagger;
  final Duration itemDuration;
  final Duration delay;
  final double rise;
  final double spacing;
  final CrossAxisAlignment crossAxisAlignment;
  final MainAxisSize mainAxisSize;

  @override
  State<StaggeredReveal> createState() => _StaggeredRevealState();
}

class _StaggeredRevealState extends State<StaggeredReveal>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c;
  bool _started = false;

  Duration get _total =>
      widget.delay +
      widget.stagger * math.max(0, widget.children.length - 1) +
      widget.itemDuration;

  @override
  void initState() {
    super.initState();
    _c = AnimationController(vsync: this, duration: _total);
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_started) return;
    _started = true;
    if (hfReduceMotion(context)) {
      _c.value = 1;
    } else {
      _c.forward();
    }
  }

  @override
  void didUpdateWidget(StaggeredReveal oldWidget) {
    super.didUpdateWidget(oldWidget);
    _c.duration = _total;
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  double _progress(int index) {
    final totalUs = _total.inMicroseconds;
    if (totalUs <= 0) return 1;
    final startUs = (widget.delay + widget.stagger * index).inMicroseconds;
    final itemUs = math.max(1, widget.itemDuration.inMicroseconds);
    final nowUs = _c.value * totalUs;
    final t = ((nowUs - startUs) / itemUs).clamp(0.0, 1.0).toDouble();
    return Curves.easeOutCubic.transform(t);
  }

  @override
  Widget build(BuildContext context) {
    final reduced = hfReduceMotion(context);
    return Column(
      mainAxisSize: widget.mainAxisSize,
      crossAxisAlignment: widget.crossAxisAlignment,
      spacing: widget.spacing,
      children: [
        for (var i = 0; i < widget.children.length; i++)
          reduced
              ? widget.children[i]
              : AnimatedBuilder(
                  animation: _c,
                  child: widget.children[i],
                  builder: (context, child) {
                    final t = _progress(i);
                    return Opacity(
                      opacity: t,
                      child: Transform.translate(
                        offset: Offset(0, widget.rise * (1 - t)),
                        child: child,
                      ),
                    );
                  },
                ),
      ],
    );
  }
}
