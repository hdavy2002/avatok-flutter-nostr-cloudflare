import 'package:flutter/material.dart';

import '../theme/hf_tokens.dart';

/// A filter or topic chip: radius 12, plum when selected. The tap area is at least 48 dp high even
/// though the chip itself is slimmer.
class HfChip extends StatelessWidget {
  const HfChip({
    super.key,
    required this.label,
    required this.selected,
    required this.onTap,
    this.icon,
  });

  final String label;
  final bool selected;
  final VoidCallback? onTap;
  final IconData? icon;

  @override
  Widget build(BuildContext context) {
    final fg = selected ? HfColors.cream : HfColors.plum;
    return Semantics(
      button: true,
      selected: selected,
      label: label,
      excludeSemantics: true,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(HfRadius.control),
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: HfSpacing.tap, minWidth: HfSpacing.tap),
          child: Center(
            widthFactor: 1,
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
              decoration: BoxDecoration(
                color: selected ? HfColors.plum : HfColors.white,
                borderRadius: BorderRadius.circular(HfRadius.control),
                border: Border.all(color: selected ? HfColors.plum : HfColors.line, width: 1.5),
              ),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  if (icon != null) ...[
                    Icon(icon, size: 18, color: fg),
                    const SizedBox(width: 6),
                  ],
                  Text(label, style: HfText.badge.copyWith(color: fg, fontSize: 15)),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
