import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:qr_flutter/qr_flutter.dart';
import 'package:share_plus/share_plus.dart';

import '../../core/analytics.dart';
import '../../core/theme.dart';
import 'affiliate_api.dart';
import 'widgets.dart';

/// "Your link is ready" bottom sheet — big QR (qr_flutter), copyable short
/// URL, native share. Shown right after POST /api/affiliate/links and from
/// the Link Detail screen.
Future<void> showLinkCreatedSheet(BuildContext context, AffiliateLink link,
    {bool justCreated = true}) {
  Analytics.capture('affiliate_qr_generated', {'link_id': link.id, 'app': link.app});
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    backgroundColor: Colors.white,
    shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(24))),
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
    return SafeArea(
      child: Padding(
        padding: EdgeInsets.fromLTRB(24, 16, 24, 24 + MediaQuery.of(context).viewInsets.bottom),
        child: Column(mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Center(child: Container(width: 36, height: 4,
              margin: const EdgeInsets.only(bottom: 16),
              decoration: BoxDecoration(color: AvaColors.line,
                  borderRadius: BorderRadius.circular(2)))),
          Row(mainAxisAlignment: MainAxisAlignment.center, children: [
            const Icon(Icons.celebration, color: kAffiliateOrange, size: 22),
            const SizedBox(width: 8),
            Text(justCreated ? 'Your link is ready!' : 'Share your link',
                style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 18)),
          ]),
          const SizedBox(height: 4),
          Text(
            'Earn 10% of every payment your referrals ever make on this listing — for life.',
            textAlign: TextAlign.center,
            style: const TextStyle(fontSize: 12.5, color: AvaColors.sub),
          ),
          const SizedBox(height: 16),
          Center(
            child: Container(
              padding: const EdgeInsets.all(14),
              decoration: BoxDecoration(
                color: Colors.white,
                border: Border.all(color: AvaColors.line),
                borderRadius: BorderRadius.circular(20),
              ),
              child: QrImageView(
                data: link.url,
                size: 220,
                backgroundColor: Colors.white,
              ),
            ),
          ),
          const SizedBox(height: 14),
          // URL pill + copy
          InkWell(
            onTap: () => _copy(context),
            borderRadius: BorderRadius.circular(12),
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
              decoration: BoxDecoration(color: AvaColors.soft,
                  borderRadius: BorderRadius.circular(12)),
              child: Row(children: [
                Expanded(child: Text(link.url, maxLines: 1, overflow: TextOverflow.ellipsis,
                    style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 13.5))),
                const Icon(Icons.copy, size: 18, color: AvaColors.sub),
              ]),
            ),
          ),
          const SizedBox(height: 14),
          FilledButton.icon(
            style: FilledButton.styleFrom(backgroundColor: kAffiliateOrange,
                padding: const EdgeInsets.symmetric(vertical: 14)),
            onPressed: _share,
            icon: const Icon(Icons.ios_share, size: 18),
            label: const Text('Share'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Done'),
          ),
        ]),
      ),
    );
  }
}
