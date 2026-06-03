import 'dart:async';
import 'dart:convert';

import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/material.dart';
import 'package:flutter_callkit_incoming/entities/entities.dart';
import 'package:flutter_callkit_incoming/flutter_callkit_incoming.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:http/http.dart' as http;
import 'package:web_socket_channel/web_socket_channel.dart';

import '../core/call_log_store.dart';
import '../core/config.dart';
import '../features/avatok/call_screen.dart';

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

/// Background/terminated FCM handler — must be a top-level entry point.
@pragma('vm:entry-point')
Future<void> firebaseBackgroundHandler(RemoteMessage message) async {
  final d = message.data;
  if (d['type'] == 'message') {
    await _showMessageNotif(d);
  } else {
    await _showIncoming(d);
  }
}

/// Local notification for a new (E2E) message. Content-less by design — only the
/// sender's display name travels; the message body never leaves the devices.
Future<void> _showMessageNotif(Map<String, dynamic> d) async {
  final who = (d['fromName'] ?? 'AvaTOK').toString();
  await _local.show(
    DateTime.now().millisecondsSinceEpoch ~/ 1000 % 100000,
    who,
    'New message',
    NotificationDetails(
      android: AndroidNotificationDetails(
        _msgChannel.id, _msgChannel.name,
        channelDescription: _msgChannel.description,
        importance: Importance.high, priority: Priority.high,
      ),
    ),
  );
}

/// Show the native full-screen incoming-call UI (CallKit / ConnectionService),
/// which rings and wakes the screen even when locked or the app is killed.
Future<void> _showIncoming(Map<String, dynamic> d) async {
  if (d['type'] != 'call') return;
  final params = CallKitParams(
    id: (d['callId'] ?? '').toString(),
    nameCaller: (d['fromName'] ?? 'AvaTOK').toString(),
    appName: 'AvaTOK',
    handle: (d['from'] ?? '').toString(),
    type: d['kind'] == 'video' ? 1 : 0, // 0 = audio, 1 = video
    duration: 45000,
    textAccept: 'Accept',
    textDecline: 'Decline',
    extra: {
      'from': d['from'] ?? '',
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
    await FirebaseMessaging.instance.requestPermission();
    await _local.initialize(const InitializationSettings(
      android: AndroidInitializationSettings('@mipmap/ic_launcher'),
    ));
    await _local
        .resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>()
        ?.createNotificationChannel(_msgChannel);
    FirebaseMessaging.onMessage.listen((m) {
      final d = m.data;
      // Server-relayed call status → update the active CallScreen.
      if (d['type'] == 'call-status') {
        callStatusBus.add((callId: (d['callId'] ?? '').toString(), status: (d['status'] ?? '').toString()));
        return;
      }
      if (d['type'] == 'message') return; // app is open — unread badge handles it
      // Already on a call → auto-reply "busy" instead of ringing.
      if (d['type'] == 'call' && gInCall) {
        _signalStatus((d['callId'] ?? '').toString(), 'busy', (d['from'] ?? '').toString());
        return;
      }
      _showIncoming(d);
    });
    _listenCallkit();
  }

  /// Best-effort: nudge recipients that a new message arrived (content-less).
  static void notifyMessage(List<String> npubs, String fromName) {
    if (npubs.isEmpty) return;
    http.post(Uri.parse(kNotifyUrl),
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({'to': npubs, 'fromName': fromName})).ignore();
  }

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
      http.post(Uri.parse(kCallStatusUrl),
          headers: {'Content-Type': 'application/json'},
          body: jsonEncode({'to': callerNpub, 'callId': callId, 'status': status})).ignore();
    }
  }

  /// React to taps on the native call UI (accept / decline / timeout).
  static void _listenCallkit() {
    FlutterCallkitIncoming.onEvent.listen((event) {
      if (event == null) return;
      switch (event.event) {
        case Event.actionCallAccept:
          _openCall(event.body['extra']);
          break;
        case Event.actionCallDecline:
          final extra = event.body['extra'];
          if (extra is Map) {
            _signalStatus((extra['callId'] ?? '').toString(), 'decline', (extra['from'] ?? '').toString());
            _logMissed(extra);
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

  static void _logMissed(Map extra) {
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
      final token = await FirebaseMessaging.instance.getToken();
      if (token == null) return;
      await http.post(
        Uri.parse(kRegisterUrl),
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({'npub': npub, 'token': token}),
      );
    } catch (_) {/* offline / not configured */}
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
