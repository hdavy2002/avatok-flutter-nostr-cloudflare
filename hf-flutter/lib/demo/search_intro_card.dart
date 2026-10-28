import 'package:flutter/material.dart';

import '../data/models/reel.dart';
import 'desi.dart';
import 'intro_reel_overlay.dart';
import 'theme.dart';
import 'verified_tick.dart';

/// [HF-SEARCH-FILTERS-1] One approved influencer in Search results (flag `hfIntroReelsEnabled`): the intro-video poster, name with the
/// green tick, small icons of the social accounts she proved by logging in, her categories, the rate, the live status and the ONE button the
/// server asked for (`mainAction`). Offline influencers are listed too: their button reads "Book a time". Tapping anywhere opens the profile.
class SearchIntroCard extends StatelessWidget {
  const SearchIntroCard({super.key, required this.reel, required this.onTap});

  final FeedReel reel;
  final VoidCallback onTap;

  /// "Call now", "Queue or book", "Book a time" or "View profile": the server's rule for this influencer.
  static String actionLabel(FeedReel r) => switch (r.effectiveMainAction) {
        'call' => 'Call now',
        'queue_or_book' => 'Queue or book',
        'none' => 'View profile',
        _ => 'Book a time',
      };

  static String statusLabel(FeedReel r) => switch (r.host.presence) {
        'online' => 'Online now',
        'busy' => 'On a call',
        _ => 'Offline',
      };

  @override
  Widget build(BuildContext context) {
    final h = reel.host;
    final online = h.online;
    final poster = reel.posterUrl ?? h.avatar;
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Material(
        color: C.white,
        borderRadius: BorderRadius.circular(18),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          key: ValueKey('hit-${h.slug}'),
          onTap: onTap,
          child: Container(
            padding: const EdgeInsets.all(10),
            decoration: BoxDecoration(borderRadius: BorderRadius.circular(18), border: Border.all(color: C.line, width: 1.5)),
            child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              ClipRRect(
                borderRadius: BorderRadius.circular(12),
                child: SizedBox(
                  width: 84,
                  height: 140,
                  child: poster == null
                      ? Container(color: C.sand, alignment: Alignment.center, child: Text(h.name.isEmpty ? '?' : String.fromCharCode(h.name.runes.first).toUpperCase(), style: t(30, color: C.maroon)))
                      : Image.network(
                          poster,
                          fit: BoxFit.cover,
                          errorBuilder: (_, __, ___) => Container(color: C.sand),
                        ),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Row(children: [
                    Flexible(child: Text(h.name, maxLines: 1, overflow: TextOverflow.ellipsis, style: t(17, w: FontWeight.w800))),
                    const SizedBox(width: 6),
                    VerifiedTick(name: h.name, videoKyc: reel.greenTick, channel: reel.socials.isNotEmpty, surface: 'app_search_card', size: 18, interactive: false),
                  ]),
                  const SizedBox(height: 4),
                  Row(children: [
                    for (final s in reel.socials)
                      Padding(
                        padding: const EdgeInsets.only(right: 6),
                        child: Icon(IntroReelOverlay.socialIcon(s.platform), key: ValueKey('plat-icon-${s.platform}'), size: 18, color: IntroReelOverlay.socialColor(s.platform), semanticLabel: 'Verified on ${IntroReelOverlay.socialName(s.platform)}'),
                      ),
                    Flexible(child: Text(h.handle ?? '', maxLines: 1, overflow: TextOverflow.ellipsis, style: t(14, color: C.muted, w: FontWeight.w600))),
                  ]),
                  if (reel.categories.isNotEmpty) ...[
                    const SizedBox(height: 8),
                    Wrap(spacing: 6, runSpacing: 6, children: [for (final c in reel.categories.take(3)) DesiChip(c.label, tone: DesiTone.tea)]),
                  ],
                  const SizedBox(height: 10),
                  Wrap(spacing: 6, runSpacing: 6, crossAxisAlignment: WrapCrossAlignment.center, children: [
                    DesiChip('₹${(reel.ratePaise / 100).round()}/min', tone: DesiTone.gold),
                    if (online)
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 4),
                        decoration: BoxDecoration(color: C.onlineBg, borderRadius: BorderRadius.circular(999)),
                        child: Text(statusLabel(reel), style: t(14, color: C.onlineInk, w: FontWeight.w800)),
                      )
                    else
                      DesiChip(statusLabel(reel), tone: DesiTone.white),
                  ]),
                  const SizedBox(height: 10),
                  Container(
                    key: ValueKey('hit-action-${h.slug}'),
                    padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
                    decoration: BoxDecoration(color: online ? C.marigold : C.maroon, borderRadius: BorderRadius.circular(999)),
                    child: Text(actionLabel(reel), style: t(15, color: online ? C.deep : C.white, w: FontWeight.w800)),
                  ),
                ]),
              ),
            ]),
          ),
        ),
      ),
    );
  }
}
