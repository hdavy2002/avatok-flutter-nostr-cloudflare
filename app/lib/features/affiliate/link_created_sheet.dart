
import '../../core/localization/ui_text.dart';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';
import 'package:qr_flutter/qr_flutter.dart';
import 'package:share_plus/share_plus.dart';

import '../../core/analytics.dart';
// [UI-DS-SWEEP-1] migrated off core/ui/zine.dart onto AD / ADText / Msg.
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/messenger_theme.dart';
import '../../core/ui/zine_widgets.dart';
import 'affiliate_api.dart';

/// "Your link is ready" bottom sheet — big QR (qr_flutter), copyable short
/// URL, native share. Shown right after POST /api/affiliate/links and from
/// the Link Detail screen.
Future<void> showLinkCreatedSheet(BuildContext context, AffiliateLink link,
    {bool justCreated = true}) {
  Analytics.capture('affiliate_qr_generated', {'link_id': link.id, 'app': link.app});
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    backgroundColor: Colors.transparent,
    builder: (_) => _LinkSheet(link: link, justCreated: justCreated),
  );
}

class _LinkSheet extends StatelessWidget {
  final AffiliateLink link;
  final bool justCreated;
  const _LinkSheet({required this.link, required this.justCreated});

  Future<void> _copy(BuildContext context) async {
    await Clipboard.setData(ClipboardData(text: link.url));
    Analytics.capture('affiliate_link_shared', {'link_id': link.id, 'share_channel': 'copy'});
    if (context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: UiText(UiMessage.m_link_copied_d12860c21e)));
    }
  }

  Future<void> _share() async {
    Analytics.capture('affiliate_link_shared', {'link_id': link.id, 'share_channel': 'native'});
    await Share.share(
      'Check out "${link.title}" on AvaTok — ${link.url}',
      subject: link.title,
    );
  }

  @override
  Widget build(BuildContext context) {
    UiLocaleScope.watch(context);
    return Container(
      decoration: const BoxDecoration(
        color: AD.bg,
        borderRadius: BorderRadius.vertical(top: Radius.circular(Msg.rLg)),
        border: Border(top: BorderSide(color: AD.borderCard, width: 1)),
      ),
      child: SafeArea(
        child: Padding(
          padding: EdgeInsets.fromLTRB(Msg.s5, Msg.s4, Msg.s5, 24 + MediaQuery.of(context).viewInsets.bottom),
          child: Column(mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Center(child: Container(width: 38, height: 5,
                margin: const EdgeInsets.only(bottom: Msg.s4),
                decoration: BoxDecoration(color: AD.textTertiary,
                    borderRadius: Msg.brPill))),
            Center(
              child: ZineMarkTitle(
                pre: justCreated ? uiCopy(UiMessage.m_your_link_is_28d1205859) : uiCopy(UiMessage.m_share_your_060ce95ea8),
                mark: justCreated ? uiCopy(UiMessage.m_ready_b24d6d3373) : uiCopy(UiMessage.m_link_b1b1bdb480),
                fontSize: 26,
              ),
            ),
            const SizedBox(height: Msg.s2),
            UiText(
              UiMessage.m_earn_10_of_every_payment_b83372e845,
              textAlign: TextAlign.center,
              style: ADText.preview(),
            ),
            const SizedBox(height: Msg.s4),
            // QR in an ink-bordered card with a hard offset shadow.
            Center(
              child: Container(
                padding: const EdgeInsets.all(Msg.s4),
                decoration: BoxDecoration(
                  color: AD.card,
                  border: Border.all(color: AD.borderCard, width: 1),
                  borderRadius: BorderRadius.circular(Msg.rLg),
                  boxShadow: const <BoxShadow>[],
                ),
                child: QrImageView(
                  data: link.url,
                  size: 220,
                  backgroundColor: AD.card,
                ),
              ),
            ),
            const SizedBox(height: Msg.s4),
            // URL pill + copy
            ZinePressable(
              onTap: () => _copy(context),
              radius: BorderRadius.circular(Msg.rLg),
              boxShadow: const <BoxShadow>[],
              padding: const EdgeInsets.symmetric(horizontal: Msg.s4, vertical: Msg.s3),
              child: Row(children: [
                Expanded(child: Text(link.url, maxLines: 1, overflow: TextOverflow.ellipsis,
                    style: ADText.sectionLabel())),
                const SizedBox(width: Msg.s2),
                PhosphorIcon(PhosphorIcons.copy(PhosphorIconsStyle.bold),
                    size: 18, color: AD.textSecondary),
              ]),
            ),
            const SizedBox(height: Msg.s4),
            ZineButton(
              label: uiCopy(UiMessage.m_share_it_692991f8b6),
              fullWidth: true,
              fontSize: 18,
              icon: PhosphorIcons.shareNetwork(PhosphorIconsStyle.bold),
              trailingIcon: false,
              onPressed: _share,
            ),
            const SizedBox(height: Msg.s3),
            Center(child: ZineLink('Done', onTap: () => Navigator.pop(context))),
          ]),
        ),
      ),
    );
  }
}
