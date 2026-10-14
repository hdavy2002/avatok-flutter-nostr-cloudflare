import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/core/theme/theme_mode_store.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  test('defaults to dark', () async {
    SharedPreferences.setMockInitialValues({});
    final c = ProviderContainer();
    addTearDown(c.dispose);
    expect(c.read(themeModeProvider), ThemeMode.dark);
    await Future<void>.delayed(Duration.zero);
    expect(c.read(themeModeProvider), ThemeMode.dark);
  });

  for (final mode in ThemeMode.values) {
    test('loads the saved ${mode.name} mode without overwriting it', () async {
      SharedPreferences.setMockInitialValues({kThemeModePrefKey: mode.name});
      final c = ProviderContainer();
      addTearDown(c.dispose);
      c.read(themeModeProvider);
      await Future<void>.delayed(const Duration(milliseconds: 20));
      expect(c.read(themeModeProvider), mode);
      final prefs = await SharedPreferences.getInstance();
      expect(prefs.getString(kThemeModePrefKey), mode.name);
    });
  }

  for (final invalid in <Object>['unknown', 42]) {
    test('invalid or unreadable preference $invalid keeps dark default', () async {
      SharedPreferences.setMockInitialValues({kThemeModePrefKey: invalid});
      final c = ProviderContainer();
      addTearDown(c.dispose);
      expect(c.read(themeModeProvider), ThemeMode.dark);
      await Future<void>.delayed(const Duration(milliseconds: 20));
      expect(c.read(themeModeProvider), ThemeMode.dark);
    });
  }

  test('a choice during the saved-mode read wins', () async {
    SharedPreferences.setMockInitialValues({kThemeModePrefKey: 'system'});
    final c = ProviderContainer();
    addTearDown(c.dispose);
    c.read(themeModeProvider);
    await c.read(themeModeProvider.notifier).set(ThemeMode.light);
    await Future<void>.delayed(const Duration(milliseconds: 20));
    expect(c.read(themeModeProvider), ThemeMode.light);
    final prefs = await SharedPreferences.getInstance();
    expect(prefs.getString(kThemeModePrefKey), 'light');
  });

  test('set saves the mode', () async {
    SharedPreferences.setMockInitialValues({});
    final c = ProviderContainer();
    addTearDown(c.dispose);
    await c.read(themeModeProvider.notifier).set(ThemeMode.system);
    expect(c.read(themeModeProvider), ThemeMode.system);
    final prefs = await SharedPreferences.getInstance();
    expect(prefs.getString(kThemeModePrefKey), 'system');
  });
}
