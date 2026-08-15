// [WALLET-REDESIGN-1] AvaWallet design tokens.
//
// [UI-DS-SWEEP-1] 2026-08-05 — FOLDED ONTO `AD` / `ADText` / `Msg`.
//
// This file used to be a whole parallel design system: its own neutral ramp,
// its own five poster accents, its own Nunito scale pinned at w800, and a
// "Zine poster" idiom of PURE-black 2.5px borders plus HARD un-blurred offset
// shadows. The 2026-08-05 UI audit counted eight such systems live at once and
// named this one the worst offender — a wallet screen that looked like it came
// from a different app than the chat screen next to it.
//
// It is now a THIN ALIAS LAYER. Every value below resolves to a token in
// `core/ui/avatok_dark.dart` (`AD` / `ADText`) or `core/ui/messenger_theme.dart`
// (`Msg`). The `AW` / `AWText` NAMES are kept deliberately: they have dozens of
// call sites across `wallet_screen.dart` and `wallet_widgets.dart`, and there
// is no local compiler, so pointing the names at the right values is far safer
// than rewriting every call site by hand.
//
// DO NOT add a new colour, size or weight here. If the wallet needs a value,
// it belongs in `AD`.

import 'package:flutter/material.dart';

import '../../core/ui/avatok_dark.dart';

/// AvaWallet palette — an alias layer over [AD]. No bespoke hexes.
class AW {
  AW._();

  // ---------------------------------------------------------------- surfaces
  /// Screen background.
  static const Color bg = AD.bg;

  /// Card / row surface.
  static const Color surf = AD.card;

  /// Raised surface (popovers, calendar) — one step lighter than [surf].
  static const Color surf2 = AD.cardHover;

  // -------------------------------------------------------------------- text
  static const Color tx = AD.textPrimary;
  static const Color txSoft = AD.textSecondary;
  static const Color txMute = AD.textTertiary;

  // ------------------------------------------------------------ lines & ink
  /// Hairline divider / quiet border.
  static const Color hair = AD.borderHairline;

  /// Container border. Was PURE black at 2.5px (the poster outline); it is now
  /// the standard AD card border, because the outline was most of what made the
  /// wallet read as a sticker book rather than as a wallet.
  static const Color ink = AD.borderCard;

  /// Glyph / label colour that sits ON a bright accent fill.
  static const Color glyph = AD.textOnInput;

  // ------------------------------------------------------------- accents
  //
  // Was five bespoke poster hexes (mint / lime / coral / blue / lilac) shared
  // with the light `Zine` system. Each now points at its nearest AD token, so
  // the wallet spends the SAME colours as the rest of the app and colour keeps
  // meaning something. The names survive because they read semantically at the
  // call sites ("money in is mint, money out is coral").

  /// Money / success / incoming.
  static const Color mint = AD.online;

  /// Primary action / selection — the single app accent.
  static const Color lime = AD.primaryBadge;

  /// Spend / outgoing / destructive. The ONLY fill that takes white text.
  static const Color coral = AD.danger;

  /// Brand / informational.
  static const Color blue = AD.newGroup;

  /// AI / magic.
  static const Color lilac = AD.micIdleBg;

  /// Accent rotation for adjacent badges.
  static const List<Color> accents = [mint, lime, coral, blue, lilac];
}

/// AvaWallet type scale — a thin skin over [ADText].
///
/// [UI-DS-SWEEP-1] Every style here used to be w800 (a few w700), which is why
/// nothing on the wallet screen could be emphasised: the balance, the row
/// title, the timestamp and the caption were all the same weight. Hierarchy now
/// comes from contrast — w700 tops out the scale, titles and values sit at
/// w600, and body/meta/caption drop to w400/w500.
///
/// Font sizes are UNCHANGED on purpose (bar `rowTitle`, 14.5 → 15, snapping a
/// half-pixel onto the scale). Changing a size changes layout, and there is no
/// local compiler or emulator to check the result.
class AWText {
  AWText._();

  // Null intentionally inherits the platform-native UI font from ADText.
  static const String? family = ADText.family;

  /// Delegates to [ADText] so family and defaults have ONE source; the wallet
  /// only overrides size, weight, tracking and leading.
  static TextStyle _s(
    double size,
    FontWeight w,
    Color c, {
    double? spacing,
    double? height,
  }) =>
      ADText.rowName(c: c).copyWith(
        fontSize: size,
        fontWeight: w,
        letterSpacing: spacing,
        height: height ?? 1.2,
      );

  /// Screen title ("AvaWallet") — 28 / 700.
  static TextStyle walletTitle({Color? c}) =>
      _s(28, FontWeight.w700, c ?? AW.tx, spacing: -0.6);

  /// Small kicker above a block — 11 / 600.
  static TextStyle kicker({Color? c}) =>
      _s(11, FontWeight.w600, c ?? AW.txMute, spacing: 0.9);

  /// Hero balance number — 56 / 700, tight.
  static TextStyle balanceHuge({Color? c}) =>
      _s(56, FontWeight.w700, c ?? AW.glyph, spacing: -1.5, height: 0.9);

  /// Unit suffix next to the hero balance ("AVA") — 18 / 600.
  static TextStyle balanceUnit({Color? c}) =>
      _s(18, FontWeight.w600, c ?? AW.glyph);

  /// Label on the balance card — 15 / 600.
  static TextStyle cardLabel({Color? c}) =>
      _s(15, FontWeight.w600, c ?? AW.glyph, spacing: 0.4);

  /// Sub-line under the hero balance — 13 / 500.
  static TextStyle balanceSub({Color? c}) =>
      _s(13, FontWeight.w500, c ?? AW.glyph);

  /// Stat tile number — 30 / 700.
  static TextStyle statBig({Color? c}) =>
      _s(30, FontWeight.w700, c ?? AW.tx, spacing: -1);

  /// Caption under a stat / donut — 11 / 500.
  static TextStyle caption({Color? c}) =>
      _s(11, FontWeight.w500, c ?? AW.txMute, spacing: 0.6);

  /// Small section heading / inline glyph — 15 / 600.
  static TextStyle sectionHead({Color? c}) =>
      _s(15, FontWeight.w600, c ?? AW.tx);

  /// Section title — 20 / 700.
  static TextStyle sectionTitle({Color? c}) =>
      _s(20, FontWeight.w700, c ?? AW.tx, spacing: -0.4);

  /// Meta line inside a card — 12 / 400.
  static TextStyle cardMeta({Color? c}) =>
      _s(12, FontWeight.w400, c ?? AW.txSoft);

  /// Transaction row title — 15 / 600 (matches [ADText.rowName]).
  static TextStyle rowTitle({Color? c}) =>
      _s(15, FontWeight.w600, c ?? AW.tx);

  /// Transaction row subtitle — 12 / 400.
  static TextStyle rowSub({Color? c}) =>
      _s(12, FontWeight.w400, c ?? AW.txMute);

  /// Transaction amount — 16 / 600.
  static TextStyle amount({Color? c}) =>
      _s(16, FontWeight.w600, c ?? AW.tx, spacing: -0.3);

  /// Transaction timestamp — 11 / 400.
  static TextStyle rowTime({Color? c}) =>
      _s(11, FontWeight.w400, c ?? AW.txMute);

  /// Bar-chart axis / value label — 10 / 500.
  static TextStyle barLabel({Color? c}) =>
      _s(10, FontWeight.w500, c ?? AW.txMute);

  /// Number in the middle of the donut — 28 / 700.
  static TextStyle donutCenter({Color? c}) =>
      _s(28, FontWeight.w700, c ?? AW.tx, spacing: -1);

  /// Donut legend label — 13 / 400.
  static TextStyle legendLabel({Color? c}) =>
      _s(13, FontWeight.w400, c ?? AW.txSoft);

  /// Donut legend value — 13 / 600.
  static TextStyle legendValue({Color? c}) =>
      _s(13, FontWeight.w600, c ?? AW.tx);

  /// Segmented-chip label — 12 / 600.
  static TextStyle chipLabel({Color? c}) =>
      _s(12, FontWeight.w600, c ?? AW.tx, spacing: 0.3);

  /// Search-field input text — 13 / 400.
  static TextStyle searchText({Color? c}) =>
      _s(13, FontWeight.w400, c ?? AW.tx);

  /// Hero amount on the transaction-detail screen — 52 / 700.
  static TextStyle detailAmount({Color? c}) =>
      _s(52, FontWeight.w700, c ?? AW.tx, spacing: -1.6, height: 0.9);

  /// Status-pill label — 11 / 600.
  static TextStyle pillLabel({Color? c}) =>
      _s(11, FontWeight.w600, c ?? AW.glyph, spacing: 0.6);

  /// Value inside the cost-breakdown box — 22 / 700.
  static TextStyle breakdownValue({Color? c}) =>
      _s(22, FontWeight.w700, c ?? AW.tx);

  /// Key/value row label — 13 / 400.
  static TextStyle infoLabel({Color? c}) =>
      _s(13, FontWeight.w400, c ?? AW.txMute);

  /// Key/value row value — 14 / 600.
  static TextStyle infoValue({Color? c}) =>
      _s(14, FontWeight.w600, c ?? AW.tx);
}
