import 'package:flutter/material.dart';

/// Neutral app surfaces with orange primary actions; pastel tints remain for
/// small decorative and status accents. Typography and geometry retain the approved sizes.
/// Ink and the `*Ink` / `*Deep` colours carry readable text.
/// NO GREEN anywhere (owner rule): `test/core/tokens_test.dart` fails on a green hue.
abstract final class HfColors {
  // ---- Core -------------------------------------------------------------------------------------------
  /// Deep ink for text and monochrome artwork.
  static const Color ink = Color(0xFF17131F);

  /// Page background.
  static const Color page = Color(0xFFF6F3EE);
  static const Color surface = Color(0xFFFFFDF9);
  static const Color primary = Color(0xFFF28C28);
  static const Color onPrimary = Color(0xFF231407);
  static const Color white = Color(0xFFFFFFFF);

  // ---- Pastel tints: bg, the ink used for big numbers, the deep colour used for icons / pill text ------
  static const Color lavender = Color(0xFFE7E1FF);
  static const Color lavenderInk = Color(0xFF2C2477);
  static const Color lavenderDeep = Color(0xFF3A2F99);

  static const Color peach = Color(0xFFFFE3D3);
  static const Color peachInk = Color(0xFF6B2C12);
  static const Color peachDeep = Color(0xFF8A3A1C);
  static const Color peachWave = Color(
    0xFFB4664A,
  ); // voice bar waveform, not yet played

  static const Color sky = Color(0xFFDCEBFF);
  static const Color skyInk = Color(0xFF1D3F6E);
  static const Color skyDeep = Color(0xFF234E86);

  static const Color butter = Color(0xFFFFF1C7);
  static const Color butterInk = Color(0xFF5C4300);
  static const Color butterDeep = Color(0xFF6E4F00);

  static const Color blush = Color(0xFFFFE0EA);
  static const Color blushInk = Color(0xFF6E1C3B);
  static const Color blushDeep = Color(0xFF9C2853);

  // ---- Accents -----------------------------------------------------------------------------------------
  static const Color rose = Color(
    0xFFB1325F,
  ); // hearts, switches, the HELLO eyebrow
  static const Color roseDot = Color(0xFFE0527E); // "Online now" dot
  static const Color amberDot = Color(0xFFD89A00); // "On a call" dot
  static const Color verifiedBlue = Color(0xFF4B6FD6);
  static const Color link = Color(0xFF4B3FB8);

  /// Rating star.
  static const Color star = Color(0xFFF2B53A);

  /// Errors and destructive actions only.
  static const Color accent = Color(0xFFBD2740);

  // ---- Neutrals ----------------------------------------------------------------------------------------
  static const Color muted = Color(0xFF4C4740); // secondary text
  static const Color mutedSoft = Color(
    0xFFE0DBEB,
  ); // secondary text on dark; grey presence dot
  static const Color line = Color(0xFFD8D1C9); // hairlines and card borders
  static const Color surfaceSoft = Color(
    0xFFE8E2DA,
  ); // price bar, offline pill, search button
  static const Color segmentTrack = Color(
    0xFFE8E2DA,
  ); // segmented control track, skeleton blocks
  static const Color handle = Color(0xFFD8D1C9); // sheet drag handle

  /// Caption on a light tinted tile and tag text.
  static const Color inkSoft = Color(0xFF4C4740);

  /// Tagline on a light frosted photo panel.
  static const Color inkTagline = Color(0xFF4C4740);

  /// Outline of an unselected mood tag.
  static const Color outlineChip = Color(0xFFD8D1C9);

  /// Big number on a butter tile (mockup `#3D2D00`).
  static const Color butterValue = Color(0xFF3D2D00);

  // ---- Dark mode ---------------------------------------------------------------------------------------
  static const Color darkBg = Color(0xFF000000);
  static const Color darkCard = Color(0xFF343438);
  static const Color darkTile = Color(
    0xFF2E2852,
  ); // lavender tile, chips, photo placeholder
  static const Color darkTileSky = Color(0xFF1C2A40);
  static const Color darkTileBlush = Color(0xFF3A1F2B);
  static const Color darkTilePeach = Color(0xFF3A2620);
  static const Color darkTileButter = Color(0xFF3A3120);
  static const Color darkNav = Color(0xFF262238);
  static const Color darkSelected = Color(
    0xFF5C5C66,
  ); // selected segment and neutral control states
  static const Color darkText = Color(0xFFF8F6FF);
  static const Color lavenderLight = Color(0xFFCFC4FF);
  static const Color peachLight = Color(0xFFFFC9AE);
  static const Color blushLight = Color(0xFFFFB3CB);
  static const Color skyLight = Color(0xFFA9CCFF);
  static const Color butterLight = Color(0xFFFFE08A);

  /// Secondary neutral surface and price bar in dark mode.
  static const Color darkBar = Color(0xFF484850);

  /// Hairline in dark mode.
  static const Color darkLine = Color(0xFF5C5C66);

  /// Online dot in dark mode (mockup `#FF7DA6`).
  static const Color blushDot = Color(0xFFFF7DA6);

  /// Every live colour above. The tokens test walks this list (no green hue allowed).
  static const List<Color> all = [
    ink,
    page,
    surface,
    primary,
    onPrimary,
    white,
    lavender,
    lavenderInk,
    lavenderDeep,
    peach,
    peachInk,
    peachDeep,
    peachWave,
    sky,
    skyInk,
    skyDeep,
    butter,
    butterInk,
    butterDeep,
    blush,
    blushInk,
    blushDeep,
    rose,
    roseDot,
    amberDot,
    verifiedBlue,
    link,
    star,
    accent,
    muted,
    mutedSoft,
    line,
    surfaceSoft,
    segmentTrack,
    handle,
    inkSoft,
    inkTagline,
    outlineChip,
    butterValue,
    darkBg,
    darkCard,
    darkTile,
    darkTileSky,
    darkTileBlush,
    darkTilePeach,
    darkTileButter,
    darkNav,
    darkSelected,
    darkText,
    lavenderLight,
    peachLight,
    blushLight,
    skyLight,
    butterLight,
    darkBar,
    darkLine,
    blushDot,
  ];

  // ---- Deprecated aliases: the old bento names keep compiling. Use the new names in new code. -----------
  @Deprecated('HF-UI-1: use HfColors.ink')
  static const Color plum = ink;
  @Deprecated('HF-UI-1: use HfColors.page')
  static const Color cream = page;
  @Deprecated('HF-UI-1: use HfColors.lavender')
  static const Color lilac = lavender;
  @Deprecated('HF-UI-1: use HfColors.link')
  static const Color orchid = link;
  @Deprecated('HF-UI-1: use HfColors.muted')
  static const Color mauve = muted;
  @Deprecated('HF-UI-1: use HfColors.sky (no green in the design)')
  static const Color mint = sky;
  @Deprecated('HF-UI-1: use HfColors.rose')
  static const Color coral = rose;
  @Deprecated('HF-UI-1: use HfColors.ink (no green in the design)')
  static const Color forest = ink;
}

/// Radii. Cards 32, photo/inner 28, tiles 22/18, controls 20, chips 14, sheets 32.
abstract final class HfRadius {
  static const double card = 32;
  static const double cardInner = 28;
  static const double sheet = 32;
  static const double tile = 22;
  static const double tileSmall = 18;
  static const double control = 20;
  static const double chip = 14;
  static const double pillRadius = 999;

  /// Text fields.
  static const double input = 18;

  /// Segmented track / its selected pill.
  static const double segment = 16;
  static const double segmentItem = 12;

  /// Floating nav bar.
  static const double nav = 26;

  /// Old name of [pillRadius]. Never use it for the top corners of a sheet: use [sheet].
  static const double pill = pillRadius;
}

abstract final class HfSpacing {
  /// Side padding around a list of cards (card feed, sheets).
  static const double page = 16;

  /// Side padding of header blocks and text screens.
  static const double pageWide = 20;
  static const double xs = 6;
  static const double sm = 8;
  static const double md = 10;
  static const double lg = 12;
  static const double xl = 14;
  static const double xxl = 18;
  static const double section = 24;

  /// Minimum tap target.
  static const double tap = 48;

  /// Old names kept so existing screens compile.
  static const double gap = 12;
  static const double gapLarge = 20;
}

abstract final class HfShadows {
  /// Neutral card elevation in light and dark mode.
  static const List<BoxShadow> card = [
    BoxShadow(color: Color(0x24000000), offset: Offset(0, 6), blurRadius: 18),
  ];
  static const List<BoxShadow> cardDark = [
    BoxShadow(color: Color(0x8C000000), offset: Offset(0, 6), blurRadius: 18),
    BoxShadow(color: Color(0x245C5C66), blurRadius: 8),
  ];

  static List<BoxShadow> cardFor(BuildContext context) =>
      Theme.of(context).brightness == Brightness.dark ? cardDark : card;

  /// `0 12 32 rgba(29,26,51,0.16)`: floating nav.
  static const List<BoxShadow> nav = [
    BoxShadow(color: Color(0x291D1A33), offset: Offset(0, 12), blurRadius: 32),
  ];

  /// Floating nav in dark mode: `0 12 32 rgba(0,0,0,0.4)`.
  static const List<BoxShadow> navDark = [
    BoxShadow(color: Color(0x66000000), offset: Offset(0, 12), blurRadius: 32),
  ];

  /// Selected segment: `0 2 8 rgba(29,26,51,0.08)`.
  static const List<BoxShadow> segment = [
    BoxShadow(color: Color(0x141D1A33), offset: Offset(0, 2), blurRadius: 8),
  ];

  /// Search field: `0 6 18 rgba(29,26,51,0.05)`.
  static const List<BoxShadow> field = [
    BoxShadow(color: Color(0x0D1D1A33), offset: Offset(0, 6), blurRadius: 18),
  ];

  /// Slide-to-call knob: `0 4 12 rgba(0,0,0,0.25)`.
  static const List<BoxShadow> knob = [
    BoxShadow(color: Color(0x40000000), offset: Offset(0, 4), blurRadius: 12),
  ];
}

/// Animation timings. Always read durations through [HfMotion.of] so reduced motion is honoured.
abstract final class HfMotion {
  static const Duration fast = Duration(milliseconds: 150);
  static const Duration base = Duration(milliseconds: 220);
  static const Duration slow = Duration(milliseconds: 300);
  static const Curve curve = Curves.easeOutCubic;

  /// [d], or zero when the phone asks for no animations.
  static Duration of(BuildContext context, Duration d) =>
      MediaQuery.disableAnimationsOf(context) ? Duration.zero : d;
}

/// Text styles. Nunito for display, Comfortaa for everything else. Nothing is below 14 sp.
/// Nunito 900 and Comfortaa 600 are not bundled (see pubspec fonts), so every "900" display style is
/// declared w800 (ExtraBold) and Comfortaa 600 renders as the nearest bundled weight.
abstract final class HfText {
  /// Font family names.
  static const String displayFamily = 'Nunito';
  static const String bodyFamily = 'Comfortaa';

  /// Smallest allowed font size. A lint-style test walks both themes and fails below this.
  static const double minSize = 14;

  // ---- Display (Nunito) --------------------------------------------------------------------------------
  /// Welcome headline 30 (mockup 900, here w800).
  static const TextStyle hero = TextStyle(
    fontFamily: displayFamily,
    fontSize: 30,
    fontWeight: FontWeight.w800,
    height: 1.15,
    letterSpacing: 0.3,
    color: HfColors.ink,
  );

  /// Screen headline 27 (mockup 900, here w800).
  static const TextStyle headline = TextStyle(
    fontFamily: displayFamily,
    fontSize: 27,
    fontWeight: FontWeight.w800,
    height: 1.15,
    letterSpacing: 0.3,
    color: HfColors.ink,
  );

  /// Host name, sheet title 24 (mockup 900, here w800).
  static const TextStyle title = TextStyle(
    fontFamily: displayFamily,
    fontSize: 24,
    fontWeight: FontWeight.w800,
    height: 1.2,
    letterSpacing: 0.3,
    color: HfColors.ink,
  );

  /// Section heading 20/800.
  static const TextStyle section = TextStyle(
    fontFamily: displayFamily,
    fontSize: 20,
    fontWeight: FontWeight.w800,
    height: 1.25,
    letterSpacing: 0.3,
    color: HfColors.ink,
  );

  /// Sub-section heading 17/800.
  static const TextStyle subsection = TextStyle(
    fontFamily: displayFamily,
    fontSize: 17,
    fontWeight: FontWeight.w800,
    height: 1.3,
    letterSpacing: 0.3,
    color: HfColors.ink,
  );

  /// Big number 22 (mockup 900, here w800).
  static const TextStyle stat = TextStyle(
    fontFamily: displayFamily,
    fontSize: 22,
    fontWeight: FontWeight.w800,
    height: 1.15,
    letterSpacing: 0.3,
    color: HfColors.ink,
  );

  /// Tile number 18 (mockup 900, here w800).
  static const TextStyle statSmall = TextStyle(
    fontFamily: displayFamily,
    fontSize: 18,
    fontWeight: FontWeight.w800,
    height: 1.2,
    letterSpacing: 0.3,
    color: HfColors.ink,
  );

  // ---- Body (Comfortaa) --------------------------------------------------------------------------------
  /// Paragraph 16/400.
  static const TextStyle body = TextStyle(
    fontFamily: bodyFamily,
    fontSize: 16,
    fontWeight: FontWeight.w400,
    height: 1.5,
    color: HfColors.ink,
  );

  /// Paragraph 16/700.
  static const TextStyle bodyStrong = TextStyle(
    fontFamily: bodyFamily,
    fontSize: 16,
    fontWeight: FontWeight.w700,
    height: 1.5,
    color: HfColors.ink,
  );

  /// Secondary paragraph 15/400.
  static const TextStyle note = TextStyle(
    fontFamily: bodyFamily,
    fontSize: 15,
    fontWeight: FontWeight.w400,
    height: 1.4,
    color: HfColors.muted,
  );

  /// Pill text 14/700.
  static const TextStyle badge = TextStyle(
    fontFamily: bodyFamily,
    fontSize: 14,
    fontWeight: FontWeight.w700,
    height: 1.3,
    color: HfColors.ink,
  );

  /// Caption 14/600.
  static const TextStyle label = TextStyle(
    fontFamily: bodyFamily,
    fontSize: 14,
    fontWeight: FontWeight.w600,
    height: 1.3,
    color: HfColors.muted,
  );

  /// Button 16/700.
  static const TextStyle button = TextStyle(
    fontFamily: bodyFamily,
    fontSize: 16,
    fontWeight: FontWeight.w700,
    height: 1.2,
  );

  /// Small button / link button 15/700.
  static const TextStyle buttonSmall = TextStyle(
    fontFamily: bodyFamily,
    fontSize: 15,
    fontWeight: FontWeight.w700,
    height: 1.2,
  );

  // ---- Old names, kept so existing screens compile -----------------------------------------------------
  /// Same as [body].
  static const TextStyle bodyText = body;

  /// Same as [subsection].
  static const TextStyle subtitle = subsection;

  // ---- Dark mode ---------------------------------------------------------------------------------------
  /// [style] recoloured for dark surfaces: ink becomes [HfColors.darkText], muted becomes
  /// [HfColors.mutedSoft]. Any other colour is kept.
  static TextStyle onDark(TextStyle style) {
    final c = style.color;
    if (c == null || c == HfColors.ink) {
      return style.copyWith(color: HfColors.darkText);
    }
    if (c == HfColors.muted) return style.copyWith(color: HfColors.mutedSoft);
    return style;
  }

  /// [style] recoloured for the theme of [context] (a no-op in light mode).
  static TextStyle of(BuildContext context, TextStyle style) =>
      Theme.of(context).brightness == Brightness.dark ? onDark(style) : style;

  /// Old name of [onDark] / [of] with a brightness argument.
  static TextStyle forBrightness(TextStyle style, Brightness brightness) =>
      brightness == Brightness.dark ? onDark(style) : style;
}
