import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show Clipboard, ClipboardData;

import 'package:url_launcher/url_launcher.dart';

import '../core/brand.dart';
import '../data/services.dart';
import '../data/share.dart';
import '../data/telemetry.dart';
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
          SharePageButtons(slug: slug, name: name),
        ]),
      ),
    );
  }
}

/// [HF-APP-PARITY-MERCH-1] Same share links as the website (HF-SHARE-WEB-1): every link carries `?utm_source=share&utm_medium=<network>`.
String sharedPageUrl(String slug, String network) =>
    Brand.url('/h/${Uri.encodeComponent(slug)}?utm_source=share&utm_medium=${Uri.encodeQueryComponent(network)}');

/// The text that goes with a shared page (the website uses the same words).
String sharedPageText(String? name) =>
    name == null || name.trim().isEmpty ? 'Book a call with me or get my merch' : 'Talk to ${name.trim()} — book a call or get my merch';

String whatsappShareHref(String slug, String text) =>
    'https://wa.me/?text=${Uri.encodeComponent('$text ${sharedPageUrl(slug, 'whatsapp')}')}';

String xShareHref(String slug, String text) =>
    'https://twitter.com/intent/tweet?text=${Uri.encodeComponent(text)}&url=${Uri.encodeComponent(sharedPageUrl(slug, 'x'))}';

String facebookShareHref(String slug) =>
    'https://www.facebook.com/sharer/sharer.php?u=${Uri.encodeComponent(sharedPageUrl(slug, 'facebook'))}';

/// [HF-APP-PARITY-MERCH-1] The share buttons of the website's "Share my page": Copy link, WhatsApp, X, Facebook, Instagram (copies the
/// link and shows the bio tip) and More (the phone's own share sheet). Each tap sends `profile_share_clicked {own, network}`
/// (and `profile_share_tapped`, which HF-SHARE-APP-1 counts).
class SharePageButtons extends StatefulWidget {
  const SharePageButtons({super.key, required this.slug, this.name});

  final String slug;
  final String? name;

  @override
  State<SharePageButtons> createState() => _SharePageButtonsState();
}

class _SharePageButtonsState extends State<SharePageButtons> {
  bool _copied = false;
  bool _igTip = false;

  void _track(String network) {
    Telemetry.event('profile_share_clicked', {'own': true, 'network': network});
    Telemetry.event('profile_share_tapped', {'own': true, 'slug': widget.slug});
  }

  Future<void> _copy(String network) async {
    await Clipboard.setData(ClipboardData(text: sharedPageUrl(widget.slug, network)));
    if (!mounted) return;
    setState(() => _copied = true);
    unawaited(Future<void>.delayed(const Duration(milliseconds: 2500), () {
      if (mounted) setState(() => _copied = false);
    }));
  }

  Future<void> _open(String network, String href) async {
    _track(network);
    var ok = false;
    try {
      ok = await launchUrl(Uri.parse(href), mode: LaunchMode.externalApplication);
    } catch (_) {
      ok = false;
    }
    if (!ok && mounted) toast(context, 'Could not open that app.');
  }

  @override
  Widget build(BuildContext context) {
    final text = sharedPageText(widget.name);
    final slug = widget.slug;
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Wrap(spacing: 8, runSpacing: 8, children: [
        DesiButton(_copied ? 'Copied' : 'Copy link', icon: Icons.copy_rounded, kind: DesiButtonKind.rani, onTap: () {
          _track('copy');
          unawaited(_copy('copy'));
        }),
        DesiButton('WhatsApp', icon: Icons.chat_rounded, kind: DesiButtonKind.ghost, onTap: () => unawaited(_open('whatsapp', whatsappShareHref(slug, text)))),
        DesiButton('X', kind: DesiButtonKind.ghost, onTap: () => unawaited(_open('x', xShareHref(slug, text)))),
        DesiButton('Facebook', kind: DesiButtonKind.ghost, onTap: () => unawaited(_open('facebook', facebookShareHref(slug)))),
        DesiButton('Instagram', kind: DesiButtonKind.ghost, onTap: () {
          _track('instagram');
          setState(() => _igTip = true);
          unawaited(_copy('instagram'));
        }),
        DesiButton('More…', icon: Icons.share_rounded, kind: DesiButtonKind.ghost, onTap: () {
          _track('native');
          unawaited(ShareSheet.text('$text\n${sharedPageUrl(slug, 'native')}'));
        }),
      ]),
      if (_igTip)
        Padding(
          padding: const EdgeInsets.only(top: 8),
          child: Text('Link copied. On Instagram, open Edit profile and paste it in your bio, so fans can tap through to your page.',
              style: t(14, color: C.muted, w: FontWeight.w700, h: 1.3)),
        ),
    ]);
  }
}

/// [HF-APP-PARITY-MERCH-1] "Share your shop" row for the top of My merch (the website shows the same row on its Merch screen).
/// Shows nothing until the influencer has a slug.
class ShareShopRow extends StatelessWidget {
  const ShareShopRow({super.key});

  @override
  Widget build(BuildContext context) {
    final me = Services.instance.me;
    final slug = me?.hostSlug;
    if (slug == null || slug.isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: DesiCard(
        title: 'Share your shop',
        note: 'Fans buy from your page: ${influencerPageUrl(slug, tracked: false)}',
        child: SharePageButtons(slug: slug, name: me?.name),
      ),
    );
  }
}
