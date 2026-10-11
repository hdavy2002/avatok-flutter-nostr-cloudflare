import 'package:flutter/material.dart';

import '../../../../core/theme/hf_theme.dart';
import '../../../../core/widgets/widgets.dart';
import '../../../demo/demo_data.dart'; // [HF-DEMO] remove with lib/features/demo
import '../../../demo/demo_widgets.dart'; // [HF-DEMO] remove with lib/features/demo
import '../../data/host_profile.dart';
import '../../host_profile_strings.dart';
import 'profile_common.dart';

/// Name + verified badge + presence pill, the tagline, and the three-stat strip (rating, talked to, regulars).
/// [onReviews] makes the rating cell jump to the reviews section.
class ProfileHeader extends StatelessWidget {
  const ProfileHeader({super.key, required this.profile, this.onReviews});

  final HostProfile profile;
  final VoidCallback? onReviews;

  @override
  Widget build(BuildContext context) {
    final dark = HfBrightness.isDark(context);
    final big = profileBigText(context, 1.4);
    final name = Wrap(
      spacing: HfSpacing.sm,
      runSpacing: HfSpacing.xs,
      crossAxisAlignment: WrapCrossAlignment.center,
      children: [
        Semantics(
          header: true,
          child: Text(
            profile.displayName,
            style: HfText.of(context, HfText.hero),
          ),
        ),
        const HfVerifiedBadge(size: 24),
        if (isDemoSlug(profile.slug))
          const DemoChip(), // [HF-DEMO] remove with lib/features/demo
      ],
    );
    final pill = HfStatusPill(status: HfPresence.fromApi(profile.status.name));
    final tagline = profile.tagline;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (big) ...[
          name,
          const SizedBox(height: HfSpacing.sm),
          Align(alignment: Alignment.centerLeft, child: pill),
        ] else
          Row(
            crossAxisAlignment: CrossAxisAlignment.center,
            children: [
              Expanded(child: name),
              const SizedBox(width: HfSpacing.sm),
              pill,
            ],
          ),
        if (tagline != null) ...[
          const SizedBox(height: HfSpacing.sm),
          Text(
            tagline,
            style: HfText.body.copyWith(
              color: dark ? HfColors.mutedSoft : HfColors.inkTagline,
            ),
          ),
        ],
        const SizedBox(height: kProfileGap),
        _StatStrip(profile: profile, onReviews: onReviews),
      ],
    );
  }
}

class _StatStrip extends StatelessWidget {
  const _StatStrip({required this.profile, this.onReviews});

  final HostProfile profile;
  final VoidCallback? onReviews;

  @override
  Widget build(BuildContext context) {
    final rating = profile.rating;
    final hasRating = profile.reviewCount > 0 && rating != null;
    final divider = Container(width: 1, color: profileLine(context));
    return Container(
      padding: const EdgeInsets.symmetric(vertical: HfSpacing.lg),
      decoration: profileBox(context),
      child: IntrinsicHeight(
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Expanded(
              child: _Stat(
                value: hasRating
                    ? '★ ${rating.toStringAsFixed(1)}'
                    : HostProfileStrings.newLabel,
                caption: hasRating
                    ? HostProfileStrings.reviewCount(profile.reviewCount)
                    : HostProfileStrings.hostWord,
                onTap: hasRating ? onReviews : null,
              ),
            ),
            divider,
            Expanded(
              child: _Stat(
                value: '${profile.talkedTo}',
                caption: HostProfileStrings.talkedTo,
              ),
            ),
            divider,
            Expanded(
              child: _Stat(
                value: '${profile.regulars}',
                caption: HostProfileStrings.regulars,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _Stat extends StatelessWidget {
  const _Stat({required this.value, required this.caption, this.onTap});

  final String value;
  final String caption;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final body = Padding(
      padding: const EdgeInsets.symmetric(horizontal: HfSpacing.xs),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Text(
            value,
            textAlign: TextAlign.center,
            style: HfText.of(context, HfText.section),
          ),
          const SizedBox(height: 2),
          Text(
            caption,
            textAlign: TextAlign.center,
            style: HfText.label.copyWith(
              fontWeight: FontWeight.w400,
              color: profileMuted(context),
            ),
          ),
        ],
      ),
    );
    return Semantics(
      button: onTap != null,
      label: '$value $caption',
      excludeSemantics: true,
      child: onTap == null ? body : InkWell(onTap: onTap, child: body),
    );
  }
}
