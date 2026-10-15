import 'dart:math' as math;

import 'package:flutter/widgets.dart';

import '../theme/hf_tokens.dart';
import 'reduced_motion.dart';

/// Which side the bubble's little tail points from.
enum SpeechBubbleTail { bottom, left, none }

/// White speech bubble (radius 18, soft shadow, small tail) with Nunito
/// 15/600 ink text that appears word by word ([wordInterval], 35 ms a word).
///
/// The bubble is sized for the whole message from the start, so it never
/// jumps while words appear. Screen readers hear the full [text] at once.
/// With reduced motion, or [animateWords] false, the full text shows at once.
/// A new [text] types again.
class SpeechBubble extends StatefulWidget {
  const SpeechBubble({
    super.key,
    required this.text,
    this.tail = SpeechBubbleTail.bottom,
    this.animateWords = true,
    this.wordInterval = const Duration(milliseconds: 35),
    this.style,
  });

  /// Key of the text inside the bubble (for tests).
  static const Key textKey = ValueKey<String>('hf-speech-bubble-text');

  final String text;
  final SpeechBubbleTail tail;
  final bool animateWords;
  final Duration wordInterval;

  /// Defaults to [HfText.bubble].
  final TextStyle? style;

  /// The words of [text] that are visible at [progress] (0..1).
  static String visibleText(String text, double progress) {
    final words = text.split(' ');
    final n = words.length;
    final shown = math.min(n, (progress * n).ceil());
    return words.take(shown).join(' ');
  }

  @override
  State<SpeechBubble> createState() => _SpeechBubbleState();
}

class _SpeechBubbleState extends State<SpeechBubble>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c;
  bool _started = false;

  int get _wordCount => widget.text.split(' ').length;

  @override
  void initState() {
    super.initState();
    _c = AnimationController(vsync: this, duration: _typingTime());
  }

  Duration _typingTime() => widget.wordInterval * math.max(1, _wordCount);

  void _restart() {
    _c.duration = _typingTime();
    if (!widget.animateWords || hfReduceMotion(context)) {
      _c.value = 1;
    } else {
      _c.forward(from: 0);
    }
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_started) return;
    _started = true;
    _restart();
  }

  @override
  void didUpdateWidget(SpeechBubble oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.text != widget.text) _restart();
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final reduced = hfReduceMotion(context);
    final style = widget.style ?? HfText.bubble;
    final text = widget.text;
    return Semantics(
      label: text,
      container: true,
      child: ExcludeSemantics(
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
          decoration: ShapeDecoration(
            color: HfColors.white,
            shadows: HfShadows.card,
            shape: _BubbleShape(widget.tail),
          ),
          child: AnimatedBuilder(
            animation: _c,
            builder: (context, child) {
              final shown = reduced
                  ? text
                  : SpeechBubble.visibleText(text, _c.value);
              final hidden = text.substring(shown.length);
              return Text.rich(
                TextSpan(
                  children: [
                    TextSpan(text: shown),
                    TextSpan(
                      text: hidden,
                      style: const TextStyle(color: Color(0x00000000)),
                    ),
                  ],
                ),
                key: SpeechBubble.textKey,
                style: style,
              );
            },
          ),
        ),
      ),
    );
  }
}

class _BubbleShape extends ShapeBorder {
  const _BubbleShape(this.tail);

  static const double _radius = 18;
  static const double _tail = 10;

  final SpeechBubbleTail tail;

  @override
  EdgeInsetsGeometry get dimensions => switch (tail) {
    SpeechBubbleTail.bottom => const EdgeInsets.only(bottom: _tail),
    SpeechBubbleTail.left => const EdgeInsets.only(left: _tail),
    SpeechBubbleTail.none => EdgeInsets.zero,
  };

  @override
  Path getInnerPath(Rect rect, {TextDirection? textDirection}) =>
      getOuterPath(rect, textDirection: textDirection);

  @override
  Path getOuterPath(Rect rect, {TextDirection? textDirection}) {
    final body = switch (tail) {
      SpeechBubbleTail.bottom => Rect.fromLTRB(
        rect.left,
        rect.top,
        rect.right,
        rect.bottom - _tail,
      ),
      SpeechBubbleTail.left => Rect.fromLTRB(
        rect.left + _tail,
        rect.top,
        rect.right,
        rect.bottom,
      ),
      SpeechBubbleTail.none => rect,
    };
    final path = Path()
      ..addRRect(
        RRect.fromRectAndRadius(body, const Radius.circular(_radius)),
      );
    switch (tail) {
      case SpeechBubbleTail.bottom:
        final cx = body.center.dx;
        // Same (clockwise) winding as the rounded rectangle, so the overlap
        // fills instead of cancelling.
        path
          ..moveTo(cx + _tail, body.bottom - 1)
          ..lineTo(cx, body.bottom + _tail)
          ..lineTo(cx - _tail, body.bottom - 1)
          ..close();
      case SpeechBubbleTail.left:
        final cy = body.center.dy;
        path
          ..moveTo(body.left + 1, cy + _tail)
          ..lineTo(body.left - _tail, cy)
          ..lineTo(body.left + 1, cy - _tail)
          ..close();
      case SpeechBubbleTail.none:
        break;
    }
    return path;
  }

  @override
  void paint(Canvas canvas, Rect rect, {TextDirection? textDirection}) {}

  @override
  ShapeBorder scale(double t) => this;
}
