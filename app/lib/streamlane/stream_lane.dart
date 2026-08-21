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

  /// The account id [_client] is connected FOR. Non-null only while a live
  /// client exists for that account.
  ///
  /// [STREAM-LANE-FIX-1] This replaces the old `bool _initStarted` latch, which
  /// was set BEFORE the account check and never cleared on failure: one
  /// `init()` that ran a millisecond too early (boot, before `AccountScope.id`
  /// is assigned in main.dart's `_afterAuth`) permanently disabled the lane for
  /// the whole app session — no client, no calls, no retry, no telemetry.
  /// Keying off the account id instead makes init idempotent (same account,
  /// already connected → no-op), correct across an account switch (different
  /// account → tear the old client down first), and retryable (a failure
  /// leaves this null, so the next call tries again).
  String? _readyUid;

  /// The single in-flight connect, so two concurrent `init()` calls share one
  /// attempt instead of building two `StreamVideo` clients.
  Future<void>? _inFlight;
  String? _pendingUid;

  /// [STREAM-LANE-FIX-1] Client-level incoming-call subscription, RETAINED so
  /// it can be cancelled. It used to be created and discarded: after an account
  /// switch (or any second init) a second listener was attached to the same
  /// stream and every incoming call pushed TWO `StreamIncomingScreen`s — one of
  /// them for the account that is no longer in front.
  StreamSubscription<dynamic>? _incomingSub;

  /// Last cid handed to the ring screen, so a re-emitted state value cannot
  /// mount the same ring twice.
  String? _lastIncomingCid;

  // Bounded self-retry. There is no sign-in callback into this file (this
  // agent owns only the two streamlane files), so the lane polls for an
  // account instead of waiting forever for one `init()` at boot.
  Timer? _retryTimer;
  int _accountWaits = 0;
  int _failureRetries = 0;
  bool _skipReported = false;

  static const Duration _kAccountWaitDelay = Duration(seconds: 3);
  static const int _kMaxAccountWaits = 20; // ~60s of waiting for sign-in
  static const int _kMaxFailureRetries = 3; // 2s, 4s, 8s

  /// True when a connected client exists for the account that is signed in
  /// RIGHT NOW. A caller about to place a Stream call should `await init()`
  /// first rather than assuming boot already succeeded.
  bool get isReady =>
      _client != null && _readyUid != null && _readyUid == AccountScope.id;

  /// Call after sign-in / account switch. Idempotent — [init] itself detects
  /// that the account changed and rebuilds the client.
  ///
  /// [STREAM-ACCOUNT-1] Verified: this deliberately does NOT delete anything
  /// from secure storage. A switch must leave the OUTGOING account's
  /// credential blob in place so switching back to it on this device works
  /// without a network round-trip. [init]'s account-switch branch already
  /// calls [_teardown] (cancels `_incomingSub`, disconnects the old
  /// `StreamVideo` client, clears `_readyUid`) before building the new
  /// client — so the outgoing account's client is fully torn down here even
  /// though its stored credentials survive. That teardown was already
  /// correct as of [STREAM-LANE-FIX-1]; nothing needed to change for it.
  Future<void> onAccountChanged() => init();

  /// Call on sign-out of [departingUid] (or account deletion). Unlike
  /// [onAccountChanged], this is destructive: it tears down the client IF it
  /// belongs to the departing account, cancels every lane subscription, and
  /// — the actual fix for the audit item — permanently deletes that
  /// account's cached Stream credential blob so this device can never
  /// recreate a client for it again, in the foreground OR in
  /// `stream_push_glue.dart`'s background recovery path. Without this, a
  /// signed-out account's ~30-day token would keep letting a shared family
  /// phone ring for it indefinitely.
  ///
  /// [departingUid] should be the account id that was active BEFORE the
  /// sign-out (i.e. `AccountScope.id` as read by the caller before it flips
  /// the scope) — pass null only when the caller genuinely has no departing
  /// account to name (defensive no-op for credential deletion; the current
  /// client, if any, is still torn down).
  Future<void> onSignOut(String? departingUid) async {
    // Always tear down whatever client is currently live: a real sign-out
    // means nobody is signed in on this lane afterward, so there is never a
    // reason to leave ANY client connected — including a mismatched
    // `_readyUid` (defensive; should not happen given `init()`'s own
    // account-switch teardown, but a stale connection is exactly the failure
    // mode this method exists to close off).
    final disconnected = _client != null;
    await _teardown();
    _retryTimer?.cancel();
    _retryTimer = null;
    _accountWaits = 0;
    _failureRetries = 0;
    _skipReported = false;

    var deleted = false;
    if (departingUid != null && departingUid.isNotEmpty) {
      deleted = await _deleteCredentials(departingUid, reason: 'sign_out');
    }

    Analytics.capture('stream_lane_signout_cleanup', {
      'account_id': departingUid ?? '',
      'disconnected': disconnected,
      'credentials_deleted': deleted,
      'user_email': Analytics.currentEmail ?? '',
    });
  }

  /// Call when an account is removed from this device (a distinct flow from
  /// signing out of the currently-active account — e.g. "forget this
  /// account" in a multi-account picker). No such flow exists in the app
  /// today (verified: no removal UI beyond sign-out/delete-account, both of
  /// which route through [onSignOut]), so this is currently unwired — kept
  /// public so the day one is added, wiring it is a single call. Deletes the
  /// credential blob unconditionally; also tears down the live client if the
  /// removed account happens to be the one currently connected.
  Future<void> onAccountRemoved(String uid) async {
    if (uid.isEmpty) return;
    final disconnected = _readyUid == uid;
    if (disconnected) {
      await _teardown();
    }
    final deleted = await _deleteCredentials(uid, reason: 'account_removed');
    Analytics.capture('stream_lane_signout_cleanup', {
      'account_id': uid,
      'disconnected': disconnected,
      'credentials_deleted': deleted,
      'user_email': Analytics.currentEmail ?? '',
    });
  }

  /// Shared by [onSignOut] and [onAccountRemoved]. Best-effort; returns
  /// whether the delete call completed without throwing (secure storage
  /// `delete` does not report whether a key existed).
  Future<bool> _deleteCredentials(String uid, {required String reason}) async {
    var ok = false;
    try {
      await _secure.delete(key: credKeyForUid(uid));
      ok = true;
    } catch (_) {/* best-effort */}
    Analytics.capture('stream_lane_credentials_deleted', {
      'account_id': uid,
      'reason': reason,
      'ok': ok,
      'user_email': Analytics.currentEmail ?? '',
    });
    return ok;
  }

  /// Creates and connects the `StreamVideo` client for the signed-in account.
  /// No-op when the flag is off, so a disabled lane never touches the network
  /// or spends a Stream connection. Safe to call repeatedly.
  Future<void> init() async {
    if (!isEnabled) return;

    final uid = AccountScope.id;
    if (uid == null || uid.isEmpty) {
      // No signed-in account YET. Nothing is latched — a later call (or the
      // scheduled retry below) starts from scratch once auth lands.
      if (!_skipReported) {
        _skipReported = true;
        Analytics.capture('stream_lane_init_skipped', {
          'reason': 'no_account',
          'user_email': Analytics.currentEmail ?? '',
        });
      }
      _scheduleAccountRetry();
      return;
    }
    _skipReported = false;

    if (_readyUid == uid && _client != null) return; // already connected

    final pending = _inFlight;
    if (pending != null) {
      if (_pendingUid == uid) return pending; // same account, share the attempt
      await pending; // an account switch landed mid-connect — let it settle
      if (_readyUid == uid && _client != null) return;
    }

    if (_readyUid != null && _readyUid != uid) {
      // Account switch: drop the previous account's client AND its incoming
      // listener before building a new one. Without this the old listener
      // survives and rings the new account's UI for the old account's calls.
      await _teardown();
    }

    final future = _connect(uid);
    _inFlight = future;
    _pendingUid = uid;
    try {
      await future;
    } finally {
      if (identical(_inFlight, future)) {
        _inFlight = null;
        _pendingUid = null;
      }
    }
  }

  Future<void> _connect(String uid) async {
    try {
      String name = 'AvaTOK';
      String image = '';
      try {
        final p = await ProfileStore().load();
        if (p.displayName.isNotEmpty) name = p.displayName;
        image = p.avatarUrl;
      } catch (_) {/* fall back to defaults */}

      final apiKey = await _resolveApiKey(uid);
      if (apiKey.isEmpty) {
        Analytics.capture('stream_lane_init_failed', {
          'reason': 'no_api_key',
          'user_email': Analytics.currentEmail ?? '',
        });
        _scheduleFailureRetry();
        return;
      }

      final client = StreamVideo(
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
        // NOT const: StreamVideoOptions has a non-const constructor (CI run
        // #606 compile error at this line — "Cannot invoke a non-'const'
        // constructor where a const expression is expected").
        options: StreamVideoOptions(
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

      _client = client;

      // Foreground ringing: show the in-app ring screen when a call comes in
      // while the app is open. Killed/background is handled by
      // stream_push_glue.dart's background variant instead.
      //
      // [STREAM-LANE-FIX-1] Retained + cancelled by [_teardown]; a stale
      // listener from a previous account used to survive re-initialisation.
      await _incomingSub?.cancel();
      _incomingSub = client.state.incomingCall.listen((call) {
        if (call == null) return;
        final cid = call.callCid.value;
        if (cid == _lastIncomingCid) return; // same ring re-emitted
        _lastIncomingCid = cid;
        Analytics.capture('stream_lane_ring_shown', {
          'call_id': cid,
          'account_id': uid,
          'user_email': Analytics.currentEmail ?? '',
        });
        StreamIncomingScreen.showForCall(call);
      });

      await client.connect();
      _readyUid = uid;
      _accountWaits = 0;
      _failureRetries = 0;
      Analytics.capture('stream_lane_client_connected', {
        'account_id': uid,
        'user_email': Analytics.currentEmail ?? '',
      });
    } catch (e, st) {
      // A failure must NOT be sticky — leave no client and no ready uid so the
      // next init() (or the retry below) tries again.
      _readyUid = null;
      _client = null;
      try {
        await _incomingSub?.cancel();
      } catch (_) {/* best-effort */}
      _incomingSub = null;
      Analytics.capture('stream_lane_init_failed', {
        'reason': 'exception',
        'error': e.toString(),
        'user_email': Analytics.currentEmail ?? '',
      });
      await Analytics.captureException(
        e,
        st,
        screen: 'stream_lane',
        handled: true,
        extra: {'op': 'init'},
      );
      _scheduleFailureRetry();
    }
  }

  /// Retry once the user signs in. No sign-in callback reaches this file, so
  /// the lane polls — bounded, and cancelled the moment a client connects.
  void _scheduleAccountRetry() {
    if (_retryTimer != null) return;
    if (_accountWaits >= _kMaxAccountWaits) return;
    _accountWaits++;
    final attempt = _accountWaits;
    _retryTimer = Timer(_kAccountWaitDelay, () {
      _retryTimer = null;
      Analytics.capture('stream_lane_init_retried', {
        'trigger': 'account_wait',
        'attempt': attempt,
        'user_email': Analytics.currentEmail ?? '',
      });
      unawaited(init());
    });
  }

  /// Retry a FAILED connect with a small backoff (2s, 4s, 8s).
  void _scheduleFailureRetry() {
    if (_retryTimer != null) return;
    if (_failureRetries >= _kMaxFailureRetries) return;
    _failureRetries++;
    final attempt = _failureRetries;
    _retryTimer = Timer(Duration(seconds: 1 << attempt), () {
      _retryTimer = null;
      Analytics.capture('stream_lane_init_retried', {
        'trigger': 'connect_failed',
        'attempt': attempt,
        'user_email': Analytics.currentEmail ?? '',
      });
      unawaited(init());
    });
  }

  /// Cancel every retained subscription/timer and drop the client. Shared by
  /// [dispose] and the account-switch path in [init], so re-entry is safe.
  Future<void> _teardown() async {
    _retryTimer?.cancel();
    _retryTimer = null;
    try {
      await _incomingSub?.cancel();
    } catch (_) {/* best-effort */}
    _incomingSub = null;
    _lastIncomingCid = null;
    _warmTokenBody = null;
    final c = _client;
    _client = null;
    _readyUid = null;
    try {
      await c?.disconnect();
    } catch (_) {/* best-effort */}
  }

  Future<void> dispose() async {
    await _teardown();
    _accountWaits = 0;
    _failureRetries = 0;
    _skipReported = false;
  }

  StreamVideo? get client => _client;

  /// [STREAM-LANE-FIX-1] The body of the token request made by
  /// [_resolveApiKey], handed to the SDK's first [TokenLoader] call instead of
  /// making a second identical signed request. Init used to fetch
  /// `/stream-video/token` TWICE back to back (once for the api key, once for
  /// the token), doubling the time before the client is connected — and this
  /// lane losing a race against the caller is exactly what production showed
  /// (`stream_lane_client_connected` landing 1.1s AFTER the call had failed).
  /// Single-use: a genuine token REFRESH later must hit the network.
  Map<String, dynamic>? _warmTokenBody;

  Future<Map<String, dynamic>> _fetchTokenBody() async {
    final response = await ApiAuth.getSigned(
      '$kApiBase/stream-video/token',
      timeout: const Duration(seconds: 8),
    );
    if (response.statusCode != 200) {
      throw StateError('stream token request failed: ${response.statusCode}');
    }
    final raw = jsonDecode(response.body);
    if (raw is! Map) throw const FormatException('invalid Stream token body');
    return Map<String, dynamic>.from(raw);
  }

  /// GET the Stream token from the Worker (mirrors the old lane's
  /// `StreamCallApi.warmForAccount` HTTP pattern in
  /// core/calls/rtc/stream_call_api.dart, which this file must not import).
  Future<String> _loadToken(String uid) async {
    final warm = _warmTokenBody;
    _warmTokenBody = null;
    final body = warm ?? await _fetchTokenBody();
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
      final body = await _fetchTokenBody();
      _warmTokenBody = body; // reused by the SDK's first tokenLoader call
      final k = (body['api_key'] ?? body['apiKey'] ?? '').toString();
      if (k.isNotEmpty) return k;
    } catch (_) {/* fall through to the compiled-in fallback */}
    return _apiKeyFallback;
  }

  /// Public so `stream_push_glue.dart`'s background handler can locate the
  /// same secure-storage entries without importing `account_storage.dart`'s
  /// `scopedKey` (which reads `AccountScope.id` — unset in the FCM
  /// background isolate, see BG-ISOLATE-1 in push_service.dart). The
  /// background reader matches on this prefix directly instead.
  static const String kCredKeyBase = 'stream_lane_credentials_v1';
  static const FlutterSecureStorage _secure = FlutterSecureStorage();

  /// The per-account secure-storage key for [uid].
  ///
  /// MUST stay byte-identical to `scopedKey(kCredKeyBase)` in
  /// core/account_storage.dart (`'${base}_${AccountScope.id}'`) — the whole
  /// point is that the background push isolate, where `AccountScope.id` is
  /// unset, can address ONE account's blob deliberately instead of scanning
  /// and guessing. `scopedKey` is not called here on purpose: it reads the
  /// scope that is current at THIS instant, which is not necessarily the
  /// account whose token round-trip just came back.
  static String credKeyForUid(String uid) => '${kCredKeyBase}_$uid';

  /// Per-account credential blob for [uid]. Read by the background push
  /// isolate (stream_push_glue.dart) to recreate a `StreamVideo` client
  /// without the main isolate's app state. Scoped via [credKeyForUid] (the
  /// `scopedKey` convention from account_storage.dart, resolved against the
  /// account this token was actually issued for) — a shared phone can hold
  /// credentials for more than one account at once, and they must never be
  /// confused with each other.
  Future<void> _persistCredentials(
    String uid,
    Map<String, dynamic> tokenBody,
    String token,
  ) async {
    try {
      final apiKey =
          (tokenBody['api_key'] ?? tokenBody['apiKey'] ?? _apiKeyFallback)
              .toString();
      await _secure.write(
        key: credKeyForUid(uid),
        value: jsonEncode({
          'uid': uid,
          'api_key': apiKey,
          'token': token,
          // [STREAM-LANE-FIX-1] Carried so background-isolate telemetry can
          // name the user: `Analytics.currentEmail` is a main-isolate static
          // and is always null in the FCM background isolate.
          'email': Analytics.currentEmail ?? '',
          'ts': DateTime.now().millisecondsSinceEpoch,
        }),
      );
    } catch (_) {/* best-effort — background recovery degrades gracefully */}
  }
}
