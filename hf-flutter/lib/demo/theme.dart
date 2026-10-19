import 'package:flutter/material.dart';

/// Rang Bazaar palette (owner pick 2026-10-19: bright, happy, everyday India; a Jaipur fabric market).
/// Token names kept from the first draft so screens did not change: maroon = strong pink, deep = plum ink,
/// marigold = sunny lemon, brass = turquoise, gold = soft light text on dark. Never green.
abstract final class C {
  static const maroon = Color(0xFFC2185B); // rani pink (headings, strong buttons)
  static const deep = Color(0xFF2B1240); // plum ink (text, dark panels)
  static const cinema = Color(0xFF1A0B26); // behind reels
  static const marigold = Color(0xFFFFC21A); // sunny lemon-saffron (Call now)
  static const gold = Color(0xFFFFF1B0); // light text on pink / plum
  static const brass = Color(0xFF14A9C4); // turquoise (borders, knobs)
  static const brassDark = Color(0xFF0B6F86);
  static const ivory = Color(0xFFFFF8EE); // page
  static const paper = Color(0xFFFFFFFF);
  static const sand = Color(0xFFFFD9EC); // light pink fills
  static const sandLine = Color(0xFFFFC2DE);
  static const rani = Color(0xFFFF2E7A); // live dot, hearts
  static const ruby = Color(0xFFD81B4A);
  static const muted = Color(0xFF6A5478);
  static const cream = Color(0xFFF1E6FF);
  static const tan = Color(0xFF8E3FB0); // violet secondary text
  static const butter = Color(0xFFFFF1B8);
  static const saffron = Color(0xFFFF8A1F);
  static const turquoise = Color(0xFF14A9C4);
  static const violet = Color(0xFF7B2FBE);
  static const lemon = Color(0xFFFFE14D);
  static const white = Color(0xFFFFFFFF);
  static const clear = Color(0x00000000);
}

/// Text style helper. Nunito ships 400–800 in the app, so 800 is the heaviest weight.
TextStyle t(
  double size, {
  Color color = C.deep,
  FontWeight w = FontWeight.w800,
  double ls = 0,
  double h = 1.25,
}) {
  return TextStyle(
    fontFamily: 'Nunito',
    fontSize: size,
    color: color,
    fontWeight: w,
    letterSpacing: size * ls,
    height: h,
  );
}

/// Outline ("stroke") version of a headline.
TextStyle tOutline(double size, {Color color = C.maroon, double stroke = 2.5, double ls = 0.04, double h = 1.02}) {
  return TextStyle(
    fontFamily: 'Nunito',
    fontSize: size,
    fontWeight: FontWeight.w800,
    letterSpacing: size * ls,
    height: h,
    foreground: Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = stroke
      ..color = color,
  );
}

ThemeData buildTheme() {
  return ThemeData(
    useMaterial3: true,
    fontFamily: 'Nunito',
    scaffoldBackgroundColor: C.ivory,
    colorScheme: ColorScheme.fromSeed(
      seedColor: C.maroon,
      primary: C.maroon,
      secondary: C.marigold,
      surface: C.ivory,
    ),
    snackBarTheme: SnackBarThemeData(
      backgroundColor: C.deep,
      contentTextStyle: t(15, color: C.gold),
      behavior: SnackBarBehavior.floating,
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: C.paper,
      contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 16),
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(14),
        borderSide: const BorderSide(color: C.deep, width: 3),
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(14),
        borderSide: const BorderSide(color: C.deep, width: 3),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(14),
        borderSide: const BorderSide(color: C.marigold, width: 3),
      ),
      hintStyle: t(16, color: C.muted, w: FontWeight.w600),
    ),
  );
}

/// Indian-grouped rupees: 124050.5 -> ₹1,24,050.50
String inr(num value, {bool paise = true, bool sign = false}) {
  final neg = value < 0;
  final cents = (value.abs() * 100).round();
  final whole = cents ~/ 100;
  final p = cents % 100;
  final s = whole.toString();
  String grouped;
  if (s.length <= 3) {
    grouped = s;
  } else {
    final last3 = s.substring(s.length - 3);
    var rest = s.substring(0, s.length - 3);
    final parts = <String>[];
    while (rest.length > 2) {
      parts.insert(0, rest.substring(rest.length - 2));
      rest = rest.substring(0, rest.length - 2);
    }
    if (rest.isNotEmpty) parts.insert(0, rest);
    grouped = '${parts.join(',')},$last3';
  }
  final tail = paise ? '.${p.toString().padLeft(2, '0')}' : '';
  final prefix = neg ? '− ' : (sign ? '+ ' : '');
  return '$prefix₹$grouped$tail';
}
