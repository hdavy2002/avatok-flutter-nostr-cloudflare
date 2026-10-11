import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/core/theme/hf_theme.dart';
import 'package:hf_app/core/theme/hf_tokens.dart';

void main() {
  test('no text style in the theme is below 14 sp', () {
    final theme = buildHfTheme();
    final styles = <String, TextStyle?>{
      for (final e in {
        'displayLarge': theme.textTheme.displayLarge,
        'headlineMedium': theme.textTheme.headlineMedium,
        'titleLarge': theme.textTheme.titleLarge,
        'titleMedium': theme.textTheme.titleMedium,
        'bodyLarge': theme.textTheme.bodyLarge,
        'bodyMedium': theme.textTheme.bodyMedium,
        'bodySmall': theme.textTheme.bodySmall,
        'labelLarge': theme.textTheme.labelLarge,
        'labelMedium': theme.textTheme.labelMedium,
        'labelSmall': theme.textTheme.labelSmall,
      }.entries)
        e.key: e.value,
    };
    for (final e in styles.entries) {
      final size = e.value?.fontSize;
      if (size != null) expect(size, greaterThanOrEqualTo(HfText.minSize), reason: e.key);
    }
  });

  test('every HfText style is at least 14 sp', () {
    for (final s in [
      HfText.hero, HfText.headline, HfText.title, HfText.subtitle, HfText.bodyText, HfText.bodyStrong,
      HfText.note, HfText.badge, HfText.label, HfText.button,
    ]) {
      expect(s.fontSize, greaterThanOrEqualTo(HfText.minSize));
    }
  });

  test('approved bento surfaces keep readable ink and visible elevation', () {
    for (final surface in [HfColors.white, HfColors.cream, HfColors.mint,
      HfColors.sky, HfColors.lavender, HfColors.butter, HfColors.blush, HfColors.coral]) {
      final contrast = (surface.computeLuminance() + 0.05) / (HfColors.ink.computeLuminance() + 0.05);
      expect(contrast, greaterThanOrEqualTo(4.5), reason: '$surface');
    }
    expect(HfColors.white, isNot(HfColors.cream));
    expect(HfShadows.card, isNotEmpty);
  });
}
