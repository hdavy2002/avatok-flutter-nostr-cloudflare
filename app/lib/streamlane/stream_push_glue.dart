// STREAM-LANE. This file is deliberately PURE — it imports NO Stream SDK
// code and nothing from stream_lane.dart, so push_service.dart's early-exit
// guards (edit C) compile and ship TODAY while the SDK packages stay
// commented out in app/pubspec.yaml. With `streamCallsEnabled` off (the
// default), both functions always return false and the old lane's behavior
// is byte-for-byte unchanged.
//
// When the lane is activated (pubspec entries uncommented + flag on), the
// SDK's own push-notification layer (stream_video_push_notification) shows
// the ring UI; these guards then only prevent push_service.dart from ALSO
// parsing the same envelope. SDK-dependent background recovery
// (StreamVideo.create from persisted credentials + the documented
// incoming-calls-in-background pattern) belongs in stream_lane.dart /
// a future stream_push_bg.dart at activation time — NOT here, so this file
// stays importable from push_service.dart forever.
library;

import '../core/remote_config.dart';

/// Pure map-level check — unit-tested with a plain `Map<String, dynamic>`
/// in app/test/streamlane/stream_push_glue_test.dart.
bool isStreamPush(Map<String, dynamic> data) =>
    (data['sender'] ?? '').toString() == 'stream.video';

/// Foreground discriminator for push_service.dart's
/// `FirebaseMessaging.onMessage` listener. Returns true only when BOTH the
/// envelope is a Stream push AND the new lane is enabled.
bool handleStreamPush(Map<String, dynamic> data) {
  if (!isStreamPush(data)) return false;
  if (!RemoteConfig.streamCallsEnabled) return false;
  return true;
}

/// Background/killed-app variant for `firebaseBackgroundHandler`. Same pure
/// logic; the SDK recovery step is added at activation time (see the library
/// comment above).
Future<bool> handleStreamPushBackground(Map<String, dynamic> data) async {
  if (!isStreamPush(data)) return false;
  if (!RemoteConfig.streamCallsEnabled) return false;
  return true;
}
