import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';
import 'package:share_plus/share_plus.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/analytics.dart';
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/messenger_theme.dart';
import '../explore/widgets.dart' show fmtWhen;

Future<void> showShareLiveEventSheet(
  BuildContext context, {
  required String listingId,
  required String title,
  int? startsAt,
  int ticketCount = 0,
}) =>
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: AD.bg,
      shape: const RoundedRectangleBorder(borderRadius: Msg.brSheetTop),
      builder: (_) => ShareLiveEventSheet(
        listingId: listingId,
        title: title,
        startsAt: startsAt,
        ticketCount: ticketCount,
      ),
    );

/// Public discovery-link sheet. The URL contains only the public listing id;
/// GetStream credentials, order ids and entitlement ids are never shared.
class ShareLiveEventSheet extends StatelessWidget {
  final String listingId, title;
  final int? startsAt;
  final int ticketCount;

  const ShareLiveEventSheet({
    super.key,
    required this.listingId,
    required this.title,
    this.startsAt,
    this.ticketCount = 0,
  });

  String get _url => 'https://avatok.ai/l/$listingId';
  String get _message => '$title on AvaTOK\n$_url';

  Future<void> _copy(BuildContext context) async {
    await Clipboard.setData(ClipboardData(text: _url));
    Analytics.capture('commercial_live_link_copied', {'listing_id': listingId});
    if (context.mounted) {
      ScaffoldMessenger.of(context)
          .showSnackBar(const SnackBar(content: Text('Event link copied')));
    }
  }

  Future<void> _share() async {
    Analytics.capture('commercial_live_link_shared', {
      'listing_id': listingId,
      'channel': 'system',
    });
    await Share.share(_message);
  }

  Future<void> _openChannel(String channel) async {
    final uri = channel == 'whatsapp'
        ? Uri.parse('https://wa.me/?text=${Uri.encodeQueryComponent(_message)}')
        : Uri(
            scheme: 'mailto',
            queryParameters: {
              'subject': 'Join my AvaTOK live event',
              'body': _message,
            },
          );
    Analytics.capture('commercial_live_link_shared', {
      'listing_id': listingId,
      'channel': channel,
    });
    await launchUrl(uri, mode: LaunchMode.externalApplication);
  }

  @override
  Widget build(BuildContext context) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(Msg.s4, Msg.s4, Msg.s4, Msg.s5),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            Container(
              width: 42,
              height: 4,
              decoration: BoxDecoration(
                color: AD.borderControl,
                borderRadius: Msg.brPill,
              ),
            ),
            const SizedBox(height: Msg.s4),
            Row(children: [
              Container(
                width: 44,
                height: 44,
                decoration: BoxDecoration(
                  color: AD.danger,
                  borderRadius: BorderRadius.circular(Msg.rMd),
                ),
                alignment: Alignment.center,
                child: PhosphorIcon(
                  PhosphorIcons.broadcast(PhosphorIconsStyle.bold),
                  color: AD.onBand(AD.danger),
                  size: 23,
                ),
              ),
              const SizedBox(width: Msg.s3),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('Your live event is published', style: ADText.rowName()),
                    Text(title,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: ADText.preview()),
                  ],
                ),
              ),
            ]),
            const SizedBox(height: Msg.s4),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(Msg.s3),
              decoration: BoxDecoration(
                color: AD.card,
                borderRadius: BorderRadius.circular(Msg.rMd),
                border: Border.all(color: AD.borderControl),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(_url, style: ADText.preview(c: AD.iconSearch)),
                  if (startsAt != null) ...[
                    const SizedBox(height: Msg.s2),
                    Text(fmtWhen(startsAt), style: ADText.rowName()),
                  ],
                  const SizedBox(height: Msg.s2),
                  Text(
                    'Anyone can view this event page. Only customers with an account-bound ticket can enter the stream.',
                    style: ADText.preview(c: AD.textPrimary),
                  ),
                  if (ticketCount > 0) ...[
                    const SizedBox(height: Msg.s2),
                    Text('$ticketCount ticket${ticketCount == 1 ? '' : 's'} reserved',
                        style: ADText.rowName()),
                  ],
                ],
              ),
            ),
            const SizedBox(height: Msg.s4),
            Row(children: [
              Expanded(
                child: _ShareAction(
                  icon: PhosphorIcons.copy(PhosphorIconsStyle.bold),
                  label: 'Copy',
                  onTap: () => _copy(context),
                ),
              ),
              const SizedBox(width: Msg.s2),
              Expanded(
                child: _ShareAction(
                  icon: PhosphorIcons.shareNetwork(PhosphorIconsStyle.bold),
                  label: 'Share',
                  onTap: _share,
                ),
              ),
              const SizedBox(width: Msg.s2),
              Expanded(
                child: _ShareAction(
                  icon: PhosphorIcons.whatsappLogo(PhosphorIconsStyle.bold),
                  label: 'WhatsApp',
                  onTap: () => _openChannel('whatsapp'),
                ),
              ),
              const SizedBox(width: Msg.s2),
              Expanded(
                child: _ShareAction(
                  icon: PhosphorIcons.envelope(PhosphorIconsStyle.bold),
                  label: 'Email',
                  onTap: () => _openChannel('email'),
                ),
              ),
            ]),
          ]),
        ),
      );
}

class _ShareAction extends StatelessWidget {
  final IconData icon;
  final String label;
  final VoidCallback onTap;

  const _ShareAction({required this.icon, required this.label, required this.onTap});

  @override
  Widget build(BuildContext context) => Material(
        color: AD.card,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(Msg.rMd),
          side: BorderSide(color: AD.borderControl),
        ),
        child: InkWell(
          borderRadius: BorderRadius.circular(Msg.rMd),
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: Msg.s3),
            child: Column(children: [
              PhosphorIcon(icon, size: 21, color: AD.iconSearch),
              const SizedBox(height: Msg.s1),
              Text(label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: ADText.statCaption()),
            ]),
          ),
        ),
      );
}
