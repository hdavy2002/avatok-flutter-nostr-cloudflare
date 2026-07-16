import 'package:flutter/material.dart';

/// Chat wallpaper presets — dark v2 (flat; two identical stops keep
/// `wallpaperGradient` a [LinearGradient] for type compatibility with
/// chat_thread + settings). Default is a mid-dark grey; the others are
/// subtle dark tints so the pale chat bubbles still pop.
///   default = grey conversation surface, teal/sunset/forest/lavender = dark
///   accent tints, sky = header/footer surface.
///
/// [CHAT-BG-CONTRAST-1] (owner report 2026-07-16, pic 3): 'default' used to be
/// AD.bg (0xFF0B0B0D) — only 8 levels away from the input band's AD.headerFooter
/// (0xFF131316). At that distance the composer had no visible edge: the message
/// area and the input area read as one continuous black field. The default is
/// now a distinctly LIGHTER grey than both the header and the footer bands, so
/// the conversation surface sits visibly *between* them and the composer reads
/// as its own control. 'sky' (= headerFooter) is deliberately left alone as the
/// low-contrast option for anyone who liked the old blended look.
const Map<String, List<Color>> kWallpapers = {
  'default': [Color(0xFF232329), Color(0xFF232329)], // grey — lighter than the header/input bands
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
