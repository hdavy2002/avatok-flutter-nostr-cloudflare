import 'package:flutter/widgets.dart';

import '../theme/hf_tokens.dart';

/// True when the phone asks for no animations (Android "Remove animations").
///
/// Every motion-kit widget reads this. When it is true the widget shows its
/// FINAL state at once: no decorative movement, and nothing stays hidden.
bool hfReduceMotion(BuildContext context) =>
    HfMotion.of(context, const Duration(milliseconds: 1)) == Duration.zero;

/// Fraction (0..1) of [total] at which [offset] falls, clamped.
double motionFraction(Duration offset, Duration total) {
  if (total.inMicroseconds <= 0) return 0;
  final f = offset.inMicroseconds / total.inMicroseconds;
  return f.clamp(0.0, 1.0).toDouble();
}
