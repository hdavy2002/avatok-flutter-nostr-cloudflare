// [WALLET-REDESIGN-1] AvaWallet redesign — design tokens.
//
// The wallet screen runs its own local flavour of the design language: the
// "Zine poster" idiom (flat saturated accent fills, HARD pure-black borders,
// HARD un-blurred offset shadows, pill chips, Nunito at w700/w800) rendered on
// a DARK canvas instead of the light paper of `core/ui/zine.dart`.
//
// It deliberately does NOT extend `AD` (core/ui/avatok_dark.dart): AD is the
// soft-shadow / hairline-border dark system, and mixing the two mid-screen
// reads as a bug. Accent hexes are reused verbatim from `Zine` so the poster
// palette stays identical across the app.
//
// Nothing here is screen-specific — only colors and type. Widgets live in
// `wallet_widgets.dart`.

import 'package:flutter/material.dart';

/// AvaWallet palette. Flat fills, pure-black ink, dark canvas.
class AW {
  AW._();

  // ---------------------------------------------------------------- surfaces
  /// Screen background — near-black.
  static const Color bg = Color(0xFF0E0E11);

  /// Card / row surface.
  static const Color surf = Color(0xFF1A1A1F);

  /// Raised surface (popovers, calendar) — one step lighter than [surf].
  static const Color surf2 = Color(0xFF26262D);

  // -------------------------------------------------------------------- text
  /// Primary text — warm off-white (matches the poster paper tone).
  static const Color tx = Color(0xFFF4F1E8);

  /// Secondary text.
  static const Color txSoft = Color(0xFFB6B1A7);

  /// Tertiary / caption / placeholder text.
  static const Color txMute = Color(0xFF7D786F);

  // ------------------------------------------------------------ lines & ink
  /// Hairline divider / soft border — translucent white so it works over any
  /// surface tone without a second token per surface.
  static const Color hair = Color(0x17FFFFFF);

  /// PURE black — every hard border and every hard offset shadow. Not the warm
  /// `Zine.ink`: on a dark canvas the warm brown reads as muddy, pure black
  /// reads as a deliberate poster outline.
  static const Color ink = Color(0xFF000000);

  /// Glyph / label color that sits ON a bright accent fill.
  static const Color glyph = Color(0xFF131313);

  // ------------------------------------------------------- poster accents
  /// Money / success / incoming.
  static const Color mint = Color(0xFF77EDAE);

  /// Primary action / selection.
  static const Color lime = Color(0xFFBFEB56);

  /// Spend / outgoing / destructive. The ONLY fill that takes white text.
  static const Color coral = Color(0xFFFE674C);

  /// Brand / informational.
  static const Color blue = Color(0xFFA0F7F1);

  /// AI / magic.
  static const Color lilac = Color(0xFFCDAEF2);

  /// Accent rotation for adjacent badges.
  static const List<Color> accents = [mint, lime, coral, blue, lilac];
}

/// AvaWallet type scale. Nunito throughout — only 600/700/800/900 are bundled
/// (see app/pubspec.yaml), so every style here is w700 or w800.
///
/// Each helper takes an optional `c` with a sensible default, mirroring
/// `ADText`, so call sites read `AWText.rowTitle()` / `AWText.rowTitle(c: ...)`.
class AWText {
  AWText._();

  static const String family = 'Nunito';

  static TextStyle _s(
    double size,
    FontWeight w,
    Color c, {
    double? spacing,
    double? height,
  }) =>
      TextStyle(
        fontFamily: family,
        fontSize: size,
        fontWeight: w,
        color: c,
        letterSpacing: spacing,
        height: height,
      );

  /// Screen title ("AvaWallet") — 28 / 800.
  static TextStyle walletTitle({Color? c}) =>
      _s(28, FontWeight.w800, c ?? AW.tx, spacing: -0.6);

  /// Small uppercase kicker above a block — 11 / 800.
  static TextStyle kicker({Color? c}) =>
      _s(11, FontWeight.w800, c ?? AW.txMute, spacing: 0.9);

  /// Hero balance number — 56 / 800, tight.
  static TextStyle balanceHuge({Color? c}) =>
      _s(56, FontWeight.w800, c ?? AW.glyph, spacing: -1.5, height: 0.9);

  /// Unit suffix next to the hero balance ("AVA") — 18 / 800.
  static TextStyle balanceUnit({Color? c}) =>
      _s(18, FontWeight.w800, c ?? AW.glyph);

  /// Label on the balance card — 15 / 800.
  static TextStyle cardLabel({Color? c}) =>
      _s(15, FontWeight.w800, c ?? AW.glyph, spacing: 0.4);

  /// Sub-line under the hero balance — 13 / 800.
  static TextStyle balanceSub({Color? c}) =>
      _s(13, FontWeight.w800, c ?? AW.glyph);

  /// Stat tile number — 30 / 800.
  static TextStyle statBig({Color? c}) =>
      _s(30, FontWeight.w800, c ?? AW.tx, spacing: -1);

  /// Uppercase caption under a stat / donut — 11 / 800.
  static TextStyle caption({Color? c}) =>
      _s(11, FontWeight.w800, c ?? AW.txMute, spacing: 0.6);

  /// Small section heading / inline glyph — 15 / 800.
  static TextStyle sectionHead({Color? c}) =>
      _s(15, FontWeight.w800, c ?? AW.tx);

  /// Section title — 20 / 800.
  static TextStyle sectionTitle({Color? c}) =>
      _s(20, FontWeight.w800, c ?? AW.tx, spacing: -0.4);

  /// Meta line inside a card — 12 / 800.
  static TextStyle cardMeta({Color? c}) =>
      _s(12, FontWeight.w800, c ?? AW.txSoft);

  /// Transaction row title — 14.5 / 800.
  static TextStyle rowTitle({Color? c}) =>
      _s(14.5, FontWeight.w800, c ?? AW.tx);

  /// Transaction row subtitle — 12 / 700.
  static TextStyle rowSub({Color? c}) =>
      _s(12, FontWeight.w700, c ?? AW.txMute);

  /// Transaction amount — 16 / 800.
  static TextStyle amount({Color? c}) =>
      _s(16, FontWeight.w800, c ?? AW.tx, spacing: -0.3);

  /// Transaction timestamp — 11 / 700.
  static TextStyle rowTime({Color? c}) =>
      _s(11, FontWeight.w700, c ?? AW.txMute);

  /// Bar-chart axis / value label — 10 / 800.
  static TextStyle barLabel({Color? c}) =>
      _s(10, FontWeight.w800, c ?? AW.txMute);

  /// Number in the middle of the donut — 28 / 800.
  static TextStyle donutCenter({Color? c}) =>
      _s(28, FontWeight.w800, c ?? AW.tx, spacing: -1);

  /// Donut legend label — 13 / 700.
  static TextStyle legendLabel({Color? c}) =>
      _s(13, FontWeight.w700, c ?? AW.txSoft);

  /// Donut legend value — 13 / 800.
  static TextStyle legendValue({Color? c}) =>
      _s(13, FontWeight.w800, c ?? AW.tx);

  /// Segmented-chip label — 12 / 800.
  static TextStyle chipLabel({Color? c}) =>
      _s(12, FontWeight.w800, c ?? AW.tx, spacing: 0.3);

  /// Search-field input text — 13 / 700.
  static TextStyle searchText({Color? c}) =>
      _s(13, FontWeight.w700, c ?? AW.tx);

  /// Hero amount on the transaction-detail screen — 52 / 800.
  static TextStyle detailAmount({Color? c}) =>
      _s(52, FontWeight.w800, c ?? AW.tx, spacing: -1.6, height: 0.9);

  /// Status-pill label (uppercase) — 11 / 800.
  static TextStyle pillLabel({Color? c}) =>
      _s(11, FontWeight.w800, c ?? AW.glyph, spacing: 0.6);

  /// Value inside the cost-breakdown box — 22 / 800.
  static TextStyle breakdownValue({Color? c}) =>
      _s(22, FontWeight.w800, c ?? AW.tx);

  /// Key/value row label — 13 / 700.
  static TextStyle infoLabel({Color? c}) =>
      _s(13, FontWeight.w700, c ?? AW.txMute);

  /// Key/value row value — 14 / 800.
  static TextStyle infoValue({Color? c}) =>
      _s(14, FontWeight.w800, c ?? AW.tx);
}
