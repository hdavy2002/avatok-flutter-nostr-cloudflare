import 'package:flutter/material.dart';

/// Chat wallpaper presets — dark v2 (flat; two identical stops keep
/// `wallpaperGradient` a [LinearGradient] for type compatibility with
/// chat_thread + settings). Default is the app near-black; the others are
/// subtle dark tints so the pale chat bubbles still pop.
///   default = app bg, teal/sunset/forest/lavender = dark accent tints,
///   sky = header/footer surface.
const Map<String, List<Color>> kWallpapers = {
  'default': [Color(0xFF0B0B0D), Color(0xFF0B0B0D)], // AD.bg
  'teal': [Color(0xFF0E1B18), Color(0xFF0E1B18)], // dark teal tint
  'sunset': [Color(0xFF1C120C), Color(0xFF1C120C)], // dark warm tint
  'forest': [Color(0xFF0E1A12), Color(0xFF0E1A12)], // dark green tint
  'lavender': [Color(0xFF15121F), Color(0xFF15121F)], // dark lilac tint
  'sky': [Color(0xFF131316), Color(0xFF131316)], // AD.headerFooter
};

const List<String> kWallpaperOrder = ['default', 'teal', 'sunset', 'forest', 'lavender', 'sky'];

LinearGradient wallpaperGradient(String? id) {
  final colors = kWallpapers[id] ?? kWallpapers['default']!;
  return LinearGradient(colors: colors, begin: Alignment.topCenter, end: Alignment.bottomCenter);
}
