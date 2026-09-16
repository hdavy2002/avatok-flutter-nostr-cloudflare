import 'dart:async';
import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';
import 'ui_locale_controller.dart';

/// Fetch only the selected script/actually used weights. google_fonts prefers
/// bundled assets, then its public on-device font cache, then HTTPS. These font
/// files contain no account data. No all-language font download at startup.
/// First-ever offline use still depends on the OS script fonts until a reviewed
/// font bundle ships; cache availability is not claimed as universal coverage.
class UiFontPolicy {
  static const _families = <String, String>{
    'Deva': 'Noto Sans Devanagari', 'Beng': 'Noto Sans Bengali',
    'Gujr': 'Noto Sans Gujarati', 'Knda': 'Noto Sans Kannada',
    'Mlym': 'Noto Sans Malayalam', 'Mtei': 'Noto Sans Meetei Mayek',
    'Orya': 'Noto Sans Oriya', 'Guru': 'Noto Sans Gurmukhi',
    'Olck': 'Noto Sans Ol Chiki', 'Taml': 'Noto Sans Tamil',
    'Telu': 'Noto Sans Telugu', 'Arab': 'Noto Naskh Arabic',
  };
  static final Set<String> _requested = {};
  static final Set<String> _availableFamilies = GoogleFonts.asMap().keys.toSet();
  static String? get _family => _families[UiLocaleController.instance.selected.script];

  static TextStyle style(TextStyle base) {
    final family = _family;
    if (family == null) return base;
    var resolved = base;
    try {
      if (_availableFamilies.contains(family)) {
        resolved = GoogleFonts.getFont(family, textStyle: base);
        final key = '$family/${base.fontWeight}/${base.fontStyle}';
        if (_requested.add(key)) {
          unawaited(GoogleFonts.pendingFonts().then<void>((_) {},
              onError: (Object _, StackTrace __) {}));
        }
      }
    } catch (_) { /* Platform fallback keeps UI usable without a font fetch. */ }
    final minHeight = UiLocaleController.instance.selected.rtl ? 1.6 : 1.35;
    return resolved.copyWith(
      fontFamilyFallback: [family, family.replaceAll(' ', ''), 'sans-serif',
        ...?base.fontFamilyFallback],
      height: base.height == null || base.height! < minHeight ? minHeight : base.height,
      // Tracking splits joined Indic/Arabic shaping and is not carried across.
      letterSpacing: 0,
    );
  }

  static TextTheme textTheme(TextTheme theme) => theme.copyWith(
    displayLarge: style(theme.displayLarge ?? const TextStyle()),
    displayMedium: style(theme.displayMedium ?? const TextStyle()),
    displaySmall: style(theme.displaySmall ?? const TextStyle()),
    headlineLarge: style(theme.headlineLarge ?? const TextStyle()),
    headlineMedium: style(theme.headlineMedium ?? const TextStyle()),
    headlineSmall: style(theme.headlineSmall ?? const TextStyle()),
    titleLarge: style(theme.titleLarge ?? const TextStyle()),
    titleMedium: style(theme.titleMedium ?? const TextStyle()),
    titleSmall: style(theme.titleSmall ?? const TextStyle()),
    bodyLarge: style(theme.bodyLarge ?? const TextStyle()),
    bodyMedium: style(theme.bodyMedium ?? const TextStyle()),
    bodySmall: style(theme.bodySmall ?? const TextStyle()),
    labelLarge: style(theme.labelLarge ?? const TextStyle()),
    labelMedium: style(theme.labelMedium ?? const TextStyle()),
    labelSmall: style(theme.labelSmall ?? const TextStyle()),
  );
  static ThemeData theme(ThemeData base) => _family == null ? base : base.copyWith(
    textTheme: textTheme(base.textTheme), primaryTextTheme: textTheme(base.primaryTextTheme));
}
