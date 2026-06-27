import 'package:flutter/material.dart';

import '../../core/ui/zine.dart';

/// AvaPhone is a DARK surface that simulates a PSTN-style phone app (dialer,
/// SMS-style inbox, contacts) while every "call"/"message" is really an
/// AvaTOK→AvaTOK in-network action (no real PSTN). The owner asked for a dark
/// theme that still speaks the zine design language, so this palette layers
/// dark surfaces UNDER the canonical zine ACCENT tokens ([Zine.lime],
/// [Zine.mint], [Zine.blue], [Zine.coral], [Zine.lilac]) — the accents, ink
/// borders, radii and Phosphor iconography all stay on-brand.
class PhoneTheme {
  // Surfaces (dark).
  static const bg = Color(0xFF0E1116);
  static const surface = Color(0xFF161A20);
  static const surface2 = Color(0xFF1E232B);
  static const border = Color(0xFF2C323B);

  // Text on dark.
  static const text = Color(0xFFF2F4F7);
  static const textSoft = Color(0xFF9AA2AD);
  static const textMute = Color(0xFF6B7480);

  // Accents reuse the zine tokens so AvaPhone reads as part of AvaVerse.
  static const accent = Zine.lime;    // primary action accent
  static const callGreen = Zine.mint; // the round "call" button
  static const teal = Zine.blue;      // info / network chips
  static const danger = Zine.coral;   // missed / spam
  static const lilac = Zine.lilac;    // assistant / receptionist

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
