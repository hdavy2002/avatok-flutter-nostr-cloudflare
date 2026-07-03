// smart_reply_chips.dart — [GROUP-AI-4] a row of up to 3 tappable suggestion
// chips shown ABOVE the input bar (DMs only). Tap inserts the text into the
// composer (never auto-sends). The parent owns debounce + fetch and the "only
// when thread open + foreground" gate; this widget is pure presentation.
import 'package:flutter/material.dart';

import '../../../core/ui/zine.dart';

class SmartReplyChips extends StatelessWidget {
  final List<String> suggestions;
  final void Function(String suggestion) onTap;
  const SmartReplyChips({super.key, required this.suggestions, required this.onTap});

  @override
  Widget build(BuildContext context) {
    if (suggestions.isEmpty) return const SizedBox.shrink();
    return SizedBox(
      height: 42,
      child: ListView(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
        children: [
          for (final s in suggestions)
            Padding(
              padding: const EdgeInsets.only(right: 8),
              child: GestureDetector(
                onTap: () => onTap(s),
                behavior: HitTestBehavior.opaque,
                child: Container(
                  alignment: Alignment.center,
                  padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 7),
                  decoration: BoxDecoration(
                    color: Zine.mint,
                    border: Zine.border,
                    borderRadius: BorderRadius.circular(100),
                    boxShadow: Zine.shadowXs,
                  ),
                  child: Text(s, maxLines: 1, overflow: TextOverflow.ellipsis, style: ZineText.value(size: 13, color: Zine.ink)),
                ),
              ),
            ),
        ],
      ),
    );
  }
}
