import 'package:flutter/material.dart';

import '../../../core/theme/hf_theme.dart';

/// White (dark: card) surface with a 1 px hairline, the Host mockup's earnings card (radius 26) and call
/// rows (radius 20). No shadow, as in the mockup.
class DashSurface extends StatelessWidget {
  const DashSurface({
    super.key,
    required this.child,
    this.radius = 26,
    this.padding = const EdgeInsets.all(HfSpacing.xxl),
    this.borderColor,
  });

  final Widget child;
  final double radius;
  final EdgeInsetsGeometry padding;

  /// Overrides the hairline colour (the problem banner uses rose).
  final Color? borderColor;

  @override
  Widget build(BuildContext context) {
    final dark = HfBrightness.isDark(context);
    return Container(
      padding: padding,
      decoration: BoxDecoration(
        color: dark ? HfColors.darkCard : HfColors.white,
        borderRadius: BorderRadius.circular(radius),
        border: Border.all(
          color: borderColor ?? (dark ? HfColors.darkLine : HfColors.line),
        ),
      ),
      child: child,
    );
  }
}

/// Section heading: Nunito 18 / 800 (the mockup's `h2`).
class DashHeading extends StatelessWidget {
  const DashHeading(this.text, {super.key});

  final String text;

  @override
  Widget build(BuildContext context) => Text(
    text,
    style: HfText.of(context, HfText.subsection.copyWith(fontSize: 18)),
  );
}

/// Secondary 14 sp text in the muted colour (dark aware).
TextStyle dashMuted(BuildContext context) =>
    HfText.of(context, HfText.label.copyWith(fontWeight: FontWeight.w400));
