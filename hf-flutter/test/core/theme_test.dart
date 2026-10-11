import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/core/theme/hf_theme.dart';

/// Every TextStyle reachable from a ThemeData that this app configures.
Map<String, TextStyle?> _themeStyles(ThemeData t) => {
      for (final e in {
        'displayLarge': t.textTheme.displayLarge,
        'displayMedium': t.textTheme.displayMedium,
        'displaySmall': t.textTheme.displaySmall,
        'headlineLarge': t.textTheme.headlineLarge,
        'headlineMedium': t.textTheme.headlineMedium,
        'headlineSmall': t.textTheme.headlineSmall,
        'titleLarge': t.textTheme.titleLarge,
        'titleMedium': t.textTheme.titleMedium,
        'titleSmall': t.textTheme.titleSmall,
        'bodyLarge': t.textTheme.bodyLarge,
        'bodyMedium': t.textTheme.bodyMedium,
        'bodySmall': t.textTheme.bodySmall,
        'labelLarge': t.textTheme.labelLarge,
        'labelMedium': t.textTheme.labelMedium,
        'labelSmall': t.textTheme.labelSmall,
        'appBarTitle': t.appBarTheme.titleTextStyle,
        'snackBar': t.snackBarTheme.contentTextStyle,
        'chipLabel': t.chipTheme.labelStyle,
        'inputLabel': t.inputDecorationTheme.labelStyle,
        'inputHint': t.inputDecorationTheme.hintStyle,
        'inputError': t.inputDecorationTheme.errorStyle,
        'dialogTitle': t.dialogTheme.titleTextStyle,
        'dialogContent': t.dialogTheme.contentTextStyle,
      }.entries)
        e.key: e.value,
    };

void main() {
  for (final entry in {'light': buildHfTheme(), 'dark': buildHfDarkTheme()}.entries) {
    test('no text style in the ${entry.key} theme is below 14 sp', () {
      for (final e in _themeStyles(entry.value).entries) {
        final size = e.value?.fontSize;
        if (size != null) expect(size, greaterThanOrEqualTo(HfText.minSize), reason: '${entry.key} ${e.key}');
      }
    });

    test('button text styles in the ${entry.key} theme are at least 14 sp', () {
      final t = entry.value;
      final styles = [
        t.filledButtonTheme.style?.textStyle?.resolve({}),
        t.elevatedButtonTheme.style?.textStyle?.resolve({}),
        t.outlinedButtonTheme.style?.textStyle?.resolve({}),
        t.textButtonTheme.style?.textStyle?.resolve({}),
      ];
      for (final s in styles) {
        expect(s?.fontSize, isNotNull);
        expect(s!.fontSize, greaterThanOrEqualTo(HfText.minSize));
      }
    });
  }

  test('light and dark themes have the right brightness and page colour', () {
    final light = buildHfTheme();
    final dark = buildHfDarkTheme();
    expect(light.brightness, Brightness.light);
    expect(dark.brightness, Brightness.dark);
    expect(light.scaffoldBackgroundColor, HfColors.page);
    expect(dark.scaffoldBackgroundColor, HfColors.darkBg);
    expect(light.useMaterial3, isTrue);
  });

  test('every HfText style is at least 14 sp', () {
    for (final s in [
      HfText.hero, HfText.headline, HfText.title, HfText.section, HfText.subsection, HfText.stat, HfText.statSmall,
      HfText.body, HfText.bodyStrong, HfText.note, HfText.badge, HfText.label, HfText.button, HfText.buttonSmall,
    ]) {
      expect(s.fontSize, greaterThanOrEqualTo(HfText.minSize));
    }
  });

  test('HfText.onDark recolours ink and muted only', () {
    expect(HfText.onDark(HfText.body).color, HfColors.darkText);
    expect(HfText.onDark(HfText.note).color, HfColors.mutedSoft);
    expect(HfText.onDark(HfText.badge.copyWith(color: HfColors.blushDeep)).color, HfColors.blushDeep);
  });

  test('pastel tints keep readable ink and the card shadow is visible', () {
    for (final pair in <(Color, Color)>[
      (HfColors.lavender, HfColors.lavenderInk),
      (HfColors.peach, HfColors.peachInk),
      (HfColors.sky, HfColors.skyInk),
      (HfColors.butter, HfColors.butterInk),
      (HfColors.blush, HfColors.blushInk),
      (HfColors.page, HfColors.ink),
      (HfColors.white, HfColors.ink),
    ]) {
      final lighter = pair.$1.computeLuminance() > pair.$2.computeLuminance() ? pair.$1 : pair.$2;
      final darker = pair.$1.computeLuminance() > pair.$2.computeLuminance() ? pair.$2 : pair.$1;
      final contrast = (lighter.computeLuminance() + 0.05) / (darker.computeLuminance() + 0.05);
      expect(contrast, greaterThanOrEqualTo(4.5), reason: '${pair.$1} / ${pair.$2}');
    }
    expect(HfColors.white, isNot(HfColors.page));
    expect(HfShadows.card, isNotEmpty);
  });

  testWidgets('HfMotion.of is zero when animations are disabled', (tester) async {
    late Duration normal;
    late Duration reduced;
    await tester.pumpWidget(MediaQuery(
      data: const MediaQueryData(),
      child: Builder(builder: (context) {
        normal = HfMotion.of(context, HfMotion.base);
        return const SizedBox();
      }),
    ));
    await tester.pumpWidget(MediaQuery(
      data: const MediaQueryData(disableAnimations: true),
      child: Builder(builder: (context) {
        reduced = HfMotion.of(context, HfMotion.base);
        return const SizedBox();
      }),
    ));
    expect(normal, const Duration(milliseconds: 220));
    expect(reduced, Duration.zero);
  });
}
