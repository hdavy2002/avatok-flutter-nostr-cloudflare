import 'package:flutter/material.dart';

import '../../core/ui/avatok_dark.dart';
import '../../core/ui/messenger_theme.dart';

/// The Calls (AvaDial) app is a DARK surface, top to bottom (owner request
/// 2026-07-12) — Contacts, Logs, Messages, Block Lists, the dialpad, contact
/// edit/history screens and the PSTN call screens (phase 5) all use this
/// palette. Migrated to the AvaTOK Dark v2 language ([AD]) — near-black
/// surfaces, hairline borders, multicolor glyph accents — so Calls reads as
/// part of AvaVerse instead of a bolted-on separate app. There is no
/// per-subtree Flutter `Theme`/`ThemeData` override anywhere else in the app
/// (see shell_v2.dart / core/theme.dart, which is light-only), so — like
/// AvaPhone — this is a plain constants class screens style against directly,
/// not a `ThemeData`.
class AvaDialTheme {
  AvaDialTheme._();

  // Surfaces (dark) — AD dark v2 tokens, shared with PhoneTheme for visual
  // consistency across AvaVerse's two dark surfaces.
  static const bg = AD.bg;
  static const surface = AD.card;
  static const surface2 = AD.cardHover;
  static const border = AD.borderControl;

  // Text on dark.
  static const text = AD.textPrimary;
  static const textSoft = AD.textSecondary;
  static const textMute = AD.textTertiary;

  // [AVADIAL-SEARCH-2] Search input — owner spec 2026-07-14: a WHITE pill with
  // black text, deliberately breaking the dark palette above so the input reads
  // as tappable/active against the near-black tabs. These are the ONLY light
  // tokens in Calls; do not reuse them for anything but the search bars.
  //
  // There are five search inputs: the shared `_AvaDialSearchBar` (Call logs +
  // Block list), Contacts' and Messages' own inline pills, and the dialpad's
  // outlined field (dialpad_search_tab.dart — different shape, same colours).
  // They all style off these three, so keep them here rather than hardcoding
  // Colors.white in five places and letting them drift.
  static const searchFill = Colors.white;
  static const searchText = Colors.black;
  static const searchHint = Colors.black54;

  // Accents reuse the AD dark v2 glyph/status tokens (contact/log row colors,
  // tab strip fills, PSTN caller-id colors) so Calls stays on-brand.
  static const contact = AD.online;      // known contact / outgoing
  static const spam = AD.danger;         // spam / missed / blocked
  static const unknown = AD.iconSearch;  // unrecognised caller
  static const accent = AD.primaryBadge; // primary action (call button)
  static const lilac = AD.iconVideo;     // messages / AI

  // [UI-DS-SWEEP-1 2026-08-05] Radii now come off the Msg scale (8/12/16).
  // These two names are kept as thin aliases so the ~40 call sites across
  // Calls keep compiling; only the VALUES changed (18 -> 16, 12 -> 12).
  static const double radius = Msg.rLg;
  static const double radiusSm = Msg.rMd;

  // [UI-DS-SWEEP-1 2026-08-05] Type folded onto the ADText weights. w800 is
  // gone everywhere: titles are 700, names/tags 600, body 400/500. Sizes are
  // whole numbers — the old half-pixel defaults were eyeball tuning.
  static TextStyle title({double size = 18, Color color = text}) => TextStyle(
        fontFamily: ADText.family,
        fontSize: size,
        height: 1.1,
        fontWeight: FontWeight.w700,
        color: color,
        letterSpacing: -0.2,
      );

  static TextStyle value({double size = 15, Color color = text, FontWeight weight = FontWeight.w600}) =>
      TextStyle(fontFamily: ADText.family, fontSize: size, height: 1.15, fontWeight: weight, color: color);

  static TextStyle sub({double size = 13, Color color = textSoft}) =>
      TextStyle(fontFamily: ADText.family, fontSize: size, height: 1.2, fontWeight: FontWeight.w400, color: color);

  static TextStyle tag({double size = 11, Color color = text}) => TextStyle(
        fontFamily: ADText.family,
        fontSize: size,
        fontWeight: FontWeight.w600,
        letterSpacing: 0.4,
        color: color,
      );

  static Widget ring(Widget child, {Color color = border, double width = 2}) => Container(
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          border: Border.all(color: color, width: width),
        ),
        child: child,
      );

  static Widget chip(String label, {Color color = unknown, IconData? icon}) => Container(
        padding: EdgeInsets.fromLTRB(icon == null ? 9 : 7, 3, 9, 3),
        decoration: BoxDecoration(
          color: color.withValues(alpha: 0.16),
          // Genuine status pill — one of the shapes rPill is reserved for.
          borderRadius: Msg.brPill,
          border: Border.all(color: color.withValues(alpha: 0.55), width: 1),
        ),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          if (icon != null) ...[
            Icon(icon, size: 11, color: color),
            const SizedBox(width: Msg.s1),
          ],
          Text(label, style: tag(size: 11, color: color)),
        ]),
      );
}
