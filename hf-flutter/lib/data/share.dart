import 'package:flutter/foundation.dart';
import 'package:share_plus/share_plus.dart';

import '../core/brand.dart';

/// The public link for a reel. The domain comes from [Brand] (Specs/brand.json), never typed here.
String reelShareUrl(String reelId) => Brand.url('/r/$reelId');

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
}
