import 'package:flutter/material.dart';

import '../../core/ui/zine.dart';

/// The Calls (AvaDial) app is a DARK surface, top to bottom (owner request
/// 2026-07-12) — Contacts, Logs, Messages, Block Lists, the dialpad, contact
/// edit/history screens and the PSTN call screens (phase 5) all use this
/// palette. Mirrors the existing [features/avaphone/phone_theme.dart]
/// `PhoneTheme` pattern: dark surfaces UNDER the canonical zine ACCENT tokens
/// ([Zine.lime], [Zine.mint], [Zine.blue], [Zine.coral], [Zine.lilac]) so Calls
/// still reads as part of AvaVerse instead of a bolted-on separate app. There is
/// no per-subtree Flutter `Theme`/`ThemeData` override anywhere else in the app
/// (see shell_v2.dart / core/theme.dart, which is light-only), so — like
/// AvaPhone — this is a plain constants class screens style against directly,
/// not a `ThemeData`.
class AvaDialTheme {
  AvaDialTheme._();

  // Surfaces (dark) — identical values to PhoneTheme for visual consistency
  // across AvaVerse's two dark surfaces.
  static const bg = Color(0xFF0E1116);
  static const surface = Color(0xFF161A20);
  static const surface2 = Color(0xFF1E232B);
  static const border = Color(0xFF2C323B);

  // Text on dark.
  static const text = Color(0xFFF2F4F7);
  static const textSoft = Color(0xFF9AA2AD);
  static const textMute = Color(0xFF6B7480);

  // Accents reuse the zine tokens (contact/log row colors, tab strip fills,
  // PSTN caller-id colors) so Calls stays on-brand.
  static const contact = Zine.mint;  // known contact / outgoing
  static const spam = Zine.coral;    // spam / missed / blocked
  static const unknown = Zine.blue;  // unrecognised caller
  static const accent = Zine.lime;   // primary action (call button)
  static const lilac = Zine.lilac;   // messages / AI

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
