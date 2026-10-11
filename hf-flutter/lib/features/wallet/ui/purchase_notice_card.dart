import 'package:flutter/material.dart';

import '../../../core/theme/hf_tokens.dart';
import '../../../core/widgets/widgets.dart';
import '../billing/purchase_controller.dart';

/// A server purchase result in a white card with a distinct coloured status icon.
class PurchaseNoticeCard extends StatelessWidget {
  const PurchaseNoticeCard({super.key, required this.notice, required this.onDismiss});

  final PurchaseNotice notice;
  final VoidCallback onDismiss;

  @override
  Widget build(BuildContext context) {
    final (Color bg, Color fg, IconData icon) = switch (notice.kind) {
      NoticeKind.success => (HfColors.mint, HfColors.ink, Icons.check_circle_outline_rounded),
      NoticeKind.pending => (HfColors.butter, HfColors.plum, Icons.hourglass_top_rounded),
      NoticeKind.cancelled => (HfColors.lilac, HfColors.mauve, Icons.info_outline_rounded),
      NoticeKind.error => (HfColors.blush, HfColors.accent, Icons.error_outline_rounded),
    };
    return Semantics(
      liveRegion: true,
      container: true,
      child: HfCard(
        key: const ValueKey<String>('purchase-notice'),
        color: HfColors.white,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Container(padding: const EdgeInsets.all(10), decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(16)), child: Icon(icon, color: fg, size: 28)),
                const SizedBox(width: 12),
                Expanded(child: Text(notice.message, style: HfText.bodyStrong)),
              ],
            ),
            Align(
              alignment: Alignment.centerRight,
              child: HfButton(label: 'OK', kind: HfButtonKind.text, expand: false, onPressed: onDismiss),
            ),
          ],
        ),
      ),
    );
  }
}
