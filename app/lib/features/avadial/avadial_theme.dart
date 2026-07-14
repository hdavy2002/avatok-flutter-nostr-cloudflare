import 'package:flutter/material.dart';

import '../../core/ui/avatok_dark.dart';

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
  // There are four search bars (Contacts and Messages keep their own inline
  // copies alongside the shared `_AvaDialSearchBar` used by Call logs + Block
  // list) — they all style off these three, so keep them here rather than
  // hardcoding Colors.white in four places and letting them drift.
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

  static const double radius = 18;
  static const double radiusSm = 12;

  static TextStyle title({double size = 18, Color color = text}) => TextStyle(
        fontFamily: 'Nunito',
        fontSize: size,
        height: 1.1,
        fontWeight: FontWeight.w800,
        color: color,
        letterSpacing: -0.2,
      );

  static TextStyle value({double size = 15.5, Color color = text, FontWeight weight = FontWeight.w600}) =>
      TextStyle(fontSize: size, height: 1.15, fontWeight: weight, color: color);

  static TextStyle sub({double size = 13, Color color = textSoft}) =>
      TextStyle(fontSize: size, height: 1.2, fontWeight: FontWeight.w500, color: color);

  static TextStyle tag({double size = 10.5, Color color = text}) => TextStyle(
        fontFamily: 'Nunito',
        fontSize: size,
        fontWeight: FontWeight.w800,
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
          borderRadius: BorderRadius.circular(100),
          border: Border.all(color: color.withValues(alpha: 0.55), width: 1),
        ),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          if (icon != null) ...[
            Icon(icon, size: 11, color: color),
            const SizedBox(width: 3),
          ],
          Text(label, style: tag(size: 9.5, color: color)),
        ]),
      );
}
