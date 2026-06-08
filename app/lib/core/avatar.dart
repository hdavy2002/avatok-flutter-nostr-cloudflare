import 'dart:io';

import 'package:flutter/material.dart';

import 'avatar_cache.dart';
import 'theme.dart';

/// Avatar: shows the user's uploaded photo (cached, Cloudflare AVIF/q60) when
/// [avatarUrl] is set, otherwise a deterministic gradient with initials.
class Avatar extends StatelessWidget {
  final String seed;
  final String name;
  final double size;
  final String? avatarUrl; // canonical blossom URL; null/empty → initials
  const Avatar({super.key, required this.seed, required this.name, this.size = 44, this.avatarUrl});

  int get _g {
    var h = 0;
    for (final c in seed.codeUnits) {
      h = (h * 31 + c) & 0x7fffffff;
    }
    return h % AvaColors.thumbGradients.length;
  }

  String get _initials {
    final parts = name.trim().split(' ').where((p) => p.isNotEmpty).toList();
    if (parts.isEmpty) return '?';
    if (parts.length == 1) return parts.first.substring(0, 1).toUpperCase();
    return (parts.first.substring(0, 1) + parts.last.substring(0, 1)).toUpperCase();
  }

  Widget _initialsCircle() => Container(
        width: size,
        height: size,
        decoration: BoxDecoration(gradient: AvaColors.thumbGradients[_g], shape: BoxShape.circle),
        alignment: Alignment.center,
        child: Text(_initials,
            style: TextStyle(color: Colors.white, fontWeight: FontWeight.w800, fontSize: size * 0.38)),
      );

  @override
  Widget build(BuildContext context) {
    final url = avatarUrl;
    if (url == null || url.isEmpty) return _initialsCircle();
    // Request roughly 2x the display size for crisp rendering on hi-dpi screens.
    final px = (size * 2).round().clamp(64, 512);
    return FutureBuilder<File?>(
      future: AvatarCache.get(url, px),
      builder: (context, snap) {
        final f = snap.data;
        if (f == null) return _initialsCircle(); // placeholder while loading / on failure
        return ClipOval(child: Image.file(f, width: size, height: size, fit: BoxFit.cover,
            errorBuilder: (_, __, ___) => _initialsCircle()));
      },
    );
  }
}
