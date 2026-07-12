import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:flutter/services.dart';
import 'package:path_provider/path_provider.dart';

import '../../core/analytics.dart';
import '../../core/ava_log.dart';

/// Direction/state of a live PSTN call, mirrored from the native
/// [AvaInCallService] over the `avatok/avadial` channel.
class AvaCallEvent {
  final String id;
  final String? number;
  final String state; // ringing|dialing|active|holding|disconnected|…
  final String direction; // incoming|outgoing|unknown
  const AvaCallEvent({
    required this.id,
    required this.number,
    required this.state,
    required this.direction,
  });
}

/// Result of a role request (spike §1). [role] is the Android role name
/// (`android.app.role.DIALER` / `…CALL_SCREENING`).
class AvaRoleResult {
  final String role;
  final bool granted;
  const AvaRoleResult(this.role, this.granted);
}

/// Dart bridge to the AvaDial native telecom layer
/// (Specs/SPIKE-2026-07-12-avadial-telecom.md). Thin + best-effort: every method
/// tolerates the platform side being absent (e.g. iOS, or the plugin not attached)
/// so nothing here can throw into the UI. All of this is DARK behind the
/// `avaDialer` remote flag — callers gate on it before touching this class.
class AvaDialChannel {
  AvaDialChannel._();
  static final AvaDialChannel I = AvaDialChannel._();

  static const MethodChannel _ch = MethodChannel('avatok/avadial');

  final _calls = StreamController<AvaCallEvent>.broadcast();
  final _removed = StreamController<String>.broadcast();
  final _roles = StreamController<AvaRoleResult>.broadcast();
  final _verdicts = StreamController<String>.broadcast();

  /// Live PSTN call add/state events.
  Stream<AvaCallEvent> get calls => _calls.stream;

  /// Call-removed events (payload = call id).
  Stream<String> get removedCalls => _removed.stream;

  /// Role-request verdicts (arrive after the system prompt returns).
  Stream<AvaRoleResult> get roleResults => _roles.stream;

  /// Best-effort screening verdicts ({red|reported|unknown}) — analytics only.
  Stream<String> get screeningVerdicts => _verdicts.stream;

  bool _wired = false;

  /// Attach the native → Dart event handler. Idempotent; call once when AvaDial
  /// first mounts (only when the `avaDialer` flag is on).
  void ensureWired() {
    if (_wired) return;
    _wired = true;
    _ch.setMethodCallHandler(_onNative);
  }

  Future<dynamic> _onNative(MethodCall call) async {
    try {
      final a = (call.arguments as Map?) ?? const {};
      switch (call.method) {
        case 'onCallAdded':
          _calls.add(AvaCallEvent(
            id: '${a['id']}',
            number: a['number'] as String?,
            state: '${a['state']}',
            direction: '${a['direction'] ?? 'unknown'}',
          ));
          break;
        case 'onCallState':
          _calls.add(AvaCallEvent(
            id: '${a['id']}',
            number: null,
            state: '${a['state']}',
            direction: 'unknown',
          ));
          break;
        case 'onCallRemoved':
          _removed.add('${a['id']}');
          break;
        case 'onRoleResult':
          _roles.add(AvaRoleResult('${a['role']}', a['granted'] == true));
          break;
        case 'onScreeningVerdict':
          final bucket = '${a['bucket']}';
          _verdicts.add(bucket);
          // No raw phone number crosses this boundary — only the verdict bucket.
          Analytics.capture('screening_verdict', {'bucket': bucket});
          break;
      }
    } catch (e) {
      AvaLog.I.log('avadial', 'native event error: $e');
    }
    return null;
  }

  // ── Roles ────────────────────────────────────────────────────────────────
  /// Request the default-dialer role. Returns the immediate state: `true` if the
  /// role is already held (no prompt), otherwise `null` (a prompt was shown and the
  /// verdict arrives on [roleResults]). Falls back to the current held-state on
  /// platforms without the plugin.
  Future<bool?> requestDialerRole() => _invokeNullableBool('requestDialerRole');
  Future<bool?> requestScreeningRole() => _invokeNullableBool('requestScreeningRole');

  Future<bool> isDialerRoleHeld() => _invokeBool('isDialerRoleHeld');
  Future<bool> isScreeningRoleHeld() => _invokeBool('isScreeningRoleHeld');

  /// Whether this app may write [BlockedNumberContract] (default dialer / SMS app).
  Future<bool> canBlockNumbers() => _invokeBool('canBlockNumbers');

  // ── Device reads (LIVE — never persisted here; caller owns the boundary) ──
  Future<List<Map<String, dynamic>>> readContacts() => _invokeList('readContacts', null);
  Future<List<Map<String, dynamic>>> readCallLog({int limit = 500}) =>
      _invokeList('readCallLog', {'limit': limit});

  // ── System block-list write-through (no-op unless default dialer) ─────────
  Future<bool> systemBlock(String number) => _invokeBool('systemBlock', {'number': number});
  Future<bool> systemUnblock(String number) => _invokeBool('systemUnblock', {'number': number});

  // ── In-call actions ──────────────────────────────────────────────────────
  Future<void> answer(String id) => _invokeVoid('answer', {'id': id});
  Future<void> reject(String id) => _invokeVoid('reject', {'id': id});
  Future<void> disconnect(String id) => _invokeVoid('disconnect', {'id': id});
  Future<void> setMuted(bool on) => _invokeVoid('setMuted', {'on': on});
  Future<void> setSpeaker(bool on) => _invokeVoid('setSpeaker', {'on': on});

  // ── Screening snapshot handshake (spike §5) ──────────────────────────────
  /// SHA-256 of an E.164 number, lowercase hex — MUST match the Kotlin hashing in
  /// [AvaCallScreeningService] so a snapshot key resolves on both sides.
  static String hashE164(String e164) =>
      sha256.convert(utf8.encode(e164)).toString();

  /// Atomically write the local spam snapshot the native [AvaCallScreeningService]
  /// reads with zero network + zero Dart round-trip. [scores] maps
  /// `hashE164(number) → 0..100`. Writes to a `.tmp` sibling then renames, so the
  /// service never sees a half-written file. Directory
  /// `<ApplicationSupport>/avadial/` == native `context.filesDir/avadial/`.
  Future<void> writeScreeningSnapshot(
    Map<String, int> scores, {
    int warnThreshold = 70,
    int rejectThreshold = 90,
  }) async {
    try {
      final dir = Directory('${(await getApplicationSupportDirectory()).path}/avadial');
      if (!await dir.exists()) await dir.create(recursive: true);
      final payload = jsonEncode({
        'v': 1,
        'updated': DateTime.now().millisecondsSinceEpoch ~/ 1000,
        'warn_threshold': warnThreshold,
        'reject_threshold': rejectThreshold,
        'scores': scores,
      });
      final tmp = File('${dir.path}/spam_snapshot.json.tmp');
      await tmp.writeAsString(payload, flush: true);
      await tmp.rename('${dir.path}/spam_snapshot.json');
    } catch (e) {
      AvaLog.I.log('avadial', 'writeScreeningSnapshot failed: $e');
    }
  }

  // ── Invoke helpers (all swallow MissingPluginException on unsupported OS) ──
  Future<bool> _invokeBool(String method, [Map<String, dynamic>? args]) async {
    try {
      return (await _ch.invokeMethod<bool>(method, args)) ?? false;
    } catch (e) {
      AvaLog.I.log('avadial', '$method failed: $e');
      return false;
    }
  }

  Future<bool?> _invokeNullableBool(String method, [Map<String, dynamic>? args]) async {
    try {
      return await _ch.invokeMethod<bool>(method, args);
    } catch (e) {
      AvaLog.I.log('avadial', '$method failed: $e');
      return false;
    }
  }

  Future<void> _invokeVoid(String method, [Map<String, dynamic>? args]) async {
    try {
      await _ch.invokeMethod<void>(method, args);
    } catch (e) {
      AvaLog.I.log('avadial', '$method failed: $e');
    }
  }

  Future<List<Map<String, dynamic>>> _invokeList(String method, Map<String, dynamic>? args) async {
    try {
      final raw = await _ch.invokeMethod<List<dynamic>>(method, args);
      if (raw == null) return const [];
      return raw
          .whereType<Map>()
          .map((m) => m.map((k, v) => MapEntry('$k', v)))
          .toList(growable: false);
    } catch (e) {
      AvaLog.I.log('avadial', '$method failed: $e');
      return const [];
    }
  }
}
