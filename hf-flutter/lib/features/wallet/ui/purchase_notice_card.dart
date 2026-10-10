import 'package:flutter/material.dart';

import '../../../core/theme/hf_tokens.dart';
import '../../../core/widgets/widgets.dart';
import '../billing/purchase_controller.dart';

/// The result of a purchase, drawn as a card at the top of the Wallet. Never green: success is lilac with
/// an orchid tick, trouble is blush with the alert colour.
class PurchaseNoticeCard extends StatelessWidget {
  const PurchaseNoticeCard({super.key, required this.notice, required this.onDismiss});

  final PurchaseNotice notice;
  final VoidCallback onDismiss;

  @override
  Widget build(BuildContext context) {
    final (Color bg, Color fg, IconData icon) = switch (notice.kind) {
      NoticeKind.success => (HfColors.lilac, HfColors.orchid, Icons.check_circle_outline_rounded),
      NoticeKind.pending => (HfColors.butter, HfColors.plum, Icons.hourglass_top_rounded),
      NoticeKind.cancelled => (HfColors.lilac, HfColors.mauve, Icons.info_outline_rounded),
      NoticeKind.error => (HfColors.blush, HfColors.accent, Icons.error_outline_rounded),
    };
    return Semantics(
      liveRegion: true,
      container: true,
      child: HfCard(
        key: const ValueKey<String>('purchase-notice'),
        color: bg,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Icon(icon, color: fg, size: 28),
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
