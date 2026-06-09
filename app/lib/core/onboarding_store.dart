import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'account_storage.dart';
import 'apps.dart';
import 'disk_cache.dart';

/// Persists onboarding completion + which apps the user enabled.
/// Now stored as plain per-account files (DiskCache) for fast cold-start reads;
/// the old encrypted values are migrated once so an UPDATING user is never sent
/// back through onboarding or loses their app toggles.
class OnboardingStore {
  static const _kDone = 'onboarding_done';
  static const _kApps = 'enabled_apps';
  static const _legacy = FlutterSecureStorage(
    aOptions: AndroidOptions(encryptedSharedPreferences: true),
  );

  Future<bool> isDone() async {
    var v = await DiskCache.read(_kDone);
    if (v == null) {
      try { v = await _legacy.read(key: scopedKey(_kDone)); } catch (_) {}
      if (v != null && v.isNotEmpty) await DiskCache.write(_kDone, v); // migrate once
    }
    return v == '1';
  }

  Future<void> setDone() => DiskCache.write(_kDone, '1');

  Future<Set<String>> enabledApps() async {
    var raw = await DiskCache.read(_kApps);
    if (raw == null) {
      try { raw = await _legacy.read(key: scopedKey(_kApps)); } catch (_) {}
      if (raw != null && raw.isNotEmpty) await DiskCache.write(_kApps, raw); // migrate once
    }
    if (raw == null || raw.isEmpty) {
      return kApps.where((a) => a.defaultOn).map((a) => a.key).toSet();
    }
    try {
      return (jsonDecode(raw) as List).cast<String>().toSet();
    } catch (_) {
      return kApps.where((a) => a.defaultOn).map((a) => a.key).toSet();
    }
  }

  Future<void> setEnabledApps(Set<String> keys) =>
      DiskCache.write(_kApps, jsonEncode(keys.toList()));
}
