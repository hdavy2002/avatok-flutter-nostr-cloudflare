import 'dart:async';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show Clipboard, ClipboardData;

import 'package:qr_flutter/qr_flutter.dart';
import 'package:share_plus/share_plus.dart';
import 'package:url_launcher/url_launcher.dart';

import '../core/brand.dart';
import '../data/services.dart';
import '../data/share.dart';
import '../data/telemetry.dart';
import 'desi.dart';
import 'screens/sheets.dart';
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
        DesiButton('QR code', icon: Icons.qr_code_2_rounded, kind: DesiButtonKind.ghost, onTap: () {
          _track('qr');
          unawaited(showPageQrSheet(context, slug: slug, name: widget.name));
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

/// [HF-APP-SHARE-QR-1] The page link as a QR code (website parity: `utm_medium=qr`), dark plum on white with a quiet zone.
Future<void> showPageQrSheet(BuildContext context, {required String slug, String? name}) {
  return showModalBottomSheet<void>(
    context: context,
    backgroundColor: C.clear,
    isScrollControlled: true,
    builder: (sheetContext) => SheetFrame(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 4, 16, 24),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text('Your QR code', style: t(20, color: C.maroon, w: FontWeight.w900)),
          const SizedBox(height: 12),
          Center(
            child: Container(
              color: C.white,
              padding: const EdgeInsets.all(16),
              child: QrImageView(
                data: sharedPageUrl(slug, 'qr'),
                version: QrVersions.auto,
                size: 240,
                backgroundColor: C.white,
                eyeStyle: const QrEyeStyle(eyeShape: QrEyeShape.square, color: C.maroon),
                dataModuleStyle: const QrDataModuleStyle(dataModuleShape: QrDataModuleShape.square, color: C.maroon),
              ),
            ),
          ),
          const SizedBox(height: 10),
          Text(influencerPageUrl(slug, tracked: false), textAlign: TextAlign.center, maxLines: 1, overflow: TextOverflow.ellipsis, style: t(15, color: C.maroon, w: FontWeight.w800)),
          const SizedBox(height: 14),
          DesiButton('Save / share QR', icon: Icons.ios_share_rounded, kind: DesiButtonKind.rani, expand: true, onTap: () => unawaited(_shareQrPng(context, slug, name))),
          const SizedBox(height: 8),
          DesiButton('Close', kind: DesiButtonKind.ghost, expand: true, onTap: () => Navigator.of(sheetContext).pop()),
        ]),
      ),
    ),
  );
}

/// Renders the QR at 1024 px (white background, 8% quiet zone) and opens the phone's share sheet with the PNG.
Future<void> _shareQrPng(BuildContext context, String slug, String? name) async {
  try {
    const px = 1024.0;
    const pad = 96.0;
    final painter = QrPainter(
      data: sharedPageUrl(slug, 'qr'),
      version: QrVersions.auto,
      gapless: true,
      eyeStyle: const QrEyeStyle(eyeShape: QrEyeShape.square, color: C.maroon),
      dataModuleStyle: const QrDataModuleStyle(dataModuleShape: QrDataModuleShape.square, color: C.maroon),
    );
    final recorder = ui.PictureRecorder();
    final canvas = Canvas(recorder);
    canvas.drawRect(const Rect.fromLTWH(0, 0, px, px), Paint()..color = C.white);
    canvas.translate(pad, pad);
    painter.paint(canvas, const Size(px - 2 * pad, px - 2 * pad));
    final image = await recorder.endRecording().toImage(px.toInt(), px.toInt());
    final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
    if (bytes == null) throw StateError('qr png');
    final safe = slug.replaceAll(RegExp(r'[^A-Za-z0-9_-]'), '_');
    final file = File('${Directory.systemTemp.path}/hf-page-qr-$safe.png');
    await file.writeAsBytes(bytes.buffer.asUint8List(bytes.offsetInBytes, bytes.lengthInBytes), flush: true);
    await Share.shareXFiles([XFile(file.path, mimeType: 'image/png')], text: '${sharedPageText(name)} ${sharedPageUrl(slug, 'qr')}');
  } catch (_) {
    if (context.mounted) toast(context, 'Could not make the QR code.');
  }
}
