import 'package:flutter/material.dart';

import '../theme/hf_theme.dart';

enum _HfChipVariant { filled, outline, selected, dark }

/// A mood / filter chip: 40 px tall, radius 20, 14 sp label. The tap area is at least 48 px high.
///
/// Variants:
/// * `HfChip.filled(tint: ...)`: tint background, deep tint text (the mood chips on Discover).
/// * `HfChip.outline(...)`: white with a 1 px outline (an unselected mood tag).
/// * `HfChip.selected(tint: ...)`: tint background plus a check icon (a picked filter).
/// * `HfChip.dark(...)`: ink background, white text (the "All moods" chip).
/// * `HfChip(label, selected, onTap)`: the original constructor, kept for existing screens:
///   selected is `dark`, unselected is `outline`.
class HfChip extends StatelessWidget {
  const HfChip({
    super.key,
    required this.label,
    required bool selected,
    required this.onTap,
    this.icon,
  })  : tint = HfTint.lavender,
        _variant = selected ? _HfChipVariant.dark : _HfChipVariant.outline;

  const HfChip.filled({
    super.key,
    required this.label,
    required this.tint,
    this.onTap,
    this.icon,
  }) : _variant = _HfChipVariant.filled;

  const HfChip.outline({
    super.key,
    required this.label,
    this.onTap,
    this.icon,
  })  : tint = HfTint.lavender,
        _variant = _HfChipVariant.outline;

  const HfChip.selected({
    super.key,
    required this.label,
    this.tint = HfTint.sky,
    this.onTap,
  })  : icon = null,
        _variant = _HfChipVariant.selected;

  const HfChip.dark({
    super.key,
    required this.label,
    this.onTap,
    this.icon,
  })  : tint = HfTint.lavender,
        _variant = _HfChipVariant.dark;

  final String label;
  final VoidCallback? onTap;
  final IconData? icon;
  final HfTint tint;
  final _HfChipVariant _variant;

  /// True for the `selected` and `dark` variants (what screens read as "picked").
  bool get isSelected => _variant == _HfChipVariant.selected || _variant == _HfChipVariant.dark;

  @override
  Widget build(BuildContext context) {
    final dark = HfBrightness.isDark(context);
    final Color bg;
    final Color fg;
    Border? border;
    FontWeight weight = FontWeight.w700;
    switch (_variant) {
      case _HfChipVariant.filled:
      case _HfChipVariant.selected:
        bg = tint.bg(context);
        fg = tint.ink(context);
      case _HfChipVariant.outline:
        bg = dark ? HfColors.darkCard : HfColors.white;
        fg = dark ? HfColors.darkText : HfColors.inkSoft;
        border = Border.all(color: dark ? HfColors.darkLine : HfColors.outlineChip);
        weight = FontWeight.w600;
      case _HfChipVariant.dark:
        bg = dark ? HfColors.lavender : HfColors.ink;
        fg = dark ? HfColors.ink : HfColors.white;
    }
    final leading = _variant == _HfChipVariant.selected ? Icons.check_rounded : icon;
    return Semantics(
      button: onTap != null,
      selected: isSelected,
      label: label,
      excludeSemantics: true,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: onTap,
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: HfSpacing.tap),
          child: Center(
            widthFactor: 1,
            child: Container(
              height: 40,
              padding: EdgeInsets.symmetric(horizontal: _variant == _HfChipVariant.selected ? 14 : 16),
              decoration: BoxDecoration(
                color: bg,
                borderRadius: BorderRadius.circular(HfRadius.control),
                border: border,
              ),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  if (leading != null) ...[
                    Icon(leading, size: 16, color: fg),
                    const SizedBox(width: HfSpacing.xs),
                  ],
                  Flexible(
                    child: Text(label, maxLines: 1, overflow: TextOverflow.ellipsis,
                        style: HfText.badge.copyWith(color: fg, fontWeight: weight)),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
