// STREAM-LANE: depends on the currently-commented-out pubspec entries
// `stream_video_flutter` / `stream_video_push_notification` (see
// app/pubspec.yaml and stream_lane.dart's library comment). SDK imports will
// not resolve until those two lines are uncommented.
library;

import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:stream_video_flutter/stream_video_flutter.dart';

import '../core/analytics.dart';
import '../core/api_auth.dart';
import '../core/calls/call_media_permissions.dart';
import '../core/config.dart';
import 'stream_call_screen.dart';
import 'stream_lane.dart';

/// [STREAM-AUTH-1 2026-08-21] The Worker route that AUTHORISES a 1:1 Stream
/// dial and mints the call id. Declared here rather than in `core/config.dart`
/// because it belongs to this lane alone; `kApiBase` is the same base every
/// other authed route is built from.
const String kStreamCallPlaceUrl = '$kApiBase/stream-calls/place';

/// [STREAM-AUTH-1 2026-08-21] The AvaTOK Worker's verdict on a 1:1 Stream dial.
///
/// Stream carries the MEDIA. It does not decide who may call whom — that is the
/// AvaTOK Worker's job, and until today this lane never asked. See
/// `Specs/PLAN-STREAM-ONLY-CALLS-2026-08-21.md` §8.1.
class StreamPlaceDecision {
  const StreamPlaceDecision._({
    required this.approved,
    required this.callId,
    required this.code,
    required this.message,
    required this.httpStatus,
  });

  const StreamPlaceDecision.approved(String callId)
      : this._(
          approved: true,
          callId: callId,
          code: 'approved',
          message: '',
          httpStatus: 200,
        );

  const StreamPlaceDecision.refused({
    required String code,
    required String message,
    required int httpStatus,
  }) : this._(
          approved: false,
          callId: '',
          code: code,
          message: message,
          httpStatus: httpStatus,
        );

  /// True only when the server said yes. [callId] is then SERVER-MINTED and is
  /// the id the Stream call must be created with.
  final bool approved;
  final String callId;

  /// Machine-readable refusal code, e.g. `recipient_unavailable`,
  /// `update_required`, `stream_calls_disabled`, `receptionist`, `network`.
  final String code;

  /// The sentence to show the user. Always the SERVER's message when it sent
  /// one — the refusal copy is a product decision that lives on the server
  /// (see worker/src/lib/call_admission.ts on why it is deliberately vague).
  final String message;
  final int httpStatus;
}

/// How a `CallStatusDisconnected` should be treated by the UI.
///
/// [STREAM-UI-1] `stream_call_screen.dart` used to pop on EVERY disconnected
/// status, which is what made the call screen vanish on a recoverable setup or
/// reconnect blip. Only [ended] pops; [failed] renders an error INSIDE the
/// visible screen; [transient] is ignored beyond a "reconnecting" banner.
enum StreamDisconnectKind { transient, ended, failed }

/// Places and manages 1:1 Stream calls. Sits next to [StreamLane] (which owns
/// the client connection) the way `place_1to1_call.dart` sits next to
/// `CallSessionManager` in the old lane — this class owns the "dial" verb,
/// not the client lifecycle.
class StreamCallService {
  StreamCallService._();

  static final StreamCallService instance = StreamCallService._();

  /// [STREAM-AUTH-1] Ask the AvaTOK Worker whether this call may happen, and
  /// get the SERVER-MINTED call id back.
  ///
  /// FAILS CLOSED. A network error, a timeout, a 5xx or an unparseable body all
  /// refuse the dial. That is deliberate and it is the owner's requirement
  /// verbatim: "Stream should transport the sound and video, but your server
  /// must first approve every call." Falling back to a client-minted id on a
  /// blip would restore exactly the bypass this method exists to remove — a
  /// blocked caller would only have to lose signal for a second to get through.
  ///
  /// The Clerk bearer, `X-Trace-Id` and (as of this change) `x-app-build` are
  /// all attached by [ApiAuth], so the Worker's `callMinBuild` gate finally has
  /// an input on this lane too.
  Future<StreamPlaceDecision> authorizePlace({
    required String peerId,
    required bool video,
    String? traceId,
  }) async {
    try {
      final res = await ApiAuth.postJsonH(
        kStreamCallPlaceUrl,
        <String, Object>{'callee_uid': peerId, 'video': video},
        <String, String>{
          if (traceId != null && traceId.isNotEmpty) 'X-Trace-Id': traceId,
        },
        timeout: const Duration(seconds: 8),
      );
      Map<String, dynamic>? body;
      try {
        final decoded = jsonDecode(res.body);
        if (decoded is Map) body = decoded.cast<String, dynamic>();
      } catch (_) {/* non-JSON (edge rejection) — handled as a refusal below */}
      if (res.statusCode == 200 && body?['approved'] == true) {
        final callId = (body?['call_id'] ?? '').toString();
        if (callId.isNotEmpty) return StreamPlaceDecision.approved(callId);
        // Approved with no id is a server bug, not a permission to dial: there
        // is no call identity to create, so this cannot proceed.
        return const StreamPlaceDecision.refused(
          code: 'no_call_id',
          message: "Couldn't start the call. Please try again.",
          httpStatus: 200,
        );
      }
      final code = (body?['code'] ?? 'refused').toString();
      final message = (body?['message'] ?? '').toString();
      return StreamPlaceDecision.refused(
        code: code,
        message: message.isNotEmpty
            ? message
            : (res.statusCode == 401 || res.statusCode == 403
                ? 'Please sign in again to make calls.'
                : "Couldn't start the call. Please try again."),
        httpStatus: res.statusCode,
      );
    } catch (e) {
      return StreamPlaceDecision.refused(
        code: e is TimeoutException ? 'authorize_timeout' : 'network',
        message: "Can't reach AvaTOK right now — check your connection and try again.",
        httpStatus: 0,
      );
    }
  }

  /// Per-call state subscriptions, keyed by call cid. Previously the
  /// subscription returned by [_wireRingingEvents] was discarded at both call
  /// sites and leaked for the lifetime of the process.
  final Map<String, StreamSubscription<CallState>> _ringSubs = {};

  /// A terminal state seen by the listener schedules the `..._call_ended`
  /// event on a short fuse instead of emitting it immediately, so that an
  /// explicit [leave] arriving milliseconds later (the normal case — the screen
  /// hangs up as soon as it sees the same state) wins and the single ended
  /// event carries `duration_s` and the `mic_released` proof.
  final Map<String, Timer> _pendingEnd = {};

  /// Call cids that have already emitted `stream_lane_call_ended`, so a
  /// terminal state observed by the listener and an explicit `leave()` do not
  /// both report the same call ending.
  final Set<String> _endedEmitted = <String>{};

  // ---------------------------------------------------------------------------
  // Failure classification
  // ---------------------------------------------------------------------------

  /// Turn an exception into a stable, low-cardinality `reason` for
  /// `stream_lane_call_join_failed`.
  ///
  /// Deliberately string-based: the SDK's error types are not stable enough to
  /// pattern-match on, and the 2026-08-21 incident showed that labelling every
  /// media failure `media_denied` costs hours (see the audit §4). A permission
  /// denial, an engine fault and a hardware fault are three different things.
  static String classifyJoinError(Object e) {
    if (e is TimeoutException) return 'timeout';
    final s = e.toString().toLowerCase();
    if (s.contains('factoryid') ||
        s.contains('getusermedia') ||
        s.contains('mediadevices')) {
      return 'media_engine';
    }
    if (s.contains('permission') ||
        s.contains('denied') ||
        s.contains('notallowed')) {
      return 'permission_denied';
    }
    if (s.contains('notfound') ||
        s.contains('not found') ||
        s.contains('no device') ||
        s.contains('hardware')) {
      return 'no_device';
    }
    if (s.contains('timeout') || s.contains('timed out')) return 'timeout';
    if (s.contains('token') ||
        s.contains('unauthenticated') ||
        s.contains('unauthorized') ||
        s.contains('401')) {
      return 'auth';
    }
    if (s.contains('socket') ||
        s.contains('network') ||
        s.contains('connection') ||
        s.contains('host')) {
      return 'network';
    }
    return 'unknown';
  }

  /// The user-facing sentence for a [classifyJoinError] reason. Never says
  /// "microphone permission" unless the failure actually looks like one.
  static String joinErrorMessage(String reason) {
    switch (reason) {
      case 'permission_denied':
        return 'AvaTOK needs microphone access to place this call. Turn it on in Settings, then try again.';
      case 'media_engine':
        return "Your device's audio/video engine could not start. Please try again.";
      case 'no_device':
        return 'No microphone or camera was available on this device.';
      case 'timeout':
        return 'The call took too long to connect.';
      case 'auth':
        return 'Your calling session expired. Please try again.';
      case 'network':
        return 'Connection problem — check your internet and try again.';
      default:
        return "Couldn't connect the call.";
    }
  }

  /// Classify a `DisconnectReason` by its runtime type NAME.
  ///
  /// Name-based on purpose: this lane has never run in production and there is
  /// no local Dart toolchain to compile-check an `is DisconnectReasonX` chain
  /// against the SDK's actual variant names. Matching on the lowercased type
  /// name cannot fail to compile and degrades safely.
  ///
  /// [everConnected] is the tie-breaker for a reason we do not recognise: if
  /// media never flowed we assume a recoverable setup blip and keep the screen
  /// up; if the call had been live, a disconnect we cannot name is treated as
  /// the call ending, so the screen does not hang around after a hangup.
  static StreamDisconnectKind classifyDisconnect(
    Object? reason, {
    required bool everConnected,
  }) {
    final n = reason.runtimeType.toString().toLowerCase();
    // Transient first — a reconnect must never be read as an ending.
    if (n.contains('reconnect') ||
        n.contains('connecting') ||
        n.contains('migrat') ||
        n.contains('switch')) {
      return StreamDisconnectKind.transient;
    }
    if (n.contains('failure') || n.contains('error') || n.contains('fail')) {
      return StreamDisconnectKind.failed;
    }
    if (n.contains('ended') ||
        n.contains('cancel') ||
        n.contains('reject') ||
        n.contains('decline') ||
        n.contains('lastparticipant') ||
        n.contains('timeout') ||
        n.contains('replaced') ||
        n.contains('eject') ||
        n.contains('block') ||
        n.contains('kick') ||
        n.contains('policy')) {
      return StreamDisconnectKind.ended;
    }
    return everConnected
        ? StreamDisconnectKind.ended
        : StreamDisconnectKind.transient;
  }

  // ---------------------------------------------------------------------------
  // Dial / answer
  // ---------------------------------------------------------------------------

  /// Place an outgoing 1:1 ring to [userId]. Mirrors `place1to1Call`'s
  /// caller-side shape (peer id + video flag) but delegates all signalling
  /// and media setup to the Stream Video SDK.
  ///
  /// [name], [avatarUrl], [peerEmail] and [traceId] are OPTIONAL and only
  /// improve what the screen renders and what telemetry can be joined on —
  /// every existing call site keeps compiling unchanged.
  ///
  /// [STREAM-UI-1] / plan P1.3: the call screen is mounted BEFORE any media
  /// work. `getOrCreate` + `join` run from inside the screen, so a failure
  /// renders an error with a Retry button on a screen the user can see,
  /// instead of the tap doing nothing at all.
  Future<void> place1to1(
    BuildContext context,
    String userId, {
    required bool video,
    String? name,
    String? avatarUrl,
    String? peerEmail,
    String? traceId,
  }) async {
    final startedAtMs = DateTime.now().millisecondsSinceEpoch;
    final email = Analytics.currentEmail ?? '';

    // ── [STREAM-AUTH-1 / plan §8.1] SERVER AUTHORITY, BEFORE ANYTHING ────────
    // This runs before the permission preflight and before a single Stream SDK
    // symbol is touched. A refused call must not prompt for the microphone and
    // must not reach Stream at all — the callee's phone costs them nothing,
    // exactly like the legacy `POST /api/call` admission gate.
    //
    // `stream_lane_call_requested` preserves the diagnostic that
    // `stream_lane_call_placed` used to provide as the first statement of this
    // method: a nonzero count proves the lane was entered. `..._placed` now
    // means "entered AND authorised", and carries the server's call id.
    Analytics.capture('stream_lane_call_requested', {
      'peer_id': userId,
      'media_mode': video ? 'video' : 'audio',
      'user_email': email,
      if (peerEmail != null && peerEmail.isNotEmpty) 'peer_email': peerEmail,
      if (traceId != null && traceId.isNotEmpty) 'trace_id': traceId,
    });
    final decision =
        await authorizePlace(peerId: userId, video: video, traceId: traceId);
    if (!decision.approved) {
      Analytics.capture('stream_lane_call_refused', {
        'peer_id': userId,
        'code': decision.code,
        'http_status': decision.httpStatus,
        'media_mode': video ? 'video' : 'audio',
        'user_email': email,
        if (peerEmail != null && peerEmail.isNotEmpty) 'peer_email': peerEmail,
        if (traceId != null && traceId.isNotEmpty) 'trace_id': traceId,
      });
      if (context.mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(decision.message)));
      }
      return;
    }
    // SERVER-MINTED. Was `'sl-${_uuid.v4()}'` — a call identity the phone made
    // up, which no part of AvaTOK had authorised or recorded.
    final callId = decision.callId;

    Analytics.capture('stream_lane_call_placed', {
      'call_id': callId,
      'peer_id': userId,
      'media_mode': video ? 'video' : 'audio',
      'user_email': email,
      if (peerEmail != null && peerEmail.isNotEmpty) 'peer_email': peerEmail,
      if (traceId != null && traceId.isNotEmpty) 'trace_id': traceId,
    });

    // ── [STREAM-PERM-1 wiring / plan P1.5] ────────────────────────────────
    // Preflight the microphone (and camera for video) BEFORE any media work.
    // Without this the SDK's own `join()` is the first thing to discover a
    // denial, and it reports it as a generic join failure — the same class of
    // misdiagnosis that made the 10612 incident take hours. `ensure` returns
    // `unknown`/`canProceed == true` on any plugin fault, so a broken checker
    // can never become a broken dialer.
    final perms = await CallMediaPermissions.ensure(
      video: video,
      surface: 'stream_lane',
      callId: callId,
    );
    if (!perms.canProceed) {
      Analytics.capture('stream_lane_call_join_failed', {
        'call_id': callId,
        'peer_id': userId,
        'stage': 'preflight',
        'reason': 'permission_denied',
        'error': perms.code,
        'blocked_by': perms.blockedBy,
        'user_email': email,
        if (peerEmail != null && peerEmail.isNotEmpty) 'peer_email': peerEmail,
        if (traceId != null && traceId.isNotEmpty) 'trace_id': traceId,
      });
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text(perms.message),
          action: perms.needsSettings
              ? SnackBarAction(
                  label: 'Settings',
                  onPressed: () => CallMediaPermissions.openSettings(),
                )
              : null,
        ));
      }
      return;
    }

    // `late final` (not plain `final`): assigned inside the try, and the catch
    // returns — this keeps definite-assignment analysis out of the way.
    late final Call call;
    try {
      // ── [STREAM-UI-1 review fix] ────────────────────────────────────────
      // `StreamVideo.instance` THROWS when no client has been created, and it
      // used to sit ABOVE this try — so a dial placed before `StreamLane.init`
      // finished threw straight out of this method: no screen, no snackbar, no
      // telemetry. Exactly the "tap does nothing" failure this class exists to
      // prevent, one line above its own guard. It is now inside the try, and
      // the readiness check below names the cause instead of guessing.
      if (!StreamLane.instance.isReady) {
        throw StateError('Stream client not ready yet (lane still connecting)');
      }
      final client = StreamVideo.instance;
      // verified: packages/stream_video/lib/src/call/call_type.dart — there
      // is no `StreamCallType.id(...)` factory; the built-in 1:1/group call
      // type is `StreamCallType.defaultType()` (value 'default').
      call = client.makeCall(
        callType: StreamCallType.defaultType(),
        id: callId,
      );
    } catch (e, st) {
      // The only failure that can happen before there is a Call to hand to a
      // screen. Everything after this point is reported INSIDE the screen.
      const reason = 'make_call';
      Analytics.capture('stream_lane_call_join_failed', {
        'call_id': callId,
        'peer_id': userId,
        'stage': 'make_call',
        'reason': reason,
        'error': e.toString(),
        'user_email': email,
        if (peerEmail != null && peerEmail.isNotEmpty) 'peer_email': peerEmail,
        if (traceId != null && traceId.isNotEmpty) 'trace_id': traceId,
      });
      // Kept for continuity with the pre-[STREAM-UI-1] dashboards.
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
        extra: {'op': 'place1to1', 'call_id': callId, 'reason': reason},
      );
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(joinErrorMessage('unknown'))),
        );
      }
      return;
    }

    _wireRingingEvents(call, email, peerId: userId, peerEmail: peerEmail);

    if (!context.mounted) {
      await disposeCall(call);
      return;
    }
    await Navigator.push(
      context,
      MaterialPageRoute(
        builder: (_) => StreamCallScreen(
          call: call,
          peerId: userId,
          peerName: name,
          peerAvatarUrl: avatarUrl,
          peerEmail: peerEmail,
          traceId: traceId,
          video: video,
          outgoing: true,
          startedAtMs: startedAtMs,
          connect: (_) async {
            await call.getOrCreate(
              memberIds: [userId],
              ringing: true,
              video: video,
            );
            // Without this the caller never joins — getOrCreate only registers
            // + rings; join() is what connects media.
            await call.join();
          },
        ),
      ),
    );
    // The route is gone — make sure nothing is left listening to this call.
    await disposeCall(call);
  }

  /// Accept an incoming ring (called from `StreamIncomingScreen`).
  ///
  /// [STREAM-UI-1] / plan P1.3: the ring screen is replaced by the call screen
  /// FIRST, then `accept()` + `join()` run inside it. Previously a failure
  /// here closed the ring screen and mounted nothing.
  Future<void> accept(
    BuildContext context,
    Call call, {
    String? peerId,
    String? name,
    String? avatarUrl,
    String? peerEmail,
    String? traceId,
  }) async {
    final email = Analytics.currentEmail ?? '';
    final startedAtMs = DateTime.now().millisecondsSinceEpoch;

    // ── [STREAM-PERM-1 wiring / plan P1.5] ────────────────────────────────
    // Preflight BEFORE the ring screen is replaced, so a denial leaves the
    // user on the ring (where Decline still works) instead of on a dead
    // screen. Mic only: `accept` is not told whether the call is video, and
    // blocking an audio answer on a camera denial would be wrong. A camera
    // denial on a video call still surfaces through the in-screen join error.
    final perms = await CallMediaPermissions.ensure(
      video: false,
      surface: 'stream_lane_accept',
      callId: call.callCid.value,
    );
    if (!perms.canProceed) {
      Analytics.capture('stream_lane_call_join_failed', {
        'call_id': call.callCid.value,
        'stage': 'preflight',
        'reason': 'permission_denied',
        'error': perms.code,
        'blocked_by': perms.blockedBy,
        'user_email': email,
        if (peerId != null && peerId.isNotEmpty) 'peer_id': peerId,
        if (peerEmail != null && peerEmail.isNotEmpty) 'peer_email': peerEmail,
        if (traceId != null && traceId.isNotEmpty) 'trace_id': traceId,
      });
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text(perms.message),
          action: perms.needsSettings
              ? SnackBarAction(
                  label: 'Settings',
                  onPressed: () => CallMediaPermissions.openSettings(),
                )
              : null,
        ));
      }
      return;
    }

    _wireRingingEvents(call, email, peerId: peerId, peerEmail: peerEmail);
    if (!context.mounted) {
      await disposeCall(call);
      return;
    }
    await Navigator.pushReplacement(
      context,
      MaterialPageRoute(
        builder: (_) => StreamCallScreen(
          call: call,
          peerId: peerId ?? '',
          peerName: name,
          peerAvatarUrl: avatarUrl,
          peerEmail: peerEmail,
          traceId: traceId,
          outgoing: false,
          startedAtMs: startedAtMs,
          connect: (attempt) async {
            // Only the FIRST attempt accepts; a Retry after a join failure
            // must not try to accept a ring that is already accepted.
            if (attempt == 1) {
              await call.accept();
              Analytics.capture('stream_lane_call_accepted', {
                'call_id': call.callCid.value,
                'user_email': email,
                if (peerId != null && peerId.isNotEmpty) 'peer_id': peerId,
                if (peerEmail != null && peerEmail.isNotEmpty)
                  'peer_email': peerEmail,
                if (traceId != null && traceId.isNotEmpty) 'trace_id': traceId,
              });
            }
            await call.join();
          },
        ),
      ),
    );
    // The route is gone — make sure nothing is left listening to this call.
    await disposeCall(call);
  }

  /// Emitted by [StreamCallScreen] the moment media is actually flowing (a
  /// remote participant is publishing at least one track) — NOT when `join()`
  /// returns. Plan §4 counts this event on two distinct persons.
  void reportConnected(
    Call call, {
    required String peerId,
    required int setupMs,
    required bool video,
    required bool localPublishing,
    String? peerEmail,
    String? traceId,
  }) {
    Analytics.capture('stream_lane_call_connected', {
      'call_id': call.callCid.value,
      'peer_id': peerId,
      'setup_ms': setupMs,
      'media_mode': video ? 'video' : 'audio',
      'local_publishing': localPublishing,
      'user_email': Analytics.currentEmail ?? '',
      if (peerEmail != null && peerEmail.isNotEmpty) 'peer_email': peerEmail,
      if (traceId != null && traceId.isNotEmpty) 'trace_id': traceId,
    });
  }

  /// Emitted by [StreamCallScreen] when `connect` throws — the failure the
  /// user is looking at on screen.
  Future<void> reportJoinFailed(
    Call call,
    Object e,
    StackTrace st, {
    required String peerId,
    required int attempt,
    required bool outgoing,
    String? peerEmail,
    String? traceId,
  }) async {
    final reason = classifyJoinError(e);
    Analytics.capture('stream_lane_call_join_failed', {
      'call_id': call.callCid.value,
      'peer_id': peerId,
      'stage': outgoing ? 'place' : 'accept',
      'reason': reason,
      'attempt': attempt,
      'error': e.toString(),
      'user_email': Analytics.currentEmail ?? '',
      if (peerEmail != null && peerEmail.isNotEmpty) 'peer_email': peerEmail,
      if (traceId != null && traceId.isNotEmpty) 'trace_id': traceId,
    });
    // Kept so the pre-[STREAM-UI-1] `stream_lane_call_failed` series stays
    // continuous; `..._join_failed` is the one carrying `reason`.
    Analytics.capture('stream_lane_call_failed', {
      'call_id': call.callCid.value,
      'peer_id': peerId,
      'stage': outgoing ? 'place' : 'accept',
      'error': e.toString(),
      'user_email': Analytics.currentEmail ?? '',
    });
    await Analytics.captureException(
      e,
      st,
      screen: 'stream_call_service',
      handled: true,
      extra: {
        'op': outgoing ? 'place1to1' : 'accept',
        'call_id': call.callCid.value,
        'reason': reason,
        'attempt': attempt,
      },
    );
  }

  /// Decline an incoming ring.
  Future<void> decline(Call call) async {
    final email = Analytics.currentEmail ?? '';
    try {
      await call.reject();
      _emitEndedOnce(call, reason: 'declined', email: email);
    } catch (e, st) {
      await Analytics.captureException(
        e,
        st,
        screen: 'stream_call_service',
        handled: true,
        extra: {'op': 'decline', 'call_id': call.callCid.value},
      );
    } finally {
      await disposeCall(call);
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
      _emitEndedOnce(
        call,
        reason: reason,
        email: email,
        durationS: durationS,
        micReleased: true,
      );
    } catch (e, st) {
      _emitEndedOnce(
        call,
        reason: reason,
        email: email,
        durationS: durationS,
        micReleased: false,
      );
      await Analytics.captureException(
        e,
        st,
        screen: 'stream_call_service',
        handled: true,
        extra: {'op': 'leave', 'call_id': call.callCid.value},
      );
    } finally {
      await disposeCall(call);
    }
  }

  /// Cancel this call's state subscription and forget its dedup entry.
  Future<void> disposeCall(Call call) async {
    final cid = call.callCid.value;
    final sub = _ringSubs.remove(cid);
    _pendingEnd.remove(cid)?.cancel();
    _endedEmitted.remove(cid);
    await sub?.cancel();
  }

  void _emitEndedOnce(
    Call call, {
    required String reason,
    required String email,
    double? durationS,
    bool? micReleased,
    String? peerId,
    String? peerEmail,
  }) {
    final cid = call.callCid.value;
    _pendingEnd.remove(cid)?.cancel();
    if (!_endedEmitted.add(cid)) return;
    Analytics.capture('stream_lane_call_ended', {
      'call_id': cid,
      'reason': reason,
      'user_email': email,
      if (durationS != null) 'duration_s': durationS,
      if (micReleased != null) 'mic_released': micReleased,
      if (peerId != null && peerId.isNotEmpty) 'peer_id': peerId,
      if (peerEmail != null && peerEmail.isNotEmpty) 'peer_email': peerEmail,
    });
  }

  /// verified: packages/stream_video/lib/src/state_emitter.dart (`StateEmitter`
  /// exposes both `.value` and `.valueStream`) + packages/stream_video/lib/
  /// src/call/call.dart (`Call.state` returns `StateEmitter<CallState>`).
  /// `StreamVideo.observeCoreRingingEvents` (packages/stream_video/lib/src/
  /// stream_video.dart) is a real client-level API but it drives the
  /// system/CallKit ringing flow, not a per-call terminal-state signal — this
  /// call-scoped `call.state.valueStream` listen is the correct, simpler way
  /// to detect `CallStatusDisconnected` for this in-app UI.
  ///
  /// The subscription is now RETAINED (keyed by cid) and cancelled by
  /// [disposeCall]; both previous call sites discarded it.
  void _wireRingingEvents(
    Call call,
    String email, {
    String? peerId,
    String? peerEmail,
  }) {
    final cid = call.callCid.value;
    _ringSubs.remove(cid)?.cancel();
    var everConnected = false;
    _ringSubs[cid] = call.state.valueStream.listen((state) {
      if (state.otherParticipants.isNotEmpty) everConnected = true;
      final status = state.status;
      if (status is! CallStatusDisconnected) return;
      final kind = classifyDisconnect(
        status.reason,
        everConnected: everConnected,
      );
      if (kind == StreamDisconnectKind.transient) return;
      final reasonName = status.reason.runtimeType.toString();
      _pendingEnd[cid]?.cancel();
      _pendingEnd[cid] = Timer(const Duration(milliseconds: 1200), () {
        _pendingEnd.remove(cid);
        _emitEndedOnce(
          call,
          reason: reasonName,
          email: email,
          peerId: peerId,
          peerEmail: peerEmail,
        );
      });
    });
  }
}
