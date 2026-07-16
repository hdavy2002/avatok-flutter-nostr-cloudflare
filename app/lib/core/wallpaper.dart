import 'package:flutter/material.dart';

import 'ui/bubble_theme.dart';

/// Chat wallpaper presets.
///
/// Owner decision 2026-07-17: the thread canvas default is now WHITE
/// ([kChatCanvas]), to match the new pale-bubble-on-white bubble system (see
/// `core/ui/bubble_theme.dart`) — every bubble kind gets a pale fill + hairline
/// border designed against a white backdrop, so a near-black canvas behind them
/// would kill the contrast those borders exist for. The other presets stay as
/// SELECTABLE dark tints (unchanged) so a user who already picked one keeps it
/// — this file only flips which entry `wallpaperGradient(null)` resolves to.
///
/// [CHAT-BG-CONTRAST-1] (owner report 2026-07-16, pic 3) is now superseded:
/// that fix made the dark 'default' a lighter grey than the header/footer
/// bands so the composer had a visible edge against a dark canvas. On white,
/// the composer/header bands (AD.headerFooter, near-black) contrast against
/// the canvas by construction, so that concern no longer applies to 'default'.
///
/// SANITY CHECK (asked for in [AVAGRP-CARDS-1]): 'teal'/'sunset'/'forest'/
/// 'lavender'/'sky' are still near-black tints (0x0E–0x15 range). Pale bubbles
/// + hairline borders were tuned for kChatCanvas (white) — on these dark
/// wallpapers the SAME pale bubbles still read fine (that's exactly what they
/// looked like before this change, since 'default' used to be dark too), but
/// the white day-separator pill / system pill colours introduced alongside
/// the new bubble system (kChatSysPillBg, kChatCanvasInk/Meta — pale-on-white)
/// will be LOW CONTRAST on these dark presets: a near-white pill on a
/// near-black wallpaper is fine, but pale-grey system-pill TEXT on a
/// near-black wallpaper is not. Flagging rather than silently deleting these
/// presets, per instructions — Agent A (chat_thread.dart, owns the picker and
/// the system-pill rendering) should decide whether the pill needs a
/// per-wallpaper ink override or whether the 5 dark presets should be retired.
const Map<String, List<Color>> kWallpapers = {
  'default': [kChatCanvas, kChatCanvas], // white — the new canvas default
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

/// [AVAGRP-BUBBLE-2] Answering the SANITY CHECK left above: every non-'default'
/// preset is still a near-black tint, so any system/day-pill colour tuned for
/// [kChatCanvas] (white) needs to know when it's sitting on one of these
/// instead. Decision (owner asked for a white DEFAULT canvas; these 5 presets
/// are pre-existing choices, not the product direction going forward): adapt
/// the pill colours per-wallpaper (see chat_thread.dart's `_sysPill*` getters)
/// rather than retire the presets outright — cheaper than a parallel dark
/// bubble system and doesn't strand anyone who already picked teal/sunset/
/// forest/lavender/sky.
const Set<String> kDarkWallpaperIds = {'teal', 'sunset', 'forest', 'lavender', 'sky'};

/// True for every preset except the white 'default' (and any unknown id,
/// which falls back to 'default' in [wallpaperGradient]).
bool wallpaperIsDark(String? id) => kDarkWallpaperIds.contains(id);
