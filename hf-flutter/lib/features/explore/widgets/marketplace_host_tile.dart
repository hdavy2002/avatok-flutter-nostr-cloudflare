import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/theme/hf_theme.dart';
import '../../../core/widgets/widgets.dart';
import '../data/host_card.dart';
import 'host_card_view.dart';
import 'host_image.dart';

/// Dense portrait card used by the marketplace rails.
///
/// The portrait, identity, rating, presence and price all remain server-owned.
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
    final wave = hostWaveHeights(host.slug, count: 9);
    final statusLabel = switch (host.status) {
      HostPresence.online => 'Online',
      HostPresence.busy => 'Busy',
      HostPresence.offline => 'Offline',
    };
    final statusColor = switch (host.status) {
      HostPresence.online => const Color(0xff24b06b),
      HostPresence.busy => const Color(0xffff9a3e),
      HostPresence.offline => muted,
    };

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
          onTap: () =>
              openHostProfile(context, ref, host, from: from, lane: lane),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Stack(
                children: [
                  AspectRatio(
                    aspectRatio: 1.18,
                    child: LayoutBuilder(
                      builder: (context, constraints) => HostAvatar(
                        url: host.avatarUrl,
                        size: constraints.maxWidth,
                        radius: 0,
                        aiLabel: host.isAiAvatar ? kAiPictureLabel : null,
                      ),
                    ),
                  ),
                  if (host.reviewCount > 0 && host.rating != null)
                    Positioned(
                      top: 8,
                      right: 8,
                      child: DecoratedBox(
                        decoration: BoxDecoration(
                          color: HfColors.white.withValues(alpha: 0.93),
                          borderRadius: BorderRadius.circular(12),
                        ),
                        child: Padding(
                          padding: const EdgeInsets.symmetric(
                            horizontal: 7,
                            vertical: 4,
                          ),
                          child: Text(
                            '★ ${host.rating!.toStringAsFixed(1)}',
                            style: HfText.badge.copyWith(color: HfColors.ink),
                          ),
                        ),
                      ),
                    ),
                  if (host.hasIntro)
                    Positioned(
                      left: 7,
                      right: 7,
                      bottom: 7,
                      child: DecoratedBox(
                        decoration: BoxDecoration(
                          color: HfColors.white.withValues(alpha: 0.92),
                          borderRadius: BorderRadius.circular(18),
                        ),
                        child: Padding(
                          padding: const EdgeInsets.fromLTRB(4, 3, 8, 3),
                          child: Row(
                            children: [
                              IntroPlayButton(
                                host: host,
                                from: from,
                                compact: true,
                              ),
                              const SizedBox(width: 5),
                              Expanded(
                                child: SizedBox(
                                  height: 20,
                                  child: Row(
                                    children: [
                                      for (final height in wave)
                                        Expanded(
                                          child: Align(
                                            alignment: Alignment.center,
                                            child: Container(
                                              width: 2,
                                              height: 4 + (height * 0.10),
                                              decoration: BoxDecoration(
                                                color: HfColors.muted
                                                    .withValues(alpha: 0.55),
                                                borderRadius:
                                                    BorderRadius.circular(2),
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
                        ),
                      ),
                    ),
                ],
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(10, 9, 10, 10),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Expanded(
                          child: Text(
                            host.displayName,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: HfText.label.copyWith(
                              color: dark ? HfColors.darkText : HfColors.ink,
                              fontWeight: FontWeight.w800,
                            ),
                          ),
                        ),
                        const SizedBox(width: 3),
                        const HfVerifiedBadge(size: 15),
                      ],
                    ),
                    const SizedBox(height: 5),
                    Row(
                      children: [
                        Container(
                          width: 7,
                          height: 7,
                          decoration: BoxDecoration(
                            color: statusColor,
                            shape: BoxShape.circle,
                          ),
                        ),
                        const SizedBox(width: 5),
                        Expanded(
                          child: Text(
                            statusLabel,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: HfText.badge.copyWith(color: muted),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 6),
                    Text(
                      host.priceLabel,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: HfText.badge.copyWith(
                        color: dark ? HfColors.darkText : HfColors.ink,
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
