import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';

import '../../core/analytics.dart';
import '../../core/api_auth.dart';
import '../../core/ava_log.dart';
import '../../core/config.dart';
import '../../core/remote_config.dart';
import 'avadial_channel.dart';

/// [AVA-MISSEDCALL-1] Owns the Truecaller-style missed-call overlay's Dart side:
///   • keeps the on-device directory (caller name + AvaTOK status) fresh so the
///     native overlay paints INSTANTLY from cache when a call is missed;
///   • performs the LIVE backend confirm ("cache then backend") when the engine is
///     alive at call time, re-painting the AvaTOK icon bright if the caller turns out
///     to be an AvaTOK user;
///   • arms/disarms the native PHONE_STATE receiver in step with the
///     `missedCallOverlay` remote flag + the "appear on top" permission.
///
/// ALL DARK behind [RemoteConfig.missedCallOverlay]. While that flag is off (or on
/// non-Android platforms) every method here is a no-op and the receiver stays disarmed.
///
/// PRIVACY NOTE: AvaTOK membership is resolved from the caller's real phone number via
/// /api/contacts/match, which the owner deliberately RE-ENABLED on 2026-07-14 (reversing
/// the 2026-06-27 phone-presence privacy lock). The raw number never leaves the device
/// as plaintext — only sha256(E.164) hashes are sent for the batch pre-sync; the single
/// live confirm sends the one number so the server can normalize it.
class MissedCallService {
  MissedCallService._();
  static final MissedCallService I = MissedCallService._();

  StreamSubscription<AvaMissedCall>? _missedSub;
  bool _started = false;
  DateTime _lastSync = DateTime.fromMillisecondsSinceEpoch(0);
  static const Duration _syncEvery = Duration(hours: 6);

  String get _matchUrl => 'https://$kSignalingHost/api/contacts/match';
  String get _tokenUrl => 'https://$kSignalingHost/api/missedcall/token';

  /// Call once on app entry (from the shell). Gated on Android + the flag. Wires the
  /// live-confirm listener, arms the receiver if permitted, and refreshes the directory.
  Future<void> init() async {
    if (_started) return;
    if (!Platform.isAndroid || !RemoteConfig.missedCallOverlay) {
      // Ensure the native receiver is disarmed if the flag was turned back off.
      if (Platform.isAndroid) {
        try {
          await AvaDialChannel.I.setMissedCallEnabled(false);
        } catch (_) {/* best-effort */}
      }
      return;
    }
    _started = true;
    AvaDialChannel.I.ensureWired();
    _missedSub = AvaDialChannel.I.missedCalls.listen(_onMissed);
    await ensureEnabled();
  }

  /// Arm the native receiver iff we can draw over other apps, then refresh the cache.
  /// Returns whether the overlay is now armed. Safe to call after the user returns from
  /// the overlay-permission screen.
  Future<bool> ensureEnabled() async {
    if (!Platform.isAndroid || !RemoteConfig.missedCallOverlay) return false;
    final canDraw = await AvaDialChannel.I.canDrawOverlay();
    // Mint the long-lived device token so the native receiver can confirm membership
    // cold-start. Best-effort — if offline/unauth, the plugin keeps any prior token and
    // the overlay still works from cache. Only bother once we can actually draw.
    final token = canDraw ? await _mintToken() : null;
    await AvaDialChannel.I.setMissedCallEnabled(
      canDraw,
      token: token,
      base: canDraw ? kSignalingHost : null,
    );
    if (canDraw) unawaited(syncDirectory());
    return canDraw;
  }

  /// Mint a 30-day HMAC device token from the Worker (Clerk-authed). Returns null on any
  /// failure; the caller then leaves the previously-stored token in place.
  Future<String?> _mintToken() async {
    try {
      final res = await ApiAuth.postJson(_tokenUrl, const {});
      if (res.statusCode != 200) return null;
      final body = jsonDecode(res.body) as Map<String, dynamic>;
      final t = (body['token'] as String?)?.trim();
      return (t != null && t.isNotEmpty) ? t : null;
    } catch (e) {
      AvaLog.I.log('missedcall', 'token mint failed: $e');
      return null;
    }
  }

  /// Send the user to the system "Display over other apps" page. The caller should
  /// re-run [ensureEnabled] when the user comes back.
  Future<void> requestPermission() => AvaDialChannel.I.requestOverlayPermission();

  Future<bool> canDraw() => AvaDialChannel.I.canDrawOverlay();

  /// Rebuild the on-device directory the overlay reads: caller names from the device
  /// contacts + recent call log (so the popup can name ANY caller), and the AvaTOK
  /// bright flag from a batched backend match. Throttled to [_syncEvery].
  Future<void> syncDirectory({bool force = false}) async {
    if (!Platform.isAndroid || !RemoteConfig.missedCallOverlay) return;
    if (!force && DateTime.now().difference(_lastSync) < _syncEvery) return;
    _lastSync = DateTime.now();
    try {
      final entries = <String, Map<String, dynamic>>{};
      final serverHashToNumber = <String, String>{};

      void addName(String? number, String? name) {
        final n = number?.trim();
        if (n == null || n.isEmpty) return;
        final key = AvaDialChannel.hashLast10(n);
        final e = entries.putIfAbsent(key, () => <String, dynamic>{
              'name': null,
              'ava': false,
              'avatar_url': null,
              'avatok_number': null,
            });
        final nm = name?.trim();
        if ((e['name'] == null || (e['name'] as String).isEmpty) && nm != null && nm.isNotEmpty) {
          e['name'] = nm;
        }
        serverHashToNumber[_serverHash(n)] = n;
      }

      for (final c in await AvaDialChannel.I.readContacts()) {
        addName(c['number'] as String?, c['name'] as String?);
      }
      for (final l in await AvaDialChannel.I.readCallLog(limit: 200)) {
        addName(l['number'] as String?, l['name'] as String?);
      }

      final matched = await _matchHashes(serverHashToNumber.keys.toList());
      for (final m in matched) {
        final h = m['hash'] as String?;
        final orig = h == null ? null : serverHashToNumber[h];
        if (orig == null) continue;
        final key = AvaDialChannel.hashLast10(orig);
        final e = entries.putIfAbsent(key, () => <String, dynamic>{
              'name': null,
              'ava': false,
              'avatar_url': null,
              'avatok_number': null,
            });
        e['ava'] = true;
        final sName = (m['name'] as String?)?.trim();
        if ((e['name'] == null || (e['name'] as String).isEmpty) && sName != null && sName.isNotEmpty) {
          e['name'] = sName;
        }
        e['avatar_url'] = m['avatar_url'];
        e['avatok_number'] = m['avatok_number'];
      }

      await AvaDialChannel.I.writeAvatokDirectory(entries);
      Analytics.capture('missed_call_directory_synced', {
        'entries': entries.length,
        'matched': matched.length,
      });
    } catch (e) {
      AvaLog.I.log('missedcall', 'syncDirectory failed: $e');
    }
  }

  /// Live "cache then backend" confirm: the overlay is already up (cache verdict); if the
  /// cache said "not AvaTOK" we re-check the single number and re-paint the icon bright on
  /// a hit. Runs only when the engine happens to be alive at call time.
  Future<void> _onMissed(AvaMissedCall m) async {
    if (m.isAvatokCached) return; // already bright — nothing to upgrade
    try {
      final res = await ApiAuth.postJson(_matchUrl, {'numbers': [m.number]});
      if (res.statusCode != 200) return;
      final body = jsonDecode(res.body) as Map<String, dynamic>;
      final list = (body['matched'] as List?) ?? const [];
      if (list.isEmpty) return;
      final first = list.first as Map;
      final name = (first['name'] as String?)?.trim();
      await AvaDialChannel.I.missedCallResolved(m.number, true, name);
      Analytics.capture('missed_call_avatok_confirmed', {'ring_secs': m.ringSecs});
      // Refresh the cache soon so the next call from this number is instant.
      unawaited(syncDirectory(force: true));
    } catch (e) {
      AvaLog.I.log('missedcall', 'live confirm failed: $e');
    }
  }

  Future<List<Map<String, dynamic>>> _matchHashes(List<String> hashes) async {
    if (hashes.isEmpty) return const [];
    try {
      final res = await ApiAuth.postJson(_matchUrl, {'hashes': hashes});
      if (res.statusCode != 200) return const [];
      final body = jsonDecode(res.body) as Map<String, dynamic>;
      final list = (body['matched'] as List?) ?? const [];
      return list
          .whereType<Map>()
          .map((m) => m.map((k, v) => MapEntry('$k', v)))
          .toList(growable: false);
    } catch (e) {
      AvaLog.I.log('missedcall', 'match failed: $e');
      return const [];
    }
  }

  /// Replicates the Worker's `normalizePhone` + sha256 so a locally-computed hash
  /// matches the stored `users.phone_hash` (sha256 of the E.164 number).
  String _serverHash(String raw) {
    final t = raw.trim().replaceAll(RegExp(r'[^\d+]'), '');
    final e164 = t.startsWith('+') ? t : '+$t';
    return sha256.convert(utf8.encode(e164)).toString();
  }

  void dispose() {
    _missedSub?.cancel();
    _missedSub = null;
    _started = false;
  }
}
