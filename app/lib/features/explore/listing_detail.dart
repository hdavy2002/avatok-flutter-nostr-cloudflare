import 'package:flutter/material.dart';

import '../../core/listings_api.dart';
import '../../core/ui/avatok_dark.dart';
import 'native_listing_detail_v2.dart';

/// Single native entry point for every listing route in the app.
/// The former monolithic detail page and its WebView dispatch are retired.
class ListingDetailScreen extends StatelessWidget {
  const ListingDetailScreen(
      {super.key, required this.listingId, this.source = 'unknown'});
  final String listingId;
  final String source;

  @override
  Widget build(BuildContext context) =>
      NativeListingDetailV2(listingId: listingId, source: source);
}

/// Compact preview used by the creator wizard; it is not the buyer details
/// page and shares no implementation with the retired detail screen.
class ListingDetailView extends StatelessWidget {
  const ListingDetailView({super.key, required this.card});
  final ListingCard card;

  @override
  Widget build(BuildContext context) => NativeListingPreview(card: card);
}

class ReviewTile extends StatelessWidget {
  const ReviewTile({super.key, required this.review});
  final ListingReview review;

  @override
  Widget build(BuildContext context) => ListTile(
        dense: true,
        leading: Text('★' * review.rating,
            style: const TextStyle(color: AD.haldi)),
        title: Text(review.body.isEmpty ? 'Verified booking' : review.body),
        subtitle: Text(review.authorName ?? 'AvaTOK member'),
      );
}
