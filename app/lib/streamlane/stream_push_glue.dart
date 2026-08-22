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
// Per-account credential lookup — [STREAM-LANE-FIX-1], plan P1.7.
//
// `stream_lane.dart` writes each account's blob under
// `StreamLane.credKeyForUid(uid)`, i.e. the same string `scopedKey` would
// produce. `scopedKey` itself cannot be CALLED here: it reads
// `AccountScope.id`, an in-memory static that is UNSET in this fresh
// background isolate (see BG-ISOLATE-1 in push_service.dart).
//
// This file used to read every secure-storage entry and take the FIRST one
// whose key carried the prefix. On a phone shared by a parent and a child —
// which is the normal case for this product — "first" is an arbitrary
// iteration order, so a call for one account could be recovered with the
// OTHER account's credentials. That is both wrong and a violation of the
// per-account scoping rule in CLAUDE.md.
//
// The payload genuinely carries no recipient id: the SDK's own
// `handleRingingFlowNotifications` only ever reads `sender`, `call_cid`,
// `type`, `video`, `created_by_id`, `created_by_display_name` and
// `call_display_name` (verified against
// packages/stream_video/lib/src/stream_video.dart, GetStream/
// stream-video-flutter@main). So the target is resolved in this order, and
// NOTHING is guessed:
//   1. an explicit recipient field on the payload, if one ever appears
//      (`receiver_id` / `receiverId` / `user_id` / `recipient_id`);
//   2. the device-level active account — the same global `clerk_account_id`
//      key push_service.dart's `_shadeAccountId` already trusts from this
//      isolate — matched against a STORED Stream credential blob;
//   3. exactly ONE stored Stream account on the device, which is
//      unambiguous by construction.
// If none of those resolves, recovery FAILS CLOSED: no client is created, and
// `stream_lane_bg_recovery_unresolved` records why. The native Stream ring
// still shows (it is driven by the registered device token, not by this
// code), so failing closed costs the in-Dart ringing bookkeeping only — never
// one account's call surfacing under another's credentials.
library;

import 'dart:async';
import 'dart:convert';

import 'package:firebase_core/firebase_core.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:stream_video_flutter/stream_video_flutter.dart';
import 'package:stream_video_push_notification/stream_video_push_notification.dart';

import '../core/disk_cache.dart';
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

  // A Firebase background handler runs in its own Dart isolate. RemoteConfig's
  // in-memory map is therefore empty here, so `streamCallsEnabled` reads its
  // compile-time false default even when production has enabled the Stream
  // lane. That made a genuine Stream push fall through to the legacy handler,
  // which intentionally ignores `sender=stream.video`; the phone woke but no
  // incoming-call surface was shown.
  //
  // The signed provider envelope is the background discriminator. Recovery
  // still fails closed unless the payload resolves to credentials persisted
  // for the active account, so this cannot revive Cloudflare media or surface
  // another account's call on a shared phone. Foreground routing continues to
  // respect RemoteConfig because the main isolate has hydrated it normally.

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

/// Guards against two pushes arriving back-to-back in the same isolate and
/// each building its own `StreamVideo` client + ringing subscription.
bool _recovering = false;

Future<void> _recoverInBackground(Map<String, dynamic> data) async {
  if (_recovering) {
    await _bgTrack('stream_lane_bg_recovery_skipped', {
      'reason': 'already_recovering',
      'call_cid': (data['call_cid'] ?? '').toString(),
    });
    return;
  }
  _recovering = true;
  try {
    // As this runs in a separate isolate, Firebase needs to be (re)initialized
    // here — matches the SDK docs' `_firebaseMessagingBackgroundHandler`
    // example exactly. Re-initializing an already-initialized default app
    // throws; that's expected on some launches and is swallowed.
    try {
      await Firebase.initializeApp(
          options: DefaultFirebaseOptions.currentPlatform);
    } catch (_) {/* already initialized in this isolate, or unavailable */}

    final resolved = await _resolveTargetCredentials(data);
    if (resolved.creds == null) {
      // FAIL CLOSED. Recovering with SOME other account's credentials would
      // surface one user's call under another user's identity on a shared
      // phone; doing nothing only costs the in-Dart ringing bookkeeping.
      await _bgTrack('stream_lane_bg_recovery_unresolved', {
        'reason': resolved.reason,
        'candidates': resolved.candidateCount,
        'call_cid': (data['call_cid'] ?? '').toString(),
        'created_by_id': (data['created_by_id'] ?? '').toString(),
        // There is no single user to attribute this to — that IS the failure.
        // The stored candidates' emails go on the event anyway, so a search by
        // either tester's email still finds it (CLAUDE.md telemetry rule).
        'user_email': resolved.candidateEmails.length == 1
            ? resolved.candidateEmails.first
            : '',
        'candidate_emails': resolved.candidateEmails.join(','),
      });
      return;
    }

    final creds = resolved.creds!;
    await _bgTrack('stream_lane_bg_recovery_started', {
      'resolved_by': resolved.reason,
      'candidates': resolved.candidateCount,
      'call_cid': (data['call_cid'] ?? '').toString(),
      'created_by_id': (data['created_by_id'] ?? '').toString(),
      // Persisted alongside the credentials by stream_lane.dart precisely
      // because `Analytics.currentEmail` is main-isolate-only.
      'user_email': creds.email,
    });

    final streamVideo = StreamVideo.create(
      creds.apiKey,
      user: User.regular(userId: creds.uid),
      userToken: creds.token,
      pushNotificationManagerProvider:
          StreamVideoPushNotificationManager.create(
        iosPushProvider: const StreamVideoPushProvider.apn(name: 'avatok-apn'),
        androidPushProvider: StreamVideoPushProvider.firebase(
          name: 'firebase',
          tokenStreamProvider: () => const Stream<String>.empty(),
        ),
        pushConfiguration: const StreamVideoPushConfiguration(
          android: AndroidPushConfiguration(
            ringtonePath: 'ringtone_default',
            incomingCallNotificationChannelName: 'AvaTOK incoming calls',
            missedCallNotificationChannelName: 'AvaTOK missed calls',
            showFullScreenOnLockScreen: true,
          ),
        ),
      ),
    )..connect();

    // Retained so it can be cancelled on BOTH paths: normally by
    // `disposeAfterResolvingRinging`, and by the catch below if
    // `handleRingingFlowNotifications` throws (previously that left the
    // subscription — and the client — alive for the isolate's lifetime).
    final subscription = streamVideo.observeCoreRingingEventsForBackground();
    streamVideo.disposeAfterResolvingRinging(
      disposingCallback: () => subscription.cancel(),
    );

    try {
      await streamVideo.handleRingingFlowNotifications(data);
    } catch (_) {
      try {
        await subscription.cancel();
      } catch (_) {/* best-effort */}
      rethrow;
    }
  } finally {
    _recovering = false;
  }
}

class _StreamLaneCreds {
  const _StreamLaneCreds({
    required this.uid,
    required this.apiKey,
    required this.token,
    required this.email,
  });
  final String uid;
  final String apiKey;
  final String token;
  final String email;
}

class _TargetResolution {
  const _TargetResolution(
    this.creds,
    this.reason,
    this.candidateCount, {
    this.candidateEmails = const <String>[],
  });
  final _StreamLaneCreds? creds;

  /// Why we ended up here — doubles as `resolved_by` on success and
  /// `reason` on failure. Low-cardinality on purpose.
  final String reason;
  final int candidateCount;

  /// Emails of the stored accounts considered. Only used to TAG a failure that
  /// by definition has no single owner, so the event is still retrievable.
  final List<String> candidateEmails;
}

const FlutterSecureStorage _secure = FlutterSecureStorage();

/// Mirrors push_service.dart's private `_kActiveAccountKey` (itself a mirror of
/// main.dart's `_kAcct`): the GLOBAL, device-level file holding the signed-in
/// Clerk account id. `DiskCache.readGlobal` is already proven to work from this
/// isolate — it is what `_shadeAccountId` uses. The three must never diverge.
const String _kActiveAccountKey = 'clerk_account_id';

/// Resolve WHICH account this push is for, and return only that account's
/// credentials. Never falls back to "some other stored account".
Future<_TargetResolution> _resolveTargetCredentials(
  Map<String, dynamic> data,
) async {
  // Prefer the active account's exact encrypted entry. `readAll()` is not a
  // reliable primitive in a cold Firebase isolate: one unrelated legacy entry
  // that cannot be decrypted makes the whole operation throw, which previously
  // turned a valid signed-in account into `no_credentials_stored`. An exact
  // lookup is also the least-privilege operation on a shared phone.
  String active = '';
  try {
    active = (await DiskCache.readGlobal(_kActiveAccountKey)) ?? '';
  } catch (_) {/* fall through */}
  active = active.trim();
  if (active.isNotEmpty) {
    final activeCreds = await _readStreamLaneCredential(active);
    if (activeCreds != null) {
      return _TargetResolution(activeCreds, 'active_account_direct', 1);
    }
  }

  final stored = await _readAllStreamLaneCredentials();
  if (stored.isEmpty) {
    return const _TargetResolution(null, 'no_credentials_stored', 0);
  }
  final emails = stored.values
      .map((c) => c.email)
      .where((e) => e.isNotEmpty)
      .toList(growable: false);

  // 1. An explicit recipient on the payload. Stream does not send one today
  //    (see the library comment); this is here so that the moment the Worker
  //    or the SDK starts tagging the target, it is honoured for free.
  for (final k in const [
    'receiver_id',
    'receiverId',
    'recipient_id',
    'recipientId',
    'user_id',
    'userId',
  ]) {
    final v = (data[k] ?? '').toString();
    if (v.isEmpty) continue;
    final hit = stored[v];
    if (hit != null) return _TargetResolution(hit, 'payload', stored.length);
    // The payload named a target we hold no credentials for — that is a
    // definite MISS, not an invitation to try someone else.
    return _TargetResolution(
      null,
      'target_not_stored',
      stored.length,
      candidateEmails: emails,
    );
  }

  // 2. The account this device is currently signed in as.
  if (active.isNotEmpty) {
    final hit = stored[active];
    if (hit != null) {
      return _TargetResolution(hit, 'active_account', stored.length);
    }
  }

  // 3. One stored account — unambiguous.
  if (stored.length == 1) {
    return _TargetResolution(stored.values.first, 'sole_account', 1);
  }

  // Several accounts, none of them identifiable as the target. Fail closed.
  return _TargetResolution(
    null,
    'ambiguous_multi_account',
    stored.length,
    candidateEmails: emails,
  );
}

Future<_StreamLaneCreds?> _readStreamLaneCredential(String uid) async {
  try {
    final encoded = await _secure.read(key: StreamLane.credKeyForUid(uid));
    if (encoded == null || encoded.isEmpty) return null;
    final raw = jsonDecode(encoded);
    if (raw is! Map) return null;
    final storedUid = (raw['uid'] ?? '').toString();
    final apiKey = (raw['api_key'] ?? '').toString();
    final token = (raw['token'] ?? '').toString();
    if (storedUid != uid || apiKey.isEmpty || token.isEmpty) return null;
    return _StreamLaneCreds(
      uid: storedUid,
      apiKey: apiKey,
      token: token,
      email: (raw['email'] ?? '').toString(),
    );
  } catch (_) {
    return null;
  }
}

/// Every stored Stream-lane credential blob on this device, keyed by its uid.
Future<Map<String, _StreamLaneCreds>> _readAllStreamLaneCredentials() async {
  final out = <String, _StreamLaneCreds>{};
  final Map<String, String> all;
  try {
    all = await _secure.readAll();
  } catch (_) {
    return out;
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
      // The key must be the one this uid's blob belongs under, or the entry is
      // not trustworthy as "account X's credentials".
      if (entry.key != StreamLane.credKeyForUid(uid)) continue;
      out[uid] = _StreamLaneCreds(
        uid: uid,
        apiKey: apiKey,
        token: token,
        email: (raw['email'] ?? '').toString(),
      );
    } catch (_) {
      continue;
    }
  }
  return out;
}

/// Durable telemetry for the FCM background isolate.
///
/// There is no PostHog client here (`Analytics.capture` is a no-op-ish in this
/// isolate — see push_service.dart's `_track`), so events go on the SAME
/// on-disk queue push_service already drains to PostHog on next foreground.
/// The key is a literal because push_service's constant is private; the two
/// must never diverge.
const String _kPendingBgTelemetry = 'pending_bg_telemetry';

Future<void> _bgTrack(String event, Map<String, dynamic> props) async {
  try {
    final raw = await DiskCache.readGlobal(_kPendingBgTelemetry);
    final list =
        (raw == null || raw.isEmpty) ? <dynamic>[] : (jsonDecode(raw) as List);
    list.add({
      'event': event,
      'props': props,
      'ts': DateTime.now().millisecondsSinceEpoch,
    });
    if (list.length > 60) list.removeRange(0, list.length - 60);
    await DiskCache.writeGlobal(_kPendingBgTelemetry, jsonEncode(list));
  } catch (_) {/* telemetry must never break the ring path */}
}
