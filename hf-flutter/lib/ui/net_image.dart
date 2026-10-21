import 'dart:io' show Platform;

import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';

import 'motion.dart';

/// [HF-APP-CACHE-1] A network picture that is kept on the phone (cached_network_image's disk cache), so avatars and reel
/// thumbnails load once, not on every visit. While it loads and when it fails, [fallback] shows (initials, a plain colour).
/// Under `flutter test` it is a plain `Image.network` (the disk cache needs platform channels the tests do not have).
class NetImage extends StatelessWidget {
  const NetImage(this.url, {super.key, required this.fallback, this.fit = BoxFit.cover, this.alignment = Alignment.center});

  final String url;
  final Widget fallback;
  final BoxFit fit;
  final Alignment alignment; // CachedNetworkImage takes Alignment, not AlignmentGeometry

  /// Tests can force either path.
  static bool useCache = !Platform.environment.containsKey('FLUTTER_TEST');

  @override
  Widget build(BuildContext context) {
    if (!useCache) {
      return Image.network(url, fit: fit, alignment: alignment, errorBuilder: (_, __, ___) => fallback);
    }
    return CachedNetworkImage(
      imageUrl: url,
      fit: fit,
      alignment: alignment,
      fadeInDuration: HfMotion.duration(context, HfMotion.quick),
      fadeOutDuration: HfMotion.duration(context, HfMotion.quick),
      placeholder: (_, __) => fallback,
      errorWidget: (_, __, ___) => fallback,
    );
  }
}
