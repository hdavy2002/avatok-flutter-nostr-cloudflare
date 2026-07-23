import 'package:flutter/material.dart';

import '../../core/ui/avatok_dark.dart';

/// [NOANSWER-LEAVE-NOTE-1] Shared live recording waveform — one bar per
/// amplitude sample, newest on the right, scrolling left as the buffer fills
/// (WhatsApp's behaviour). Extracted verbatim from the AvaTok Messenger chat
/// composer's recorder so the messenger and the call "leave a voice note" card
/// draw the SAME waveform from ONE definition.
///
/// This is driven by the recorder's REAL metering (`onAmplitudeChanged`), not an
/// animation on a timer. That distinction is the entire feature: a canned
/// animation would look identical whether or not the mic was working. If these
/// bars are flat, the mic genuinely isn't hearing anything.
class LiveWaveform extends StatelessWidget {
  const LiveWaveform({super.key, required this.levels});
  final List<double> levels;

  @override
  Widget build(BuildContext context) => CustomPaint(
        painter: _LiveWaveformPainter(levels),
        size: Size.infinite,
      );
}

class _LiveWaveformPainter extends CustomPainter {
  _LiveWaveformPainter(this.levels);
  final List<double> levels;

  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = AD.iconSearch
      ..strokeCap = StrokeCap.round
      ..strokeWidth = 2.6;
    const gap = 4.5;
    final mid = size.height / 2;
    // Right-align: the newest sample sits at the right edge and older samples
    // march left, so the waveform reads as "now" rather than jumping around.
    for (var i = 0; i < levels.length; i++) {
      final x = size.width - (levels.length - i) * gap;
      if (x < 0) continue;
      final h = (levels[i] * size.height).clamp(2.0, size.height);
      canvas.drawLine(Offset(x, mid - h / 2), Offset(x, mid + h / 2), paint);
    }
  }

  @override
  bool shouldRepaint(_LiveWaveformPainter old) => true;
}
