import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show Clipboard, ClipboardData;

import '../data/services.dart';
import '../data/share.dart';
import 'desi.dart';
import 'theme.dart';
import 'widgets.dart';

/// [HF-SHARE-APP-1] Copies the influencer's public page link and says so.
Future<void> copyMyPageLink(BuildContext context, String slug) async {
  await Clipboard.setData(ClipboardData(text: influencerPageUrl(slug)));
  if (context.mounted) toast(context, 'Link copied');
}

/// [HF-SHARE-APP-1] "Share my page" card for the influencer's own app: the link, Copy link and Share.
/// Shows nothing until the influencer has a slug (`GET /api/hf/me` host.slug).
class SharePageCard extends StatelessWidget {
  const SharePageCard({super.key});

  @override
  Widget build(BuildContext context) {
    final me = Services.instance.me;
    final slug = me?.hostSlug;
    if (slug == null || slug.isEmpty) return const SizedBox.shrink();
    final name = me?.name ?? slug;
    return Padding(
      padding: const EdgeInsets.only(top: 12),
      child: DesiCard(
        title: 'Share my page',
        note: 'Send this link to your fans so they can book a call or buy your merch.',
        tone: DesiTone.rani,
        corner: DesiCorner.yellow,
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(influencerPageUrl(slug, tracked: false), maxLines: 1, overflow: TextOverflow.ellipsis, style: t(15, color: C.maroon, w: FontWeight.w800)),
          const SizedBox(height: 10),
          Wrap(spacing: 8, runSpacing: 8, children: [
            DesiButton('Share', icon: Icons.share_rounded, kind: DesiButtonKind.rani, onTap: () => unawaited(ShareSheet.influencer(slug, name, own: true))),
            DesiButton('Copy link', icon: Icons.copy_rounded, kind: DesiButtonKind.ghost, onTap: () => unawaited(copyMyPageLink(context, slug))),
          ]),
        ]),
      ),
    );
  }
}
