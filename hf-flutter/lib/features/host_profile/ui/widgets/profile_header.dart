import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/format/money.dart';
import '../../../../core/theme/hf_tokens.dart';
import '../../../../core/widgets/widgets.dart';
import '../../data/host_profile.dart';
import '../../host_profile_strings.dart';
import 'net_image.dart';

/// A small rounded label (languages, topics, badges). 14 sp or more, never green.
class HfTag extends StatelessWidget {
  const HfTag({
    super.key,
    required this.label,
    this.icon,
    this.background = HfColors.lilac,
    this.foreground = HfColors.orchid,
  });

  final String label;
  final IconData? icon;
  final Color background;
  final Color foreground;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
      decoration: BoxDecoration(color: background, borderRadius: BorderRadius.circular(HfRadius.pill)),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (icon != null) ...[
            Icon(icon, size: 16, color: foreground),
            const SizedBox(width: 6),
          ],
          Flexible(child: Text(label, style: HfText.badge.copyWith(color: foreground))),
        ],
      ),
    );
  }
}

/// Avatar with its AI label, name, tagline, status, rating, price and (signed in, token mode) the estimate.
class ProfileHeader extends ConsumerWidget {
  const ProfileHeader({super.key, required this.profile, this.estimate});

  final HostProfile profile;
  final HostEstimate? estimate;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final image = ref.watch(hostImageBuilderProvider);
    final avatar = profile.avatarUrl;
    final est = estimate;
    final price = profile.pricePerMin;
    final badges = <Widget>[
      if (profile.womenOnly)
        const HfTag(
          label: HostProfileStrings.womenOnlyBadge,
          icon: Icons.favorite_rounded,
          background: HfColors.blush,
          foreground: HfColors.rose,
        ),
      if (profile.lgbtqFriendly)
        const HfTag(label: HostProfileStrings.lgbtqBadge, icon: Icons.diversity_1_rounded),
    ];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Semantics(
          image: true,
          label: '${profile.displayName}, ${HostProfileStrings.aiAvatarAlt}',
          excludeSemantics: true,
          child: ClipRRect(
            borderRadius: BorderRadius.circular(HfRadius.card),
            child: AspectRatio(
              aspectRatio: 1,
              child: Stack(
                fit: StackFit.expand,
                children: [
                  if (avatar != null) image(context, avatar, fit: BoxFit.cover) else const PicturePlaceholder(),
                  const Positioned(left: 12, right: 12, bottom: 12, child: Align(alignment: Alignment.bottomLeft, child: AiLabel())),
                ],
              ),
            ),
          ),
        ),
        const SizedBox(height: HfSpacing.gapLarge),
        Semantics(header: true, child: Text(profile.displayName, style: HfText.headline)),
        if (profile.tagline != null) ...[
          const SizedBox(height: 6),
          Text(profile.tagline!, style: HfText.bodyText),
        ],
        const SizedBox(height: HfSpacing.gap),
        Wrap(
          spacing: 12,
          runSpacing: 8,
          crossAxisAlignment: WrapCrossAlignment.center,
          children: [
            StatusPill(presence: profile.status),
            _RatingLine(profile: profile),
          ],
        ),
        const SizedBox(height: HfSpacing.gap),
        Wrap(
          spacing: 12,
          crossAxisAlignment: WrapCrossAlignment.end,
          children: [
            Text('${Money.rupees(price)}/min', style: HfText.title),
            Text('10 min ≈ ${Money.rupees(price * 10)}', style: HfText.note),
          ],
        ),
        if (est != null && est.isTokens && est.aboutText != null) ...[
          const SizedBox(height: 4),
          Text(est.aboutText!, style: HfText.note),
        ],
        if (badges.isNotEmpty) ...[
          const SizedBox(height: HfSpacing.gap),
          Wrap(spacing: 8, runSpacing: 8, children: badges),
        ],
      ],
    );
  }
}

class _RatingLine extends StatelessWidget {
  const _RatingLine({required this.profile});

  final HostProfile profile;

  @override
  Widget build(BuildContext context) {
    final rating = profile.rating;
    if (profile.reviewCount <= 0 || rating == null) {
      return const Text(HostProfileStrings.newHost, style: HfText.bodyStrong);
    }
    final n = profile.reviewCount;
    return Semantics(
      label: '${rating.toStringAsFixed(1)} out of 5, $n ${n == 1 ? 'review' : 'reviews'}',
      excludeSemantics: true,
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Icon(Icons.star_rounded, size: 22, color: HfColors.orchid),
          const SizedBox(width: 4),
          Text(rating.toStringAsFixed(1), style: HfText.bodyStrong),
          const SizedBox(width: 6),
          Text('($n ${n == 1 ? 'review' : 'reviews'})', style: HfText.note),
        ],
      ),
    );
  }
}
