import 'package:flutter/material.dart';

import '../../../../core/theme/hf_theme.dart';
import '../../data/host_profile.dart';
import '../../data/host_profile_providers.dart';
import '../../host_profile_strings.dart';
import 'profile_common.dart';

/// "What callers say": a summary card (big rating, stars, 5-to-1 bars in the star colour), a horizontal strip of
/// review cards alternating sky and butter, and the "checked before they appear" note. The strip bleeds to the
/// screen edges, so this section pads itself instead of relying on the sheet.
class ReviewsSection extends StatelessWidget {
  const ReviewsSection({
    super.key,
    required this.profile,
    required this.topicLabels,
  });

  final HostProfile profile;
  final Map<String, String> topicLabels;

  @override
  Widget build(BuildContext context) {
    final rating = profile.rating;
    final breakdownTotal = profile.ratingBreakdown.values.fold<int>(
      0,
      (a, b) => a + b,
    );
    final total = profile.reviewCount > 0
        ? profile.reviewCount
        : breakdownTotal;
    final hasSummary = total > 0 && rating != null;
    const pad = EdgeInsets.symmetric(horizontal: kProfileSidePad);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const Padding(
          padding: pad,
          child: SectionTitle(HostProfileStrings.reviews),
        ),
        const SizedBox(height: HfSpacing.lg),
        if (!hasSummary && profile.reviews.isEmpty)
          Padding(
            padding: pad,
            child: Text(
              HostProfileStrings.noReviews,
              style: HfText.of(context, HfText.body),
            ),
          ),
        if (hasSummary)
          Padding(
            padding: pad,
            child: _Summary(
              rating: rating,
              total: total,
              breakdown: profile.ratingBreakdown,
            ),
          ),
        if (profile.reviews.isNotEmpty) ...[
          const SizedBox(height: HfSpacing.lg),
          _ReviewStrip(reviews: profile.reviews, topicLabels: topicLabels),
        ],
        if (hasSummary || profile.reviews.isNotEmpty) ...[
          const SizedBox(height: HfSpacing.lg),
          Padding(
            padding: pad,
            child: Text(
              HostProfileStrings.reviewsNote,
              style: HfText.note.copyWith(
                color: profileMuted(context),
                fontSize: 14,
              ),
            ),
          ),
        ],
      ],
    );
  }
}

class _Stars extends StatelessWidget {
  const _Stars({required this.stars});

  final int stars;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      label: '$stars out of 5 stars',
      excludeSemantics: true,
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          for (var i = 1; i <= 5; i++)
            Icon(
              i <= stars ? Icons.star_rounded : Icons.star_outline_rounded,
              size: 16,
              color: HfColors.star,
            ),
        ],
      ),
    );
  }
}

class _Summary extends StatelessWidget {
  const _Summary({
    required this.rating,
    required this.total,
    required this.breakdown,
  });

  final double rating;
  final int total;
  final Map<int, int> breakdown;

  @override
  Widget build(BuildContext context) {
    final left = Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(
          rating.toStringAsFixed(1),
          style: HfText.of(
            context,
            HfText.hero,
          ).copyWith(fontSize: 38, height: 1),
        ),
        const SizedBox(height: 2),
        _Stars(stars: rating.round()),
        const SizedBox(height: 2),
        Text(
          HostProfileStrings.reviewCount(total),
          textAlign: TextAlign.center,
          style: HfText.label.copyWith(
            fontWeight: FontWeight.w400,
            color: profileMuted(context),
          ),
        ),
      ],
    );
    final bars = Semantics(
      container: true,
      label: 'Rating breakdown',
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          for (var n = 5; n >= 1; n--) ...[
            if (n < 5) const SizedBox(height: 5),
            _BreakdownRow(stars: n, count: breakdown[n] ?? 0, total: total),
          ],
        ],
      ),
    );
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: profileBox(context, radius: 24),
      child: LayoutBuilder(
        builder: (context, c) {
          if (c.maxWidth < 300 || profileBigText(context, 1.5)) {
            return Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [left, const SizedBox(height: 12), bars],
            );
          }
          return Row(
            crossAxisAlignment: CrossAxisAlignment.center,
            children: [
              ConstrainedBox(
                constraints: const BoxConstraints(minWidth: 84),
                child: left,
              ),
              const SizedBox(width: 16),
              Expanded(child: bars),
            ],
          );
        },
      ),
    );
  }
}

class _BreakdownRow extends StatelessWidget {
  const _BreakdownRow({
    required this.stars,
    required this.count,
    required this.total,
  });

  final int stars;
  final int count;
  final int total;

  @override
  Widget build(BuildContext context) {
    final value = total <= 0 ? 0.0 : (count / total).clamp(0.0, 1.0).toDouble();
    final scaler = MediaQuery.textScalerOf(context);
    final dark = HfBrightness.isDark(context);
    final style = HfText.badge.copyWith(
      fontWeight: FontWeight.w400,
      color: profileSoftInk(context),
    );
    return Row(
      children: [
        SizedBox(
          width: scaler.scale(14),
          child: Text('$stars', style: style),
        ),
        const SizedBox(width: HfSpacing.sm),
        Expanded(
          child: ClipRRect(
            borderRadius: BorderRadius.circular(4),
            child: SizedBox(
              height: 8,
              child: Stack(
                children: [
                  Positioned.fill(
                    child: ColoredBox(
                      color: dark ? HfColors.darkTile : HfColors.segmentTrack,
                    ),
                  ),
                  FractionallySizedBox(
                    alignment: Alignment.centerLeft,
                    widthFactor: value,
                    child: const ColoredBox(
                      color: HfColors.star,
                      child: SizedBox.expand(),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
        const SizedBox(width: HfSpacing.sm),
        SizedBox(
          width: scaler.scale(22),
          child: Text('$count', textAlign: TextAlign.end, style: style),
        ),
      ],
    );
  }
}

class _ReviewStrip extends StatelessWidget {
  const _ReviewStrip({required this.reviews, required this.topicLabels});

  final List<HostReview> reviews;
  final Map<String, String> topicLabels;

  @override
  Widget build(BuildContext context) {
    final cardWidth = (MediaQuery.sizeOf(context).width * 0.76)
        .clamp(240.0, 300.0)
        .toDouble();
    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      padding: const EdgeInsets.symmetric(horizontal: kProfileSidePad),
      child: IntrinsicHeight(
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            for (var i = 0; i < reviews.length; i++) ...[
              if (i > 0) const SizedBox(width: HfSpacing.md),
              SizedBox(
                width: cardWidth,
                child: _ReviewCard(
                  review: reviews[i],
                  tint: i.isEven ? HfTint.sky : HfTint.butter,
                  topicLabels: topicLabels,
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _ReviewCard extends StatelessWidget {
  const _ReviewCard({
    required this.review,
    required this.tint,
    required this.topicLabels,
  });

  final HostReview review;
  final HfTint tint;
  final Map<String, String> topicLabels;

  @override
  Widget build(BuildContext context) {
    final meta = <String>[
      if (review.topic != null) topicLabel(topicLabels, review.topic!),
      if (review.minutes != null) '${review.minutes} min',
      if (review.regular) HostProfileStrings.regular,
    ];
    final when = review.dateLabel;
    final soft = HfText.label.copyWith(
      fontWeight: FontWeight.w400,
      color: tint.ink(context),
    );
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: tint.bg(context),
        borderRadius: BorderRadius.circular(HfRadius.tile),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Wrap(
            spacing: HfSpacing.sm,
            runSpacing: 2,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              Text(
                review.firstName,
                style: HfText.of(context, HfText.badge).copyWith(fontSize: 15),
              ),
              Semantics(
                label: '${review.stars} out of 5',
                excludeSemantics: true,
                child: Text(
                  '★' * review.stars,
                  style: HfText.badge.copyWith(color: tint.ink(context)),
                ),
              ),
              if (when.isNotEmpty) Text(when, style: soft),
            ],
          ),
          if (review.text.isNotEmpty) ...[
            const SizedBox(height: HfSpacing.md),
            Text(
              review.text,
              style: HfText.of(context, HfText.body).copyWith(fontSize: 15),
            ),
          ],
          if (meta.isNotEmpty) ...[
            const SizedBox(height: HfSpacing.md),
            Text(meta.join(' · '), style: soft),
          ],
        ],
      ),
    );
  }
}
