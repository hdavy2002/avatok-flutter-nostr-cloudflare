import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/theme/hf_tokens.dart';

/// Draws a picture from a URL. The default uses `cached_network_image` (7-day disk cache, memory cache sized
/// to the screen). Widget tests override [hostImageBuilderProvider] with a plain box, so no test needs
/// the network or the cache database.
typedef HostImageBuilder = Widget Function(BuildContext context, String url, {BoxFit fit});

final hostImageBuilderProvider = Provider<HostImageBuilder>((ref) => _cachedImage);

Widget _cachedImage(BuildContext context, String url, {BoxFit fit = BoxFit.cover}) {
  return CachedNetworkImage(
    imageUrl: url,
    fit: fit,
    memCacheWidth: 900,
    fadeInDuration: const Duration(milliseconds: 150),
    placeholder: (_, __) => const PicturePlaceholder(),
    errorWidget: (_, __, ___) => const PicturePlaceholder(),
  );
}

/// Shown while a picture loads, when it fails, and when a host has none.
class PicturePlaceholder extends StatelessWidget {
  const PicturePlaceholder({super.key, this.icon = Icons.person_rounded});

  final IconData icon;

  @override
  Widget build(BuildContext context) {
    return Container(
      color: HfColors.lilac,
      alignment: Alignment.center,
      child: Icon(icon, size: 72, color: HfColors.orchid),
    );
  }
}
