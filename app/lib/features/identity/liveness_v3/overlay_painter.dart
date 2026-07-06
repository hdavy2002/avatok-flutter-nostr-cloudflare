import 'package:flutter/material.dart';

import '../liveness_v2/live_theme.dart';
import 'challenge_session.dart';

/// Liveness V3 — PARAMETRIZED face overlay (Specs/LIVENESS-V3-VOICE-GUIDED-PLAN-
/// DRAFT.md §4 / §4-A.7). This is the SAME "fit your face in the oval" visual the
/// V2 position/recording stages use, but driven by the server's randomized
/// [LivenessOverlay] (shape / position / size) instead of hardcoded constants —
/// so a universal replay recording can't match the shape. We PARAMETRIZE the
/// existing oval rather than replace it (owner requirement: reuse the current UI).
class OverlayPainter extends CustomPainter {
  OverlayPainter({
    required this.overlay,
    required this.locked,
    this.color,
  });

  final LivenessOverlay overlay;

  /// Solid lime when locked/framed, dashed dim paper while searching (matches the
  /// V2 [PositionStep] oval states exactly).
  final bool locked;

  /// Override stroke colour (defaults to lime when locked, dim paper otherwise).
  final Color? color;

  @override
  void paint(Canvas canvas, Size size) {
    final rect = Rect.fromCenter(
      center: Offset(size.width * overlay.centerX, size.height * overlay.centerY),
      width: size.width * overlay.widthFrac,
      height: size.height * overlay.heightFrac,
    );
    final paint = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 3
      ..color = color ?? (locked ? LiveTheme.lime : LiveTheme.dimPaper);

    switch (overlay.shape) {
      case 'circle':
        final r = rect.shortestSide / 2;
        final c = Rect.fromCircle(center: rect.center, radius: r);
        locked ? canvas.drawOval(c, paint) : _dashed(canvas, Path()..addOval(c), paint);
        break;
      case 'rounded':
      case 'rounded_square': // server token (worker/src/routes/liveness_v3.ts)
        final rr = RRect.fromRectAndRadius(rect, const Radius.circular(28));
        locked
            ? canvas.drawRRect(rr, paint)
            : _dashed(canvas, Path()..addRRect(rr), paint);
        break;
      case 'oval':
      default:
        locked
            ? canvas.drawOval(rect, paint)
            : _dashed(canvas, Path()..addOval(rect), paint);
    }
  }

  void _dashed(Canvas canvas, Path path, Paint paint) {
    const dash = 10.0, gap = 8.0;
    for (final metric in path.computeMetrics()) {
      var d = 0.0;
      while (d < metric.length) {
        canvas.drawPath(metric.extractPath(d, d + dash), paint);
        d += dash + gap;
      }
    }
  }

  @override
  bool shouldRepaint(OverlayPainter old) =>
      old.locked != locked || old.overlay != overlay || old.color != color;
}
