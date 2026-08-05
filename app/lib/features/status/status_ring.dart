import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../core/ui/avatok_dark.dart';

/// [STATUS-FANOUT-1] Animated "story" ring drawn around a contact's avatar when
/// they have a live (unexpired) status — owner spec 2026-07-15: "display a round
/// animated circle around a users profile icon in the avatok chat threads. This
/// way, other users will know that he has some status."
///
/// ## [UI-MSG-PERF-1] 2026-08-05 — THE RING NO LONGER SPINS. Do not re-add it.
///
/// This used to run `AnimationController(3s)..repeat()`, i.e. one permanently
/// looping ticker **per visible chat row**. Two problems, and the first is the
/// one the owner actually noticed:
///
///  1. **It looked restless.** A chat list is a reading surface. Something
///     rotating forever next to every name says "loading", not "there's a
///     status here" — and it was the single most animated thing in the app.
///  2. **It cost real frames.** Every ring drives its own ticker and repaints a
///     `SweepGradient` shader each frame. Ten visible rows meant ten shaders
///     rebuilt 60 times a second, forever, on the busiest screen in the
///     product. The old `RepaintBoundary` limited the damage to the ring's own
///     layer; it did not make the work go away.
///
/// The ring is now a **static** gradient arc. It still reads unmistakably as
/// "this person has a status" — same colour, same thickness, same tap target —
/// it just stops moving. The widget stays `StatelessWidget` so there is no
/// ticker to leak and nothing to dispose.
///
/// If a status ring ever needs motion again, animate it **once on appear** and
/// stop; never `repeat()` inside a list row.
class StatusRing extends StatelessWidget {
  /// Diameter of the avatar this wraps (the ring is drawn OUTSIDE it).
  final double size;
  final Widget child;
  /// Ring thickness. 2.5 matches the static ring in the chat-list header.
  final double stroke;
  const StatusRing({super.key, required this.size, required this.child, this.stroke = 2.5});

  @override
  Widget build(BuildContext context) {
    // Gap between the ring and the avatar, so the photo isn't crowded.
    final pad = stroke + 2;
    return SizedBox(
      width: size + pad * 2,
      height: size + pad * 2,
      child: Stack(alignment: Alignment.center, children: [
        // RepaintBoundary kept: the ring is static now, so this lets the raster
        // cache hold it and skip re-rasterising the arc while the list scrolls.
        RepaintBoundary(
          child: CustomPaint(
            size: Size.square(size + pad * 2),
            painter: _RingPainter(stroke: stroke),
          ),
        ),
        SizedBox(width: size, height: size, child: child),
      ]),
    );
  }
}

class _RingPainter extends CustomPainter {
  final double stroke;
  const _RingPainter({required this.stroke});

  @override
  void paint(Canvas canvas, Size size) {
    final rect = Offset.zero & size;
    final centre = rect.center;
    final radius = (size.width / 2) - (stroke / 2);
    // Static sweep, fixed at a 45° start. The gradient is kept (it gives the
    // ring a little depth so it doesn't read as a flat border) but it no longer
    // rotates, and the fully-transparent stop is gone — a "comet head" only
    // makes sense on something that moves. The ring now reads as a solid arc
    // that fades slightly at one end.
    final shader = SweepGradient(
      startAngle: 0,
      endAngle: math.pi * 2,
      transform: const GradientRotation(math.pi / 4),
      colors: [
        AD.online.withValues(alpha: 0.55),
        AD.online,
        AD.online.withValues(alpha: 0.55),
      ],
      stops: const [0.0, 0.5, 1.0],
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

  // Nothing animates any more; only a stroke change can require a repaint.
  @override
  bool shouldRepaint(_RingPainter old) => old.stroke != stroke;
}
