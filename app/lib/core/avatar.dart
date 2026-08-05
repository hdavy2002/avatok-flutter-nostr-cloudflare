import 'dart:io';

import 'package:flutter/material.dart';

import 'avatar_cache.dart';
import 'ui/avatok_dark.dart';

/// Avatar: shows the user's uploaded photo (cached, Cloudflare AVIF/q60) when
/// [avatarUrl] is set, otherwise a deterministic flat accent fill with initials
/// (bordered circle, flat colour — no gradients).
class Avatar extends StatelessWidget {
  final String seed;
  final String name;
  final double size;
  final String? avatarUrl; // canonical blossom URL; null/empty → initials
  const Avatar({super.key, required this.seed, required this.name, this.size = 44, this.avatarUrl});

  String get _initials {
    final parts = name.trim().split(' ').where((p) => p.isNotEmpty).toList();
    if (parts.isEmpty) return '?';
    if (parts.length == 1) return parts.first.substring(0, 1).toUpperCase();
    return (parts.first.substring(0, 1) + parts.last.substring(0, 1)).toUpperCase();
  }

  Widget _initialsCircle() {
    // Deterministic dark-v2 avatar family for this seed — the SAME rotation the
    // groups tab and the chat rows already use, so one person is one colour
    // everywhere. The `solid` variants are mid-dark, so the initials are always
    // white (the old "white only on coral" rule belonged to the pale palette).
    final fill = AD.family(seed).solid;
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        color: fill,
        shape: BoxShape.circle,
        border: Border.all(color: AD.borderHairline, width: 2),
      ),
      alignment: Alignment.center,
      child: Text(_initials,
          style: TextStyle(
              fontFamily: ADText.family,
              color: AD.selfAvatarInk,
              fontWeight: FontWeight.w600,
              fontSize: size * 0.38)),
    );
  }

  @override
  Widget build(BuildContext context) {
    final url = avatarUrl;
    if (url == null || url.isEmpty) return _initialsCircle();
    // Request roughly 2x the display size for crisp rendering on hi-dpi screens.
    final px = (size * 2).round().clamp(64, 512);
    // [AVATAR-MEM-CACHE] (AVA-UI-CACHE) If this URL+size was already resolved this
    // session, render the photo SYNCHRONOUSLY on the first frame — no FutureBuilder
    // waiting state, no initials-then-photo pop-in as a chat list paints. Falls
    // back to the async disk/network path only on a genuinely cold avatar.
    final warm = AvatarCache.peek(url, px);
    if (warm != null) {
      return ClipOval(child: Image.file(warm, width: size, height: size, fit: BoxFit.cover,
          errorBuilder: (_, __, ___) => _initialsCircle()));
    }
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
