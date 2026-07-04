import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../../core/analytics.dart';
import '../../../core/ui/zine.dart';
import '../../../core/ui/zine_widgets.dart';

/// Liveness V2 — PHRASE challenge step (Specs/LIVENESS-V2-PLAN.md §4 step 4c).
/// Shows the 3-word phrase the user must say aloud WHILE the orchestrator's
/// video clip is recording (the clip's audio track is what the server checks
/// with Whisper). A live mic-level bar shows the app is "listening".
///
/// LIVE-V2 NOTE: the repo has no on-device audio-amplitude / sound-level source
/// (searched `app/lib` for amplitude / sound_level / noise / NoiseMeter — none
/// exist, and the camera plugin does not expose a live level while recording).
/// So the bar here is an ANIMATED PLACEHOLDER and step completion is gated on a
/// minimum on-screen duration (the user must stay ≥ 4s) plus an explicit
/// "I said it" tap — NOT a timer auto-advance. True speech-energy gating would
/// need an amplitude plugin (e.g. `record`'s onAmplitude); the actual speech
/// check is done server-side by Whisper on the recorded clip (check B6).
class PhraseStep extends StatefulWidget {
  const PhraseStep({
    super.key,
    required this.phrase,
    required this.onComplete,
  });

  final String phrase;

  /// Fired when the user confirms after the minimum listen window.
  final VoidCallback onComplete;

  @override
  State<PhraseStep> createState() => _PhraseStepState();
}

class _PhraseStepState extends State<PhraseStep>
    with SingleTickerProviderStateMixin {
  static const _minMs = 4000; // user must stay ≥ 4s before "I said it" enables

  late final AnimationController _anim;
  Timer? _gate;
  bool _canConfirm = false;
  bool _done = false;
  final int _startMs = DateTime.now().millisecondsSinceEpoch;

  @override
  void initState() {
    super.initState();
    _anim = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 900),
    )..repeat(reverse: true);
    _gate = Timer(const Duration(milliseconds: _minMs), () {
      if (mounted) setState(() => _canConfirm = true);
    });
  }

  void _confirm() {
    if (_done) return;
    _done = true;
    Analytics.capture('liveness_step', {
      'step': 'phrase',
      'outcome': 'passed',
      'ms': DateTime.now().millisecondsSinceEpoch - _startMs,
      'retries': 0,
    });
    widget.onComplete();
  }

  @override
  void dispose() {
    _gate?.cancel();
    _anim.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Stack(
      fit: StackFit.expand,
      children: [
        Positioned(
          left: 0,
          right: 0,
          bottom: 40,
          child: Column(
            children: [
              Container(
                margin: const EdgeInsets.symmetric(horizontal: 24),
                padding: const EdgeInsets.all(18),
                decoration: BoxDecoration(
                  color: Zine.ink.withValues(alpha: .72),
                  borderRadius: BorderRadius.circular(Zine.rSm),
                  border: Border.all(color: Zine.lime, width: Zine.bw),
                ),
                child: Column(mainAxisSize: MainAxisSize.min, children: [
                  Text('Say out loud:',
                      style: ZineText.sub(size: 13, color: Zine.paper)),
                  const SizedBox(height: 6),
                  Text('“${widget.phrase}”',
                      textAlign: TextAlign.center,
                      style: ZineText.cardTitle(size: 24, color: Zine.paper)),
                  const SizedBox(height: 14),
                  // Live "listening" mic bar (animated placeholder — see note).
                  SizedBox(
                    height: 26,
                    child: AnimatedBuilder(
                      animation: _anim,
                      builder: (_, __) => CustomPaint(
                        painter: _MicBarPainter(phase: _anim.value),
                        size: const Size(double.infinity, 26),
                      ),
                    ),
                  ),
                ]),
              ),
              const SizedBox(height: 12),
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 24),
                child: ZineButton(
                  label: _canConfirm ? "I said it" : 'Listening…',
                  fullWidth: true,
                  onPressed: _canConfirm ? _confirm : null,
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

/// A simple animated waveform to signal the mic is active (not a real level).
class _MicBarPainter extends CustomPainter {
  _MicBarPainter({required this.phase});

  final double phase; // 0..1

  @override
  void paint(Canvas canvas, Size size) {
    const bars = 20;
    final w = size.width / bars;
    final paint = Paint()..color = Zine.lime;
    for (var i = 0; i < bars; i++) {
      final t = phase + i / bars;
      final h = (0.35 + 0.65 * (0.5 + 0.5 * math.sin(t * 2 * math.pi))) *
          size.height;
      final x = i * w + w * 0.2;
      canvas.drawRRect(
        RRect.fromRectAndRadius(
          Rect.fromLTWH(x, (size.height - h) / 2, w * 0.6, h),
          const Radius.circular(2),
        ),
        paint,
      );
    }
  }

  @override
  bool shouldRepaint(_MicBarPainter old) => old.phase != phase;
}
