import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'apps.dart';

/// Persists onboarding completion + which apps the user enabled.
/// Disabling an app only hides it from the sidebar — data/settings are kept.
class OnboardingStore {
  static const _kDone = 'onboarding_done';
  static const _kApps = 'enabled_apps';

  final FlutterSecureStorage _s;
  OnboardingStore([FlutterSecureStorage? s])
      : _s = s ??
            const FlutterSecureStorage(
              aOptions: AndroidOptions(encryptedSharedPreferences: true),
            );

  Future<bool> isDone() async => (await _s.read(key: _kDone)) == '1';
  Future<void> setDone() => _s.write(key: _kDone, value: '1');

  Future<Set<String>> enabledApps() async {
    final raw = await _s.read(key: _kApps);
    if (raw == null) {
      return kApps.where((a) => a.defaultOn).map((a) => a.key).toSet();
    }
    return (jsonDecode(raw) as List).cast<String>().toSet();
  }

  Future<void> setEnabledApps(Set<String> keys) =>
      _s.write(key: _kApps, value: jsonEncode(keys.toList()));
}
