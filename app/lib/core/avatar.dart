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

  /// [AVATAR-WARM-1] The ONE circle both states are drawn into. The initials
  /// state used to draw a 2px border while the resolved photo was a bare
  /// ClipOval, so the ring vanished the instant the photo landed — a visible
  /// second "settle" on top of the initials→photo swap. Both states now use this
  /// identical box (same outer [size], same border, same clip), so when a swap
  /// does still happen only the fill changes.
  Widget _circle({Color? fill, Widget? child}) => Container(
        width: size,
        height: size,
        decoration: BoxDecoration(
          color: fill,
          shape: BoxShape.circle,
          // [AVATAR-NORING-1 2026-08-21] Was `AD.borderHairline` — full ink.
          // Every avatar in the app therefore carried its OWN black ring even
          // before a caller wrapped it in one, so retiring only the ~36 caller
          // rings would have left a black ring on every single avatar and
          // looked like the change had not worked.
          //
          // Repointed to `AD.borderAvatar` (now transparent) rather than
          // deleted: this Container has an explicit width/height of `size`, so
          // the border is INSIDE the box. Keeping a 2px transparent border
          // preserves the exact photo crop and circle size; removing it would
          // let the photo grow 4px and re-crop every avatar in the app.
          border: Border.all(color: AD.borderAvatar, width: 2),
        ),
        clipBehavior: Clip.antiAlias,
        alignment: Alignment.center,
        child: child,
      );

  Widget get _initialsText => Text(_initials,
      style: TextStyle(
          fontFamily: ADText.family,
          color: AD.selfAvatarInk,
          fontWeight: FontWeight.w600,
          fontSize: size * 0.38));

  Widget _initialsCircle() {
    // Deterministic dark-v2 avatar family for this seed — the SAME rotation the
    // groups tab and the chat rows already use, so one person is one colour
    // everywhere. The `solid` variants are mid-dark, so the initials are always
    // white (the old "white only on coral" rule belonged to the pale palette).
    return _circle(fill: AD.family(seed).solid, child: _initialsText);
  }

  /// Fallback for a decode failure INSIDE [_photoCircle]: the outer bordered box
  /// is already drawn, so this fills it rather than nesting a second circle
  /// (which would double the border and shrink the avatar).
  Widget _initialsInner() => Container(
        color: AD.family(seed).solid,
        alignment: Alignment.center,
        child: _initialsText,
      );

  /// The photo state. Same box as [_initialsCircle]; [gaplessPlayback] keeps the
  /// previous frame on screen if the source ever swaps (cache → fresh file)
  /// instead of blanking to the fill for a frame.
  Widget _photoCircle(File f) => _circle(
        child: Image.file(f,
            width: size,
            height: size,
            fit: BoxFit.cover,
            gaplessPlayback: true,
            errorBuilder: (_, __, ___) => _initialsInner()),
      );

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
    // [AVATAR-WARM-1] `_mem` is now WARMED FROM DISK at boot (AvatarCache.warm()),
    // so this hits on the very first frame of a cold launch for any avatar already
    // cached — not just ones re-resolved later in the same session. That is what
    // stops the chat list painting initials and popping to photos one by one.
    final warm = AvatarCache.peek(url, px);
    if (warm != null) return _photoCircle(warm);
    return FutureBuilder<File?>(
      future: AvatarCache.get(url, px),
      builder: (context, snap) {
        final f = snap.data;
        if (f == null) return _initialsCircle(); // placeholder while loading / on failure
        return _photoCircle(f);
      },
    );
  }
}
