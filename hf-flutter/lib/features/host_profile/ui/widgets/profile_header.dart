import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/format/money.dart';
import '../../../../core/theme/hf_tokens.dart';
import '../../../../core/widgets/widgets.dart';
import '../../data/host_profile.dart';
import '../../host_profile_strings.dart';
import 'net_image.dart';

/// A readable pill label for languages, topics and server-provided badges.
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
    final picture = Semantics(image: true,
      label: '${profile.displayName}, ${HostProfileStrings.aiAvatarAlt}', excludeSemantics: true,
      child: ClipRRect(borderRadius: BorderRadius.circular(26),
        child: SizedBox(width: 156, height: 178,
          child: Stack(fit: StackFit.expand, children: [
            if (avatar != null) image(context, avatar, fit: BoxFit.cover) else const PicturePlaceholder(),
            const Positioned(left: 8, right: 8, bottom: 8,
              child: Align(alignment: Alignment.bottomLeft, child: AiLabel())),
          ]))));
    final identity = Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Semantics(header: true, child: Text(profile.displayName, style: HfText.hero)),
      const SizedBox(height: 10),
      StatusPill(presence: profile.status),
      if (profile.tagline != null) ...[
        const SizedBox(height: 10), Text(profile.tagline!, style: HfText.bodyText)],
    ]);
    return HfCard(padding: const EdgeInsets.all(16),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        LayoutBuilder(builder: (context, c) {
          if (c.maxWidth<320 || MediaQuery.textScalerOf(context).scale(16)>22) {
            return Column(crossAxisAlignment: CrossAxisAlignment.start,
              children: [picture, const SizedBox(height: 16), identity]);
          }
          return Row(crossAxisAlignment: CrossAxisAlignment.start,
            children: [picture, const SizedBox(width: 16), Expanded(child: identity)]);
        }),
        const SizedBox(height: 18),
        Wrap(spacing: 16, runSpacing: 10, children: [
          _RatingLine(profile: profile),
          if (profile.languages.isNotEmpty) Text(profile.languages.join(' · '), style: HfText.bodyText),
        ]),
        const SizedBox(height: 18),
        Container(padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(color: HfColors.cream, borderRadius: BorderRadius.circular(22)),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('${Money.rupees(price)}/min', style: HfText.title),
            const SizedBox(height: 4),
            if (est != null && est.isTokens && est.aboutText != null)
              Text(est.aboutText!, style: HfText.note)
            else const Text('See your estimate before starting a call.', style: HfText.note),
          ])),
        if (badges.isNotEmpty) ...[
          const SizedBox(height: 14), Wrap(spacing: 8, runSpacing: 8, children: badges)],
      ]));
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
      child: Wrap(
        spacing: 4,
        runSpacing: 4,
        crossAxisAlignment: WrapCrossAlignment.center,
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
