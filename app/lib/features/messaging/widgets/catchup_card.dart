// catchup_card.dart — [GROUP-AI-1] a dismissible "What did I miss?" summary card
// pinned above the unread divider in a group thread. Renders the <=6 attributed
// bullets returned by /api/ai/catchup. The summary is NEVER stored server-side
// (D6); this card lives only in the open thread's state.
import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../../core/ui/avatok_dark.dart';
import '../ai_chat_api.dart';

class CatchupCard extends StatelessWidget {
  final List<CatchupBullet> bullets;
  final int msgCount;
  final VoidCallback onDismiss;
  const CatchupCard({super.key, required this.bullets, required this.msgCount, required this.onDismiss});

  @override
  Widget build(BuildContext context) {
    if (bullets.isEmpty) return const SizedBox.shrink();
    return Container(
      margin: const EdgeInsets.fromLTRB(12, 8, 12, 8),
      padding: const EdgeInsets.fromLTRB(14, 12, 10, 12),
      decoration: BoxDecoration(
        color: AD.card,
        border: Border.all(color: AD.borderControl, width: 1),
        borderRadius: BorderRadius.circular(AD.rStatCard),
      ),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          PhosphorIcon(PhosphorIcons.sparkle(PhosphorIconsStyle.fill), size: 15, color: AD.iconVideo),
          const SizedBox(width: 6),
          Expanded(
            child: Text('WHAT YOU MISSED · $msgCount messages',
                style: ADText.statCaption(c: AD.textSecondary)),
          ),
          GestureDetector(
            onTap: onDismiss,
            behavior: HitTestBehavior.opaque,
            child: Padding(
              padding: const EdgeInsets.all(4),
              child: PhosphorIcon(PhosphorIcons.x(PhosphorIconsStyle.bold), size: 16, color: AD.textSecondary),
            ),
          ),
        ]),
        const SizedBox(height: 8),
        for (final b in bullets)
          Padding(
            padding: const EdgeInsets.only(bottom: 5),
            child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Padding(
                padding: const EdgeInsets.only(top: 2, right: 6),
                child: Text('•', style: ADText.rowName()),
              ),
              Expanded(
                child: RichText(
                  text: TextSpan(children: [
                    if (b.sender.isNotEmpty)
                      TextSpan(text: '${b.sender} ', style: ADText.rowName(c: AD.iconSearch)),
                    TextSpan(text: b.text, style: ADText.preview(c: AD.textSecondary)),
                  ]),
                ),
              ),
            ]),
          ),
      ]),
    );
  }
}
