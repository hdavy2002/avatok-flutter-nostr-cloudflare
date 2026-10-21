import 'package:flutter/material.dart';

import '../ui/motion.dart';

/// "Rangoli Soft" palette (owner decision 2026-10-20 [HF-PALETTE-RANGOLI-1]): paler, calmer, lavender-indigo with
/// rose and soft marigold. Token NAMES are kept from the Rang Bazaar draft so screens did not change; the meaning of
/// each name is in its comment. Artwork keeps its own colours. Green is allowed ONLY for the Online state (online* tokens).
abstract final class C {
  static const maroon = Color(0xFF6D63B8); // PRIMARY lavender indigo (headings, buttons, selected tab). White text on it passes 5:1
  static const deep = Color(0xFF2B2645); // ink (text, dark panels)
  static const cinema = Color(0xFF1A0B26); // behind reels (video scrim, unchanged)
  static const marigold = Color(0xFFF4CF73); // soft marigold CTA (Call now). Ink text on it
  static const gold = Color(0xFFFFF6DE); // light text on indigo / ink panels
  static const brass = Color(0xFF8C84CC); // soft indigo borders and knobs
  static const brassDark = Color(0xFF4F4796); // deep indigo (icons and ink on pale fills)
  static const ivory = Color(0xFFFBF8FF); // page
  static const paper = Color(0xFFFFFFFF);
  static const sand = Color(0xFFEFEBFB); // chip / light fills
  static const sandLine = Color(0xFFE2DCF3); // borders
  static const rani = Color(0xFFD9809B); // rose accent (hearts, ring). Not for text with white on top
  static const ruby = Color(0xFFB8385A); // error / destructive (text passes 4.5:1 on white)
  static const muted = Color(0xFF726D88); // muted text (passes 4.5:1 on the page)
  static const cream = Color(0xFFF2EEFC); // light text on dark panels, pale fills
  static const tan = Color(0xFFB0537A); // secondary / eyebrow text: dark rose, passes 4.5:1 on white
  static const butter = Color(0xFFFDF1D3); // pale marigold fill
  static const saffron = Color(0xFFEBA05A); // soft saffron (decorative dots, gradients)
  static const turquoise = Color(0xFF8C84CC); // was turquoise; now soft indigo borders / dots
  static const violet = Color(0xFF8F80D6); // decorative violet
  static const lemon = Color(0xFFF4CF73); // same soft marigold (accent on indigo / ink)
  static const white = Color(0xFFFFFFFF);
  static const clear = Color(0x00000000);

  // Online state is the one place green is allowed.
  static const onlineBg = Color(0xFFE3F6E8); // pale green fill
  static const onlineLine = Color(0xFFA2DAB3); // pale green border
  static const onlineInk = Color(0xFF1F6B3F); // dark green text / icons on onlineBg (passes 4.5:1)
  static const onlineDot = Color(0xFF3FA868); // green dot, Online pill fill
  // Footer (both bottom bars) kolam background and motif stroke.
  static const footerBg = Color(0xFFF6F2FD);
  static const footerDot = Color(0xFFDCD3F1);
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
    fontSize: size < 14 ? 14 : size, // [HF-WIRE-12] nothing under 14 sp
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
    pageTransitionsTheme: const PageTransitionsTheme(builders: {
      TargetPlatform.android: HfPageTransitionsBuilder(),
      TargetPlatform.iOS: HfPageTransitionsBuilder(cupertino: true),
      TargetPlatform.macOS: HfPageTransitionsBuilder(cupertino: true),
    }),
    fontFamily: 'Nunito',
    scaffoldBackgroundColor: C.ivory,
    colorScheme: ColorScheme.fromSeed(
      seedColor: C.maroon,
      primary: C.maroon,
      secondary: C.marigold,
      surface: C.ivory,
      onPrimary: C.white,
      onSecondary: C.deep,
      onSurface: C.deep,
    ),
    dividerColor: C.sandLine,
    switchTheme: SwitchThemeData(
      thumbColor: WidgetStateProperty.resolveWith((s) => s.contains(WidgetState.selected) ? C.white : C.brass),
      trackColor: WidgetStateProperty.resolveWith((s) => s.contains(WidgetState.selected) ? C.maroon : C.sand),
      trackOutlineColor: WidgetStateProperty.resolveWith((s) => s.contains(WidgetState.selected) ? C.maroon : C.brass),
    ),
    dialogTheme: DialogThemeData(
      backgroundColor: C.paper,
      surfaceTintColor: C.clear,
      titleTextStyle: t(20, color: C.deep),
      contentTextStyle: t(16, color: C.deep, w: FontWeight.w600),
    ),
    bottomSheetTheme: const BottomSheetThemeData(backgroundColor: C.paper, surfaceTintColor: C.clear),
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
        borderSide: const BorderSide(color: C.brass, width: 2),
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(14),
        borderSide: const BorderSide(color: C.brass, width: 2),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(14),
        borderSide: const BorderSide(color: C.maroon, width: 3),
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
