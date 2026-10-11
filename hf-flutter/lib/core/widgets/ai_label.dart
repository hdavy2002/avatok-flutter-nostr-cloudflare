import 'package:flutter/material.dart';

import '../theme/hf_tokens.dart';

/// Always-visible AI disclosure. The owner approved this caption-only 11sp exception.
class AiLabel extends StatelessWidget {
  const AiLabel({super.key, this.text = 'AI avatar'});

  /// Compact avatar disclosure by default; galleries supply their image disclosure.
  final String text;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
      decoration: BoxDecoration(
        color: HfColors.white,
        borderRadius: BorderRadius.circular(HfRadius.pill),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Icon(Icons.auto_awesome, size: 12, color: HfColors.ink),
          const SizedBox(width: 6),
          Flexible(child: Text(text, style: HfText.badge.copyWith(fontSize: 11, color: HfColors.ink))),
        ],
      ),
    );
  }
}
