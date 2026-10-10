import 'package:flutter/painting.dart';

/// Design tokens taken from the website (web/src/styles, the callvaal and profile-card CSS).
/// Light, colourful, rounded. NEVER GREEN, anywhere (owner rule): the "online now" pill is rose on blush.
abstract final class HfColors {
  /// Ink and primary.
  static const Color plum = Color(0xFF46113E);

  /// Page background.
  static const Color cream = Color(0xFFFFFDF7);
  static const Color lilac = Color(0xFFF2EFFF);
  static const Color blush = Color(0xFFFCE4EB);
  static const Color butter = Color(0xFFFFF1CF);
  static const Color butterDeep = Color(0xFFFFE28A);
  static const Color orchid = Color(0xFF7B388C);

  /// Muted text.
  static const Color mauve = Color(0xFF785979);
  static const Color line = Color(0xFFE8DCE7);

  /// Alerts and errors.
  static const Color accent = Color(0xFFBD2740);
  static const Color rose = Color(0xFFB2367E);
  static const Color white = Color(0xFFFFFFFF);
}

/// Radii: 18 on cards, 12 on chips and buttons, 24 on pills.
abstract final class HfRadius {
  static const double card = 18;
  static const double control = 12;
  static const double pill = 24;
}

abstract final class HfSpacing {
  /// Side padding of every page. Content fills the width; it is never a narrow centred column.
  static const double page = 20;
  static const double gap = 12;
  static const double gapLarge = 20;

  /// Minimum tap target.
  static const double tap = 48;
}

abstract final class HfShadows {
  /// `0 5 22 #46113E0B`.
  static const List<BoxShadow> card = [
    BoxShadow(color: Color(0x0B46113E), offset: Offset(0, 5), blurRadius: 22),
  ];
}

/// Text styles. Nunito for display and headline styles, Comfortaa for everything else.
/// Sizes: body 16, note 15, badge 14 (the floor: nothing is smaller), title 22, hero 28-32.
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
