import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';

/// Design tokens lifted from the AvaTOK mockup.
class AvaColors {
  static const brand = Color(0xFF08C4C4);
  static const brand50 = Color(0xFFE2FCFC);
  static const ink = Color(0xFF0F1115);
  static const sub = Color(0xFF737A86);
  static const line = Color(0xFFECEEF1);
  static const soft = Color(0xFFF4F5F7);
  static const bg = Color(0xFFE7E9EE);
  static const danger = Color(0xFFEF4444);
  static const success = Color(0xFF22C55E);
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
