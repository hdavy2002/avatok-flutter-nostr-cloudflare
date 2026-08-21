// STREAM-LANE. `isStreamPush`/`handleStreamPush` stay PURE (no SDK import) so
// push_service.dart's early-exit guards keep compiling and shipping even if
// the SDK packages were ever re-commented — with `streamCallsEnabled` off
// (the default) both functions return false and the old lane's behavior is
// byte-for-byte unchanged.
//
// `handleStreamPushBackground` is the one function in this file that is NOT
// pure: it now also performs the SDK background-recovery step described
// below, so it imports the Stream SDK + `stream_lane.dart`. This is safe
// because it is live only once the pubspec deps resolve (activated
// 2026-08-21) and it is still gated behind `isStreamPush` + the flag, same as
// before.
//
// FOREGROUND: `handleStreamPush` deliberately does NOT call the SDK's
// `handleRingingFlowNotifications` — verified against
// packages/stream_video/lib/src/stream_video.dart +
// getstream.io/video/docs/flutter/advanced/incoming-calls/android-firebase-integration:
// once `StreamLane.instance.init()` has connected the client (main.dart,
// STREAM-LANE-ACTIVATE block), the coordinator WebSocket itself drives
// `StreamVideo.instance.state.incomingCall`, which stream_lane.dart already
// listens to and uses to show `StreamIncomingScreen` — independent of the FCM
// envelope. Also calling `handleRingingFlowNotifications` here would be
// redundant (and would double-surface a notification-style ring alongside
// the in-app screen) for a call the connected client already knows about.
// Returning `true` to suppress the OLD lane's parsing is therefore already
// the complete foreground behavior; no further forwarding is added.
//
// BACKGROUND/TERMINATED: no client is connected (fresh isolate, no app
// state), so the SDK's documented recovery pattern applies — verified
// against the same stream_video.dart source + the "Handle push in background
// and terminated state" section of the docs page above:
//   1. `StreamVideo.create(apiKey, user: ..., userToken: ..., pushNotificationManagerProvider: ...)`
//      — the unassociated-instance factory (as opposed to the `StreamVideo(...)`
//      singleton factory), matching the doc's "instance separate from
//      `StreamVideo.instance`" note.
//   2. `..connect()` (fire-and-forget, matches the doc's cascade — ringing
//      display goes through `pushNotificationManager`, not the coordinator
//      WS, so the call is not blocked on connect completing).
//   3. `observeCoreRingingEventsForBackground()` — the background-scoped
//      subset of `observeCoreRingingEvents` (incoming + declined only, no
//      accept/end wiring, since there is no in-app screen to navigate from
//      this isolate).
//   4. `disposeAfterResolvingRinging(disposingCallback: ...)` — tears the
//      short-lived background client down once the ring resolves.
//   5. `handleRingingFlowNotifications(data)` — shows the native
//      ring/missed-call notification; it already checks
//      `payload['sender'] == 'stream.video'` internally, so this call is
//      safe even though `isStreamPush` already gated entry.
//
// Per-account credential lookup: `stream_lane.dart`'s `_persistCredentials`
// writes the blob under `scopedKey(StreamLane.kCredKeyBase)`, which is keyed
// off `AccountScope.id` — an in-memory static that is UNSET in this fresh
// background isolate (see BG-ISOLATE-1 in push_service.dart; the same class
// of problem). `scopedKey` therefore cannot be used here to reconstruct the
// exact key. Instead this file reads every secure-storage entry and matches
// on the `StreamLane.kCredKeyBase` prefix directly. On a device shared by
// multiple signed-in accounts this can find more than one candidate; there is
// no recipient-id field on the FCM payload to disambiguate against (the
// payload carries `call_cid`/`created_by_id`, not the target user), so this
// picks the first match and accepts the known limitation that a second
// stored account on the same device won't get its own recovered client for
// this push. This degrades to "no in-place recovery" (native ring UI still
// covers the primary account; nothing crashes), never to leaking one
// account's credentials into another's UI.
library;

import 'dart:async';
import 'dart:convert';

import 'package:firebase_core/firebase_core.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:stream_video_flutter/stream_video_flutter.dart';
import 'package:stream_video_push_notification/stream_video_push_notification.dart';

import '../core/remote_config.dart';
import '../firebase_options.dart';
import 'stream_lane.dart';

/// Pure map-level check — unit-tested with a plain `Map<String, dynamic>`
/// in app/test/streamlane/stream_push_glue_test.dart.
bool isStreamPush(Map<String, dynamic> data) =>
    (data['sender'] ?? '').toString() == 'stream.video';

/// Foreground discriminator for push_service.dart's
/// `FirebaseMessaging.onMessage` listener. Returns true only when BOTH the
/// envelope is a Stream push AND the new lane is enabled. See the library
/// comment above for why nothing further needs to run here.
bool handleStreamPush(Map<String, dynamic> data) {
  if (!isStreamPush(data)) return false;
  if (!RemoteConfig.streamCallsEnabled) return false;
  return true;
}

/// Background/killed-app variant for `firebaseBackgroundHandler`. Same
/// pure gate, plus the SDK background-recovery step (see library comment).
/// Always returns the same true/false the pure gate would have returned —
/// callers only use the return value to decide whether to keep parsing the
/// OLD lane's envelope, so a failure in the recovery step below must never
/// change that decision.
Future<bool> handleStreamPushBackground(Map<String, dynamic> data) async {
  if (!isStreamPush(data)) return false;
  if (!RemoteConfig.streamCallsEnabled) return false;

  try {
    await _recoverInBackground(data);
  } catch (e, st) {
    // Best-effort: the native Stream push layer (registered device token)
    // is the primary path for background ringing; this recovery step only
    // adds the in-Dart ringing-event bookkeeping the docs recommend. A
    // failure here must not throw out of the FCM background handler.
    debugPrint('[stream_push_glue] background recovery failed: $e\n$st');
  }
  return true;
}

Future<void> _recoverInBackground(Map<String, dynamic> data) async {
  // As this runs in a separate isolate, Firebase needs to be (re)initialized
  // here — matches the SDK docs' `_firebaseMessagingBackgroundHandler`
  // example exactly. Re-initializing an already-initialized default app
  // throws; that's expected on some launches and is swallowed.
  try {
    await Firebase.initializeApp(options: DefaultFirebaseOptions.currentPlatform);
  } catch (_) {/* already initialized in this isolate, or unavailable */}

  final creds = await _readAnyStreamLaneCredentials();
  if (creds == null) return; // no locally persisted credentials to recover

  final streamVideo = StreamVideo.create(
    creds.apiKey,
    user: User.regular(userId: creds.uid),
    userToken: creds.token,
    pushNotificationManagerProvider: StreamVideoPushNotificationManager.create(
      iosPushProvider: const StreamVideoPushProvider.apn(name: 'avatok-apn'),
      androidPushProvider: const StreamVideoPushProvider.firebase(name: 'firebase'),
    ),
  )..connect();

  final subscription = streamVideo.observeCoreRingingEventsForBackground();
  streamVideo.disposeAfterResolvingRinging(
    disposingCallback: () => subscription.cancel(),
  );

  await streamVideo.handleRingingFlowNotifications(data);
}

class _StreamLaneCreds {
  const _StreamLaneCreds({required this.uid, required this.apiKey, required this.token});
  final String uid;
  final String apiKey;
  final String token;
}

const FlutterSecureStorage _secure = FlutterSecureStorage();

/// Reads every secure-storage entry and returns the first one whose key
/// starts with [StreamLane.kCredKeyBase] — see the library comment for why
/// `scopedKey` can't be used from this isolate.
Future<_StreamLaneCreds?> _readAnyStreamLaneCredentials() async {
  final Map<String, String> all;
  try {
    all = await _secure.readAll();
  } catch (_) {
    return null;
  }
  for (final entry in all.entries) {
    if (!entry.key.startsWith(StreamLane.kCredKeyBase)) continue;
    try {
      final raw = jsonDecode(entry.value);
      if (raw is! Map) continue;
      final uid = (raw['uid'] ?? '').toString();
      final apiKey = (raw['api_key'] ?? '').toString();
      final token = (raw['token'] ?? '').toString();
      if (uid.isEmpty || apiKey.isEmpty || token.isEmpty) continue;
      return _StreamLaneCreds(uid: uid, apiKey: apiKey, token: token);
    } catch (_) {
      continue;
    }
  }
  return null;
}
