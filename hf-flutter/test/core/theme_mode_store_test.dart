import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/core/theme/theme_mode_store.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  test('defaults to light', () async {
    SharedPreferences.setMockInitialValues({});
    final c = ProviderContainer();
    addTearDown(c.dispose);
    expect(c.read(themeModeProvider), ThemeMode.light);
    await Future<void>.delayed(Duration.zero);
    expect(c.read(themeModeProvider), ThemeMode.light);
  });

  test('loads the saved mode', () async {
    SharedPreferences.setMockInitialValues({kThemeModePrefKey: 'dark'});
    final c = ProviderContainer();
    addTearDown(c.dispose);
    c.read(themeModeProvider);
    await Future<void>.delayed(const Duration(milliseconds: 20));
    expect(c.read(themeModeProvider), ThemeMode.dark);
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
