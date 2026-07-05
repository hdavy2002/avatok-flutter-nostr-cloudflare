import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../../core/analytics.dart';
import 'live_theme.dart';

/// Liveness V2 — PHRASE / READ-ALOUD challenge step (Specs/LIVENESS-V2-PLAN.md
/// §4 step 4c), restyled to the new dark stage [LIVE-UI-3].
///
/// Flow: the user picks a language chip (English/Español/Français/Deutsch), sees
/// the phrase on a taped card, taps the big lime "I'm ready — start", then reads
/// it aloud WHILE the orchestrator's clip records (the clip's audio is what the
/// server checks with Whisper). While recording we show a coral "Listening" pill
/// + animated waveform, then complete after a minimum listen window.
///
/// LIVE-V2 NOTE (unchanged): the repo has no on-device audio-amplitude source, so
/// the waveform is an animated indicator and completion is gated on a minimum
/// on-screen duration after start (NOT a raw timer auto-advance) — the actual
/// speech check is server-side Whisper on the recorded clip.
///
/// Language selection lives in the ORCHESTRATOR (it re-requests the server
/// challenge for the chosen language); this widget just renders the chips and
/// reports taps via [onPickLang]. Chips lock once the user taps start.
class PhraseStep extends StatefulWidget {
  const PhraseStep({
    super.key,
    required this.phrase,
    required this.langCode,
    required this.langLabel,
    required this.onPickLang,
    required this.onStart,
    required this.onComplete,
    this.langBusy = false,
  });

  /// The read-aloud sentence for the currently selected language.
  final String phrase;

  /// Active language code ('en'|'es'|'fr'|'de') and its display label.
  final String langCode;
  final String langLabel;

  /// User tapped a language chip (before start). The orchestrator re-requests
  /// the challenge in that language.
  final void Function(String code) onPickLang;

  /// User tapped "I'm ready — start". The orchestrator begins the clip recording.
  final VoidCallback onStart;

  /// Fired after the minimum listen window once recording is under way.
  final VoidCallback onComplete;

  /// True while the orchestrator is re-fetching the challenge for a new language
  /// (chips disabled + phrase card shows a placeholder).
  final bool langBusy;

  @override
  State<PhraseStep> createState() => _PhraseStepState();
}

/// Supported read-aloud languages (label + code). English is the safe default.
const _kLangs = <({String code, String label})>[
  (code: 'en', label: 'English'),
  (code: 'es', label: 'Español'),
  (code: 'fr', label: 'Français'),
  (code: 'de', label: 'Deutsch'),
];

class _PhraseStepState extends State<PhraseStep>
    with SingleTickerProviderStateMixin {
  static const _minMs = 4000; // must read for ≥4s before we auto-complete

  late final AnimationController _anim;
  Timer? _gate;
  bool _reading = false;
  bool _done = false;
  int _startMs = 0;

  @override
  void initState() {
    super.initState();
    _anim = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 700),
    );
  }

  void _start() {
    if (_reading) return;
    setState(() => _reading = true);
    _startMs = DateTime.now().millisecondsSinceEpoch;
    widget.onStart(); // orchestrator starts recording
    // Respect reduced motion: only animate the waveform when animations are on.
    if (!LiveTheme.reducedMotion(context)) _anim.repeat(reverse: true);
    _gate = Timer(const Duration(milliseconds: _minMs), _complete);
  }

  void _complete() {
    if (_done) return;
    _done = true;
    Analytics.capture('liveness_step', {
      'step': 'phrase',
      'outcome': 'passed',
      'ms': DateTime.now().millisecondsSinceEpoch - _startMs,
      'lang': widget.langCode,
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
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        LiveTheme.stageHeadline('Now read this ', markWord: 'aloud'),
        const SizedBox(height: 6),
        Text('Pick your language, then read the line in one go.',
            style: LiveTheme.subStyle),
        const SizedBox(height: 16),
        // Language chips (disabled once reading has started, or while re-fetching).
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            for (final l in _kLangs)
              LiveTheme.chip(
                label: l.label,
                active: l.code == widget.langCode,
                onTap: (_reading || widget.langBusy)
                    ? null
                    : () => widget.onPickLang(l.code),
              ),
          ],
        ),
        const SizedBox(height: 18),
        // Taped phrase card.
        _phraseCard(),
        const Spacer(),
        if (!_reading)
          LiveTheme.limeButton(
            label: "I'm ready — start",
            icon: Icons.mic,
            onPressed: widget.langBusy ? null : _start,
          )
        else
          _listening(),
        const SizedBox(height: 4),
      ],
    );
  }

  Widget _phraseCard() => Container(
        margin: const EdgeInsets.only(top: 10),
        padding: const EdgeInsets.fromLTRB(20, 26, 20, 20),
        decoration: LiveTheme.taperedCardDecoration,
        child: Stack(
          clipBehavior: Clip.none,
          children: [
            // Tape strip.
            Positioned(
              top: -22,
              left: 0,
              right: 0,
              child: Center(child: LiveTheme.tapeStrip()),
            ),
            Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('READ ALOUD · ${widget.langLabel}',
                    style: LiveTheme.kickerOnCardStyle),
                const SizedBox(height: 8),
                Text(
                  widget.langBusy ? '…' : '“${widget.phrase}”',
                  style: LiveTheme.phraseStyle,
                ),
              ],
            ),
          ],
        ),
      );

  Widget _listening() => Column(
        children: [
          LiveTheme.pill(
            label: 'Listening',
            filled: LiveTheme.coral,
            textOnFill: Colors.white,
            leadingDotBlink: true,
          ),
          const SizedBox(height: 12),
          SizedBox(
            height: 40,
            child: AnimatedBuilder(
              animation: _anim,
              builder: (_, __) => CustomPaint(
                painter: _WavePainter(phase: _anim.value),
                size: const Size(160, 40),
              ),
            ),
          ),
          const SizedBox(height: 10),
          Text('Keep going — I can hear you clearly.',
              style: LiveTheme.subStyle),
        ],
      );
}

/// Animated waveform bars (indicator only — see LIVE-V2 NOTE, not a real level).
class _WavePainter extends CustomPainter {
  _WavePainter({required this.phase});
  final double phase;

  @override
  void paint(Canvas canvas, Size size) {
    const bars = 12;
    final gap = 5.0;
    final barW = 5.0;
    final totalW = bars * barW + (bars - 1) * gap;
    var x = (size.width - totalW) / 2;
    final paint = Paint()..color = LiveTheme.lime;
    for (var i = 0; i < bars; i++) {
      final t = phase + i / bars;
      final h = 10 + 24 * (0.5 + 0.5 * math.sin(t * 2 * math.pi));
      canvas.drawRRect(
        RRect.fromRectAndRadius(
          Rect.fromLTWH(x, (size.height - h) / 2, barW, h),
          const Radius.circular(3),
        ),
        paint,
      );
      x += barW + gap;
    }
  }

  @override
  bool shouldRepaint(_WavePainter old) => old.phase != phase;
}
