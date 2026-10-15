import 'package:flutter/material.dart';

import '../../../core/format/money.dart';
import '../../../core/widgets/widgets.dart';

/// A rupee amount the server sent, already formatted (for example `₹1,234.50`), shown with a count-up from zero
/// (HF-MOTION-D). Display only: the phone never computes money. The text is read back into paise and animated
/// through the same [formatPaise] formatter; when that does not give back exactly the same text (an unexpected
/// shape) the amount is shown as plain text, so the final number is always the server's.
class MoneyCountUp extends StatelessWidget {
  const MoneyCountUp(this.display, {super.key, this.style, this.textAlign});

  final String display;
  final TextStyle? style;
  final TextAlign? textAlign;

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
    if (paise == null) {
      return Text(display, style: style, textAlign: textAlign);
    }
    return CountUpText(
      value: paise,
      from: 0,
      formatter: (v) => formatPaise(v.round()),
      style: style,
      textAlign: textAlign,
      duration: const Duration(milliseconds: 900),
    );
  }
}
