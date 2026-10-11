import 'package:flutter/material.dart';

import '../theme/hf_theme.dart';

/// Always-visible AI disclosure ("AI avatar"): a white 85% chip, 14 sp, radius 12. Never hide it.
class AiLabel extends StatelessWidget {
  const AiLabel({super.key, this.text = 'AI avatar'});

  /// Compact avatar disclosure by default; galleries supply their image disclosure.
  final String text;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
      decoration: BoxDecoration(
        color: const Color(0xD9FFFFFF),
        borderRadius: BorderRadius.circular(HfRadius.segmentItem),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Icon(Icons.auto_awesome, size: 14, color: HfColors.inkSoft),
          const SizedBox(width: HfSpacing.xs),
          Flexible(child: Text(text, style: HfText.label.copyWith(color: HfColors.inkSoft))),
        ],
      ),
    );
  }
}
