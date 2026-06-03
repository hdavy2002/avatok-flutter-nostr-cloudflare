import 'package:flutter/material.dart';

/// The AvaTOK mark: a teal peak (Λ) with a coral dot.
class AvaLogo extends StatelessWidget {
  final double size;
  final Color color;
  final Color dot;
  const AvaLogo({
    super.key,
    this.size = 56,
    this.color = const Color(0xFF11C7C0),
    this.dot = const Color(0xFFFF5A4D),
  });

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: size,
      height: size * 0.82,
      child: CustomPaint(painter: _AvaLogoPainter(color, dot)),
    );
  }
}

class _AvaLogoPainter extends CustomPainter {
  final Color color;
  final Color dot;
  _AvaLogoPainter(this.color, this.dot);

  @override
  void paint(Canvas canvas, Size s) {
    final stroke = s.width * 0.20;
    final p = Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = stroke
      ..strokeJoin = StrokeJoin.round
      ..strokeCap = StrokeCap.round;
    final path = Path()
      ..moveTo(stroke * 0.6, s.height - stroke * 0.6)
      ..lineTo(s.width / 2, stroke * 0.7)
      ..lineTo(s.width - stroke * 0.6, s.height - stroke * 0.6);
    canvas.drawPath(path, p);
    canvas.drawCircle(
      Offset(s.width / 2, s.height * 0.66),
      s.width * 0.075,
      Paint()..color = dot,
    );
  }

  @override
  bool shouldRepaint(covariant _AvaLogoPainter old) =>
      old.color != color || old.dot != dot;
}
