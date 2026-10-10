import 'package:flutter/material.dart';

import '../../../../core/theme/hf_tokens.dart';
import '../../../../core/widgets/widgets.dart';
import '../../data/host_profile.dart';
import '../../data/host_profile_providers.dart';
import '../../host_profile_strings.dart';
import 'profile_header.dart';

/// Five stars, filled up to [stars]. Read aloud as "4 out of 5 stars".
class StarRow extends StatelessWidget {
  const StarRow({super.key, required this.stars, this.size = 20});

  final int stars;
  final double size;

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
              size: size,
              color: i <= stars ? HfColors.orchid : HfColors.line,
            ),
        ],
      ),
    );
  }
}

/// Rating summary (5 to 1 bars), who they have talked to, and the latest reviews: first name, stars, text.
class ReviewsSection extends StatelessWidget {
  const ReviewsSection({super.key, required this.profile, required this.topicLabels});

  final HostProfile profile;
  final Map<String, String> topicLabels;

  @override
  Widget build(BuildContext context) {
    final rating = profile.rating;
    final breakdownTotal = profile.ratingBreakdown.values.fold<int>(0, (a, b) => a + b);
    final total = profile.reviewCount > 0 ? profile.reviewCount : breakdownTotal;
    final hasReviews = total > 0 && rating != null;
    return HfCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Semantics(header: true, child: const Text(HostProfileStrings.reviews, style: HfText.title)),
          const SizedBox(height: HfSpacing.gap),
          if (!hasReviews)
            const Text(HostProfileStrings.noReviews, style: HfText.bodyText)
          else ...[
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(rating!.toStringAsFixed(1), style: HfText.hero),
                    StarRow(stars: rating!.round()),
                    const SizedBox(height: 4),
                    Text('$total ${total == 1 ? 'review' : 'reviews'}', style: HfText.note),
                  ],
                ),
                const SizedBox(width: 20),
                Expanded(
                  child: Column(
                    children: [
                      for (var n = 5; n >= 1; n--) _BreakdownRow(stars: n, count: profile.ratingBreakdown[n] ?? 0, total: total),
                    ],
                  ),
                ),
              ],
            ),
            if (profile.talkedTo > 0) ...[
              const SizedBox(height: HfSpacing.gap),
              Text(
                'Talked to ${profile.talkedTo} ${profile.talkedTo == 1 ? 'person' : 'people'}'
                '${profile.regulars > 0 ? ' · ${profile.regulars} ${profile.regulars == 1 ? 'regular' : 'regulars'}' : ''}',
                style: HfText.note,
              ),
            ],
          ],
          for (final r in profile.reviews) ...[
            const Divider(height: 28, color: HfColors.line),
            _ReviewTile(review: r, topicLabels: topicLabels),
          ],
        ],
      ),
    );
  }
}

class _BreakdownRow extends StatelessWidget {
  const _BreakdownRow({required this.stars, required this.count, required this.total});

  final int stars;
  final int count;
  final int total;

  @override
  Widget build(BuildContext context) {
    final value = total <= 0 ? 0.0 : (count / total).clamp(0.0, 1.0).toDouble();
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(
        children: [
          SizedBox(width: 22, child: Text('$stars', style: HfText.badge)),
          const Icon(Icons.star_rounded, size: 16, color: HfColors.orchid),
          const SizedBox(width: 8),
          Expanded(
            child: ClipRRect(
              borderRadius: BorderRadius.circular(6),
              child: LinearProgressIndicator(
                value: value,
                minHeight: 10,
                color: HfColors.orchid,
                backgroundColor: HfColors.lilac,
              ),
            ),
          ),
          const SizedBox(width: 8),
          SizedBox(width: 28, child: Text('$count', style: HfText.badge, textAlign: TextAlign.end)),
        ],
      ),
    );
  }
}

class _ReviewTile extends StatelessWidget {
  const _ReviewTile({required this.review, required this.topicLabels});

  final HostReview review;
  final Map<String, String> topicLabels;

  @override
  Widget build(BuildContext context) {
    final meta = <String>[
      if (review.topic != null) topicLabel(topicLabels, review.topic!),
      if (review.minutes != null) '${review.minutes} min call',
      if (review.dateLabel.isNotEmpty) review.dateLabel,
    ];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Wrap(
          spacing: 10,
          runSpacing: 6,
          crossAxisAlignment: WrapCrossAlignment.center,
          children: [
            Text(review.firstName, style: HfText.bodyStrong),
            StarRow(stars: review.stars, size: 18),
            if (review.regular)
              const HfTag(label: HostProfileStrings.regular, background: HfColors.butter, foreground: HfColors.plum),
          ],
        ),
        if (review.text.isNotEmpty) ...[
          const SizedBox(height: 6),
          Text(review.text, style: HfText.bodyText),
        ],
        if (meta.isNotEmpty) ...[
          const SizedBox(height: 6),
          Text(meta.join(' · '), style: HfText.note),
        ],
      ],
    );
  }
}
