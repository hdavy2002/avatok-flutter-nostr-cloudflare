import 'package:flutter/material.dart';

/// [HF-APP-DESI-1] Dashboard palette (owner 2026-10-22: "colors and design layouts on dashboards and app look the same"),
/// replacing the earlier "Rangoli Soft" values. Token NAMES kept so screens did not change. Was: "Rangoli Soft" palette (owner decision 2026-10-20 [HF-PALETTE-RANGOLI-1]): paler, calmer, lavender-indigo with
/// rose and soft marigold. Token NAMES are kept from the Rang Bazaar draft so screens did not change; the meaning of
/// each name is in its comment. Artwork keeps its own colours. Green is allowed ONLY for the Online state (online* tokens).
abstract final class C {
  static const maroon = Color(0xFF4A1747); // PRIMARY lavender indigo (headings, buttons, selected tab). White text on it passes 5:1
  static const deep = Color(0xFF2B1530); // ink (text, dark panels)
  static const cinema = Color(0xFF1A0B26); // behind reels (video scrim, unchanged)
  static const marigold = Color(0xFFF59E0B); // soft marigold CTA (Call now). Ink text on it
  static const gold = Color(0xFFFFF1D6); // light text on indigo / ink panels
  static const brass = Color(0xFFD9C3D4); // soft indigo borders and knobs
  static const brassDark = Color(0xFF6B2468); // deep indigo (icons and ink on pale fills)
  static const ivory = Color(0xFFFFF8F0); // page
  static const paper = Color(0xFFFFFFFF);
  static const sand = Color(0xFFF8EEE6); // chip / light fills
  static const sandLine = Color(0xFFF1E3D6); // borders
  static const rani = Color(0xFFD81B72); // rose accent (hearts, ring). Not for text with white on top
  static const ruby = Color(0xFFC0262D); // error / destructive (text passes 4.5:1 on white)
  static const muted = Color(0xFF6F5B6F); // muted text (passes 4.5:1 on the page)
  static const cream = Color(0xFFFFFAF3); // light text on dark panels, pale fills
  static const tan = Color(0xFFC2185B); // secondary / eyebrow text: dark rose, passes 4.5:1 on white
  static const butter = Color(0xFFFFF1D6); // pale marigold fill
  static const saffron = Color(0xFFEA6A12); // soft saffron (decorative dots, gradients)
  static const turquoise = Color(0xFF0E7C86); // was turquoise; now soft indigo borders / dots
  static const violet = Color(0xFF6D4FD0); // decorative violet
  static const lemon = Color(0xFFFBBF24); // same soft marigold (accent on indigo / ink)
  // [HF-APP-DESI-1] dashboard tokens (styles/hf-dash3.css)
  static const plum2 = Color(0xFF6B2468);
  static const lav = Color(0xFF6D4FD0);
  static const peacock = Color(0xFF0E7C86);
  static const amber = Color(0xFFB45309);
  static const blush = Color(0xFFFFE6EF);
  static const lavtint = Color(0xFFF1EBFF);
  static const goldtint = Color(0xFFFFF1D6);
  static const teatint = Color(0xFFE3F6F6);
  static const line = Color(0xFFF1E3D6);
  static const white = Color(0xFFFFFFFF);
  static const clear = Color(0x00000000);

  // Online state is the one place green is allowed.
  static const onlineBg = Color(0xFFE3F6E8); // pale green fill
  static const onlineLine = Color(0xFFA2DAB3); // pale green border
  static const onlineInk = Color(0xFF1F6B3F); // dark green text / icons on onlineBg (passes 4.5:1)
  static const onlineDot = Color(0xFF3FA868); // green dot, Online pill fill
  // Footer (both bottom bars) kolam background and motif stroke.
  static const footerBg = Color(0xFFFFFAF3);
  static const footerDot = Color(0xFFF1E3D6);
}

/// [HF-CHANNEL-APP-1] "Galli Pop" tokens (owner mock 2026-10-23, Specs: .agent-wt/mock/gp.css): the colours of the influencer
/// channel page, product page, bag and checkout. Truck-art red / marigold / blue / rani on ivory and ink. No green.
abstract final class GP {
  static const bg = Color(0xFFFFF9F0); // page
  static const paper = Color(0xFFFFFFFF);
  static const ink = Color(0xFF1F1630); // text, dark sections, dark buttons
  static const black = Color(0xFF000000); // under-edge of the dark button
  static const muted = Color(0xFF625872);
  static const line = Color(0xFFECE3D6);
  static const tile = Color(0xFFF5EEE4); // plain soft product tile (D3: no arch, no shelf)
  static const red = Color(0xFFE2231A);
  static const redDeep = Color(0xFFB3170F);
  static const mari = Color(0xFFFFB000);
  static const yel = Color(0xFFFFD400);
  static const yelDeep = Color(0xFFC9A400);
  static const rani = Color(0xFFE0157A);
  static const raniTint = Color(0xFFFDE7F1);
  static const blue = Color(0xFF1B3FA0);
  static const blueTint = Color(0xFFE7ECFB);
  static const blueSoft = Color(0xFF9FB2F0); // light end of a video wash
  static const mariTint = Color(0xFFFFF1CC);
  static const onDark = Color(0xFFE2DBEE); // body text on ink
  static const onDarkMuted = Color(0xFFCFC8E0);
  static const inputLine = Color(0xFFD8CCBB);
  static const shadow = Color(0x331F1630); // soft drop shadow
  static const scrim = Color(0xA81F1630); // dim around the crop window
  static const veil = Color(0xEEFFFFFF); // pale chip on a photo
  static const gridLine = Color(0x55FFFFFF); // rule-of-thirds lines
  static const darkTile = Color(0xFF2C2142); // art slot on the ink "order placed" panel
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
