import 'package:flutter/foundation.dart';
import 'package:share_plus/share_plus.dart';

import '../core/brand.dart';
import 'telemetry.dart';

/// The public link for a reel. The domain comes from [Brand] (Specs/brand.json), never typed here.
String reelShareUrl(String reelId) => Brand.url('/r/$reelId');

/// [HF-SHARE-APP-1] The public page of an influencer. [tracked] adds the app-share campaign tag.
String influencerPageUrl(String slug, {bool tracked = true}) =>
    Brand.url('/h/${Uri.encodeComponent(slug)}${tracked ? '?utm_source=app_share' : ''}');

/// Opens the system share sheet (HF-REEL-6 share). Tests replace [testSink] to capture the text.
abstract final class ShareSheet {
  @visibleForTesting
  static Future<void> Function(String text)? testSink;

  static Future<void> text(String text) {
    final sink = testSink;
    if (sink != null) return sink(text);
    return Share.share(text);
  }

  static Future<void> reel(String reelId, {String? caption}) =>
      text('${caption == null || caption.isEmpty ? 'Watch this on ${Brand.name}' : caption}\n${reelShareUrl(reelId)}');

  /// [HF-SHARE-APP-1] Shares an influencer's page. [own] is the influencer sharing his or her own page.
  static Future<void> influencer(String slug, String displayName, {bool own = false}) {
    Telemetry.event('profile_share_tapped', {'own': own, 'slug': slug});
    final url = influencerPageUrl(slug);
    return text(own
        ? 'Book a private call with me or shop my merch on ${Brand.name}: $url'
        : 'Talk to $displayName on a private call or shop their merch on ${Brand.name}: $url');
  }
}
