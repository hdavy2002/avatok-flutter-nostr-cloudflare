import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// SharedPreferences key of the saved appearance (device level, shared by every account on the phone).
const String kThemeModePrefKey = 'hf.theme_mode.v1';

/// The app's [ThemeMode]. Dark by default; the person can pick Light or System in
/// Me > Appearance. The choice is saved on the device, not per account, and read back at launch.
class ThemeModeNotifier extends Notifier<ThemeMode> {
  bool _touched = false;

  @override
  ThemeMode build() {
    _load();
    return ThemeMode.dark;
  }

  Future<void> _load() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final saved = decode(prefs.getString(kThemeModePrefKey));
      // A tap that landed before the read finished wins over the stored value.
      if (!_touched && saved != null && ref.mounted) state = saved;
    } catch (_) {
      // Storage unavailable: stay on dark.
    }
  }

  Future<void> set(ThemeMode mode) async {
    _touched = true;
    state = mode;
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(kThemeModePrefKey, encode(mode));
    } catch (_) {
      // The choice still applies for this launch.
    }
  }

  static String encode(ThemeMode m) => switch (m) {
    ThemeMode.light => 'light',
    ThemeMode.dark => 'dark',
    ThemeMode.system => 'system',
  };

  static ThemeMode? decode(String? v) => switch (v) {
    'light' => ThemeMode.light,
    'dark' => ThemeMode.dark,
    'system' => ThemeMode.system,
    _ => null,
  };
}

final themeModeProvider = NotifierProvider<ThemeModeNotifier, ThemeMode>(
  ThemeModeNotifier.new,
);
