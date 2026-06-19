import 'package:flutter/material.dart';

import 'ui/zine.dart';

export 'ui/zine.dart';

/// Legacy color names, re-pointed at the AvaTOK design-system (zine) palette so
/// every screen that still references AvaColors gets the new look. New code
/// should use [Zine] / [ZineText] from core/ui/zine.dart directly.
class AvaColors {
  /// Brand accent (was bright teal) → deep teal-blue accent ink.
  static const brand = Zine.blueInk;
  static const brand50 = Zine.blue;
  static const ink = Zine.ink;
  static const sub = Zine.inkSoft;
  /// Hairlines/dividers — ink at 25%.
  static const line = Color(0x40231B14);
  static const soft = Zine.paper2;
  static const bg = Zine.paper;
  static const danger = Zine.coral;
  static const success = Zine.mintInk;
  static const coral = Zine.coral;

  /// Welcome backdrop — flat deep teal (the single permitted dark surface,
  /// §7.16). Kept as a "gradient" type for API compatibility, but both stops
  /// are identical: NO real gradients in the system.
  static const welcomeGradient = LinearGradient(
    begin: Alignment.topCenter,
    end: Alignment.bottomCenter,
    colors: [Color(0xFF062D2A), Color(0xFF062D2A)],
  );

  /// CREATOR DROP banner — flat coral (white text is allowed on coral).
  static const dropGradient = LinearGradient(
    begin: Alignment.centerLeft,
    end: Alignment.centerRight,
    colors: [Zine.coral, Zine.coral],
  );

  /// Avatar/thumbnail fills — flat poster accents (each "gradient" is a single
  /// flat color; avatars are bordered circles with flat fills, §6).
  static const thumbGradients = <LinearGradient>[
    LinearGradient(colors: [Zine.blue, Zine.blue]),
    LinearGradient(colors: [Zine.lilac, Zine.lilac]),
    LinearGradient(colors: [Zine.mint, Zine.mint]),
    LinearGradient(colors: [Zine.lime, Zine.lime]),
    LinearGradient(colors: [Zine.coral, Zine.coral]),
  ];
}

class AvaTheme {
  static ThemeData get light {
    final base = ThemeData(
      useMaterial3: true,
      colorScheme: ColorScheme.fromSeed(
        seedColor: Zine.blueInk,
        primary: Zine.blueInk,
        secondary: Zine.lime,
        error: Zine.coral,
        surface: Zine.card,
      ),
      scaffoldBackgroundColor: Zine.paper,
      fontFamily: ZineText.body,
    );

    // Fredoka for display/titles, Nunito (>=600) for body — bundled fonts.
    final textTheme = base.textTheme.apply(
      fontFamily: ZineText.body,
      bodyColor: Zine.ink,
      displayColor: Zine.ink,
    ).copyWith(
      displayLarge: ZineText.hero(size: 38),
      displayMedium: ZineText.hero(size: 34),
      headlineMedium: ZineText.hero(size: 28),
      headlineSmall: ZineText.appbar(),
      titleLarge: ZineText.cardTitle(size: 21),
      titleMedium: ZineText.value(size: 16),
      bodyLarge: ZineText.sub(size: 16, color: Zine.ink),
      bodyMedium: ZineText.sub(size: 14.5, color: Zine.ink),
      labelLarge: ZineText.button(size: 17),
      labelSmall: ZineText.kicker(),
    );

    return base.copyWith(
      textTheme: textTheme,
      appBarTheme: AppBarTheme(
        backgroundColor: Zine.paper2,
        foregroundColor: Zine.ink,
        elevation: 0,
        scrolledUnderElevation: 0,
        centerTitle: false,
        titleTextStyle: ZineText.appbar(),
        shape: const Border(bottom: BorderSide(color: Zine.ink, width: Zine.bw)),
      ),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          backgroundColor: Zine.lime,
          foregroundColor: Zine.ink,
          disabledBackgroundColor: Zine.paper2,
          disabledForegroundColor: Zine.inkMute,
          padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 15),
          shape: const StadiumBorder(side: BorderSide(color: Zine.ink, width: Zine.bw)),
          textStyle: ZineText.button(size: 17),
          elevation: 0,
        ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          foregroundColor: Zine.ink,
          side: const BorderSide(color: Zine.ink, width: Zine.bw),
          shape: const StadiumBorder(),
          textStyle: ZineText.button(size: 15),
        ),
      ),
      textButtonTheme: TextButtonThemeData(
        style: TextButton.styleFrom(
          foregroundColor: Zine.blueInk,
          textStyle: ZineText.link(size: 13.5),
        ),
      ),
      // NO default box. The zine design wraps every input in its own bordered
      // container (ZineTextField, the chat composer, search bars), so a themed
      // filled+outlined box here drew a SECOND bar inside that container (the
      // "double bar" bug). Keep the theme borderless/unfilled; containers supply
      // the visual. (2026-06-18)
      inputDecorationTheme: InputDecorationTheme(
        filled: false,
        isDense: true,
        hintStyle: ZineText.input(size: 16).copyWith(color: Zine.placeholder, fontWeight: FontWeight.w700),
        labelStyle: ZineText.kicker(size: 12),
        border: InputBorder.none,
        enabledBorder: InputBorder.none,
        focusedBorder: InputBorder.none,
        disabledBorder: InputBorder.none,
        errorBorder: InputBorder.none,
        focusedErrorBorder: InputBorder.none,
      ),
      cardTheme: CardThemeData(
        color: Zine.card,
        elevation: 0,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(Zine.r),
          side: const BorderSide(color: Zine.ink, width: Zine.bw),
        ),
      ),
      dividerTheme: const DividerThemeData(color: AvaColors.line, thickness: 1.5),
      chipTheme: base.chipTheme.copyWith(
        backgroundColor: Zine.card,
        selectedColor: Zine.lime,
        labelStyle: ZineText.tag(size: 12.5),
        side: const BorderSide(color: Zine.ink, width: 2),
        shape: const StadiumBorder(),
      ),
      switchTheme: SwitchThemeData(
        thumbColor: WidgetStateProperty.resolveWith(
            (s) => s.contains(WidgetState.selected) ? Zine.ink : Zine.card),
        trackColor: WidgetStateProperty.resolveWith(
            (s) => s.contains(WidgetState.selected) ? Zine.lime : Zine.paper2),
        trackOutlineColor: const WidgetStatePropertyAll(Zine.ink),
        trackOutlineWidth: const WidgetStatePropertyAll(2),
      ),
      snackBarTheme: SnackBarThemeData(
        backgroundColor: Zine.ink,
        contentTextStyle: ZineText.value(size: 14, color: Zine.paper),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
        behavior: SnackBarBehavior.floating,
      ),
      progressIndicatorTheme: const ProgressIndicatorThemeData(color: Zine.blueInk),
    );
  }

  /// Brand wordmark — Fredoka 700 (the only display font in the system).
  static TextStyle wordmark(double size, {Color color = Zine.ink}) => TextStyle(
      fontFamily: ZineText.display, fontWeight: FontWeight.w700,
      fontSize: size, letterSpacing: -0.02 * size, color: color);
}
