import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../core/ui/avatok_dark.dart';

/// [STATUS-FANOUT-1] Animated "story" ring drawn around a contact's avatar when
/// they have a live (unexpired) status — owner spec 2026-07-15: "display a round
/// animated circle around a users profile icon in the avatok chat threads. This
/// way, other users will know that he has some status."
///
/// A slowly rotating sweep gradient rather than a pulsing scale: the chat list
/// can show many of these at once, and anything that changes SIZE would reflow
/// every row on each frame. Rotation repaints inside a fixed box, so layout is
/// untouched — only the ring's own [CustomPaint] repaints.
///
/// The ticker is owned by this widget, so it stops the moment the row scrolls out
/// of the list (Flutter disposes it) — there is no global animation left running
/// behind the chat list.
class StatusRing extends StatefulWidget {
  /// Diameter of the avatar this wraps (the ring is drawn OUTSIDE it).
  final double size;
  final Widget child;
  /// Ring thickness. 2.5 matches the static header glow ([_glowRing]).
  final double stroke;
  const StatusRing({super.key, required this.size, required this.child, this.stroke = 2.5});

  @override
  State<StatusRing> createState() => _StatusRingState();
}

class _StatusRingState extends State<StatusRing> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(
    vsync: this,
    // Slow on purpose. This sits in a scrolling list next to text the user is
    // trying to read; a fast spin reads as a loading spinner ("is it stuck?")
    // rather than an ambient "there's something here".
    duration: const Duration(seconds: 3),
  )..repeat();

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    // Gap between the ring and the avatar, so the photo isn't crowded.
    final pad = widget.stroke + 2;
    return SizedBox(
      width: widget.size + pad * 2,
      height: widget.size + pad * 2,
      child: Stack(alignment: Alignment.center, children: [
        // RepaintBoundary: without it, every frame of the rotation would mark the
        // whole row (avatar, name, preview text) dirty. With it, only the ring's
        // own layer repaints.
        RepaintBoundary(
          child: AnimatedBuilder(
            animation: _c,
            builder: (_, __) => CustomPaint(
              size: Size.square(widget.size + pad * 2),
              painter: _RingPainter(turns: _c.value, stroke: widget.stroke),
            ),
          ),
        ),
        SizedBox(width: widget.size, height: widget.size, child: widget.child),
      ]),
    );
  }
}

class _RingPainter extends CustomPainter {
  final double turns; // 0..1
  final double stroke;
  _RingPainter({required this.turns, required this.stroke});

  @override
  void paint(Canvas canvas, Size size) {
    final rect = Offset.zero & size;
    final centre = rect.center;
    final radius = (size.width / 2) - (stroke / 2);
    // Sweep gradient rotated by `turns`. AD.online is the same green the static
    // header glow uses, so a status reads identically in both places; the
    // transparent stop is what makes the travelling "comet" head visible.
    final shader = SweepGradient(
      startAngle: 0,
      endAngle: math.pi * 2,
      transform: GradientRotation(turns * 2 * math.pi),
      colors: [
        AD.online.withValues(alpha: 0.0),
        AD.online.withValues(alpha: 0.55),
        AD.online,
        AD.online.withValues(alpha: 0.0),
      ],
      stops: const [0.0, 0.45, 0.75, 1.0],
    ).createShader(rect);
    canvas.drawCircle(
      centre,
      radius,
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = stroke
        ..strokeCap = StrokeCap.round
        ..shader = shader,
    );
  }

  // Repaint only when the rotation actually advances.
  @override
  bool shouldRepaint(_RingPainter old) => old.turns != turns || old.stroke != stroke;
}
