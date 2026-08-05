import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/avatar.dart';
// [UI-DS-SWEEP-1] migrated off core/ui/zine.dart onto AD / ADText / Msg.
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/messenger_theme.dart';
import '../../core/ui/zine_widgets.dart';
import 'affiliate_api.dart';

/// Display metadata for the three promotable apps (zine accent rotation —
/// matches affiliate_home / link_detail `_appMeta`).
class AffApp {
  final String key, label;
  final IconData icon;
  final Color color;
  const AffApp(this.key, this.label, this.icon, this.color);
}

final kAffApps = <AffApp>[
  AffApp('avalive', 'AvaLive', PhosphorIcons.broadcast(PhosphorIconsStyle.bold), AD.danger),
  AffApp('avaconsult', 'AvaConsult', PhosphorIcons.videoCamera(PhosphorIconsStyle.bold), AD.newGroup),
  AffApp('avavoice', 'AvaVoice', PhosphorIcons.microphone(PhosphorIconsStyle.bold), AD.micIdleBg),
];

AffApp affApp(String key) =>
    kAffApps.firstWhere((a) => a.key == key, orElse: () => kAffApps.first);

String fmtAffDate(int ms) {
  if (ms <= 0) return '—';
  final d = DateTime.fromMillisecondsSinceEpoch(ms);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return '${months[d.month - 1]} ${d.day}, ${d.year}';
}

/// Small sticker naming the source app of a listing/link (§7.5).
class AppBadge extends StatelessWidget {
  final String appKey;
  const AppBadge({super.key, required this.appKey});
  @override
  Widget build(BuildContext context) {
    final a = affApp(appKey);
    return ZineSticker(a.label, icon: a.icon);
  }
}

/// Dashboard headline stat tile — metric card (§7.11).
class StatCard extends StatelessWidget {
  final String label, value;
  final IconData icon;
  final Color color;
  final String? sub;
  const StatCard({super.key, required this.label, required this.value,
      required this.icon, required this.color, this.sub});
  @override
  Widget build(BuildContext context) {
    return ZineCard(
      radius: Msg.rLg,
      padding: const EdgeInsets.all(Msg.s4),
      boxShadow: const <BoxShadow>[],
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        ZineIconBadge(icon: icon, color: color, size: 30),
        const SizedBox(height: Msg.s3),
        FittedBox(
          fit: BoxFit.scaleDown,
          alignment: Alignment.centerLeft,
          child: Text(value, maxLines: 1, style: ADText.appTitle().copyWith(fontSize: 24)),
        ),
        const SizedBox(height: Msg.s1),
        Text(label, maxLines: 1, overflow: TextOverflow.ellipsis,
            style: ADText.sectionLabel()),
        if (sub != null)
          Text(sub!, maxLines: 1, overflow: TextOverflow.ellipsis,
              style: ADText.sectionLabel(c: AD.textTertiary)),
      ]),
    );
  }
}

/// Product Picker listing card with the live "you earn per sale" estimate.
class ListingPickCard extends StatelessWidget {
  final AffiliateListing listing;
  final VoidCallback onCreateLink;
  final bool busy;
  const ListingPickCard({super.key, required this.listing,
      required this.onCreateLink, this.busy = false});

  @override
  Widget build(BuildContext context) {
    final est = estimatedCommissionPerSale(listing.price);
    return ZineCard(
      radius: Msg.rLg,
      padding: const EdgeInsets.all(Msg.s3),
      boxShadow: const <BoxShadow>[],
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Container(
            decoration: const BoxDecoration(
              shape: BoxShape.circle,
              border: Border.fromBorderSide(BorderSide(color: AD.borderCard, width: 2)),
            ),
            child: Avatar(seed: listing.creatorId.isEmpty ? listing.id : listing.creatorId,
                name: listing.creatorName, size: 44, avatarUrl: listing.creatorAvatar),
          ),
          const SizedBox(width: Msg.s3),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(listing.title, maxLines: 2, overflow: TextOverflow.ellipsis,
                  style: ADText.threadName()),
              const SizedBox(height: Msg.s1),
              Row(children: [
                Flexible(child: Text(listing.creatorName, maxLines: 1,
                    overflow: TextOverflow.ellipsis, style: ADText.preview())),
                if (listing.rating != null) ...[
                  const SizedBox(width: Msg.s2),
                  PhosphorIcon(PhosphorIcons.star(PhosphorIconsStyle.fill),
                      size: 13, color: AD.danger),
                  const SizedBox(width: 2),
                  Text(listing.rating!.toStringAsFixed(1),
                      style: ADText.rowName()),
                ],
              ]),
            ]),
          ),
          const SizedBox(width: Msg.s2),
          AppBadge(appKey: listing.app),
        ]),
        const SizedBox(height: Msg.s3),
        Row(children: [
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(affCoinsLabel(listing.price),
                  style: ADText.rowName().copyWith(fontWeight: FontWeight.w700)),
              const SizedBox(height: 1),
              Text('You earn ~${affCoinsLabel(est)} per sale — for life',
                  style: ADText.rowName(c: AD.online)),
            ]),
          ),
          const SizedBox(width: Msg.s3),
          ZineButton(
            label: 'Create my link',
            variant: ZineButtonVariant.blue,
            fontSize: 14,
            loading: busy,
            onPressed: busy ? null : onCreateLink,
          ),
        ]),
      ]),
    );
  }
}

/// Per-link performance row (Dashboard list) — zine card row.
class LinkRow extends StatelessWidget {
  final AffiliateLink link;
  final VoidCallback onTap;
  const LinkRow({super.key, required this.link, required this.onTap});
  @override
  Widget build(BuildContext context) {
    final a = affApp(link.app);
    return ZinePressable(
      onTap: onTap,
      radius: BorderRadius.circular(Msg.rLg),
      boxShadow: const <BoxShadow>[],
      padding: const EdgeInsets.all(Msg.s3),
      child: Row(children: [
        ZineIconBadge(icon: a.icon, color: a.color, size: 40),
        const SizedBox(width: Msg.s3),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              Expanded(child: Text(link.title, maxLines: 1, overflow: TextOverflow.ellipsis,
                  style: ADText.rowName())),
              if (link.paused) ...[
                const SizedBox(width: Msg.s2),
                const ZineSticker('paused', kind: ZineStickerKind.hint),
              ],
            ]),
            const SizedBox(height: Msg.s1),
            Text('${link.clicks} clicks · ${link.binds} referred',
                style: ADText.sectionLabel(c: AD.textTertiary)),
          ]),
        ),
        const SizedBox(width: Msg.s3),
        Column(crossAxisAlignment: CrossAxisAlignment.end, children: [
          Text(affCoinsLabel(link.earnedCoins),
              style: ADText.rowName(c: AD.online).copyWith(fontWeight: FontWeight.w700)),
          Text('Earned', style: ADText.sectionLabel(c: AD.textTertiary)),
        ]),
      ]),
    );
  }
}

/// Centered empty/notice state (§7.12).
class AffEmpty extends StatelessWidget {
  final String text;
  const AffEmpty(this.text, {super.key});
  @override
  Widget build(BuildContext context) => Center(
        child: Padding(
          padding: const EdgeInsets.all(Msg.s6),
          child: ZineEmptyState(
            icon: PhosphorIcons.megaphone(PhosphorIconsStyle.bold),
            text: text,
          ),
        ),
      );
}
