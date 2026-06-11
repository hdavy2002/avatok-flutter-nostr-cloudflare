import 'package:flutter/material.dart';

/// Chat wallpaper presets — FLAT zine tints (design system: no gradients).
/// Each entry keeps two identical stops so `wallpaperGradient` can stay a
/// [LinearGradient] for type compatibility with chat_thread + settings.
/// Tints are the zine accents blended at low alpha over paper:
///   default = paper, teal = blue tint, sunset = coral tint, forest = mint
///   tint, lavender = lilac tint, sky = paper2.
const Map<String, List<Color>> kWallpapers = {
  'default': [Color(0xFFF9F7ED), Color(0xFFF9F7ED)], // Zine.paper
  'teal': [Color(0xFFE3F7EE), Color(0xFFE3F7EE)], // blue @25% over paper
  'sunset': [Color(0xFFFAE1D5), Color(0xFFFAE1D5)], // coral @15% over paper
  'forest': [Color(0xFFDFF5E0), Color(0xFFDFF5E0)], // mint @20% over paper
  'lavender': [Color(0xFFEFE7EE), Color(0xFFEFE7EE)], // lilac @22% over paper
  'sky': [Color(0xFFF4F0E3), Color(0xFFF4F0E3)], // Zine.paper2
};

const List<String> kWallpaperOrder = ['default', 'teal', 'sunset', 'forest', 'lavender', 'sky'];

LinearGradient wallpaperGradient(String? id) {
  final colors = kWallpapers[id] ?? kWallpapers['default']!;
  return LinearGradient(colors: colors, begin: Alignment.topCenter, end: Alignment.bottomCenter);
}
