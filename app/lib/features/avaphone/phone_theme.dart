import 'package:flutter/material.dart';

import '../../core/ui/avatok_dark.dart';

/// AvaPhone is a DARK surface that simulates a PSTN-style phone app (dialer,
/// SMS-style inbox, contacts) while every "call"/"message" is really an
/// AvaTOK→AvaTOK in-network action (no real PSTN). Migrated to the AvaTOK
/// Dark v2 language ([AD]) — near-black surfaces, hairline borders, multicolor
/// glyph accents and Phosphor iconography all stay on-brand.
class PhoneTheme {
  // Surfaces (dark) — AD dark v2 tokens.
  static const bg = AD.bg;
  static const surface = AD.card;
  static const surface2 = AD.cardHover;
  static const border = AD.borderControl;

  // Text on dark.
  static const text = AD.textPrimary;
  static const textSoft = AD.textSecondary;
  static const textMute = AD.textTertiary;

  // Accents reuse the AD dark v2 glyph/status tokens so AvaPhone reads as
  // part of AvaVerse.
  static const accent = AD.primaryBadge;  // primary action accent
  static const callGreen = AD.incomingCall; // the round "call" button
  static const teal = AD.iconSearch;      // info / network chips
  static const danger = AD.danger;        // missed / spam
  static const lilac = AD.iconVideo;      // assistant / receptionist

  static const double radius = 18;
  static const double radiusSm = 12;

  // ── Text styles (mono-tag style borrowed from zine, recoloured for dark) ──
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

  /// A bordered circular avatar wrapper (zine §6: avatars sit inside a ring) —
  /// on dark the ring uses the subtle border colour instead of full ink.
  static Widget ring(Widget child, {Color color = border, double width = 2}) => Container(
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          border: Border.all(color: color, width: width),
        ),
        child: child,
      );

  /// A small pill chip (e.g. the "AvaTOK number" / "true" markers in the refs).
  static Widget chip(String label, {Color color = teal, IconData? icon}) => Container(
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
