import 'package:flutter/material.dart';

import '../../core/avatar.dart';
import '../../core/theme.dart';
import 'affiliate_api.dart';

/// AvaAffiliate brand accent (matches the core/app_registry.dart tile color).
const Color kAffiliateOrange = Color(0xFFF97316);

/// Hero gradient for the landing + dashboard header.
const LinearGradient kAffiliateGradient = LinearGradient(
  begin: Alignment.topLeft,
  end: Alignment.bottomRight,
  colors: [Color(0xFFF97316), Color(0xFFFB923C)],
);

/// Display metadata for the three promotable apps.
class AffApp {
  final String key, label;
  final IconData icon;
  final Color color;
  const AffApp(this.key, this.label, this.icon, this.color);
}

const kAffApps = <AffApp>[
  AffApp('avalive', 'AvaLive', Icons.sensors, Color(0xFFFF3B30)),
  AffApp('avaconsult', 'AvaConsult', Icons.video_camera_front, Color(0xFF22C9C0)),
  AffApp('avavoice', 'AvaVoice', Icons.mic, Color(0xFFA06AF0)),
];

AffApp affApp(String key) =>
    kAffApps.firstWhere((a) => a.key == key, orElse: () => kAffApps.first);

String fmtAffDate(int ms) {
  if (ms <= 0) return '—';
  final d = DateTime.fromMillisecondsSinceEpoch(ms);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return '${months[d.month - 1]} ${d.day}, ${d.year}';
}

/// Small colored badge naming the source app of a listing/link.
class AppBadge extends StatelessWidget {
  final String appKey;
  const AppBadge({super.key, required this.appKey});
  @override
  Widget build(BuildContext context) {
    final a = affApp(appKey);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
      decoration: BoxDecoration(
          color: a.color.withValues(alpha: .12), borderRadius: BorderRadius.circular(8)),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        Icon(a.icon, size: 11, color: a.color),
        const SizedBox(width: 3),
        Text(a.label,
            style: TextStyle(fontSize: 10, fontWeight: FontWeight.w800, color: a.color)),
      ]),
    );
  }
}

/// Dashboard headline stat tile.
class StatCard extends StatelessWidget {
  final String label, value;
  final IconData icon;
  final Color color;
  final String? sub;
  const StatCard({super.key, required this.label, required this.value,
      required this.icon, required this.color, this.sub});
  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        border: Border.all(color: AvaColors.line),
        borderRadius: BorderRadius.circular(16),
      ),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Icon(icon, size: 16, color: color),
          const SizedBox(width: 6),
          Expanded(child: Text(label, maxLines: 1, overflow: TextOverflow.ellipsis,
              style: const TextStyle(fontSize: 11.5, color: AvaColors.sub, fontWeight: FontWeight.w700))),
        ]),
        const SizedBox(height: 8),
        Text(value, maxLines: 1, overflow: TextOverflow.ellipsis,
            style: const TextStyle(fontSize: 19, fontWeight: FontWeight.w800, color: AvaColors.ink)),
        if (sub != null)
          Text(sub!, maxLines: 1, overflow: TextOverflow.ellipsis,
              style: const TextStyle(fontSize: 10.5, color: AvaColors.sub)),
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
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        border: Border.all(color: AvaColors.line),
        borderRadius: BorderRadius.circular(16),
      ),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Avatar(seed: listing.creatorId.isEmpty ? listing.id : listing.creatorId,
              name: listing.creatorName, size: 44, avatarUrl: listing.creatorAvatar),
          const SizedBox(width: 10),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(listing.title, maxLines: 2, overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 14.5)),
              const SizedBox(height: 2),
              Row(children: [
                Flexible(child: Text(listing.creatorName, maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(fontSize: 12, color: AvaColors.sub))),
                if (listing.rating != null) ...[
                  const SizedBox(width: 6),
                  const Icon(Icons.star, size: 13, color: Color(0xFFEAB308)),
                  Text(listing.rating!.toStringAsFixed(1),
                      style: const TextStyle(fontSize: 12, color: AvaColors.sub,
                          fontWeight: FontWeight.w700)),
                ],
              ]),
            ]),
          ),
          AppBadge(appKey: listing.app),
        ]),
        const SizedBox(height: 10),
        Row(children: [
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(affCoinsLabel(listing.price),
                  style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 15)),
              Text('You earn ~${affCoinsLabel(est)} per sale — for life',
                  style: const TextStyle(fontSize: 11.5, color: kAffiliateOrange,
                      fontWeight: FontWeight.w800)),
            ]),
          ),
          FilledButton(
            style: FilledButton.styleFrom(
                backgroundColor: kAffiliateOrange,
                padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10)),
            onPressed: busy ? null : onCreateLink,
            child: busy
                ? const SizedBox(width: 16, height: 16,
                    child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                : const Text('Create my link', style: TextStyle(fontSize: 13)),
          ),
        ]),
      ]),
    );
  }
}

/// Per-link performance row (Dashboard list).
class LinkRow extends StatelessWidget {
  final AffiliateLink link;
  final VoidCallback onTap;
  const LinkRow({super.key, required this.link, required this.onTap});
  @override
  Widget build(BuildContext context) {
    final a = affApp(link.app);
    return ListTile(
      contentPadding: const EdgeInsets.symmetric(horizontal: 4, vertical: 2),
      leading: Container(width: 40, height: 40,
          decoration: BoxDecoration(color: a.color.withValues(alpha: .12),
              borderRadius: BorderRadius.circular(12)),
          child: Icon(a.icon, color: a.color, size: 20)),
      title: Row(children: [
        Expanded(child: Text(link.title, maxLines: 1, overflow: TextOverflow.ellipsis,
            style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 14))),
        if (link.paused)
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
            decoration: BoxDecoration(color: AvaColors.soft,
                borderRadius: BorderRadius.circular(8)),
            child: const Text('PAUSED', style: TextStyle(fontSize: 9,
                fontWeight: FontWeight.w800, color: AvaColors.sub)),
          ),
      ]),
      subtitle: Text('${link.clicks} clicks · ${link.binds} referred',
          style: const TextStyle(fontSize: 11.5, color: AvaColors.sub)),
      trailing: Column(mainAxisAlignment: MainAxisAlignment.center,
          crossAxisAlignment: CrossAxisAlignment.end, children: [
        Text(affCoinsLabel(link.earnedCoins),
            style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 14.5,
                color: AvaColors.success)),
        const Text('earned', style: TextStyle(fontSize: 10.5, color: AvaColors.sub)),
      ]),
      onTap: onTap,
    );
  }
}

/// Centered empty/notice state.
class AffEmpty extends StatelessWidget {
  final String text;
  const AffEmpty(this.text, {super.key});
  @override
  Widget build(BuildContext context) => Center(
      child: Padding(padding: const EdgeInsets.all(32),
          child: Text(text, textAlign: TextAlign.center,
              style: const TextStyle(color: AvaColors.sub))));
}
