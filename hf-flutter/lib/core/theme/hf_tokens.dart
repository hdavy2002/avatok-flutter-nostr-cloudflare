import 'package:flutter/painting.dart';

/// Native bento palette approved 2026-10-11. Soft colour is decoration; ink carries readable text.
abstract final class HfColors {
  /// Deep ink for readable text.
  static const Color ink = Color(0xFF121C3D);
  static const Color plum = ink;
  static const Color mint = Color(0xFFAFF0D5);
  static const Color sky = Color(0xFFA9D6FF);
  static const Color lavender = Color(0xFFDBD0FF);
  static const Color coral = Color(0xFFFF626C);
  static const Color forest = Color(0xFF14634E);

  /// Page background.
  static const Color cream = Color(0xFFF7F8FC);
  static const Color lilac = lavender;
  static const Color blush = Color(0xFFFFE1E9);
  static const Color butter = Color(0xFFFFE8A4);
  static const Color butterDeep = Color(0xFFFFCD53);
  static const Color orchid = Color(0xFF614884);

  /// Muted text.
  static const Color mauve = Color(0xFF64708B);
  static const Color line = Color(0xFFE6E9F1);

  /// Alerts and errors.
  static const Color accent = Color(0xFFBD2740);
  static const Color rose = Color(0xFFB2367E);
  static const Color white = Color(0xFFFFFFFF);
}

/// Generous native cards and rounded controls.
abstract final class HfRadius {
  static const double card = 28;
  static const double control = 24;
  static const double pill = 40;
}

abstract final class HfSpacing {
  /// Side padding of every page. Content fills the width; it is never a narrow centred column.
  static const double page = 18;
  static const double gap = 12;
  static const double gapLarge = 20;

  /// Minimum tap target.
  static const double tap = 48;
}

abstract final class HfShadows {
  /// Visible, soft elevation against the off-white page.
  static const List<BoxShadow> card = [
    BoxShadow(color: Color(0x14121C3D), offset: Offset(0, 8), blurRadius: 24),
    BoxShadow(color: Color(0x06121C3D), offset: Offset(0, 2), blurRadius: 5),
  ];
}

/// Text styles. Nunito for display and headline styles, Comfortaa for everything else.
/// Sizes: body 16, note 15, badge 14, title 22, hero 28-32.
/// Only the owner-approved discreet AI avatar caption uses a smaller local style.
abstract final class HfText {
  static const String display = 'Nunito';
  static const String body = 'Comfortaa';

  /// Smallest allowed font size. A lint-style test walks the theme and fails below this.
  static const double minSize = 14;

  static const TextStyle hero = TextStyle(
    fontFamily: display, fontSize: 30, fontWeight: FontWeight.w800, height: 1.15, color: HfColors.plum);
  static const TextStyle headline = TextStyle(
    fontFamily: display, fontSize: 26, fontWeight: FontWeight.w800, height: 1.2, color: HfColors.plum);
  static const TextStyle title = TextStyle(
    fontFamily: display, fontSize: 22, fontWeight: FontWeight.w700, height: 1.25, color: HfColors.plum);
  static const TextStyle subtitle = TextStyle(
    fontFamily: display, fontSize: 18, fontWeight: FontWeight.w700, height: 1.3, color: HfColors.plum);
  static const TextStyle bodyText = TextStyle(
    fontFamily: body, fontSize: 16, fontWeight: FontWeight.w400, height: 1.45, color: HfColors.plum);
  static const TextStyle bodyStrong = TextStyle(
    fontFamily: body, fontSize: 16, fontWeight: FontWeight.w700, height: 1.45, color: HfColors.plum);
  static const TextStyle note = TextStyle(
    fontFamily: body, fontSize: 15, fontWeight: FontWeight.w400, height: 1.4, color: HfColors.mauve);
  static const TextStyle badge = TextStyle(
    fontFamily: body, fontSize: 14, fontWeight: FontWeight.w700, height: 1.3, color: HfColors.plum);
  static const TextStyle label = TextStyle(
    fontFamily: body, fontSize: 14, fontWeight: FontWeight.w500, height: 1.3, color: HfColors.mauve);
  static const TextStyle button = TextStyle(
    fontFamily: body, fontSize: 16, fontWeight: FontWeight.w700, height: 1.2);
}
