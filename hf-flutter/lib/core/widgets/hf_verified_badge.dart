import 'package:flutter/material.dart';

import '../theme/hf_theme.dart';

/// "Video verified" badge: a rounded 8-point star in `verifiedBlue` with a white tick (the mockup's 24x24 SVG
/// path, painted). [size] is the square side in logical pixels (20 on the host card).
class HfVerifiedBadge extends StatelessWidget {
  const HfVerifiedBadge({super.key, this.size = 20});

  final double size;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      label: 'Video verified',
      image: true,
      excludeSemantics: true,
      child: CustomPaint(size: Size.square(size), painter: const _BadgePainter()),
    );
  }
}

class _BadgePainter extends CustomPainter {
  const _BadgePainter();

  static const List<Offset> _star = [
    Offset(12, 2), Offset(14.4, 3.8), Offset(17.4, 3.6), Offset(18.3, 6.5), Offset(20.8, 8.2),
    Offset(19.8, 11), Offset(20.8, 13.8), Offset(18.3, 15.5), Offset(17.4, 18.4), Offset(14.4, 18.2),
    Offset(12, 22), Offset(9.6, 20.2), Offset(6.6, 20.4), Offset(5.7, 17.5), Offset(3.2, 15.8),
    Offset(4.2, 13), Offset(3.2, 10.2), Offset(5.7, 8.5), Offset(6.6, 5.6), Offset(9.6, 5.8),
  ];

  @override
  void paint(Canvas canvas, Size size) {
    canvas.save();
    canvas.scale(size.width / 24, size.height / 24);
    final star = Path()..moveTo(_star.first.dx, _star.first.dy);
    for (final p in _star.skip(1)) {
      star.lineTo(p.dx, p.dy);
    }
    star.close();
    canvas.drawPath(star, Paint()..color = HfColors.verifiedBlue);
    // Round the corners a little, like the mockup.
    canvas.drawPath(
      star,
      Paint()
        ..color = HfColors.verifiedBlue
        ..style = PaintingStyle.stroke
        ..strokeWidth = 1.2
        ..strokeJoin = StrokeJoin.round,
    );
    final tick = Path()
      ..moveTo(8.5, 12)
      ..lineTo(10.9, 14.4)
      ..lineTo(15.5, 9.8);
    canvas.drawPath(
      tick,
      Paint()
        ..color = HfColors.white
        ..style = PaintingStyle.stroke
        ..strokeWidth = 2.2
        ..strokeCap = StrokeCap.round
        ..strokeJoin = StrokeJoin.round,
    );
    canvas.restore();
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}
