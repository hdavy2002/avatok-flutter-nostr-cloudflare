import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:app_badge_plus/app_badge_plus.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/material.dart';
import 'package:flutter_callkit_incoming/entities/entities.dart';
import 'package:flutter_callkit_incoming/flutter_callkit_incoming.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import '../core/analytics.dart';
import '../core/api_auth.dart';
import '../core/ava_log.dart';
import '../core/call_log_store.dart';
import '../core/config.dart';
import '../core/disk_cache.dart';
import '../core/ice_cache.dart';
import '../features/avatok/call_screen.dart';
import '../sync/sync_hub.dart';

/// Global key so we can navigate to the call screen when a call is accepted.
final navigatorKey = GlobalKey<NavigatorState>();

/// Broadcasts call-status updates (declined / busy / ended) pushed by the server
/// to the active CallScreen — reliable even when the WS path couldn't be held.
final callStatusBus = StreamController<({String callId, String status})>.broadcast();

final _local = FlutterLocalNotificationsPlugin();
const _msgChannel = AndroidNotificationChannel(
  'avatok_messages', 'Messages',
  description: 'New message notifications', importance: Importance.high,
);

// --- Unread app-icon badge (red dot + count, WhatsApp-style) ----------------
// Device-level (NOT per-account): the launcher badge is one OS-level affordance
// for the whole phone, and it's a transient count cleared the moment the app is
// opened — not durable per-user data — so a device key is correct here (the
// account-scoping rule's explicit exception for device-level values). Stored in
// secure storage so the BACKGROUND isolate (no app state) can read + bump it.
const _kBadgeKey = 'avatok_badge_count';
const _badgeStore = FlutterSecureStorage(mOptions: MacOsOptions(useDataProtectionKeyChain: false), );

Future<int> _bumpBadge() async {
  final cur = int.tryParse(await _badgeStore.read(key: _kBadgeKey) ?? '0') ?? 0;
  final next = cur + 1;
  await _badgeStore.write(key: _kBadgeKey, value: '$next');
  try { await AppBadgePlus.updateBadge(next); } catch (_) {}
  return next;
}

Future<void> _clearBadge() async {
  await _badgeStore.write(key: _kBadgeKey, value: '0');
  try { await AppBadgePlus.updateBadge(0); } catch (_) {}
  try { await _local.cancel(8000); } catch (_) {}
}

/// A tapped message notification must open the inbox — NOT wherever the app
/// happened to be. (The old build had no tap handler, so a tap just foregrounded
/// the app on whatever screen it was last on — e.g. the Diagnostics page.)
void _onNotifTap(String? payload) {
  if (payload != 'chat') return; // call taps are handled by CallKit, not here
  _clearBadge();
  navigatorKey.currentState?.popUntil((r) => r.isFirst); // back to shell/chat list
}

/// Background/terminated FCM handler — must be a top-level entry point.
@pragma('vm:entry-point')
Future<void> firebaseBackgroundHandler(RemoteMessage message) async {
  final d = message.data;
  if (d['type'] == 'message') {
    await _showMessageNotif(d);
  } else if (d['type'] == 'del') {
    // Delete-for-everyone — silent. Park it for the app to apply on next foreground.
    await _queuePendingDelete(d);
  } else if (d['type'] == 'call-status') {
    // Caller cancelled / call ended before we answered → stop ringing.
    final callId = (d['callId'] ?? '').toString();
    if (callId.isNotEmpty && _terminalCallStatus((d['status'] ?? '').toString())) {
      await FlutterCallkitIncoming.endCall(callId);
    }
  } else {
    await _showIncoming(d);
  }
}

/// Park a delete-for-everyone that arrived while the app was backgrounded/killed.
/// The background isolate has no AccountScope loaded, so it can't write the
/// per-account DeletedStore directly — instead it appends to the GLOBAL
/// (device-level) queue, which [SyncHub.drainPendingDeletes] flushes into the
/// scoped store the instant the app is alive. Silent by design: a redaction must
/// never raise a banner. Entry format mirrors the drain: 'conv\ttarget'.
Future<void> _queuePendingDelete(Map<String, dynamic> d) async {
  final target = (d['target'] ?? '').toString();
  if (target.isEmpty) return;
  final entry = '${(d['conv'] ?? '').toString()}\t$target';
  try {
    final raw = await DiskCache.readGlobal(SyncHub.pendingDeletesKey);
    List<dynamic> list;
    try {
      list = (raw == null || raw.isEmpty) ? <dynamic>[] : (jsonDecode(raw) as List);
    } catch (_) {
      list = <dynamic>[];
    }
    if (!list.contains(entry)) {
      list.add(entry);
      await DiskCache.writeGlobal(SyncHub.pendingDeletesKey, jsonEncode(list));
    }
  } catch (_) {/* best-effort; the next full sync still applies it */}
}

/// A call-status that means the call is over and any incoming ring should stop.
bool _terminalCallStatus(String s) =>
    s == 'cancel' || s == 'ended' || s == 'missed' || s == 'no-answer';

/// Local notification for a new (E2E) message. Content-less by design — only the
/// sender's display name travels; the message body never leaves the devices.
Future<void> _showMessageNotif(Map<String, dynamic> d) async {
  // Two server push paths carry type=message:
  //  • "notify"      → has fromName (the REAL sender) → this is the user-facing
  //                    banner ("<name> · New message").
  //  • "relay-event" → has event_id but only the EPHEMERAL gift-wrap author
  //                    (E2E hides the real sender), so it can't name anyone. We
  //                    use it purely as a high-priority WAKE so a sleeping phone
  //                    reconnects + syncs fast — no duplicate banner, no bump.
  if (d.containsKey('event_id')) return; // relay-event → wake only
  final who = (d['fromName'] ?? 'AvaTOK').toString();
  final count = await _bumpBadge();
  final body = count > 1 ? '$count new messages' : 'New message';
  await _local.show(
    8000, // fixed id → the message notification updates in place (one banner)
    who,
    body,
    NotificationDetails(
      android: AndroidNotificationDetails(
        _msgChannel.id, _msgChannel.name,
        channelDescription: _msgChannel.description,
        importance: Importance.high, priority: Priority.high,
        number: count, // launchers read this for the icon badge count
        ticker: 'Message from $who',
        category: AndroidNotificationCategory.message,
      ),
    ),
    payload: 'chat',
  );
}

/// Show the native full-screen incoming-call UI (CallKit / ConnectionService),
/// which rings and wakes the screen even when locked or the app is killed.
Future<void> _showIncoming(Map<String, dynamic> d) async {
  if (d['type'] != 'call') { AvaLog.I.log('call', 'incoming skipped (type=${d['type']})'); return; }
  AvaLog.I.log('call', 'showing incoming-call UI callId=${d['callId']} kind=${d['kind']} from=${d['fromName']}');
  IceCache.prefetch(); // warm TURN creds while the phone is still ringing
  final params = CallKitParams(
    id: (d['callId'] ?? '').toString(),
    nameCaller: (d['fromName'] ?? 'AvaTOK').toString(),
    appName: 'AvaTOK',
    handle: (d['fromPub'] ?? '').toString(),
    type: d['kind'] == 'video' ? 1 : 0, // 0 = audio, 1 = video
    duration: 45000,
    textAccept: 'Accept',
    textDecline: 'Decline',
    extra: {
      'from': d['fromPub'] ?? '', // server sends 'fromPub' (FCM reserves 'from')
      'kind': d['kind'] ?? 'audio',
      'callId': d['callId'] ?? '',
      'fromName': d['fromName'] ?? 'AvaTOK',
    },
    android: const AndroidParams(
      isCustomNotification: true,
      isShowLogo: false,
      ringtonePath: 'system_ringtone_default',
      backgroundColor: '#11A37F',
      actionColor: '#4CAF50',
      incomingCallNotificationChannelName: 'Incoming calls',
    ),
    ios: const IOSParams(handleType: 'generic', supportsVideo: true),
  );
  await FlutterCallkitIncoming.showCallkitIncoming(params);
}

class PushService {
  static Future<void> init() async {
    // Desktop (macOS) test build: no APNs and no native incoming-call UI
    // (flutter_callkit_incoming is mobile-only). Skip push/CallKit wiring so the
    // app runs cleanly; messaging still works over the live socket while open.
    if (!Platform.isAndroid && !Platform.isIOS) {
      AvaLog.I.log('app', 'push/CallKit disabled on desktop (${Platform.operatingSystem})');
      return;
    }
    AvaLog.I.log('app', 'session start (app=${AvaLog.I.app}, session=${AvaLog.I.session})');
    await FirebaseMessaging.instance.requestPermission();
    await _local.initialize(
      const InitializationSettings(
        android: AndroidInitializationSettings('@mipmap/ic_launcher'),
      ),
      onDidReceiveNotificationResponse: (resp) => _onNotifTap(resp.payload),
    );
    await _local
        .resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>()
        ?.createNotificationChannel(_msgChannel);
    // Cold-started by tapping a message notification? Route to the inbox.
    final launch = await _local.getNotificationAppLaunchDetails();
    if (launch?.didNotificationLaunchApp ?? false) {
      _onNotifTap(launch!.notificationResponse?.payload);
    }
    FirebaseMessaging.onMessage.listen((m) {
      final d = m.data;
      AvaLog.I.log('push', 'FCM received (foreground) type=${d['type']} callId=${d['callId'] ?? ''}');
      // Server-relayed call status → update the active CallScreen.
      if (d['type'] == 'call-status') {
        final callId = (d['callId'] ?? '').toString();
        final status = (d['status'] ?? '').toString();
        callStatusBus.add((callId: callId, status: status));
        // If we're the callee still ringing, dismiss the incoming-call UI.
        if (callId.isNotEmpty && _terminalCallStatus(status)) {
          FlutterCallkitIncoming.endCall(callId);
        }
        return;
      }
      if (d['type'] == 'message') {
        // App is open: the live InboxDO socket should already have it. But if the
        // socket was dropped (mobile DNS), this FCM wake forces a reconnect + sync
        // so the message lands immediately instead of waiting for a manual refresh.
        SyncHub.I.ensureConnected();
        return;
      }
      if (d['type'] == 'del') {
        // Delete-for-everyone arriving while the app is foregrounded — apply the
        // redaction in realtime (durable tombstone + live thread update).
        SyncHub.I.applyRemoteDelete(
            (d['target'] ?? '').toString(), conv: (d['conv'] ?? '').toString());
        return;
      }
      // Incoming call. Reconcile a possibly-stale "on a call" flag BEFORE
      // deciding to ring or auto-reply busy — a leftover gInCall used to make
      // the device busy-reject every future call (the phantom-busy bug).
      if (d['type'] == 'call') {
        final incomingId = (d['callId'] ?? '').toString();
        final kind = (d['kind'] == 'video') ? 'video' : 'audio';
        // Duplicate/echo push for the call already on screen → ignore.
        if (incomingId.isNotEmpty && incomingId == gActiveCallId) {
          Analytics.capture('call_duplicate_push_ignored', {'call_id': incomingId});
          return;
        }
        if (callIsGenuinelyActive()) {
          _signalStatus(incomingId, 'busy', (d['fromPub'] ?? '').toString());
          Analytics.capture('call_incoming_autobusy', {
            'call_id': incomingId, 'kind': kind, 'busy_reason': 'on_another_call',
          });
          return;
        }
        if (gInCall) {
          // Stale gInCall — a previous call left it set without tearing down.
          // Clear it so we ring normally instead of silently rejecting busy.
          Analytics.capture('call_stale_incall_cleared', {
            'call_id': incomingId,
            'age_ms': gInCallSince == 0
                ? -1
                : DateTime.now().millisecondsSinceEpoch - gInCallSince,
          });
          gInCall = false;
          gActiveCallId = null;
          gInCallSince = 0;
        }
        Analytics.capture('call_incoming_received', {
          'call_id': incomingId, 'kind': kind, 'state': 'foreground',
        });
        _showIncoming(d);
        return;
      }
      _showIncoming(d);
    });
    // The FCM token rotates (reinstall, restore, periodic refresh). Always
    // re-register the new one so the device never silently stops receiving
    // calls/pushes — this was a key cause of "no call came through".
    FirebaseMessaging.instance.onTokenRefresh.listen((t) {
      AvaLog.I.log('push', 'FCM token refreshed — re-registering');
      _postToken(t).catchError((e) => AvaLog.I.log('push', 're-register failed: $e'));
    });
    _listenCallkit();
    await CallDiag.load(); // TURN-only diagnostics flag
    await _recoverAcceptedCall();
  }

  /// Killed-state accept: when the app was terminated and the user accepted the
  /// native incoming-call UI, the engine cold-starts and the accept event has
  /// already fired before _listenCallkit ran. Check the OS for a call that's
  /// active-but-unanswered-in-Flutter and route into it.
  static Future<void> _recoverAcceptedCall() async {
    try {
      final calls = await FlutterCallkitIncoming.activeCalls();
      if (calls is! List || calls.isEmpty) return;
      for (final c in calls) {
        final m = (c as Map?) ?? const {};
        final accepted = m['isAccepted'] == true || m['accepted'] == true;
        final extra = m['extra'];
        if (accepted && extra is Map && !gInCall) {
          AvaLog.I.log('call', 'recovering accepted call after cold start callId=${extra['callId']}');
          IceCache.prefetch();
          // Give the navigator one frame to exist.
          WidgetsBinding.instance.addPostFrameCallback((_) => _openCall(extra));
          return;
        }
      }
    } catch (e) {
      AvaLog.I.log('call', 'activeCalls recovery check failed: $e');
    }
  }

  /// Best-effort: nudge recipients that a new message arrived (content-less).
  static void notifyMessage(List<String> npubs, String fromName) {
    if (npubs.isEmpty) return;
    ApiAuth.postJson(kNotifyUrl, {'to': npubs, 'fromName': fromName}).ignore();
  }

  /// Clear the unread app-icon badge + collapse the message notification. Call
  /// when the user opens the app or views the chat list.
  static Future<void> clearMessageBadge() => _clearBadge();

  /// Tell the caller a call was declined / busy — over the WS room (fast path)
  /// AND via the server push (works even if the socket can't be held).
  static void _signalStatus(String callId, String status, String callerNpub) {
    if (callId.isEmpty) return;
    // fast path: signaling room
    try {
      final ch = WebSocketChannel.connect(
          Uri.parse('wss://$kSignalingHost/room/$callId?id=ctl-${DateTime.now().millisecondsSinceEpoch}'));
      ch.sink.add(jsonEncode({'type': status}));
      Future.delayed(const Duration(milliseconds: 800), () {
        try { ch.sink.close(); } catch (_) {}
      });
    } catch (_) {/* best effort */}
    // durable path: server pushes the status to the caller
    if (callerNpub.isNotEmpty) {
      ApiAuth.postJson(kCallStatusUrl, {'to': callerNpub, 'callId': callId, 'status': status}).ignore();
    }
  }

  /// React to taps on the native call UI (accept / decline / timeout).
  static void _listenCallkit() {
    FlutterCallkitIncoming.onEvent.listen((event) {
      if (event == null) return;
      switch (event.event) {
        case Event.actionCallAccept:
          IceCache.prefetch(); // accept tapped → call screen is next; warm TURN now
          final acc = event.body['extra'];
          if (acc is Map) {
            Analytics.capture('call_incoming_accepted', {
              'call_id': (acc['callId'] ?? '').toString(),
              'kind': acc['kind'] == 'video' ? 'video' : 'audio',
            });
          }
          _openCall(event.body['extra']);
          break;
        case Event.actionCallDecline:
          final extra = event.body['extra'];
          if (extra is Map) {
            // v2 Mode C: if the owner enabled "let Ava take calls I decline",
            // signal 'decline_ava' so the caller hands off to the receptionist
            // instead of getting a plain decline. Else signal a normal decline.
            // ignore: unawaited_futures
            _declineRouting(extra);
          }
          break;
        case Event.actionCallTimeout:
          final ex = event.body['extra'];
          if (ex is Map) _logMissed(ex);
          break;
        case Event.actionCallEnded:
          break;
        default:
          break;
      }
    });
  }

  /// Decline routing (v2 Mode C). Audio calls only — Ava is audio. Reads the
  /// per-account local mirror written by the Settings card (DiskCache keys
  /// receptionist_enabled + receptionist_decline_to_ava) so it works even when
  /// the app was woken cold for the call.
  static Future<void> _declineRouting(Map extra) async {
    final callId = (extra['callId'] ?? '').toString();
    final from = (extra['from'] ?? '').toString();
    var status = 'decline';
    try {
      final isAudio = extra['kind'] != 'video';
      if (isAudio) {
        // Owner decision 2026-06-25: when Ava is enabled, an explicit Decline
        // should ALSO hand the caller to the receptionist to take a message.
        // This was gated behind a separate decline_to_ava sub-toggle that was
        // off by default, so Reject → dead end instead of "Ava takes a message".
        // Enabling Ava is now sufficient (the caller still falls back to a plain
        // decline if Ava can't actually pick up).
        final enabled = (await DiskCache.read('receptionist_enabled')) == '1';
        if (enabled) status = 'decline_ava';
      }
    } catch (_) {/* fall back to plain decline */}
    _signalStatus(callId, status, from);
    Analytics.capture('call_incoming_declined', {
      'call_id': callId,
      'routed_to': status, // 'decline' | 'decline_ava'
    });
    _logMissed(extra);
  }

  static void _logMissed(Map extra) {
    Analytics.capture('call_incoming_missed', {
      'call_id': (extra['callId'] ?? '').toString(),
      'kind': extra['kind'] == 'video' ? 'video' : 'audio',
    });
    CallLogStore().add(CallEntry(
      name: (extra['fromName'] ?? 'Caller').toString(),
      seed: (extra['from'] ?? 'caller').toString(),
      video: extra['kind'] == 'video',
      dir: CallDir.missed,
      ts: DateTime.now().millisecondsSinceEpoch ~/ 1000,
    ));
  }

  /// Register this device's FCM token against the user's npub.
  static Future<void> registerToken(String npub) async {
    try {
      var token = await FirebaseMessaging.instance.getToken();
      if (token == null) {
        AvaLog.I.log('push', 'FCM token null — retrying in 3s');
        await Future.delayed(const Duration(seconds: 3));
        token = await FirebaseMessaging.instance.getToken();
      }
      if (token == null) {
        AvaLog.I.log('push', 'FCM token STILL NULL — device cannot receive calls/pushes');
        return;
      }
      await _postToken(token);
    } catch (e) {
      AvaLog.I.log('push', 'register token FAILED: $e');
    }
  }

  /// POST the current token to the server (npub is derived server-side from the
  /// NIP-98 signature). Used by registerToken AND by onTokenRefresh.
  static Future<void> _postToken(String token) async {
    final res = await ApiAuth.postJson(kRegisterUrl, {'token': token, 'platform': 'fcm'});
    AvaLog.I.log('push', 'registered FCM token ${token.substring(0, 10)}… -> HTTP ${res.statusCode}');
  }

  static void _openCall(dynamic extra) {
    try {
      final e = (extra as Map);
      navigatorKey.currentState?.push(MaterialPageRoute(
        builder: (_) => CallScreen(
          room: (e['callId'] ?? '').toString(),
          title: (e['fromName'] ?? 'Caller').toString(),
          seed: (e['from'] ?? 'caller').toString(),
          video: e['kind'] == 'video',
          outgoing: false,
        ),
      ));
    } catch (_) {}
  }
}
