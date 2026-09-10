import 'dart:ui';

import 'package:flutter/material.dart';

import '../messenger_theme.dart';

/// A changed number (a balance, a count) re-entering character by character
/// from below, each glyph popping in through a soft blur on a short stagger.
///
/// This takes an already-formatted [String] — `"₹2,480"`, not a number — so
/// currency and grouping stay the caller's job and this widget only ever
/// animates glyphs.
///
/// Numbers are one of the two places [Msg.pop]'s mild overshoot is allowed:
/// a balance ticking up should feel alive, not flat. The whole change is an
/// [Msg.event]-class moment ("a balance changing"), but the actual per-glyph
/// travel is short — 8px and a 2px blur — because the overshoot curve
/// already supplies the energy; stacking a long slide on top of it would tip
/// into the cartoonish territory the audit flagged. The last two characters
/// (typically the decimals) sit closest together in the stagger, so they
/// read as counting up together rather than trailing the whole number.
class AdPopNumber extends StatefulWidget {
  const AdPopNumber(this.value, {super.key, this.style, this.textAlign});

  /// The current, already-formatted display string.
  final String value;
  final TextStyle? style;
  final TextAlign? textAlign;

  @override
  State<AdPopNumber> createState() => _AdPopNumberState();
}

class _AdPopNumberState extends State<AdPopNumber>
    with SingleTickerProviderStateMixin {
  // Stagger across characters; the spec's "70ms across characters".
  static const Duration _stagger = Duration(milliseconds: 70);
  // Each glyph's own settle, independent of how many glyphs precede it.
  static const Duration _perChar = Duration(milliseconds: 220);

  late AnimationController _controller;
  late List<String> _chars;

  @override
  void initState() {
    super.initState();
    _chars = widget.value.split('');
    _controller = AnimationController(vsync: this, duration: _durationFor(_chars.length));
    final reduce = MediaQuery.of(context).disableAnimations;
    if (reduce) {
      _controller.value = 1;
    } else {
      _controller.forward();
    }
  }

  Duration _durationFor(int charCount) {
    if (charCount <= 1) return _perChar;
    return _stagger * (charCount - 1) + _perChar;
  }

  @override
  void didUpdateWidget(covariant AdPopNumber oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.value == widget.value) return;
    _chars = widget.value.split('');
    _controller.duration = _durationFor(_chars.length);
    final reduce = MediaQuery.of(context).disableAnimations;
    if (reduce) {
      _controller.value = 1;
    } else {
      _controller
        ..reset()
        ..forward();
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final reduce = MediaQuery.of(context).disableAnimations;
    return Row(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.baseline,
      textBaseline: TextBaseline.alphabetic,
      children: [
        for (var i = 0; i < _chars.length; i++) _buildChar(i, reduce),
      ],
    );
  }

  Widget _buildChar(int index, bool reduce) {
    final glyph = Text(_chars[index], style: widget.style, textAlign: widget.textAlign);
    if (reduce) return glyph;

    final totalMs = _controller.duration!.inMilliseconds;
    final perCharMs = _perChar.inMilliseconds;
    final startMs = (index * _stagger.inMilliseconds)
        .clamp(0, (totalMs - perCharMs).clamp(0, totalMs))
        .toDouble();
    final start = totalMs == 0 ? 0.0 : startMs / totalMs;
    final end = totalMs == 0 ? 1.0 : ((startMs + perCharMs) / totalMs).clamp(0.0, 1.0);

    final animation = CurvedAnimation(
      parent: _controller,
      curve: Interval(start, end, curve: Msg.pop),
    );

    return AnimatedBuilder(
      animation: animation,
      builder: (context, child) {
        final t = animation.value;
        final dy = (1 - t) * 8; // 8px travel from below
        final blur = (1 - t).clamp(0.0, 1.0) * 2; // 2px cross-blur
        return Opacity(
          opacity: t.clamp(0.0, 1.0),
          child: Transform.translate(
            offset: Offset(0, dy),
            child: ImageFiltered(
              imageFilter: ImageFilter.blur(sigmaX: blur, sigmaY: blur),
              child: child,
            ),
          ),
        );
      },
      child: glyph,
    );
  }
}
