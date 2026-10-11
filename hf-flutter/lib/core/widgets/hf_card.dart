import 'package:flutter/material.dart';

import '../theme/hf_theme.dart';

/// Card with radius 32, a 1 px hairline and the soft card shadow. White in light mode, `darkCard` in dark mode
/// (pass [color] to use a tint). Optional whole-card action.
class HfCard extends StatelessWidget {
  const HfCard({
    super.key,
    required this.child,
    this.onTap,
    this.padding = const EdgeInsets.all(16),
    this.color,
    this.margin,
  });

  final Widget child;
  final VoidCallback? onTap;
  final EdgeInsetsGeometry padding;

  /// Surface colour; null uses the theme card colour.
  final Color? color;
  final EdgeInsetsGeometry? margin;

  @override
  Widget build(BuildContext context) {
    final dark = HfBrightness.isDark(context);
    final radius = BorderRadius.circular(HfRadius.card);
    // A transparent Material inside the decorated box lets ListTile / ExpansionTile / InkWell children paint
    // their ink and splashes above the card colour instead of being hidden by it.
    final body = Material(
      type: MaterialType.transparency,
      child: Padding(padding: padding, child: child),
    );
    return Container(
      margin: margin,
      decoration: BoxDecoration(
        color: color ?? (dark ? HfColors.darkCard : HfColors.white),
        borderRadius: radius,
        border: Border.all(color: dark ? HfColors.darkLine : HfColors.line),
        boxShadow: dark ? null : HfShadows.card,
      ),
      child: onTap == null
          ? body
          : Material(
              color: Colors.transparent,
              borderRadius: radius,
              child: InkWell(borderRadius: radius, onTap: onTap, child: body),
            ),
    );
  }
}
