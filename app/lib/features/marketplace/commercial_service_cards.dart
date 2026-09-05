import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/avatar.dart';
import '../../core/listings_api.dart';
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/messenger_theme.dart';
import '../explore/widgets.dart' show CoverImage, RatingStars, fmtTokens, fmtWhen;
import 'listing_quick_info.dart';

String _creatorName(ListingCard card) =>
    (card.creator.name?.trim().isNotEmpty ?? false)
        ? card.creator.name!.trim()
        : (card.creator.handle?.trim().isNotEmpty ?? false)
            ? '@${card.creator.handle!.trim()}'
            : 'Creator';

/// Phase 2 commercial live-event discovery card. This is discovery UI only:
/// the public listing id may be shared, while checkout remains the server-owned
/// path that creates an account-bound entitlement.
class LiveEventCard extends StatelessWidget {
  final ListingCard card;
  final VoidCallback onTap;

  const LiveEventCard({super.key, required this.card, required this.onTap});

  @override
  Widget build(BuildContext context) {
    final live = card.status == 'live';
    return _CommercialServiceCard(
      card: card,
      lane: 'live',
      badge: live ? 'LIVE NOW' : 'UPCOMING LIVE',
      badgeColor: live ? AD.danger : AD.primaryBadge,
      meta: fmtWhen(card.startsAt),
      action: live
          ? 'Watch now'
          : card.effectivePrice <= 0
              ? 'Reserve free'
              : 'Buy ticket',
      actionIcon: live
          ? PhosphorIcons.play(PhosphorIconsStyle.fill)
          : PhosphorIcons.ticket(PhosphorIconsStyle.bold),
      onTap: onTap,
    );
  }
}

/// Phase 2 paid 1:1 consultation discovery card. Availability and payment are
/// intentionally resolved on the detail/checkout screens, never on this card.
class ConsultationCard extends StatelessWidget {
  final ListingCard card;
  final VoidCallback onTap;

  const ConsultationCard({super.key, required this.card, required this.onTap});

  @override
  Widget build(BuildContext context) {
    final duration = card.durationMin == null ? '' : '${card.durationMin} min';
    return _CommercialServiceCard(
      card: card,
      lane: 'consultation',
      badge: '1:1 CONSULTATION',
      badgeColor: AD.tabCalls,
      meta: duration,
      action: 'View available times',
      actionIcon: PhosphorIcons.calendarCheck(PhosphorIconsStyle.bold),
      onTap: onTap,
    );
  }
}

class _CommercialServiceCard extends StatelessWidget {
  final ListingCard card;
  final String lane, badge, meta, action;
  final Color badgeColor;
  final IconData actionIcon;
  final VoidCallback onTap;

  const _CommercialServiceCard({
    required this.card,
    required this.lane,
    required this.badge,
    required this.badgeColor,
    required this.meta,
    required this.action,
    required this.actionIcon,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final creator = _creatorName(card);
    return Semantics(
      button: true,
      label: '$badge, ${card.title}, by $creator, ${fmtTokens(card.effectivePrice)}',
      child: Material(
        color: AD.card,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(AD.rListCard),
          side: BorderSide(color: AD.borderControl),
        ),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: () {
            Analytics.capture('commercial_card_opened', {
              'lane': lane,
              'kind': card.kind,
              'listing_id': card.id,
              'poster_first': card.hasAiPoster,
            });
            // [POSTER-FIRST-1] On a poster card the facts are not on screen —
            // the poster only carries the title and tagline — so a tap opens
            // the quick-info sheet with the price, duration and rules, and
            // "Details" from there goes to the full page. Without a poster the
            // card still shows those facts itself, so a tap goes straight
            // through as before rather than adding a needless extra step.
            if (card.hasAiPoster) {
              showListingQuickInfo(context, card, onDetails: onTap);
            } else {
              onTap();
            }
          },
          child: SizedBox(
            width: 286,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                // [POSTER-FIRST-1 2026-09-05] A generated poster gets its true
                // 2:3 shape. Cropping it into the old 132px band would cut off
                // the painted title, which is the only thing the poster is
                // carrying — the price pill and badge stay, because those are
                // deliberately NOT on the poster and come from the row.
                AspectRatio(
                  aspectRatio: card.hasAiPoster ? 2 / 3 : 286 / 132,
                  child: Stack(children: [
                    Positioned.fill(
                      child: CoverImage(
                        url: card.posterUrl ?? card.coverUrl,
                        seed: card.id.hashCode,
                        radius: BorderRadius.zero,
                      ),
                    ),
                    // Only when the artwork is deliberately textless because
                    // the model could not be trusted to letter it.
                    if (card.hasAiPoster && card.posterNeedsLettering)
                      Positioned(
                        left: Msg.s3,
                        right: Msg.s3,
                        top: Msg.s3,
                        child: IgnorePointer(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                card.posterTitle.toUpperCase(),
                                maxLines: 3,
                                overflow: TextOverflow.ellipsis,
                                style: ADText.rowName(c: AD.onBandCream).copyWith(
                                  fontSize: 22,
                                  height: 1.05,
                                  // Never negative on display type — CLAUDE.md.
                                  letterSpacing: 1.2,
                                  fontWeight: FontWeight.w900,
                                  // Hard poster-print drop shadow. Token, not
                                  // a literal — design guard, and it must track
                                  // the ink colour if that ever changes.
                                  shadows: const [
                                    Shadow(offset: Offset(2, 2), color: AD.textPrimary),
                                  ],
                                ),
                              ),
                              if (card.posterTagline.isNotEmpty) ...[
                                const SizedBox(height: Msg.s1),
                                Text(
                                  card.posterTagline,
                                  maxLines: 2,
                                  overflow: TextOverflow.ellipsis,
                                  style: ADText.preview(c: AD.onBandCream).copyWith(
                                    fontWeight: FontWeight.w800,
                                    letterSpacing: 0.6,
                                    shadows: const [
                                      Shadow(offset: Offset(1, 1), color: AD.textPrimary),
                                    ],
                                  ),
                                ),
                              ],
                            ],
                          ),
                        ),
                      ),
                    Positioned(
                      left: Msg.s3,
                      top: Msg.s3,
                      child: Container(
                        padding: const EdgeInsets.symmetric(
                            horizontal: Msg.s3, vertical: Msg.s1),
                        decoration: BoxDecoration(
                          color: badgeColor,
                          borderRadius: Msg.brPill,
                        ),
                        child: Text(badge,
                            style: ADText.preview(c: AD.onBand(badgeColor))
                                .copyWith(fontWeight: FontWeight.w800)),
                      ),
                    ),
                    Positioned(
                      right: Msg.s3,
                      bottom: Msg.s3,
                      child: Container(
                        padding: const EdgeInsets.symmetric(
                            horizontal: Msg.s3, vertical: Msg.s1),
                        decoration: BoxDecoration(
                          color: AD.card,
                          borderRadius: Msg.brPill,
                          border: Border.all(color: AD.borderControl),
                        ),
                        child: Text(fmtTokens(card.effectivePrice),
                            style: ADText.rowName()),
                      ),
                    ),
                  ]),
                ),
                Padding(
                  padding: const EdgeInsets.all(Msg.s3),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      // [POSTER-FIRST-1] The poster already says the title, in
                      // paint. Repeating it here is the same words twice — the
                      // exact clutter the poster was meant to replace. The
                      // Semantics label above still carries it for TalkBack,
                      // because painted lettering is pixels to a screen reader.
                      if (!card.hasAiPoster) ...[
                        Text(card.title,
                            maxLines: 2,
                            overflow: TextOverflow.ellipsis,
                            style: ADText.rowName()),
                        const SizedBox(height: Msg.s2),
                      ],
                      Row(children: [
                        Avatar(
                          seed: card.creator.uid,
                          name: creator,
                          avatarUrl: card.creator.avatarUrl,
                          size: 28,
                        ),
                        const SizedBox(width: Msg.s2),
                        Expanded(
                          child: Text(creator,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: ADText.preview()),
                        ),
                        RatingStars(
                          rating: card.ratingAvg,
                          count: card.ratingCount,
                          size: 12,
                        ),
                      ]),
                      if (meta.isNotEmpty) ...[
                        const SizedBox(height: Msg.s2),
                        Text(meta,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: ADText.preview(c: AD.textSecondary)),
                      ],
                      const SizedBox(height: Msg.s3),
                      Row(children: [
                        PhosphorIcon(actionIcon, size: 17, color: AD.iconSearch),
                        const SizedBox(width: Msg.s2),
                        Expanded(
                          child: Text(action,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: ADText.preview(c: AD.iconSearch)
                                  .copyWith(fontWeight: FontWeight.w700)),
                        ),
                        PhosphorIcon(
                          PhosphorIcons.caretRight(PhosphorIconsStyle.bold),
                          size: 16,
                          color: AD.iconSearch,
                        ),
                      ]),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
