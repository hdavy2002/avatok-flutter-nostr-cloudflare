import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';
import 'package:qr_flutter/qr_flutter.dart';
import 'package:share_plus/share_plus.dart';

import '../../core/analytics.dart';
import '../../core/ui/zine.dart';
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
          const SnackBar(content: Text('Link copied')));
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
    return Container(
      decoration: const BoxDecoration(
        color: Zine.paper,
        borderRadius: BorderRadius.vertical(top: Radius.circular(Zine.r)),
        border: Border(top: BorderSide(color: Zine.ink, width: Zine.bw)),
      ),
      child: SafeArea(
        child: Padding(
          padding: EdgeInsets.fromLTRB(24, 14, 24, 24 + MediaQuery.of(context).viewInsets.bottom),
          child: Column(mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Center(child: Container(width: 38, height: 5,
                margin: const EdgeInsets.only(bottom: 16),
                decoration: BoxDecoration(color: Zine.inkMute,
                    borderRadius: BorderRadius.circular(3)))),
            Center(
              child: ZineMarkTitle(
                pre: justCreated ? 'Your link is ' : 'Share your ',
                mark: justCreated ? 'ready' : 'link',
                fontSize: 26,
              ),
            ),
            const SizedBox(height: 8),
            Text(
              'Earn 10% of every payment your referrals ever make on this listing — for life.',
              textAlign: TextAlign.center,
              style: ZineText.sub(size: 12.5),
            ),
            const SizedBox(height: 18),
            // QR in an ink-bordered card with a hard offset shadow.
            Center(
              child: Container(
                padding: const EdgeInsets.all(14),
                decoration: BoxDecoration(
                  color: Zine.card,
                  border: Zine.border,
                  borderRadius: BorderRadius.circular(Zine.r),
                  boxShadow: Zine.shadowSm,
                ),
                child: QrImageView(
                  data: link.url,
                  size: 220,
                  backgroundColor: Zine.card,
                ),
              ),
            ),
            const SizedBox(height: 18),
            // URL pill + copy
            ZinePressable(
              onTap: () => _copy(context),
              radius: BorderRadius.circular(Zine.rSm),
              boxShadow: Zine.shadowXs,
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
              child: Row(children: [
                Expanded(child: Text(link.url, maxLines: 1, overflow: TextOverflow.ellipsis,
                    style: ZineText.tag(size: 13))),
                const SizedBox(width: 8),
                PhosphorIcon(PhosphorIcons.copy(PhosphorIconsStyle.bold),
                    size: 18, color: Zine.inkSoft),
              ]),
            ),
            const SizedBox(height: 16),
            ZineButton(
              label: 'Share it',
              fullWidth: true,
              fontSize: 18,
              icon: PhosphorIcons.shareNetwork(PhosphorIconsStyle.bold),
              trailingIcon: false,
              onPressed: _share,
            ),
            const SizedBox(height: 12),
            Center(child: ZineLink('DONE', onTap: () => Navigator.pop(context))),
          ]),
        ),
      ),
    );
  }
}
