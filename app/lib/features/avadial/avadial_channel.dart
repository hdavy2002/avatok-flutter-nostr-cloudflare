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
  // [AVADIAL-HARDEN-3] Community spam score 0..100 stashed by
  // AvaCallScreeningService for this same number, or null when the number was
  // never screened / had no snapshot hit.
  final int? spamScore;
  const AvaCallEvent({
    required this.id,
    required this.number,
    required this.state,
    required this.direction,
    this.spamScore,
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
  // [AVADIAL-HARDEN-2] True when the call was already answered (native
  // "answer" notification action fired before Flutter/MainActivity came up) —
  // the shell then opens the active-call UI instead of the ringing screen.
  final bool answered;
  // [AVADIAL-HARDEN-3] Screening verdict carried through the cold-start /
  // relaunch launch so PstnCallScreen can paint red without a live onCallAdded.
  final int? spamScore;
  const AvaIncomingLaunch(this.callId, this.number, {this.answered = false, this.spamScore});
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

/// [AVA-MISSEDCALL-1] A missed incoming call detected by the native
/// [AvaMissedCallReceiver]. Raised AFTER the overlay is already on screen (painted
/// from the on-device cache); [isAvatokCached] is the cache verdict, which
/// [MissedCallService] may upgrade via a live backend confirm.
class AvaMissedCall {
  final String number;
  final int ringSecs;
  final bool isAvatokCached;
  const AvaMissedCall(this.number, this.ringSecs, this.isAvatokCached);
}

/// A cold-start / background "open this caller in AvaTOK" launch, from the missed-call
/// overlay's View-profile / AvaTOK action (MainActivity route `avadial/openDial`).
class AvaOpenDialLaunch {
  final String? number;
  final String? avatokNumber;
  const AvaOpenDialLaunch(this.number, this.avatokNumber);
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
  final _missed = StreamController<AvaMissedCall>.broadcast();
  final _openDial = StreamController<AvaOpenDialLaunch>.broadcast();

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

  /// [AVA-MISSEDCALL-1] Missed-call events from the native PHONE_STATE receiver.
  Stream<AvaMissedCall> get missedCalls => _missed.stream;

  /// "Open in AvaTOK" launches from the missed-call overlay (already-running case).
  Stream<AvaOpenDialLaunch> get openDialLaunch => _openDial.stream;

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
            spamScore: (a['spam_score'] as num?)?.toInt(),
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
            _incoming.add(AvaIncomingLaunch(id, a['number'] as String?,
                answered: a['answered'] == true,
                spamScore: (a['spam_score'] as num?)?.toInt()));
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
        case 'onMissedCall':
          final missedNumber = a['number'] as String?;
          if (missedNumber != null && missedNumber.isNotEmpty) {
            _missed.add(AvaMissedCall(
              missedNumber,
              (a['ring_secs'] as num?)?.toInt() ?? 0,
              a['is_avatok_cached'] == true,
            ));
          }
          // Telemetry carries NO raw number — only the ring duration + cache verdict.
          Analytics.capture('missed_call_overlay_shown', {
            'ring_secs': (a['ring_secs'] as num?)?.toInt() ?? 0,
            'avatok_cached': a['is_avatok_cached'] == true,
          });
          break;
        case 'onLaunchOpenDial':
          _openDial.add(AvaOpenDialLaunch(
            a['number'] as String?,
            a['avatok_number'] as String?,
          ));
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

  /// Deep-link to the OS "Default apps" settings screen so the user can set
  /// AvaTOK as the default phone/SMS app — or hand a role back to another app
  /// (Truecaller / stock) — at the OS level. We can only LAUNCH this screen; a
  /// role can never be forced or released programmatically. Best-effort no-op on
  /// unsupported platforms.
  Future<void> openDefaultAppsSettings() => _invokeVoid('openDefaultAppsSettings');

  // ── Rival detection (setup sheet) ─────────────────────────────────────────
  /// Label of the app currently holding the default PHONE slot (e.g. "Truecaller"),
  /// or null when it's already AvaTOK / none / unresolvable.
  Future<String?> defaultDialerLabel() => _invokeString('defaultDialerLabel');

  /// Label of the app currently holding the default SMS slot, or null when it's us.
  Future<String?> defaultSmsLabel() => _invokeString('defaultSmsLabel');

  /// Installed third-party caller-ID / dialer apps that draw their own overlay
  /// (Truecaller etc.) → each `{package, label}`. Android forbids disabling them,
  /// so the setup sheet names them and deep-links to each one via [openAppDetails].
  Future<List<Map<String, dynamic>>> detectRivalCallerApps() =>
      _invokeList('detectRivalCallerApps', null);

  /// Deep-link to a specific app's system "App info" page so the user can revoke
  /// its "appear on top" permission or disable it (we can only open the screen).
  Future<void> openAppDetails(String package) =>
      _invokeVoid('openAppDetails', {'package': package});

  /// [AVA-SMS-FIX-1] Deep-link to OUR OWN system "App info" page — the screen
  /// with ⋮ → "Allow restricted settings", which is the only unlock for the
  /// Android 15+ hard-restriction on SMS permissions for sideloaded installs.
  /// The native side resolves an empty package to `ctx.packageName`, so this
  /// stays correct across the prod / `.staging` applicationId suffixes.
  Future<void> openOwnAppDetails() =>
      _invokeVoid('openAppDetails', {'package': ''});

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

  /// [AVA-SMS-BADGE-1] Per-address UNREAD message counts from the OS inbox
  /// (`read = 0`) → `[{address, count}]`. Empty until READ_SMS/ROLE_SMS is held.
  Future<List<Map<String, dynamic>>> smsUnreadCounts() =>
      _invokeList('smsUnreadCounts', null);

  /// [AVA-SMS-BADGE-1] Mark every unread message from [address] as read (the
  /// user opened that thread). Provider write needs ROLE_SMS; safe no-op
  /// otherwise. Returns rows updated (0 on failure/unsupported platform).
  Future<int> smsMarkRead(String address) async {
    try {
      return await _ch.invokeMethod<int>('smsMarkRead', {'address': address}) ?? 0;
    } catch (e) {
      AvaLog.I.log('avadial', 'smsMarkRead failed: $e');
      return 0;
    }
  }

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
      return AvaIncomingLaunch(id, raw['number']?.toString(),
          answered: raw['answered'] == true,
          spamScore: (raw['spam_score'] as num?)?.toInt());
    } catch (e) {
      AvaLog.I.log('avadial', 'getPendingIncoming failed: $e');
      return null;
    }
  }

  // ── Device reads (LIVE — never persisted here; caller owns the boundary) ──
  Future<List<Map<String, dynamic>>> readContacts() => _invokeList('readContacts', null);
  Future<List<Map<String, dynamic>>> readCallLog({int limit = 500}) =>
      _invokeList('readCallLog', {'limit': limit});

  // ── Device contact WRITES (WRITE_CONTACTS — writes the real OS phone book) ──
  /// Create a new contact in the device address book. Returns the new aggregated
  /// contact id on success, or null (fell back / unsupported / permission absent).
  Future<String?> writeContact({
    required String name,
    required String number,
    String? personalEmail,
    String? businessEmail,
    String? linkedin,
    String? note,
    String? address,
  }) async {
    try {
      return await _ch.invokeMethod<String>('writeContact', {
        'name': name,
        'number': number,
        'personalEmail': personalEmail,
        'businessEmail': businessEmail,
        'linkedin': linkedin,
        'note': note,
        'address': address,
      });
    } catch (e) {
      AvaLog.I.log('avadial', 'writeContact failed: $e');
      return null;
    }
  }

  /// BULK-write many device contacts in as few provider transactions as possible
  /// (the fast path for contact-book RESTORE). Each entry is a map with keys
  /// name/number/personalEmail/businessEmail/linkedin/note. Returns the number
  /// written, or -1 when the native side is unavailable (older build / iOS) so the
  /// caller can fall back to per-contact [writeContact].
  Future<int> writeContactsBatch(List<Map<String, dynamic>> contacts) async {
    if (contacts.isEmpty) return 0;
    try {
      final n = await _ch.invokeMethod<int>('writeContactsBatch', {'contacts': contacts});
      return n ?? -1;
    } catch (e) {
      AvaLog.I.log('avadial', 'writeContactsBatch failed: $e');
      return -1; // signal: fall back to per-contact writes
    }
  }

  /// Update an existing device contact (by aggregated [id]). Managed fields (name,
  /// phone, emails, website, note, address) are replaced. [clearFields] names the
  /// managed field keys (name/number/personalEmail/businessEmail/linkedin/note/
  /// address) whose value the caller explicitly wants CLEARED — an empty string for
  /// a field NOT in [clearFields] is otherwise left untouched on the device
  /// (owner data-loss guard, [AVADIAL-HARDEN-2]). Returns true on success.
  Future<bool> updateContact({
    required String id,
    required String name,
    required String number,
    String? personalEmail,
    String? businessEmail,
    String? linkedin,
    String? note,
    String? address,
    List<String>? clearFields,
  }) =>
      _invokeBool('updateContact', {
        'id': id,
        'name': name,
        'number': number,
        'personalEmail': personalEmail,
        'businessEmail': businessEmail,
        'linkedin': linkedin,
        'note': note,
        'address': address,
        'clearFields': clearFields,
      });

  /// Delete a device contact (and its raw rows) by aggregated [id].
  Future<bool> deleteContact(String id) => _invokeBool('deleteContact', {'id': id});

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

  // ── [AVA-MISSEDCALL-1] Missed-call overlay ────────────────────────────────
  /// True when AvaTOK may draw over other apps ("appear on top"). The overlay
  /// cannot show without it.
  Future<bool> canDrawOverlay() => _invokeBool('canDrawOverlay');

  /// Open the system "Display over other apps" settings page for AvaTOK.
  Future<void> requestOverlayPermission() => _invokeVoid('requestOverlayPermission');

  /// Arm/disarm the native PHONE_STATE receiver by writing `{enabled, token, base}`
  /// into the native config file. The receiver early-returns until `enabled` is true;
  /// [token] + [base] let it confirm AvaTOK membership over the device-token lane while
  /// the app is dead (both null → keep any previously-stored values).
  Future<void> setMissedCallEnabled(bool enabled, {String? token, String? base}) =>
      _invokeVoid('setMissedCallEnabled', {
        'enabled': enabled,
        'token': token,
        'base': base,
      });

  /// Atomically write the on-device AvaTOK directory the overlay reads for caller
  /// name + AvaTOK status. [entries] maps `hashLast10(number) → {name, ava,
  /// avatar_url, avatok_number}`.
  Future<void> writeAvatokDirectory(Map<String, Map<String, dynamic>> entries) =>
      _invokeVoid('writeAvatokDirectory', {
        'json': jsonEncode({
          'v': 1,
          'updated': DateTime.now().millisecondsSinceEpoch ~/ 1000,
          'entries': entries,
        }),
      });

  /// Re-paint the currently-shown overlay after a late backend confirm (the
  /// "cache then backend" upgrade). No-op if a different card is now showing.
  Future<void> missedCallResolved(String number, bool avatok, String? name) =>
      _invokeVoid('missedCallResolved', {
        'number': number,
        'avatok': avatok,
        'name': name,
      });

  /// Debug/QA: show the overlay directly without a real call.
  Future<void> showMissedCallPreview({
    required String number,
    String? name,
    int ringSecs = 24,
    bool isAvatok = true,
    String? avatokNumber,
  }) =>
      _invokeVoid('showMissedCallPreview', {
        'number': number,
        'name': name,
        'ring_secs': ringSecs,
        'is_avatok': isAvatok,
        'avatok_number': avatokNumber,
      });

  /// Drain a pending "open in AvaTOK" launch queued by the overlay before the
  /// engine was ready (cold start).
  Future<AvaOpenDialLaunch?> consumePendingOpenDial() async {
    try {
      final raw = await _ch.invokeMethod<Map<dynamic, dynamic>>('getPendingOpenDial');
      if (raw == null) return null;
      return AvaOpenDialLaunch(raw['number'] as String?, raw['avatok_number'] as String?);
    } catch (e) {
      AvaLog.I.log('avadial', 'getPendingOpenDial failed: $e');
      return null;
    }
  }

  /// SHA-256 of the last 10 digits of [number], lowercase hex — the directory key
  /// the native overlay/receiver compute. Formatting-independent so a contact and a
  /// call-log entry for the same person collide.
  static String hashLast10(String number) {
    final digits = number.replaceAll(RegExp(r'\D'), '');
    final last10 = digits.length > 10 ? digits.substring(digits.length - 10) : digits;
    return sha256.convert(utf8.encode(last10)).toString();
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

  Future<String?> _invokeString(String method, [Map<String, dynamic>? args]) async {
    try {
      return await _ch.invokeMethod<String>(method, args);
    } catch (e) {
      AvaLog.I.log('avadial', '$method failed: $e');
      return null;
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
