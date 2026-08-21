// STREAM-LANE: this file talks to the real Stream Video Flutter SDK
// (`package:stream_video_flutter`, `package:stream_video_push_notification`).
// Both packages are currently COMMENTED OUT in app/pubspec.yaml pending
// resolution of a native Android conflict with the existing `flutter_webrtc`
// dependency used by the old 1:1 call lane (see the pubspec.yaml comment next
// to the commented-out entries for the full reasoning). Until those two lines
// are uncommented, every import below fails to resolve and nothing in
// app/lib/streamlane/ compiles. The code is written AS IF the SDK were
// present so it is ready to drop in the moment the conflict is cleared.
//
// This is a NEW, independent Stream integration — do not confuse it with the
// existing `core/calls/rtc/stream_call_api.dart` / `stream_call_provider.dart`
// pilot, which talks to Stream via a hand-rolled token exchange and a native
// `stream_call_bridge` plugin, not this SDK. That pilot is gated by
// `RemoteConfig.streamCallPilotEnabled`; this lane is gated by the new,
// separate `RemoteConfig.streamCallsEnabled` flag (see edit A in
// core/remote_config.dart) so the two can never both be live for the same call.
library;

import 'dart:async';
import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
// ignore: unused_import
import 'package:stream_video_flutter/stream_video_flutter.dart';
// ignore: unused_import
import 'package:stream_video_push_notification/stream_video_push_notification.dart';

import '../core/account_storage.dart';
import '../core/analytics.dart';
import '../core/api_auth.dart';
import '../core/config.dart';
import '../core/profile_store.dart';
import '../core/remote_config.dart';
import '../identity/identity.dart' show AccountScope;
import 'stream_incoming_screen.dart';

/// Bootstrap singleton for the Stream Video SDK client. Mirrors the shape of
/// [StreamCallApi] in the old lane (lazy client, per-account credentials) but
/// owns a real `StreamVideo` client instance instead of a bespoke token store.
class StreamLane {
  StreamLane._();

  static final StreamLane instance = StreamLane._();

  /// Flag getter is deliberately separate from `StreamCallPilot.enabled` (the
  /// old lane's gate) — see the library comment above.
  static bool get isEnabled => RemoteConfig.streamCallsEnabled;

  // Not a Stream SDK symbol — this is the Worker's token-response contract
  // (worker/src/routes/stream_video_calls.ts ~line 297 returns `api_key`),
  // left as a placeholder per the activation instructions. Ideally this key
  // comes from remote config or the token response body instead of being
  // compiled in, so an API key rotation doesn't require a client release.
  static const String _apiKeyFallback = 'REPLACE_WITH_STREAM_API_KEY';

  StreamVideo? _client;
  bool _initStarted = false;

  /// Lazily creates and connects the `StreamVideo` client. No-op when the
  /// flag is off, so a disabled lane never touches the network or spends a
  /// Stream connection.
  Future<void> init() async {
    if (!isEnabled) return;
    if (_initStarted) return;
    _initStarted = true;
    try {
      final uid = AccountScope.id;
      if (uid == null || uid.isEmpty) return; // no signed-in account yet
      String name = 'AvaTOK';
      String image = '';
      try {
        final p = await ProfileStore().load();
        if (p.displayName.isNotEmpty) name = p.displayName;
        image = p.avatarUrl;
      } catch (_) {/* fall back to defaults */}

      final apiKey = await _resolveApiKey(uid);
      if (apiKey.isEmpty) return;

      _client = StreamVideo(
        apiKey,
        user: User.regular(userId: uid, name: name, image: image),
        // verified: packages/stream_video/lib/src/token/token.dart —
        // `typedef TokenLoader = Future<String> Function(String userId)`.
        // `_loadToken` already matches that shape exactly (it ignores the
        // callback's userId arg and closes over `uid`, which is fine since
        // they're always the same value here), so passing the tear-off
        // directly is correct; the previous `() => _loadToken(uid)` closure
        // took zero arguments and did not satisfy TokenLoader.
        tokenLoader: _loadToken,
        options: const StreamVideoOptions(
          // verified: packages/stream_video/lib/src/stream_video.dart
          // (StreamVideoOptions field names)
          keepConnectionsAliveWhenInBackground: true,
          muteAudioWhenInBackground: true,
        ),
        // verified: packages/stream_video_push_notification/lib/src/
        // stream_video_push_notification.dart + stream_video_push_provider.dart
        // (dogfooding/lib/di/injector.dart uses this exact shape). Both
        // `iosPushProvider` and `androidPushProvider` are REQUIRED params —
        // there is no bare `AndroidPushProvider`/`PushProviderInfo` type in
        // the SDK; the real type is `StreamVideoPushProvider.apn(name:)` /
        // `StreamVideoPushProvider.firebase(name:)`. The `name` must exactly
        // match the Push Provider configured in the Stream Dashboard.
        pushNotificationManagerProvider:
            StreamVideoPushNotificationManager.create(
          iosPushProvider: const StreamVideoPushProvider.apn(
            name: 'avatok-apn',
          ),
          androidPushProvider: const StreamVideoPushProvider.firebase(
            name: 'firebase',
          ),
          registerApnDeviceToken: true,
        ),
      );

      // Foreground ringing: show the in-app ring screen when a call comes in
      // while the app is open. Killed/background is handled by
      // stream_push_glue.dart's background variant instead.
      _client!.state.incomingCall.listen((call) {
        if (call == null) return;
        Analytics.capture('stream_lane_ring_shown', {
          'call_id': call.callCid.value,
          'user_email': Analytics.currentEmail ?? '',
        });
        StreamIncomingScreen.showForCall(call);
      });

      await _client!.connect();
      Analytics.capture('stream_lane_client_connected', {
        'user_email': Analytics.currentEmail ?? '',
      });
    } catch (e, st) {
      await Analytics.captureException(
        e,
        st,
        screen: 'stream_lane',
        handled: true,
        extra: {'op': 'init'},
      );
    }
  }

  Future<void> dispose() async {
    try {
      await _client?.disconnect();
    } catch (_) {/* best-effort */}
    _client = null;
    _initStarted = false;
  }

  StreamVideo? get client => _client;

  /// GET the Stream token from the Worker (mirrors the old lane's
  /// `StreamCallApi.warmForAccount` HTTP pattern in
  /// core/calls/rtc/stream_call_api.dart, which this file must not import).
  Future<String> _loadToken(String uid) async {
    final response = await ApiAuth.getSigned(
      '$kApiBase/stream-video/token',
      timeout: const Duration(seconds: 8),
    );
    if (response.statusCode != 200) {
      throw StateError('stream token request failed: ${response.statusCode}');
    }
    final raw = jsonDecode(response.body);
    if (raw is! Map) throw const FormatException('invalid Stream token body');
    final body = Map<String, dynamic>.from(raw);
    final token = (body['token'] ?? '').toString();
    if (token.isEmpty) {
      throw const FormatException('empty Stream token');
    }
    // Persist minimal credentials per account so the background push isolate
    // (stream_push_glue.dart) can recreate a `StreamVideo` client without a
    // round-trip through this main-isolate code.
    unawaited(_persistCredentials(uid, body, token));
    return token;
  }

  Future<String> _resolveApiKey(String uid) async {
    // Not a Stream SDK symbol — prefers the `api_key`/`apiKey` value carried
    // on the Worker's token response body (worker/src/routes/
    // stream_video_calls.ts) over the hardcoded fallback above.
    try {
      final response = await ApiAuth.getSigned(
        '$kApiBase/stream-video/token',
        timeout: const Duration(seconds: 8),
      );
      if (response.statusCode == 200) {
        final raw = jsonDecode(response.body);
        if (raw is Map) {
          final k = (raw['api_key'] ?? raw['apiKey'] ?? '').toString();
          if (k.isNotEmpty) return k;
        }
      }
    } catch (_) {/* fall through to the compiled-in fallback */}
    return _apiKeyFallback;
  }

  /// Public so `stream_push_glue.dart`'s background handler can locate the
  /// same secure-storage entries without importing `account_storage.dart`'s
  /// `scopedKey` (which reads `AccountScope.id` — unset in the FCM
  /// background isolate, see BG-ISOLATE-1 in push_service.dart). The
  /// background reader matches on this prefix directly instead.
  static const String kCredKeyBase = 'stream_lane_credentials_v1';
  static const String _kCredKey = kCredKeyBase;
  static const FlutterSecureStorage _secure = FlutterSecureStorage();

  /// Per-account credential blob for [uid]. Read by the background push
  /// isolate (stream_push_glue.dart) to recreate a `StreamVideo` client
  /// without the main isolate's app state. Scoped via [scopedKey] per the
  /// account_storage.dart convention — a shared phone can hold credentials
  /// for more than one account at once.
  Future<void> _persistCredentials(
    String uid,
    Map<String, dynamic> tokenBody,
    String token,
  ) async {
    try {
      final apiKey =
          (tokenBody['api_key'] ?? tokenBody['apiKey'] ?? _apiKeyFallback)
              .toString();
      final key = scopedKey(_kCredKey);
      await _secure.write(
        key: key,
        value: jsonEncode({'uid': uid, 'api_key': apiKey, 'token': token}),
      );
    } catch (_) {/* best-effort — background recovery degrades gracefully */}
  }
}
