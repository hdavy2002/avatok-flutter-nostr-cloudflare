// STREAM-LANE: depends on the currently-commented-out pubspec entries
// `stream_video_flutter` / `stream_video_push_notification` (see
// app/pubspec.yaml and stream_lane.dart's library comment). SDK imports will
// not resolve until those two lines are uncommented.
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:stream_video_flutter/stream_video_flutter.dart';
import 'package:uuid/uuid.dart';

import '../core/analytics.dart';
import 'stream_call_screen.dart';
import 'stream_lane.dart';

/// Places and manages 1:1 Stream calls. Sits next to [StreamLane] (which owns
/// the client connection) the way `place_1to1_call.dart` sits next to
/// `CallSessionManager` in the old lane — this class owns the "dial" verb,
/// not the client lifecycle.
class StreamCallService {
  StreamCallService._();

  static final StreamCallService instance = StreamCallService._();

  static const Uuid _uuid = Uuid();

  /// Place an outgoing 1:1 ring to [userId]. Mirrors `place1to1Call`'s
  /// caller-side shape (peer id + video flag) but delegates all signalling
  /// and media setup to the Stream Video SDK.
  Future<void> place1to1(
    BuildContext context,
    String userId, {
    required bool video,
  }) async {
    final client = StreamVideo.instance;
    final callId = 'sl-${_uuid.v4()}';
    final startedAtMs = DateTime.now().millisecondsSinceEpoch;
    final email = Analytics.currentEmail ?? '';
    Analytics.capture('stream_lane_call_placed', {
      'call_id': callId,
      'peer_id': userId,
      'media_mode': video ? 'video' : 'audio',
      'user_email': email,
    });
    try {
      // verified: packages/stream_video/lib/src/call/call_type.dart — there
      // is no `StreamCallType.id(...)` factory; the built-in 1:1/group call
      // type is `StreamCallType.defaultType()` (value 'default').
      final call = client.makeCall(
        callType: StreamCallType.defaultType(),
        id: callId,
      );
      await call.getOrCreate(
        memberIds: [userId],
        ringing: true,
        video: video,
      );
      // REVIEW FIX 2026-08-21: without this the caller never joined the call
      // — getOrCreate only registers + rings; join() is what connects media.
      // The SDK keeps the call in ringing state until the callee accepts.
      await call.join();
      Analytics.capture('stream_lane_call_connected', {
        'call_id': callId,
        'peer_id': userId,
        'setup_ms': DateTime.now().millisecondsSinceEpoch - startedAtMs,
        'user_email': email,
      });
      _wireRingingEvents(call, email);
      if (!context.mounted) return;
      await Navigator.push(
        context,
        MaterialPageRoute(
          builder: (_) => StreamCallScreen(call: call, peerId: userId),
        ),
      );
    } catch (e, st) {
      Analytics.capture('stream_lane_call_failed', {
        'call_id': callId,
        'peer_id': userId,
        'stage': 'place',
        'error': e.toString(),
        'user_email': email,
      });
      await Analytics.captureException(
        e,
        st,
        screen: 'stream_call_service',
        handled: true,
        extra: {'op': 'place1to1', 'call_id': callId},
      );
    }
  }

  /// Accept an incoming ring (called from [StreamIncomingScreen]).
  Future<void> accept(BuildContext context, Call call) async {
    final email = Analytics.currentEmail ?? '';
    try {
      await call.accept();
      Analytics.capture('stream_lane_call_accepted', {
        'call_id': call.callCid.value,
        'user_email': email,
      });
      _wireRingingEvents(call, email);
      await call.join();
      if (!context.mounted) return;
      await Navigator.pushReplacement(
        context,
        MaterialPageRoute(
          builder: (_) => StreamCallScreen(call: call, peerId: ''),
        ),
      );
    } catch (e, st) {
      Analytics.capture('stream_lane_call_failed', {
        'call_id': call.callCid.value,
        'stage': 'accept',
        'error': e.toString(),
        'user_email': email,
      });
      await Analytics.captureException(
        e,
        st,
        screen: 'stream_call_service',
        handled: true,
        extra: {'op': 'accept', 'call_id': call.callCid.value},
      );
    }
  }

  /// Decline an incoming ring.
  Future<void> decline(Call call) async {
    final email = Analytics.currentEmail ?? '';
    try {
      await call.reject();
      Analytics.capture('stream_lane_call_ended', {
        'call_id': call.callCid.value,
        'reason': 'declined',
        'user_email': email,
      });
    } catch (e, st) {
      await Analytics.captureException(
        e,
        st,
        screen: 'stream_call_service',
        handled: true,
        extra: {'op': 'decline', 'call_id': call.callCid.value},
      );
    }
  }

  /// Hang up. `mic_released` is set ONLY after `call.leave()` returns without
  /// throwing, per the audit requirement that this event is proof the mic was
  /// actually released, not just that a hangup was requested.
  Future<void> leave(
    Call call, {
    required DateTime connectedAt,
    String reason = 'user_hangup',
  }) async {
    final email = Analytics.currentEmail ?? '';
    final durationS =
        DateTime.now().difference(connectedAt).inMilliseconds / 1000.0;
    try {
      await call.leave();
      Analytics.capture('stream_lane_call_ended', {
        'call_id': call.callCid.value,
        'reason': reason,
        'duration_s': durationS,
        'mic_released': true,
        'user_email': email,
      });
    } catch (e, st) {
      Analytics.capture('stream_lane_call_ended', {
        'call_id': call.callCid.value,
        'reason': reason,
        'duration_s': durationS,
        'mic_released': false,
        'user_email': email,
      });
      await Analytics.captureException(
        e,
        st,
        screen: 'stream_call_service',
        handled: true,
        extra: {'op': 'leave', 'call_id': call.callCid.value},
      );
    }
  }

  /// verified: packages/stream_video/lib/src/state_emitter.dart (`StateEmitter`
  /// exposes both `.value` and `.valueStream`) + packages/stream_video/lib/
  /// src/call/call.dart (`Call.state` returns `StateEmitter<CallState>`).
  /// `StreamVideo.observeCoreRingingEvents` (packages/stream_video/lib/src/
  /// stream_video.dart) is a real client-level API but it drives the
  /// system/CallKit ringing flow, not a per-call terminal-state signal — this
  /// call-scoped `call.state.valueStream` listen is the correct, simpler way
  /// to detect `CallStatusDisconnected` for this in-app UI.
  StreamSubscription<CallState>? _wireRingingEvents(Call call, String email) {
    return call.state.valueStream.listen((state) {
      final status = state.status;
      if (status is CallStatusDisconnected) {
        Analytics.capture('stream_lane_call_ended', {
          'call_id': call.callCid.value,
          'reason': status.reason.runtimeType.toString(),
          'user_email': email,
        });
      }
    });
  }
}
