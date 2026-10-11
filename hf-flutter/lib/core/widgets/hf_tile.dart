import 'package:flutter/material.dart';

import '../theme/hf_theme.dart';

/// Pastel stat tile (Main host card "talked to / regulars", CallSheet "Rate", Wallet balance).
///
/// An optional 36 px white rounded square holds [icon]; [value] is a bold Nunito number or short phrase;
/// [caption] is a 14 sp line under it (leave it empty for a value-only tile such as a language list).
/// [compact] is the host-card size (padding 10, value 18); the default is the larger sheet size
/// (padding 12, value 22). Pass [valueStyle] for a text-only tile (for example Comfortaa 14/700).
class HfTile extends StatelessWidget {
  const HfTile({
    super.key,
    required this.tint,
    this.icon,
    required this.value,
    this.caption = '',
    this.compact = false,
    this.valueStyle,
  });

  final HfTint tint;
  final IconData? icon;
  final String value;
  final String caption;
  final bool compact;

  /// Overrides the default value style (colour is still the tint's value ink unless the style sets one).
  final TextStyle? valueStyle;

  @override
  Widget build(BuildContext context) {
    final dark = HfBrightness.isDark(context);
    final base = valueStyle ?? (compact ? HfText.statSmall : HfText.stat);
    final valueText = base.copyWith(
      color: base.color == HfColors.ink ? tint.valueInk(context) : base.color,
    );
    final captionStyle = HfText.label.copyWith(
      color: dark
          ? tint.ink(context)
          : (tint == HfTint.butter
                ? HfColors.butterInk
                : tint == HfTint.blush
                ? HfColors.blushInk
                : HfColors.inkSoft),
      fontWeight: FontWeight.w400,
    );
    return Semantics(
      container: true,
      label: caption.isEmpty ? value : '$value $caption',
      excludeSemantics: true,
      child: Container(
        padding: EdgeInsets.all(compact ? 10 : 12),
        decoration: BoxDecoration(
          color: tint.bg(context),
          borderRadius: BorderRadius.circular(HfRadius.tileSmall),
        ),
        child: Row(
          children: [
            if (icon != null) ...[
              Container(
                width: 36,
                height: 36,
                decoration: BoxDecoration(
                  color: dark ? HfColors.darkCard : HfColors.white,
                  borderRadius: BorderRadius.circular(HfRadius.segmentItem),
                ),
                child: Icon(icon, size: 18, color: tint.ink(context)),
              ),
              const SizedBox(width: HfSpacing.md),
            ],
            Flexible(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(value, style: valueText),
                  if (caption.isNotEmpty) Text(caption, style: captionStyle),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
