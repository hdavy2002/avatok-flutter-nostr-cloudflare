import 'package:flutter/material.dart';

import '../../../core/format/money.dart';
import '../../../core/widgets/widgets.dart';

/// A rupee amount the server sent, already formatted (for example `₹1,234.50`), shown with a count-up from zero
/// (HF-MOTION-D). Display only: the phone never computes money. The text is read back into paise and animated
/// through the same [formatPaise] formatter; when that does not give back exactly the same text (an unexpected
/// shape) the amount is shown as plain text, so the final number is always the server's.
///
/// [textKey] goes on the [Text] that shows the number, so a finder by that key reads the amount as before.
class MoneyCountUp extends StatelessWidget {
  const MoneyCountUp(
    this.display, {
    super.key,
    this.textKey,
    this.style,
    this.textAlign,
  });

  final String display;
  final Key? textKey;
  final TextStyle? style;
  final TextAlign? textAlign;

  static const Duration duration = Duration(milliseconds: 900);

  /// Paise in [display] when it is exactly what [formatPaise] prints for them, else `null`.
  static int? paiseOf(String display) {
    final digits = display.replaceAll(RegExp(r'[^0-9]'), '');
    if (digits.isEmpty || digits.length > 15) return null;
    final paise = int.tryParse(digits);
    if (paise == null) return null;
    final negative = display.contains('-');
    final value = negative ? -paise : paise;
    return formatPaise(value) == display ? value : null;
  }

  @override
  Widget build(BuildContext context) {
    final paise = paiseOf(display);
    if (paise == null || paise == 0 || hfReduceMotion(context)) {
      return Text(display, key: textKey, style: style, textAlign: textAlign);
    }
    return Semantics(
      label: display,
      excludeSemantics: true,
      child: TweenAnimationBuilder<double>(
        // Keyed by the amount so a new server value counts up again from zero.
        key: ValueKey<int>(paise),
        tween: Tween<double>(begin: 0, end: 1),
        duration: duration,
        curve: Curves.easeOutCubic,
        builder: (context, t, _) => Text(
          // The last frame is the server's own text, never a recomputed one.
          t >= 1 ? display : formatPaise((paise * t).round()),
          key: textKey,
          style: style,
          textAlign: textAlign,
        ),
      ),
    );
  }
}
