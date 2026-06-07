import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'account_storage.dart';
import 'apps.dart';

/// Persists onboarding completion + which apps the user enabled.
/// Disabling an app only hides it from the sidebar — data/settings are kept.
/// Keys are namespaced per Clerk account (see [scopedKey]) so each user on a
/// shared phone keeps their own onboarding state — a second account signing in
/// now gets the full onboarding flow (incl. the @handle step) instead of
/// inheriting the first user's "done" flag.
class OnboardingStore {
  static const _kDone = 'onboarding_done';
  static const _kApps = 'enabled_apps';

  final FlutterSecureStorage _s;
  OnboardingStore([FlutterSecureStorage? s])
      : _s = s ??
            const FlutterSecureStorage(
              aOptions: AndroidOptions(encryptedSharedPreferences: true),
            );

  Future<bool> isDone() async => (await readScoped(_s, _kDone)) == '1';
  Future<void> setDone() => _s.write(key: scopedKey(_kDone), value: '1');

  Future<Set<String>> enabledApps() async {
    final raw = await readScoped(_s, _kApps);
    if (raw == null) {
      return kApps.where((a) => a.defaultOn).map((a) => a.key).toSet();
    }
    return (jsonDecode(raw) as List).cast<String>().toSet();
  }

  Future<void> setEnabledApps(Set<String> keys) =>
      _s.write(key: scopedKey(_kApps), value: jsonEncode(keys.toList()));
}
