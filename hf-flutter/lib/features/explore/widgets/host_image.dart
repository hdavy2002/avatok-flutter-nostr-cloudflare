import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';

import '../../../core/brand.dart';
import '../../../core/theme/hf_tokens.dart';

/// Cloudflare image resizing, the same rule the website uses (web/src/lib/config.ts `cfImage`):
/// only our own public media is transformed; signed, private, svg and gif URLs are left alone.
/// Width snaps to a few sizes so the image cache does not split per pixel. WebP, because every Android decodes it.
const List<int> kImageWidths = <int>[48, 96, 160, 256, 420, 640, 900, 1280];

String resizedImageUrl(String url, {required double width, int quality = 60}) {
  try {
    final u = Uri.parse(url);
    if (!(u.scheme == 'https' || u.scheme == 'http')) return url;
    final host = u.host;
    final ours = host == Brand.domain ||
        host.endsWith('.${Brand.domain}') ||
        host == Brand.apiHost ||
        host == Brand.mediaHost;
    if (!ours || u.userInfo.isNotEmpty || u.hasQuery || u.fragment.isNotEmpty) return url;
    final path = u.path;
    if (path.startsWith('/cdn-cgi/image/')) return url;
    if (RegExp(r'(?:^|/)(?:private|private-read|api|verification)(?:/|$)', caseSensitive: false).hasMatch(path)) return url;
    if (RegExp(r'\.(?:svg|gif)$', caseSensitive: false).hasMatch(path)) return url;
    final w = kImageWidths.firstWhere((v) => v >= width, orElse: () => kImageWidths.last);
    final port = u.hasPort ? ':${u.port}' : '';
    return '${u.scheme}://$host$port/cdn-cgi/image/format=webp,quality=$quality,width=$w,fit=cover$path';
  } catch (_) {
    return url;
  }
}

/// A host's picture: cached on disk for 7 days (cached_network_image), resized by Cloudflare, decoded at
/// the size it is shown. No picture, or one that fails, shows a soft lilac tile with a person icon.
class HostAvatar extends StatelessWidget {
  const HostAvatar({super.key, required this.url, required this.size, this.radius = HfRadius.card, this.aiLabel});

  final String? url;
  final double size;
  final double radius;

  /// A band along the bottom of the picture (HF-AVA-1: "AI picture"). 14 sp, never hidden.
  final String? aiLabel;

  @override
  Widget build(BuildContext context) {
    final dpr = MediaQuery.devicePixelRatioOf(context);
    final px = (size * dpr).round();
    final source = url;
    final placeholder = Container(
      width: size,
      height: size,
      color: HfColors.lilac,
      alignment: Alignment.center,
      child: Icon(Icons.person_rounded, size: size * 0.5, color: HfColors.orchid),
    );
    final label = aiLabel;
    return ClipRRect(
      borderRadius: BorderRadius.circular(radius),
      child: SizedBox(
        width: size,
        height: size,
        child: Stack(
          fit: StackFit.expand,
          children: [
            if (source == null)
              placeholder
            else
              CachedNetworkImage(
                imageUrl: resizedImageUrl(source, width: size * dpr),
                width: size,
                height: size,
                fit: BoxFit.cover,
                memCacheWidth: px,
                fadeInDuration: const Duration(milliseconds: 150),
                placeholder: (_, __) => placeholder,
                errorWidget: (_, __, ___) => placeholder,
              ),
            if (label != null)
              Positioned(
                left: 0,
                right: 0,
                bottom: 0,
                child: Container(
                  color: const Color(0xEBF2EFFF), // lilac, a little see-through
                  padding: const EdgeInsets.symmetric(vertical: 3),
                  child: Text(
                    label,
                    textAlign: TextAlign.center,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: HfText.badge.copyWith(color: HfColors.orchid),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}
