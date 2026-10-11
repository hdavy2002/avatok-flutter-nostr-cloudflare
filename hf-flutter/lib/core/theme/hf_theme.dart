import 'package:flutter/material.dart';

import 'hf_tokens.dart';

/// The one ThemeData of the app (light only). Every text style is 14 sp or bigger.
ThemeData buildHfTheme() {
  const scheme = ColorScheme(
    brightness: Brightness.light,
    primary: HfColors.plum,
    onPrimary: HfColors.cream,
    secondary: HfColors.orchid,
    onSecondary: HfColors.cream,
    tertiary: HfColors.rose,
    onTertiary: HfColors.cream,
    error: HfColors.accent,
    onError: HfColors.cream,
    surface: HfColors.white,
    onSurface: HfColors.plum,
    outline: HfColors.line,
    outlineVariant: HfColors.line,
  );

  const textTheme = TextTheme(
    displayLarge: HfText.hero,
    displayMedium: HfText.hero,
    displaySmall: HfText.headline,
    headlineLarge: HfText.headline,
    headlineMedium: HfText.title,
    headlineSmall: HfText.title,
    titleLarge: HfText.title,
    titleMedium: HfText.subtitle,
    titleSmall: HfText.bodyStrong,
    bodyLarge: HfText.bodyText,
    bodyMedium: HfText.bodyText,
    bodySmall: HfText.note,
    labelLarge: HfText.button,
    labelMedium: HfText.label,
    labelSmall: HfText.badge,
  );

  final controlShape = RoundedRectangleBorder(borderRadius: BorderRadius.circular(HfRadius.control));
  const minButton = Size(HfSpacing.tap, 52);

  return ThemeData(
    useMaterial3: true,
    colorScheme: scheme,
    scaffoldBackgroundColor: HfColors.cream,
    fontFamily: HfText.body,
    textTheme: textTheme,
    primaryTextTheme: textTheme,
    visualDensity: VisualDensity.standard,
    materialTapTargetSize: MaterialTapTargetSize.padded,
    appBarTheme: const AppBarTheme(
      backgroundColor: HfColors.cream,
      foregroundColor: HfColors.plum,
      elevation: 0,
      scrolledUnderElevation: 0,
      centerTitle: false,
      titleTextStyle: HfText.title,
    ),
    elevatedButtonTheme: ElevatedButtonThemeData(
      style: ElevatedButton.styleFrom(
        backgroundColor: HfColors.coral,
        foregroundColor: HfColors.ink,
        minimumSize: minButton,
        shape: controlShape,
        textStyle: HfText.button,
        elevation: 3,
        shadowColor: HfColors.coral.withValues(alpha: 0.35),
        padding: const EdgeInsets.symmetric(horizontal: 22, vertical: 16),
      ),
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        backgroundColor: HfColors.coral,
        foregroundColor: HfColors.ink,
        minimumSize: minButton,
        shape: controlShape,
        textStyle: HfText.button,
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        foregroundColor: HfColors.plum,
        minimumSize: minButton,
        shape: controlShape,
        backgroundColor: HfColors.white,
        side: const BorderSide(color: HfColors.line),
        padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 16),
        textStyle: HfText.button,
      ),
    ),
    textButtonTheme: TextButtonThemeData(
      style: TextButton.styleFrom(
        foregroundColor: HfColors.orchid,
        minimumSize: const Size(HfSpacing.tap, HfSpacing.tap),
        textStyle: HfText.button,
      ),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: HfColors.white,
      contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 16),
      labelStyle: HfText.label,
      hintStyle: HfText.note,
      errorStyle: HfText.badge.copyWith(color: HfColors.accent),
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(HfRadius.control),
        borderSide: const BorderSide(color: HfColors.line, width: 1.5),
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(HfRadius.control),
        borderSide: const BorderSide(color: HfColors.line, width: 1.5),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(HfRadius.control),
        borderSide: const BorderSide(color: HfColors.orchid, width: 2),
      ),
      errorBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(HfRadius.control),
        borderSide: const BorderSide(color: HfColors.accent, width: 1.5),
      ),
      focusedErrorBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(HfRadius.control),
        borderSide: const BorderSide(color: HfColors.accent, width: 2),
      ),
    ),
    dividerTheme: const DividerThemeData(color: HfColors.line, thickness: 1, space: 1),
    progressIndicatorTheme: const ProgressIndicatorThemeData(color: HfColors.plum),
    snackBarTheme: SnackBarThemeData(
      behavior: SnackBarBehavior.floating,
      backgroundColor: HfColors.plum,
      contentTextStyle: HfText.bodyText.copyWith(color: HfColors.cream),
      shape: controlShape,
    ),
    bottomSheetTheme: const BottomSheetThemeData(
      backgroundColor: HfColors.cream,
      showDragHandle: true,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(HfRadius.pill)),
      ),
    ),
  );
}
