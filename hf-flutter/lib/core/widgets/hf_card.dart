import 'package:flutter/material.dart';

import '../theme/hf_tokens.dart';

/// White bento card, generous corners and visible soft elevation. Optional whole-card action.
class HfCard extends StatelessWidget {
  const HfCard({
    super.key,
    required this.child,
    this.onTap,
    this.padding = const EdgeInsets.all(16),
    this.color = HfColors.white,
    this.margin,
  });

  final Widget child;
  final VoidCallback? onTap;
  final EdgeInsetsGeometry padding;
  final Color color;
  final EdgeInsetsGeometry? margin;

  @override
  Widget build(BuildContext context) {
    final radius = BorderRadius.circular(HfRadius.card);
    final body = Padding(padding: padding, child: child);
    return Container(
      margin: margin,
      decoration: BoxDecoration(
        color: color,
        borderRadius: radius,
        border: Border.all(color: HfColors.line),
        boxShadow: HfShadows.card,
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
