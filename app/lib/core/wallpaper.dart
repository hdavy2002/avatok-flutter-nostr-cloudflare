import 'package:flutter/material.dart';

/// Chat wallpaper presets (light gradients so bubble text stays readable).
const Map<String, List<Color>> kWallpapers = {
  'default': [Color(0xFFF4F5F7), Color(0xFFF4F5F7)],
  'teal': [Color(0xFFE2F7F4), Color(0xFFD3ECFB)],
  'sunset': [Color(0xFFFFEBD9), Color(0xFFFFD9E3)],
  'forest': [Color(0xFFE6F3E2), Color(0xFFD8EAD2)],
  'lavender': [Color(0xFFEDE7FB), Color(0xFFF3E1F0)],
  'sky': [Color(0xFFE3F0FF), Color(0xFFEAF7FF)],
};

const List<String> kWallpaperOrder = ['default', 'teal', 'sunset', 'forest', 'lavender', 'sky'];

LinearGradient wallpaperGradient(String? id) {
  final colors = kWallpapers[id] ?? kWallpapers['default']!;
  return LinearGradient(colors: colors, begin: Alignment.topCenter, end: Alignment.bottomCenter);
}
