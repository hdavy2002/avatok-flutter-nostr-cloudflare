import 'package:flutter/material.dart';

import '../../../core/theme/hf_tokens.dart';

/// A choice chip for the filter sheet and the lane tabs. Like the shared `HfChip`, but a long label
/// (some topics are a whole sentence) wraps onto a second line instead of running off the screen.
/// The tap area is at least 48 dp high.
class OptionChip extends StatelessWidget {
  const OptionChip({super.key, required this.label, required this.selected, required this.onTap});

  final String label;
  final bool selected;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final fg = selected ? HfColors.cream : HfColors.plum;
    final maxWidth = MediaQuery.sizeOf(context).width - 2 * HfSpacing.page;
    return Semantics(
      button: true,
      selected: selected,
      label: label,
      excludeSemantics: true,
      child: ConstrainedBox(
        constraints: BoxConstraints(maxWidth: maxWidth, minHeight: HfSpacing.tap, minWidth: HfSpacing.tap),
        child: Material(
          color: selected ? HfColors.plum : HfColors.white,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(HfRadius.control),
            side: BorderSide(color: selected ? HfColors.plum : HfColors.line, width: 1.5),
          ),
          child: InkWell(
            onTap: onTap,
            borderRadius: BorderRadius.circular(HfRadius.control),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  if (selected) ...[
                    Icon(Icons.check_rounded, size: 18, color: fg),
                    const SizedBox(width: 6),
                  ],
                  Flexible(
                    child: Text(label, style: HfText.badge.copyWith(color: fg, fontSize: 15), maxLines: 3),
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
