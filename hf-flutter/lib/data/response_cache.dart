import 'dart:async';
import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

/// [HF-APP-CACHE-1] The app's read cache: the last good answer of a GET, kept in memory and (when [persist] is on) on disk,
/// so a screen can paint instantly and refresh behind it (stale-while-revalidate). See Specs/PLAN-2026-10-20-HF-SPEED.md.
///
/// Per-account scoping: a key is `hfc1|<scope>|<path?query>` where scope is `u:<account id>` for signed-in calls and `pub`
/// for public ones. A call that needs sign-in but has no account id yet is never cached. [clearAccount] wipes one account's
/// entries (sign-out, lost session), so the next person on a shared phone never sees them.
///
/// Never used for money-moving calls: only GET responses are written, and every successful write call (POST/PUT/PATCH/DELETE)
/// calls [invalidateAfterWrite], which deletes every entry except the slow-changing public ones.
class ResponseCache {
  ResponseCache({this.persist = false, DateTime Function()? now, this.maxBytes = 262144}) : _now = now ?? DateTime.now;

  /// Disk too (shared_preferences). Off in tests unless asked for.
  final bool persist;
  final int maxBytes;
  final DateTime Function() _now;

  DateTime now() => _now();

  static const String _prefix = 'hfc1|';

  /// Public, slow-changing data that a write call does not throw away (the config, topics, the reels feed, search).
  static const List<String> keptAfterWrite = [
    '/api/config',
    '/api/hf/options',
    '/api/hf/reels',
    '/api/hf/search',
    '/api/hf/invites/top',
  ];

  final Map<String, CacheHit> _mem = {};

  String keyFor(String scope, String path, Map<String, Object?>? query) {
    final q = <String>[
      if (query != null)
        for (final e in query.entries)
          if (e.value != null) '${e.key}=${e.value}',
    ]..sort();
    return '$_prefix$scope|$path${q.isEmpty ? '' : '?${q.join('&')}'}';
  }

  /// The stored answer, or null when there is none or it is older than [maxAge].
  Future<CacheHit?> read(String key, Duration maxAge) async {
    var hit = _mem[key];
    if (hit == null && persist) {
      try {
        final p = await SharedPreferences.getInstance();
        final raw = p.getString(key);
        if (raw != null) {
          final cut = raw.indexOf('|');
          final at = cut > 0 ? int.tryParse(raw.substring(0, cut)) : null;
          if (at != null) {
            hit = CacheHit(jsonDecode(raw.substring(cut + 1)), DateTime.fromMillisecondsSinceEpoch(at));
            _mem[key] = hit;
          }
        }
      } catch (_) {
        hit = null; // unreadable entry or no storage: behave as a miss
      }
    }
    if (hit == null) return null;
    if (_now().difference(hit.at) > maxAge) return null;
    return hit;
  }

  Future<void> write(String key, Object? json) async {
    final hit = CacheHit(json, _now());
    _mem[key] = hit;
    if (!persist) return;
    try {
      final text = jsonEncode(json);
      if (text.length > maxBytes) return;
      final p = await SharedPreferences.getInstance();
      await p.setString(key, '${hit.at.millisecondsSinceEpoch}|$text');
    } catch (_) {
      // best effort: the memory copy still works
    }
  }

  /// Drop every entry whose key contains [part] (for example `/api/hf/app/wallet`).
  Future<void> invalidate(String part) => _drop((k) => k.contains(part));

  /// Called by the API client after a write call succeeded: forget everything but [keptAfterWrite].
  Future<void> invalidateAfterWrite() => _drop((k) {
        final path = k.substring(k.indexOf('|', _prefix.length) + 1);
        return !keptAfterWrite.any(path.startsWith);
      });

  /// Sign-out / lost session: wipe one account's entries, memory and disk.
  Future<void> clearAccount(String accountId) => _drop((k) => k.startsWith('${_prefix}u:$accountId|'));

  /// Housekeeping at start: delete disk entries older than [olderThan].
  Future<void> prune({Duration olderThan = const Duration(days: 14)}) async {
    if (!persist) return;
    try {
      final p = await SharedPreferences.getInstance();
      final cutoff = _now().subtract(olderThan).millisecondsSinceEpoch;
      for (final k in p.getKeys().where((k) => k.startsWith(_prefix)).toList()) {
        final raw = p.getString(k);
        final cut = raw == null ? -1 : raw.indexOf('|');
        final at = cut > 0 ? int.tryParse(raw!.substring(0, cut)) : null;
        if (at == null || at < cutoff) await p.remove(k);
      }
    } catch (_) {}
  }

  /// Bumps on every invalidation. A read that started before a write must not be stored after it (its answer predates the
  /// write), so the client compares this before storing.
  int generation = 0;

  Future<void> _drop(bool Function(String key) test) async {
    generation++;
    _mem.removeWhere((k, _) => test(k));
    if (!persist) return;
    try {
      final p = await SharedPreferences.getInstance();
      for (final k in p.getKeys().where((k) => k.startsWith(_prefix) && test(k)).toList()) {
        await p.remove(k);
      }
    } catch (_) {}
  }
}

class CacheHit {
  const CacheHit(this.json, this.at);

  final Object? json;
  final DateTime at;
}

/// How long a cached answer counts. Inside [fresh] the screen is served from the cache alone; between [fresh] and [maxAge]
/// the cached answer paints first and the network refreshes it; older than [maxAge] the cache is ignored.
class CachePolicy {
  const CachePolicy({required this.fresh, required this.maxAge});

  final Duration fresh;
  final Duration maxAge;

  /// Money and bookings: paint the last answer at once, ALWAYS re-ask the server.
  static const CachePolicy live = CachePolicy(fresh: Duration.zero, maxAge: Duration(days: 1));

  /// Bookable times: a minute of grace, then re-ask (the server still has the last word with 409 on booking).
  static const CachePolicy slots = CachePolicy(fresh: Duration(seconds: 20), maxAge: Duration(hours: 6));

  /// Profile-ish data that changes rarely.
  static const CachePolicy profile = CachePolicy(fresh: Duration(minutes: 2), maxAge: Duration(days: 3));

  /// Feeds, search landing, lists others change.
  static const CachePolicy list = CachePolicy(fresh: Duration(seconds: 30), maxAge: Duration(days: 1));

  /// Config, topic chips.
  static const CachePolicy stable = CachePolicy(fresh: Duration(hours: 6), maxAge: Duration(days: 30));
}
