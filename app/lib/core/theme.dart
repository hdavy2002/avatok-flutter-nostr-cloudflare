import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';

/// Design tokens lifted from the AvaTOK mockup.
class AvaColors {
  static const brand = Color(0xFF08C4C4);
  static const brand50 = Color(0xFFE2FCFC);
  static const ink = Color(0xFF0F1115);
  static const sub = Color(0xFF737A86);
  static const line = Color(0xFFECEEF1);
  static const soft = Color(0xFFF2F3F5);
  static const bg = Color(0xFFFFFFFF);
  static const danger = Color(0xFFEF4444);
  static const success = Color(0xFF22C55E);
  static const coral = Color(0xFFFF5A4D);

  /// Welcome screen background: deep ink/navy — calm and premium; the white
  /// logo card, brand accents and CTA carry the color. (Was a bright teal.)
  static const welcomeGradient = LinearGradient(
    begin: Alignment.topCenter,
    end: Alignment.bottomCenter,
    colors: [Color(0xFF171C2E), Color(0xFF0C0F1C)],
  );

  /// CREATOR DROP banner gradient (orange → pink).
  static const dropGradient = LinearGradient(
    begin: Alignment.centerLeft,
    end: Alignment.centerRight,
    colors: [Color(0xFFFFA24D), Color(0xFFFF6F8B)],
  );

  /// Diagonal gradient presets for product thumbnails.
  static const thumbGradients = <LinearGradient>[
    LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight,
        colors: [Color(0xFF4F8DFD), Color(0xFF6FB0FF)]),
    LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight,
        colors: [Color(0xFFB06AF0), Color(0xFFD08BF5)]),
    LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight,
        colors: [Color(0xFF22D3C0), Color(0xFF4FE0CF)]),
    LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight,
        colors: [Color(0xFFFF7A59), Color(0xFFFF9E72)]),
    LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight,
        colors: [Color(0xFFFF6FA5), Color(0xFFFF9AC2)]),
  ];
}

class AvaTheme {
  static ThemeData get light {
    final base = ThemeData(
      useMaterial3: true,
      colorScheme: ColorScheme.fromSeed(
        seedColor: AvaColors.brand,
        primary: AvaColors.brand,
        surface: Colors.white,
      ),
      scaffoldBackgroundColor: AvaColors.bg,
    );

    // Nunito for body, Comfortaa for display/titles.
    final textTheme = GoogleFonts.nunitoTextTheme(base.textTheme).copyWith(
      displayLarge: GoogleFonts.comfortaa(
          fontWeight: FontWeight.w800, color: AvaColors.ink),
      headlineSmall: GoogleFonts.comfortaa(
          fontWeight: FontWeight.w700, color: AvaColors.ink),
      titleLarge: GoogleFonts.comfortaa(
          fontWeight: FontWeight.w700, color: AvaColors.ink),
      titleMedium: GoogleFonts.nunito(
          fontWeight: FontWeight.w700, color: AvaColors.ink),
    );

    return base.copyWith(
      textTheme: textTheme,
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          backgroundColor: AvaColors.brand,
          foregroundColor: Colors.white,
          padding: const EdgeInsets.symmetric(vertical: 16),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
          textStyle: GoogleFonts.nunito(fontSize: 16, fontWeight: FontWeight.w700),
        ),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: Colors.white,
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(14),
          borderSide: BorderSide.none,
        ),
      ),
      cardTheme: CardThemeData(
        color: Colors.white,
        elevation: 0,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18)),
      ),
    );
  }

  /// Pacifico script for the wordmark.
  static TextStyle wordmark(double size, {Color color = AvaColors.ink}) =>
      GoogleFonts.pacifico(fontSize: size, color: color);
}
