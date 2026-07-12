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

/// A cold-start / background incoming-call launch (MainActivity route extra
/// `avadial/incoming`). The shell opens [PstnCallScreen] for it on app entry.
class AvaIncomingLaunch {
  final String callId;
  final String? number;
  const AvaIncomingLaunch(this.callId, this.number);
}

/// Live audio-route + mute state for the in-call UI, mirrored from
/// [AvaInCallService.onCallAudioStateChanged]. [route] is
/// `speaker|earpiece|bluetooth|headset`.
class AvaAudioRoute {
  final String route;
  final bool muted;
  const AvaAudioRoute(this.route, this.muted);
  bool get isSpeaker => route == 'speaker';
}

/// An inbound SMS mirrored from the native [AvaSmsReceiver] (AVA-SMS). Bodies are
/// live OS-owned data — never persisted by AvaTOK outside the SMS provider (plan
/// device-data boundary). [spam] is the LOCAL snapshot verdict (label only).
class AvaSmsMessage {
  final String? address;
  final String body;
  final int date; // epoch ms
  final bool spam;
  const AvaSmsMessage({
    required this.address,
    required this.body,
    required this.date,
    required this.spam,
  });
}

/// Delivery status of a sent SMS, from the native sent/delivered PendingIntents.
/// [phase] is `sent` or `delivered`; [ref] matches the send request's ref.
class AvaSmsSendStatus {
  final String ref;
  final String phase;
  final bool ok;
  const AvaSmsSendStatus(this.ref, this.phase, this.ok);
}

/// A cold-start / background SMS-compose launch (MainActivity route extra
/// `avadial/compose`, or an ACTION_SENDTO on sms:/smsto:). [number] is the parsed
/// recipient (may be null/empty for a blank compose).
class AvaComposeLaunch {
  final String? number;
  const AvaComposeLaunch(this.number);
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
  final _incoming = StreamController<AvaIncomingLaunch>.broadcast();
  final _audio = StreamController<AvaAudioRoute>.broadcast();
  final _smsIn = StreamController<AvaSmsMessage>.broadcast();
  final _smsStatus = StreamController<AvaSmsSendStatus>.broadcast();
  final _compose = StreamController<AvaComposeLaunch>.broadcast();

  /// Shared guard so the incoming-call screen never double-opens: the shell
  /// (cold-start/relaunch path) and [AvaDialRoot] (foreground ringing path) both
  /// check + set this before pushing [PstnCallScreen].
  bool incomingScreenOpen = false;

  /// Live PSTN call add/state events.
  Stream<AvaCallEvent> get calls => _calls.stream;

  /// Call-removed events (payload = call id).
  Stream<String> get removedCalls => _removed.stream;

  /// Role-request verdicts (arrive after the system prompt returns).
  Stream<AvaRoleResult> get roleResults => _roles.stream;

  /// Best-effort screening verdicts ({red|reported|unknown}) — analytics only.
  Stream<String> get screeningVerdicts => _verdicts.stream;

  /// Incoming-call launches from a cold start / background relaunch (the app was
  /// already running when the notification fired).
  Stream<AvaIncomingLaunch> get incomingLaunch => _incoming.stream;

  /// Live audio-route + mute changes during a call (drives the in-call UI chips).
  Stream<AvaAudioRoute> get audioRoute => _audio.stream;

  /// Inbound SMS mirrored from the native default-SMS receiver (AVA-SMS).
  Stream<AvaSmsMessage> get smsIncoming => _smsIn.stream;

  /// Sent/delivered status of SMS sent via [smsSend].
  Stream<AvaSmsSendStatus> get smsSendStatus => _smsStatus.stream;

  /// SMS-compose launches from a cold start / notification tap / ACTION_SENDTO.
  Stream<AvaComposeLaunch> get composeLaunch => _compose.stream;

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
        case 'onLaunchIncoming':
          final id = '${a['call_id']}';
          if (id.isNotEmpty && id != 'null') {
            _incoming.add(AvaIncomingLaunch(id, a['number'] as String?));
          }
          break;
        case 'onAudioRoute':
          _audio.add(AvaAudioRoute('${a['route']}', a['muted'] == true));
          break;
        case 'onSmsReceived':
          _smsIn.add(AvaSmsMessage(
            address: a['address'] as String?,
            body: '${a['body'] ?? ''}',
            date: (a['date'] as num?)?.toInt() ?? 0,
            spam: a['spam'] == true,
          ));
          break;
        case 'onSmsSendStatus':
          _smsStatus.add(AvaSmsSendStatus(
            '${a['ref']}',
            '${a['phase']}',
            a['ok'] == true,
          ));
          break;
        case 'onMmsReceived':
          // Minimal: no MMS parsing yet (documented). Nothing to surface.
          break;
        case 'onLaunchCompose':
          _compose.add(AvaComposeLaunch(a['number'] as String?));
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

  /// Request the default-SMS-app role (AVA-SMS). Same contract as
  /// [requestDialerRole]: `true` if already held, else `null` (a system prompt
  /// showed and the verdict arrives on [roleResults] with role `…role.SMS`).
  Future<bool?> requestSmsRole() => _invokeNullableBool('requestSmsRole');

  Future<bool> isDialerRoleHeld() => _invokeBool('isDialerRoleHeld');
  Future<bool> isScreeningRoleHeld() => _invokeBool('isScreeningRoleHeld');
  Future<bool> isSmsRoleHeld() => _invokeBool('isSmsRoleHeld');

  // ── SMS (default-SMS-app layer, AVA-SMS) ──────────────────────────────────
  /// Send an SMS to [dest]. [ref] correlates the send with its
  /// [smsSendStatus] events; pass a stable id per outgoing message. Returns true
  /// when the send was dispatched (delivery arrives async on [smsSendStatus]).
  Future<bool> smsSend(String dest, String body, {required String ref}) =>
      _invokeBool('smsSend', {'dest': dest, 'body': body, 'ref': ref});

  /// LIVE read of SMS conversation threads (one row per thread, latest snippet).
  Future<List<Map<String, dynamic>>> smsQueryThreads({int limit = 200}) =>
      _invokeList('smsQueryThreads', {'limit': limit});

  /// LIVE read of the messages in one thread, matched by [address].
  Future<List<Map<String, dynamic>>> smsQueryMessages(String address, {int limit = 500}) =>
      _invokeList('smsQueryMessages', {'address': address, 'limit': limit});

  /// Drain any pending SMS-compose launch the native side stored before Dart was
  /// ready (route extra `avadial/compose` / ACTION_SENDTO). Null when there is none.
  Future<AvaComposeLaunch?> consumePendingCompose() async {
    try {
      final raw = await _ch.invokeMethod<Map<dynamic, dynamic>>('getPendingCompose');
      if (raw == null) return null;
      return AvaComposeLaunch(raw['number']?.toString());
    } catch (e) {
      AvaLog.I.log('avadial', 'getPendingCompose failed: $e');
      return null;
    }
  }

  /// Whether this app may write [BlockedNumberContract] (default dialer / SMS app).
  Future<bool> canBlockNumbers() => _invokeBool('canBlockNumbers');

  // ── Cold-start incoming-call drain ──────────────────────────────────────
  /// Pull any pending incoming-call launch the native side stored before Dart was
  /// ready (route extra `avadial/incoming`). Returns null when there is none.
  Future<AvaIncomingLaunch?> consumePendingIncoming() async {
    try {
      final raw = await _ch.invokeMethod<Map<dynamic, dynamic>>('getPendingIncoming');
      if (raw == null) return null;
      final id = raw['call_id']?.toString();
      if (id == null || id.isEmpty) return null;
      return AvaIncomingLaunch(id, raw['number']?.toString());
    } catch (e) {
      AvaLog.I.log('avadial', 'getPendingIncoming failed: $e');
      return null;
    }
  }

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

  /// Play a DTMF tone for [digit] ("0".."9","*","#") on the call [id] (keypad overlay).
  Future<void> sendDtmf(String id, String digit) => _invokeVoid('dtmf', {'id': id, 'digit': digit});

  /// Place an outgoing PSTN call via TelecomManager (default dialer). Returns true when
  /// dispatched; false means the platform side is absent OR CALL_PHONE is not yet
  /// granted (a runtime prompt was kicked off) — the caller then falls back to an
  /// ACTION_DIAL intent for this attempt.
  Future<bool> placeCall(String number) => _invokeBool('placeCall', {'number': number});

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
