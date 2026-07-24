import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;

import 'ava_log.dart';
import 'config.dart';

/// ICE server cache + pre-warm (Scale proposal Phase 1).
///
/// Fetching TURN credentials used to happen inside CallScreen._start(), adding a
/// full HTTPS round-trip to every call setup. Now:
///   • [prefetch] is fired when a call becomes likely (incoming ring shown,
///     call button tapped) so credentials are already here when the call starts.
///   • [get] returns the cached list instantly when fresh, else fetches.
/// TURN credentials are short-lived → small TTL. Falls back to the static STUN
/// list in [kIceServers] on any failure (a call must never block on this).
class IceCache {
  static List<Map<String, dynamic>>? _servers;
  static int _fetchedAt = 0;
  static Future<List<Map<String, dynamic>>>? _inflight;
  static const _ttlMs = 2 * 60 * 1000;

  static bool get _fresh =>
      _servers != null && DateTime.now().millisecondsSinceEpoch - _fetchedAt < _ttlMs;

  /// Fire-and-forget warm-up; safe to call often.
  static void prefetch() {
    if (_fresh || _inflight != null) return;
    get().ignore();
  }

  /// [CALL-REL-6] [forceRefresh]: bypass the cache and fetch fresh TURN
  /// credentials even if the cached ones are still within TTL. Relay
  /// migration needs this — credentials may be short-lived and a stale-but-
  /// "fresh by TTL" set is exactly what plan §7.4 step 1 says not to reuse.
  static Future<List<Map<String, dynamic>>> get({bool forceRefresh = false}) async {
    if (!forceRefresh && _fresh) return _servers!;
    final inflight = _inflight;
    if (!forceRefresh && inflight != null) return inflight;
    final f = _fetch();
    _inflight = f;
    try {
      return await f;
    } finally {
      _inflight = null;
    }
  }

  static Future<List<Map<String, dynamic>>> _fetch() async {
    try {
      final r = await http.get(Uri.parse(kIceUrl)).timeout(const Duration(seconds: 5));
      if (r.statusCode == 200) {
        final data = jsonDecode(r.body) as Map<String, dynamic>;
        final servers = (data['iceServers'] as List).cast<Map<String, dynamic>>();
        if (servers.isNotEmpty) {
          _servers = servers;
          _fetchedAt = DateTime.now().millisecondsSinceEpoch;
          return servers;
        }
      }
    } catch (e) {
      AvaLog.I.log('call', 'ICE fetch failed (using STUN fallback): $e');
    }
    return _servers ?? kIceServers; // stale beats static; static beats nothing
  }
}

/// Device-level call diagnostics flags (NOT per-account: these are tester knobs,
/// the explicit device-level exception in the scoping rule).
class CallDiag {
  static const _store = FlutterSecureStorage(mOptions: MacOsOptions(useDataProtectionKeyChain: false), );
  static const _kTurnOnly = 'diag_turn_only';
  static bool turnOnly = false;

  static Future<void> load() async {
    try { turnOnly = (await _store.read(key: _kTurnOnly)) == '1'; } catch (_) {}
  }

  static Future<void> setTurnOnly(bool v) async {
    turnOnly = v;
    try { await _store.write(key: _kTurnOnly, value: v ? '1' : '0'); } catch (_) {}
  }
}
