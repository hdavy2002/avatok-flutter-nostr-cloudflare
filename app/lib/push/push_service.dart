import 'dart:convert';

import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/material.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:http/http.dart' as http;

import '../core/config.dart';
import '../features/avatok/call_screen.dart';

/// Global key so we can navigate to the call screen from a notification tap.
final navigatorKey = GlobalKey<NavigatorState>();

final _local = FlutterLocalNotificationsPlugin();

const _callChannel = AndroidNotificationChannel(
  'avatok_calls',
  'Incoming calls',
  description: 'AvaTOK incoming call notifications',
  importance: Importance.max,
);

/// Background/terminated FCM handler — must be a top-level entry point.
@pragma('vm:entry-point')
Future<void> firebaseBackgroundHandler(RemoteMessage message) async {
  await _showIncoming(message.data);
}

Future<void> _showIncoming(Map<String, dynamic> d) async {
  if (d['type'] != 'call') return;
  await _local.show(
    1001,
    (d['fromName'] ?? 'Incoming call').toString(),
    d['kind'] == 'video' ? 'Video call' : 'Voice call',
    NotificationDetails(
      android: AndroidNotificationDetails(
        _callChannel.id,
        _callChannel.name,
        channelDescription: _callChannel.description,
        importance: Importance.max,
        priority: Priority.max,
        category: AndroidNotificationCategory.call,
        fullScreenIntent: true,
        ongoing: true,
        autoCancel: true,
      ),
    ),
    payload: jsonEncode(d),
  );
}

class PushService {
  static Future<void> init() async {
    await _local.initialize(
      const InitializationSettings(
        android: AndroidInitializationSettings('@mipmap/ic_launcher'),
      ),
      onDidReceiveNotificationResponse: (resp) => _openCall(resp.payload),
    );
    await _local
        .resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>()
        ?.createNotificationChannel(_callChannel);

    await FirebaseMessaging.instance.requestPermission();
    FirebaseMessaging.onMessage.listen((m) => _showIncoming(m.data));
    FirebaseMessaging.onMessageOpenedApp.listen((m) => _openCall(jsonEncode(m.data)));
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

  static void _openCall(String? payload) {
    if (payload == null) return;
    try {
      final d = jsonDecode(payload) as Map<String, dynamic>;
      if (d['type'] != 'call') return;
      navigatorKey.currentState?.push(MaterialPageRoute(
        builder: (_) => CallScreen(
          room: (d['callId'] ?? '').toString(),
          title: (d['fromName'] ?? 'Caller').toString(),
          seed: (d['from'] ?? 'caller').toString(),
          video: d['kind'] == 'video',
        ),
      ));
    } catch (_) {}
  }
}
