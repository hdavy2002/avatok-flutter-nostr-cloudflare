import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'account_storage.dart';
import 'api_auth.dart';
import 'vault.dart';

/// Syncs the user's preferences across devices via the encrypted vault
/// (kind 'settings'). One blob bundles everything device-local that the user
/// would expect to follow them: which AvaVerse apps they turned on, their
/// profile (name/handle/phone/presence), account type, custom chat filters,
/// starred messages and chat flags (pins/archives). Encrypted with a key
/// derived from the user's Nostr key — the server only sees ciphertext.
class PrefsSync {
  // Per-account (scoped) preference keys.
  static const _scoped = <String>['enabled_apps', 'avatok_profile', 'account_kind'];
  // Device-global preference keys that should still follow the user.
  static const _global = <String>['avatok_custom_filters', 'avatok_stars', 'avatok_chatflags'];

  static const _s = FlutterSecureStorage(
    aOptions: AndroidOptions(encryptedSharedPreferences: true),
  );

  /// Snapshot the current preferences, encrypt, and upload. Best-effort.
  static Future<void> push() async {
    final id = ApiAuth.identity;
    if (id == null) return;
    final map = <String, String>{};
    for (final k in _scoped) {
      final v = await _s.read(key: scopedKey(k));
      if (v != null && v.isNotEmpty) map['s:$k'] = v;
    }
    for (final k in _global) {
      final v = await _s.read(key: k);
      if (v != null && v.isNotEmpty) map['g:$k'] = v;
    }
    if (map.isEmpty) return;
    try {
      final blob = await Vault.encrypt(jsonEncode(map), id.privHex);
      await Vault.put('settings', blob);
    } catch (_) {/* best-effort */}
  }

  /// Pull the preferences blob and apply it locally (on login / new device).
  /// Leaves local state untouched on any failure.
  static Future<void> pull() async {
    final id = ApiAuth.identity;
    if (id == null) return;
    final blob = await Vault.get('settings');
    if (blob == null) return;
    final plain = await Vault.decrypt(blob, id.privHex);
    if (plain == null) return;
    Map<String, dynamic> map;
    try {
      map = jsonDecode(plain) as Map<String, dynamic>;
    } catch (_) {
      return;
    }
    for (final e in map.entries) {
      final val = e.value?.toString();
      if (val == null || val.isEmpty) continue;
      if (e.key.startsWith('s:')) {
        await _s.write(key: scopedKey(e.key.substring(2)), value: val);
      } else if (e.key.startsWith('g:')) {
        await _s.write(key: e.key.substring(2), value: val);
      }
    }
  }
}
