import 'package:flutter/material.dart';

import 'hf_tokens.dart';

export 'hf_tokens.dart';

/// Brightness helper: `HfBrightness.isDark(context)`.
abstract final class HfBrightness {
  static bool isDark(BuildContext context) =>
      Theme.of(context).brightness == Brightness.dark;
}

/// The five pastel tints shared by tiles, chips, nav items and status surfaces.
enum HfTint {
  lavender,
  peach,
  sky,
  butter,
  blush;

  /// Surface colour of this tint in the theme of [context] (light pastel, or the matching dark tile).
  Color bg(BuildContext context) =>
      HfBrightness.isDark(context) ? _darkBg : _lightBg;

  /// Text and icon colour on [bg] (the mockups' "deep" colour; the light pastel ink on dark).
  Color ink(BuildContext context) =>
      HfBrightness.isDark(context) ? _darkInk : _lightDeep;

  /// Colour of the big number on a tile (the mockups' darker "ink" of the tint).
  Color valueInk(BuildContext context) =>
      HfBrightness.isDark(context) ? _darkInk : _lightValue;

  Color get _lightBg => switch (this) {
    HfTint.lavender => HfColors.lavender,
    HfTint.peach => HfColors.peach,
    HfTint.sky => HfColors.sky,
    HfTint.butter => HfColors.butter,
    HfTint.blush => HfColors.blush,
  };

  Color get _lightDeep => switch (this) {
    HfTint.lavender => HfColors.lavenderDeep,
    HfTint.peach => HfColors.peachDeep,
    HfTint.sky => HfColors.skyDeep,
    HfTint.butter => HfColors.butterDeep,
    HfTint.blush => HfColors.blushDeep,
  };

  Color get _lightValue => switch (this) {
    HfTint.lavender => HfColors.lavenderInk,
    HfTint.peach => HfColors.peachInk,
    HfTint.sky => HfColors.skyInk,
    HfTint.butter => HfColors.butterValue,
    HfTint.blush => HfColors.blushInk,
  };

  Color get _darkBg => switch (this) {
    HfTint.lavender => HfColors.darkTile,
    HfTint.peach => HfColors.darkTilePeach,
    HfTint.sky => HfColors.darkTileSky,
    HfTint.butter => HfColors.darkBar,
    HfTint.blush => HfColors.darkTileBlush,
  };

  Color get _darkInk => switch (this) {
    HfTint.lavender => HfColors.lavenderLight,
    HfTint.peach => HfColors.peachLight,
    HfTint.sky => HfColors.skyLight,
    HfTint.butter => HfColors.star,
    HfTint.blush => HfColors.blushLight,
  };
}

/// The light ThemeData of the app. Every text style is 14 sp or bigger.
ThemeData buildHfTheme() => _build(Brightness.light);

/// The dark ThemeData (mockup `HomeDark`). Same shapes, dark surfaces.
ThemeData buildHfDarkTheme() => _build(Brightness.dark);

ThemeData _build(Brightness brightness) {
  final dark = brightness == Brightness.dark;
  final Color page = dark ? HfColors.darkBg : HfColors.page;
  final Color card = dark ? HfColors.darkCard : HfColors.white;
  final Color text = dark ? HfColors.darkText : HfColors.ink;
  final Color muted = dark ? HfColors.mutedSoft : HfColors.muted;
  final Color line = dark ? HfColors.darkLine : HfColors.line;
  final Color linkColor = dark ? HfColors.lavenderLight : HfColors.link;
  // Primary buttons are ink with white text; in dark mode they flip to lavender with ink text.
  final Color primary = dark ? HfColors.lavender : HfColors.ink;
  final Color onPrimary = dark ? HfColors.ink : HfColors.white;

  final scheme = ColorScheme(
    brightness: brightness,
    primary: primary,
    onPrimary: onPrimary,
    secondary: linkColor,
    onSecondary: dark ? HfColors.ink : HfColors.white,
    tertiary: HfColors.rose,
    onTertiary: HfColors.white,
    error: dark ? HfColors.blushLight : HfColors.accent,
    onError: dark ? HfColors.ink : HfColors.white,
    surface: card,
    onSurface: text,
    surfaceContainerHighest: dark ? HfColors.darkTile : HfColors.segmentTrack,
    outline: line,
    outlineVariant: line,
  );

  TextStyle c(TextStyle s, Color color) => s.copyWith(color: color);

  final textTheme = TextTheme(
    displayLarge: c(HfText.hero, text),
    displayMedium: c(HfText.hero, text),
    displaySmall: c(HfText.headline, text),
    headlineLarge: c(HfText.headline, text),
    headlineMedium: c(HfText.title, text),
    headlineSmall: c(HfText.title, text),
    titleLarge: c(HfText.title, text),
    titleMedium: c(HfText.subsection, text),
    titleSmall: c(HfText.bodyStrong, text),
    bodyLarge: c(HfText.body, text),
    bodyMedium: c(HfText.body, text),
    bodySmall: c(HfText.note, muted),
    labelLarge: c(HfText.button, text),
    labelMedium: c(HfText.label, muted),
    labelSmall: c(HfText.badge, text),
  );

  final controlShape = RoundedRectangleBorder(
    borderRadius: BorderRadius.circular(HfRadius.control),
  );
  const buttonSize = Size(HfSpacing.tap, 56);
  const buttonPadding = EdgeInsets.symmetric(horizontal: 22, vertical: 16);

  OutlineInputBorder border(Color color, double width) => OutlineInputBorder(
    borderRadius: BorderRadius.circular(HfRadius.input),
    borderSide: BorderSide(color: color, width: width),
  );

  return ThemeData(
    useMaterial3: true,
    brightness: brightness,
    colorScheme: scheme,
    scaffoldBackgroundColor: page,
    canvasColor: page,
    fontFamily: HfText.bodyFamily,
    textTheme: textTheme,
    primaryTextTheme: textTheme,
    visualDensity: VisualDensity.standard,
    materialTapTargetSize: MaterialTapTargetSize.padded,
    appBarTheme: AppBarTheme(
      backgroundColor: page,
      foregroundColor: text,
      elevation: 0,
      scrolledUnderElevation: 0,
      centerTitle: false,
      titleTextStyle: c(HfText.title, text),
    ),
    elevatedButtonTheme: ElevatedButtonThemeData(
      style: ElevatedButton.styleFrom(
        backgroundColor: primary,
        foregroundColor: onPrimary,
        minimumSize: buttonSize,
        shape: controlShape,
        textStyle: HfText.button,
        elevation: 0,
        padding: buttonPadding,
      ),
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        backgroundColor: primary,
        foregroundColor: onPrimary,
        minimumSize: buttonSize,
        shape: controlShape,
        textStyle: HfText.button,
        padding: buttonPadding,
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        foregroundColor: text,
        minimumSize: buttonSize,
        shape: controlShape,
        backgroundColor: Colors.transparent,
        side: BorderSide(
          color: dark ? HfColors.lavenderLight : HfColors.ink,
          width: 2,
        ),
        padding: buttonPadding,
        textStyle: HfText.button,
      ),
    ),
    textButtonTheme: TextButtonThemeData(
      style: TextButton.styleFrom(
        foregroundColor: linkColor,
        minimumSize: const Size(HfSpacing.tap, HfSpacing.tap),
        textStyle: HfText.buttonSmall,
      ),
    ),
    chipTheme: ChipThemeData(
      backgroundColor: card,
      selectedColor: dark ? HfColors.darkTile : HfColors.sky,
      labelStyle: c(HfText.badge, text),
      side: BorderSide(color: dark ? HfColors.darkLine : HfColors.outlineChip),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(HfRadius.chip),
      ),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: card,
      contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 16),
      labelStyle: c(HfText.label, muted),
      hintStyle: c(HfText.note, muted),
      errorStyle: c(HfText.badge, dark ? HfColors.blushLight : HfColors.accent),
      border: border(line, 1),
      enabledBorder: border(line, 1),
      focusedBorder: border(dark ? HfColors.lavenderLight : HfColors.ink, 2),
      errorBorder: border(dark ? HfColors.blushLight : HfColors.accent, 1),
      focusedErrorBorder: border(
        dark ? HfColors.blushLight : HfColors.accent,
        2,
      ),
    ),
    dividerTheme: DividerThemeData(color: line, thickness: 1, space: 1),
    progressIndicatorTheme: ProgressIndicatorThemeData(
      color: dark ? HfColors.lavenderLight : HfColors.ink,
    ),
    snackBarTheme: SnackBarThemeData(
      behavior: SnackBarBehavior.floating,
      backgroundColor: dark ? HfColors.darkSelected : HfColors.ink,
      contentTextStyle: c(
        HfText.body,
        dark ? HfColors.darkText : HfColors.white,
      ),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(HfRadius.input),
      ),
    ),
    bottomSheetTheme: BottomSheetThemeData(
      backgroundColor: card,
      modalBackgroundColor: card,
      showDragHandle: true,
      dragHandleColor: dark ? HfColors.darkSelected : HfColors.handle,
      dragHandleSize: const Size(44, 5),
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(
          top: Radius.circular(HfRadius.sheet),
        ),
      ),
    ),
    switchTheme: SwitchThemeData(
      thumbColor: const WidgetStatePropertyAll<Color>(HfColors.white),
      trackColor: WidgetStateProperty.resolveWith<Color>(
        (states) => states.contains(WidgetState.selected)
            ? HfColors.rose
            : (dark ? HfColors.darkSelected : HfColors.handle),
      ),
      trackOutlineColor: const WidgetStatePropertyAll<Color>(
        Colors.transparent,
      ),
    ),
    sliderTheme: SliderThemeData(
      activeTrackColor: dark ? HfColors.lavenderLight : HfColors.lavenderDeep,
      inactiveTrackColor: dark ? HfColors.darkSelected : HfColors.segmentTrack,
      thumbColor: dark ? HfColors.lavenderLight : HfColors.lavenderDeep,
    ),
    dialogTheme: DialogThemeData(
      backgroundColor: card,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(HfRadius.card),
      ),
      titleTextStyle: c(HfText.title, text),
      contentTextStyle: c(HfText.body, text),
    ),
  );
}
