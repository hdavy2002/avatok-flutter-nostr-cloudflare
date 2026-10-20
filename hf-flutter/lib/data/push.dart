import 'dart:async';

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../core/deep_links.dart';
import 'api_client.dart';
import 'telemetry.dart';

/// Lets [PushNotifications] show the in-app banner for a push that arrives while the app is open.
/// Passed to `MaterialApp.router(scaffoldMessengerKey: ...)` in main.dart.
final GlobalKey<ScaffoldMessengerState> hfMessengerKey = GlobalKey<ScaffoldMessengerState>();

/// [HF-BOOK-APPROVE-PUSH] Push notifications: token registration and "tap a notification, open the screen".
///
/// - [init] (main.dart, after the first frame): starts Firebase and listens for taps. Quietly does nothing when the
///   build has no google-services.json (CI writes it only when the secret HF_GOOGLE_SERVICES_JSON is set).
/// - [onAccount] (Services, after `/api/hf/me` loaded for a signed-in person): asks for the notification permission
///   once (Android 13+ dialog), then registers the device token with the worker for THIS account.
/// - [onSignOut]: removes the token from the account before the Clerk session ends, so a shared phone never gets the
///   previous person's pushes.
///
/// The worker sends a "notification" message with a data block `{type, kind, path, title, body}` (consumers/src/fcm.ts
/// buildHfPayload). `path` is an app-friendly location such as `/bookings/<id>`; [DeepLinks.openPush] maps it to a screen.
/// App closed: the system shows the notification, a tap starts the app and [FirebaseMessaging.getInitialMessage] has it
/// (state `cold`). App in the background: [FirebaseMessaging.onMessageOpenedApp] (state `background`). App open: the system
/// shows nothing, so a banner with an OPEN button is shown here (state `foreground`, counted only when OPEN is tapped).
abstract final class PushNotifications {
  static const String _askedKey = 'hf_push_asked_v1';

  static bool _ready = false;
  static bool _active = false;
  static ApiClient? _api;
  static String _shell = 'native';
  static String? _registeredToken;
  static bool _busy = false;

  /// True once Firebase is up (a build with google-services.json, after [init]).
  static bool get ready => _ready;

  static Future<void> init() async {
    if (_ready) return;
    try {
      await Firebase.initializeApp();
    } catch (_) {
      return; // no google-services.json in this build: the app works, without push
    }
    _ready = true;
    try {
      final fm = FirebaseMessaging.instance;
      FirebaseMessaging.onMessage.listen(_onForeground, onError: (Object _) {});
      FirebaseMessaging.onMessageOpenedApp.listen((m) => _tapped(m, 'background'), onError: (Object _) {});
      fm.onTokenRefresh.listen((t) => unawaited(_register(t)), onError: (Object _) {});
      final first = await fm.getInitialMessage();
      if (first != null) _tapped(first, 'cold');
    } catch (_) {
      // push is a convenience
    }
  }

  /// Signed-in person is known: ask once, then register this device for them. Never throws.
  static Future<void> onAccount(ApiClient api, {String shell = 'native'}) async {
    if (!_ready || _busy) return;
    _busy = true;
    try {
      _api = api;
      _shell = shell;
      _active = true;
      final fm = FirebaseMessaging.instance;
      var status = (await fm.getNotificationSettings()).authorizationStatus;
      if (!_isAllowed(status) && await _firstAsk()) {
        status = (await fm.requestPermission()).authorizationStatus;
      }
      if (!_isAllowed(status)) return; // she said no; the OS settings are the way back
      final token = await fm.getToken();
      if (token == null || token.isEmpty) {
        Telemetry.event('hf_push_registered', {'outcome': 'failed', 'reason': 'no_token', 'shell_version': _shell});
        return;
      }
      await _register(token);
    } catch (_) {
      // never block the app on push
    } finally {
      _busy = false;
    }
  }

  /// The session is gone without a sign-out (token revoked): stop registering, nothing to call.
  static void forget() {
    _active = false;
    _registeredToken = null;
  }

  /// Sign-out: take this device's token off the account (needs the session, so call before Clerk signs out).
  static Future<void> onSignOut(ApiClient api) async {
    _active = false;
    final known = _registeredToken;
    _registeredToken = null;
    if (!_ready) return;
    try {
      final token = known ?? await FirebaseMessaging.instance.getToken();
      if (token == null || token.isEmpty) return;
      await api.deleteJson('/api/hf/push/register', body: {'token': token}).timeout(const Duration(seconds: 4));
    } catch (_) {
      // the worker also drops dead tokens by itself
    }
  }

  static bool _isAllowed(AuthorizationStatus s) => s == AuthorizationStatus.authorized || s == AuthorizationStatus.provisional;

  /// True the first time only: the system dialog is shown once per install, not on every app start.
  static Future<bool> _firstAsk() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      if (prefs.getBool(_askedKey) ?? false) return false;
      await prefs.setBool(_askedKey, true);
      return true;
    } catch (_) {
      return false;
    }
  }

  static Future<void> _register(String token) async {
    final api = _api;
    if (!_active || api == null || token == _registeredToken) return;
    final started = Stopwatch()..start();
    try {
      await api.postJson('/api/hf/push/register', body: {'token': token, 'platform': 'android', 'shell': _shell});
      _registeredToken = token;
      Telemetry.event('hf_push_registered', {'outcome': 'ok', 'ms': started.elapsedMilliseconds, 'shell_version': _shell});
    } catch (_) {
      Telemetry.event('hf_push_registered', {'outcome': 'failed', 'reason': 'error', 'ms': started.elapsedMilliseconds, 'shell_version': _shell});
    }
  }

  static void _tapped(RemoteMessage m, String state) {
    final path = m.data['path'];
    if (path is String && path.isNotEmpty) DeepLinks.openPush(path, state: state);
  }

  /// The app is open, so Android shows nothing for a "notification" message: show a banner with an OPEN button.
  static void _onForeground(RemoteMessage m) {
    try {
      final title = (m.notification?.title ?? m.data['title']?.toString() ?? '').trim();
      final body = (m.notification?.body ?? m.data['body']?.toString() ?? '').trim();
      if (title.isEmpty && body.isEmpty) return;
      final messenger = hfMessengerKey.currentState;
      if (messenger == null) return;
      final path = m.data['path'];
      messenger.hideCurrentSnackBar();
      // [HF-BOOK-APPROVE-QA-1] A SnackBar with an action never times out when the phone reports accessible navigation, and on
      // the test phone it sat over the booking screen's Continue button for minutes. Close it ourselves and give it an X.
      final ctl = messenger.showSnackBar(
        SnackBar(
          behavior: SnackBarBehavior.floating,
          duration: const Duration(seconds: 8),
          showCloseIcon: true,
          content: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (title.isNotEmpty) Text(title, style: const TextStyle(fontWeight: FontWeight.w800)),
              if (body.isNotEmpty) Text(body),
            ],
          ),
          action: path is String && path.isNotEmpty
              ? SnackBarAction(label: 'OPEN', onPressed: () => DeepLinks.openPush(path, state: 'foreground'))
              : null,
        ),
      );
      Timer(const Duration(seconds: 8), () {
        try { ctl.close(); } catch (_) {}
      });
    } catch (_) {
      // a banner must never crash the app
    }
  }
}
