import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/theme/hf_theme.dart';
import '../../../core/widgets/widgets.dart';
import '../data/host_card.dart';
import 'host_card_view.dart';
import 'host_image.dart';

/// Compact marketplace card used by the horizontal Explore rails.
class MarketplaceHostTile extends ConsumerWidget {
  const MarketplaceHostTile({
    super.key,
    required this.host,
    required this.from,
    this.lane,
  });

  final HostCard host;
  final String from;
  final String? lane;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final dark = HfBrightness.isDark(context);
    final muted = dark ? HfColors.mutedSoft : HfColors.muted;
    final open = () =>
        openHostProfile(context, ref, host, from: from, lane: lane);
    final wave = hostWaveHeights(host.slug, count: 15);

    return Semantics(
      button: true,
      label: 'Open ${host.displayName}’s profile',
      child: Material(
        color: dark ? HfColors.darkCard : HfColors.white,
        borderRadius: BorderRadius.circular(HfRadius.card),
        elevation: dark ? 0 : 2,
        shadowColor: HfColors.ink.withValues(alpha: 0.08),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: open,
          child: Padding(
            padding: const EdgeInsets.all(HfSpacing.md),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Stack(
                  children: [
                    HostAvatar(
                      url: host.avatarUrl,
                      size: 154,
                      radius: HfRadius.cardInner,
                      aiLabel: host.isAiAvatar ? kAiPictureLabel : null,
                    ),
                    Positioned(
                      top: HfSpacing.sm,
                      left: HfSpacing.sm,
                      child: HfStatusPill(
                        status: switch (host.status) {
                          HostPresence.online => HfPresence.online,
                          HostPresence.busy => HfPresence.busy,
                          HostPresence.offline => HfPresence.offline,
                        },
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: HfSpacing.md),
                Row(
                  children: [
                    Expanded(
                      child: Text(
                        host.displayName,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: HfText.of(context, HfText.subsection),
                      ),
                    ),
                    const SizedBox(width: HfSpacing.xs),
                    const HfVerifiedBadge(size: 18),
                  ],
                ),
                if (host.tagline != null) ...[
                  const SizedBox(height: 3),
                  Text(
                    host.tagline!,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: HfText.label.copyWith(
                      color: muted,
                      fontWeight: FontWeight.w400,
                    ),
                  ),
                ],
                const Spacer(),
                if (host.hasIntro) ...[
                  Row(
                    children: [
                      IntroPlayButton(host: host, from: from),
                      const SizedBox(width: HfSpacing.sm),
                      Expanded(
                        child: SizedBox(
                          height: 30,
                          child: Row(
                            crossAxisAlignment: CrossAxisAlignment.center,
                            children: [
                              for (final height in wave)
                                Expanded(
                                  child: Align(
                                    alignment: Alignment.center,
                                    child: Container(
                                      width: 2,
                                      height: 6 + (height * 0.16),
                                      decoration: BoxDecoration(
                                        color: muted.withValues(alpha: 0.55),
                                        borderRadius: BorderRadius.circular(2),
                                      ),
                                    ),
                                  ),
                                ),
                            ],
                          ),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: HfSpacing.sm),
                ],
                Row(
                  children: [
                    Expanded(
                      child: Text(
                        host.priceLabel,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: HfText.bodyStrong.copyWith(
                          color: dark ? HfColors.darkText : HfColors.ink,
                        ),
                      ),
                    ),
                    if (host.reviewCount > 0 && host.rating != null)
                      Text(
                        '★ ${host.rating!.toStringAsFixed(1)}',
                        style: HfText.badge.copyWith(color: HfColors.star),
                      ),
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
