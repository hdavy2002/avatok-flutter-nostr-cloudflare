import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

import 'account_storage.dart';

/// One cached JSON value and when it was written.
class CacheEntry {
  const CacheEntry({required this.at, required this.data});

  final DateTime at;
  final Object? data;

  Duration get age => DateTime.now().difference(at);

  /// True when older than [maxAge] (the "Showing saved list" pill uses 10 minutes).
  bool isStale(Duration maxAge) => age > maxAge;
}

/// Small JSON cache on shared_preferences, with timestamps.
///
/// Public data (host list, profiles) uses the plain key. Anything about a person (`scoped: true`) goes
/// through [scopedKey]. Money is never cached: wallet and calls must be live.
///
/// Key convention: `hf.cache.<name>.v<n>` (bump the version when the stored shape changes).
class JsonCache {
  const JsonCache();

  String _key(String key, bool scoped) => scoped ? scopedKey(key) : key;

  Future<CacheEntry?> read(String key, {bool scoped = false}) async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final raw = prefs.getString(_key(key, scoped));
      if (raw == null) return null;
      final map = jsonDecode(raw);
      if (map is! Map) return null;
      final at = DateTime.tryParse('${map['at']}');
      if (at == null) return null;
      return CacheEntry(at: at, data: map['data']);
    } catch (_) {
      // A cache that cannot be read is a cache miss, never an error.
      return null;
    }
  }

  Future<void> write(String key, Object? data, {bool scoped = false}) async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(
        _key(key, scoped),
        jsonEncode({'at': DateTime.now().toIso8601String(), 'data': data}),
      );
    } catch (_) {
      // Best effort: failing to cache must never break the screen.
    }
  }

  Future<void> remove(String key, {bool scoped = false}) async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.remove(_key(key, scoped));
    } catch (_) {
      // nothing to do
    }
  }

  /// Removes every key that starts with `hf.cache.` (public) and every key of the active account.
  /// Called on sign-out.
  Future<void> clearAll() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final suffix = '_${AccountScope.id ?? kGuestScope}';
      for (final k in prefs.getKeys().toList()) {
        if (k.startsWith('hf.cache.') || k.endsWith(suffix)) {
          await prefs.remove(k);
        }
      }
    } catch (_) {
      // nothing to do
    }
  }
}
