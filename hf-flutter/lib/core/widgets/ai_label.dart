import 'package:flutter/material.dart';

import '../strings.dart';
import '../theme/hf_tokens.dart';

/// The "AI avatar chosen by the host" / "AI images" label (HF-AVA-1). Always 14 sp or more, never hidden.
class AiLabel extends StatelessWidget {
  const AiLabel({super.key, this.text = Strings.aiAvatarLabel});

  /// [Strings.aiAvatarLabel] by default; use [Strings.aiImagesLabel] on the gallery.
  final String text;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
      decoration: BoxDecoration(
        color: HfColors.lilac,
        borderRadius: BorderRadius.circular(HfRadius.pill),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Icon(Icons.auto_awesome, size: 16, color: HfColors.orchid),
          const SizedBox(width: 6),
          Flexible(child: Text(text, style: HfText.badge.copyWith(color: HfColors.orchid))),
        ],
      ),
    );
  }
}
