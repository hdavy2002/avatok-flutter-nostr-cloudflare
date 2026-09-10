import 'dart:ui';

import 'package:flutter/material.dart';

import '../messenger_theme.dart';

/// A status-line swap: the old string exits upward through a soft blur while
/// the new one enters from just below it.
///
/// Status text (typing indicators, presence, "Delivered" -> "Read") changes
/// often enough that a hard cut reads as flicker, but the change itself is
/// never a moment worth dwelling on — it should read as fast and settled, not
/// springy. That is why this uses [Msg.fast] (exits are snappier than
/// arrivals) and [Msg.settle] (no overshoot) rather than the pop/spring
/// curves reserved for numbers and reward moments.
///
/// The 2-3px blur paired with a 4px vertical travel is the library's
/// signature: a small blur reads as far more distance than the pixels
/// actually move, without the swim of a long slide.
class AdSwitchText extends StatelessWidget {
  const AdSwitchText(
    this.text, {
    super.key,
    this.style,
    this.textAlign,
    this.maxLines,
    this.overflow,
  });

  /// The current status string. A [ValueKey] on this value is what tells
  /// [AnimatedSwitcher] a swap happened.
  final String text;
  final TextStyle? style;
  final TextAlign? textAlign;
  final int? maxLines;
  final TextOverflow? overflow;

  @override
  Widget build(BuildContext context) {
    final reduceMotion = MediaQuery.of(context).disableAnimations;

    return AnimatedSwitcher(
      duration: reduceMotion ? Duration.zero : Msg.fast,
      switchInCurve: Msg.settle,
      switchOutCurve: Msg.settle,
      layoutBuilder: (currentChild, previousChildren) => Stack(
        alignment: Alignment.centerLeft,
        children: [
          ...previousChildren,
          if (currentChild != null) currentChild,
        ],
      ),
      transitionBuilder: (child, animation) {
        if (reduceMotion) return child;

        // The incoming child animates 0->1; the outgoing one is handed the
        // same Animation running in reverse by AnimatedSwitcher, so a single
        // transitionBuilder can drive both without knowing which is which.
        final isEntering = child.key == ValueKey<String>(text);
        final offsetTween = isEntering
            ? Tween<Offset>(begin: const Offset(0, 0.18), end: Offset.zero)
            : Tween<Offset>(begin: Offset.zero, end: const Offset(0, -0.18));
        final blurTween = isEntering
            ? Tween<double>(begin: 2, end: 0)
            : Tween<double>(begin: 0, end: 2);

        return SlideTransition(
          position: offsetTween.animate(animation),
          child: FadeTransition(
            opacity: animation,
            child: AnimatedBuilder(
              animation: animation,
              builder: (context, grandchild) => ImageFiltered(
                imageFilter: ImageFilter.blur(
                  sigmaX: blurTween.evaluate(animation),
                  sigmaY: blurTween.evaluate(animation),
                ),
                child: grandchild,
              ),
              child: child,
            ),
          ),
        );
      },
      child: Text(
        text,
        key: ValueKey<String>(text),
        style: style,
        textAlign: textAlign,
        maxLines: maxLines,
        overflow: overflow,
      ),
    );
  }
}
