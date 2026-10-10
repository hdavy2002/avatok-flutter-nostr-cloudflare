import 'dart:async';

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'push_payload.dart';

enum PushPermission { granted, notGranted }

/// The one place the app touches Firebase Messaging, so tests swap it for a fake
/// (`pushGatewayProvider.overrideWithValue(FakePushGateway())`).
abstract class PushGateway {
  const PushGateway();

  /// False when Firebase never started (a build without google-services.json, or a test).
  /// Then there is no token, no prompt and no stream.
  bool get available;

  Future<PushPermission> permission();

  /// Shows the Android 13+ prompt (a no-op below 13, where the permission is granted at install).
  Future<PushPermission> requestPermission();

  Future<String?> token();

  Stream<String> get onTokenRefresh;

  /// A message that arrived while the app was open.
  Stream<PushMessage> get onForeground;

  /// A notification tapped while the app was in the background.
  Stream<PushMessage> get onOpened;

  /// The notification that started the app from closed, once.
  Future<PushMessage?> initialMessage();
}

final pushGatewayProvider = Provider<PushGateway>((ref) => const FirebasePushGateway());

class FirebasePushGateway extends PushGateway {
  const FirebasePushGateway();

  @override
  bool get available {
    try {
      return Firebase.apps.isNotEmpty;
    } catch (_) {
      return false;
    }
  }

  FirebaseMessaging get _fm => FirebaseMessaging.instance;

  static PushPermission _map(AuthorizationStatus s) =>
      (s == AuthorizationStatus.authorized || s == AuthorizationStatus.provisional)
          ? PushPermission.granted
          : PushPermission.notGranted;

  @override
  Future<PushPermission> permission() async {
    if (!available) return PushPermission.notGranted;
    final s = await _fm.getNotificationSettings();
    return _map(s.authorizationStatus);
  }

  @override
  Future<PushPermission> requestPermission() async {
    if (!available) return PushPermission.notGranted;
    final s = await _fm.requestPermission();
    return _map(s.authorizationStatus);
  }

  @override
  Future<String?> token() async => available ? _fm.getToken() : null;

  @override
  Stream<String> get onTokenRefresh => available ? _fm.onTokenRefresh : const Stream<String>.empty();

  @override
  Stream<PushMessage> get onForeground =>
      available ? FirebaseMessaging.onMessage.map(_message) : const Stream<PushMessage>.empty();

  @override
  Stream<PushMessage> get onOpened =>
      available ? FirebaseMessaging.onMessageOpenedApp.map(_message) : const Stream<PushMessage>.empty();

  @override
  Future<PushMessage?> initialMessage() async {
    if (!available) return null;
    final m = await _fm.getInitialMessage();
    return m == null ? null : _message(m);
  }

  static PushMessage _message(RemoteMessage m) => PushMessage(
        title: m.notification?.title ?? '',
        body: m.notification?.body ?? '',
        data: m.data.map((k, v) => MapEntry(k, '$v')),
      );
}
