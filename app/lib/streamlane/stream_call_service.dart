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
import 'stream_call_telemetry.dart';
import 'stream_lane.dart';

/// [STREAM-AUTH-1 2026-08-21] The Worker route that AUTHORISES a 1:1 Stream
/// dial and mints the call id. Declared here rather than in `core/config.dart`
/// because it belongs to this lane alone; `kApiBase` is the same base every
/// other authed route is built from.
const String kStreamCallPlaceUrl = '$kApiBase/stream-calls/place';
const String kStreamCallCancelUrl = '$kApiBase/stream-calls/cancel';

/// One user gesture, shared by the visible preparation screen and the network
/// work it starts. Dart HTTP futures cannot be force-aborted, so cancellation
/// is cooperative: every completed stage checks this token and the server is
/// also told to invalidate the attempt. This prevents a response that arrives
/// after the user pressed hang-up from becoming a late/ghost ring.
class StreamOutgoingAttempt {
  StreamOutgoingAttempt({required this.attemptId, this.traceId});

  final String attemptId;
  final String? traceId;
  bool cancelled = false;
  String callId = '';
  int startedAtMs = DateTime.now().millisecondsSinceEpoch;
}

class StreamPreparedOutgoing {
  const StreamPreparedOutgoing({
    required this.call,
    required this.connect,
    required this.callId,
  });

  final Call call;
  final String callId;
  final Future<void> Function(int attempt) connect;
}

class StreamOutgoingPreparationException implements Exception {
  const StreamOutgoingPreparationException(this.code, this.message);
  final String code;
  final String message;
  @override
  String toString() => message;
}

/// [STREAM-AUTH-1 2026-08-21] The AvaTOK Worker's verdict on a 1:1 Stream dial.
///
/// Stream carries the MEDIA. It does not decide who may call whom — that is the
/// AvaTOK Worker's job, and until today this lane never asked. See
/// `Specs/PLAN-STREAM-ONLY-CALLS-2026-08-21.md` §8.1.
class StreamPlaceDecision {
  const StreamPlaceDecision._({
    required this.approved,
    required this.callId,
    required this.created,
    required this.code,
    required this.message,
    required this.httpStatus,
  });

  const StreamPlaceDecision.approved(
    String callId, {
    bool created = false,
  }) : this._(
          approved: true,
          callId: callId,
          created: created,
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
          created: false,
          code: code,
          message: message,
          httpStatus: httpStatus,
        );

  /// True only when the server said yes. [callId] is then SERVER-MINTED and is
  /// the id the Stream call must be created with.
  final bool approved;
  final String callId;

  /// [STREAM-SERVER-CREATE-1 2026-08-21] True when the WORKER already
  /// created and rang the Stream call server-side (contract change: the
  /// place route now does the `getOrCreate(ringing:true)` itself instead of
  /// only authorising). When true, the client must NOT call
  /// `getOrCreate(ringing:true)` again — it only constructs the local `Call`
  /// handle for the server-minted id and joins it. When false or absent
  /// (an older, not-yet-upgraded worker), the client falls back to today's
  /// client-side `getOrCreate(ringing:true)` so this lane keeps working
  /// against a worker that hasn't shipped the new contract yet.
  final bool created;

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
  /// The Clerk bearer, `X-Trace-Id` and `x-app-build` are all attached by
  /// [ApiAuth], so the Worker's `callMinBuild` gate has an input on this lane
  /// too. [attemptId] is a UUID minted once per user gesture
  /// (see [StreamCallTelemetry.mintAttemptId]) — the Worker dedups repeated
  /// `place` calls on it, so a double-send from a flaky connection cannot
  /// mint two calls for one tap.
  Future<StreamPlaceDecision> authorizePlace({
    required String peerId,
    required bool video,
    required String attemptId,
    String? traceId,
  }) async {
    try {
      final res = await ApiAuth.postJsonH(
        kStreamCallPlaceUrl,
        <String, Object>{
          'callee_uid': peerId,
          'video': video,
          'attempt_id': attemptId,
        },
        <String, String>{
          if (traceId != null && traceId.isNotEmpty) 'X-Trace-Id': traceId,
        },
        // Longer than the Worker's whole-request deadline plus its compensating
        // end-call window. The caller remains on the staged screen, while this
        // prevents the phone declaring failure before the server has finished
        // guaranteeing that no late ring can escape.
        timeout: const Duration(seconds: 11),
      );
      Map<String, dynamic>? body;
      try {
        final decoded = jsonDecode(res.body);
        if (decoded is Map) body = decoded.cast<String, dynamic>();
      } catch (_) {/* non-JSON (edge rejection) — handled as a refusal below */}
      if (res.statusCode == 200 && body?['approved'] == true) {
        final callId = (body?['call_id'] ?? '').toString();
        if (callId.isNotEmpty) {
          return StreamPlaceDecision.approved(
            callId,
            created: body?['created'] == true,
          );
        }
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
        message:
            "Can't reach AvaTOK right now — check your connection and try again.",
        httpStatus: 0,
      );
    }
  }

  /// Per-call state subscriptions, keyed by call cid. Previously the
  /// subscription returned by [_wireRingingEvents] was discarded at both call
  /// sites and leaked for the lifetime of the process.
  final Map<String, StreamSubscription<CallState>> _ringSubs = {};

  /// The role ('caller'/'callee') each ringing call was wired with, so the
  /// listener-driven end path in [_wireRingingEvents] can tag
  /// `stream_lane_call_ended` correctly even when no explicit [leave]/
  /// [decline]/[cancelRinging] call supplied it first.
  final Map<String, String> _roleByCid = {};

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
  // Telemetry — shared property base
  // ---------------------------------------------------------------------------

  /// Every `stream_lane_*` event from this lane carries these: `call_id`,
  /// `provider:'stream'`, `role`, the app lifecycle state, `user_email`, and
  /// (when known) `peer_id`/`media_mode`/`trace_id`.
  ///
  /// [AUDIT-8 2026-08-21] `peer_email` is deliberately NOT part of this base
  /// — the server already correlates both sides of a call via `call_id`, so
  /// copying the other person's email onto every client event was needless
  /// duplication of personal data. `peerEmail` parameters remain on the
  /// public methods below only so call sites elsewhere in the app (owned by
  /// other agents) keep compiling; they are simply no longer read here.
  Map<String, Object> _base({
    required String callId,
    required String role,
    String? peerId,
    String? mediaMode,
    String? traceId,
  }) =>
      <String, Object>{
        'call_id': callId,
        'provider': 'stream',
        'role': role,
        'app_lifecycle': StreamCallTelemetry.lifecycleState(),
        'user_email': Analytics.currentEmail ?? '',
        if (peerId != null && peerId.isNotEmpty) 'peer_id': peerId,
        if (mediaMode != null) 'media_mode': mediaMode,
        if (traceId != null && traceId.isNotEmpty) 'trace_id': traceId,
      };

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
  /// every existing call site keeps compiling unchanged. [peerEmail] is no
  /// longer emitted (audit item 8); it stays as a parameter for source
  /// compatibility with existing callers.
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
    final mediaMode = video ? 'video' : 'audio';
    // [STREAM-AUTH-1 attempt_id 2026-08-21] One id for this whole gesture —
    // minted once, sent on the `place` request, and reused in every
    // telemetry event this call emits below. `place1to1` runs exactly once
    // per tap; nothing here re-authorises on a later retry, so a single mint
    // already satisfies "stable across in-gesture retries".
    final attemptId = StreamCallTelemetry.mintAttemptId();

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
      ..._base(
          callId: '',
          role: 'caller',
          peerId: userId,
          mediaMode: mediaMode,
          traceId: traceId),
      'attempt_id': attemptId,
    });
    final decision = await authorizePlace(
      peerId: userId,
      video: video,
      attemptId: attemptId,
      traceId: traceId,
    );
    if (!decision.approved) {
      Analytics.capture('stream_lane_call_refused', {
        ..._base(
            callId: '',
            role: 'caller',
            peerId: userId,
            mediaMode: mediaMode,
            traceId: traceId),
        'attempt_id': attemptId,
        'code': decision.code,
        'http_status': decision.httpStatus,
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
    // `_roleByCid[callId]` is set inside `_wireRingingEvents` below, once
    // there is an actual subscription (and therefore a `disposeCall` path)
    // to clean it up — not here, where an early return (preflight/make_call
    // failure) would otherwise leak the entry forever.

    Analytics.capture('stream_lane_call_placed', {
      ..._base(
          callId: callId,
          role: 'caller',
          peerId: userId,
          mediaMode: mediaMode,
          traceId: traceId),
      'attempt_id': attemptId,
      'created': decision.created,
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
        ..._base(
            callId: callId,
            role: 'caller',
            peerId: userId,
            mediaMode: mediaMode,
            traceId: traceId),
        'stage': 'preflight',
        'reason': 'permission_denied',
        'error': perms.code,
        'blocked_by': perms.blockedBy,
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
      // type is `StreamCallType.defaultType()` (value 'default'). This is
      // unchanged by the server-create contract change: whether the server
      // or the client ends up calling `getOrCreate`, the client still needs
      // a local `Call` HANDLE for the server-minted [callId] to join it.
      call = client.makeCall(
        callType: StreamCallType.defaultType(),
        id: callId,
      );
    } catch (e, st) {
      // The only failure that can happen before there is a Call to hand to a
      // screen. Everything after this point is reported INSIDE the screen.
      const reason = 'make_call';
      Analytics.capture('stream_lane_call_join_failed', {
        ..._base(
            callId: callId,
            role: 'caller',
            peerId: userId,
            mediaMode: mediaMode,
            traceId: traceId),
        'stage': 'make_call',
        'reason': reason,
        'error': e.toString(),
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

    _wireRingingEvents(call, email, role: 'caller', peerId: userId);

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
            if (decision.created) {
              // [STREAM-SERVER-CREATE-1] The Worker already created and rang
              // this call server-side — calling `getOrCreate(ringing: true)`
              // again here would ring the callee a second time. The client
              // only needs to join the media session.
              await call.join();
            } else {
              // Fallback for a worker that hasn't shipped the new contract
              // yet: keep today's client-side create+ring path so this lane
              // does not regress against the currently-deployed worker.
              await call.getOrCreate(
                memberIds: [userId],
                ringing: true,
                video: video,
              );
              // Without this the caller never joins — getOrCreate only
              // registers + rings; join() is what connects media.
              await call.join();
            }
          },
        ),
      ),
    );
    // The route is gone — make sure nothing is left listening to this call.
    await disposeCall(call);
  }

  /// Immediate-mount outgoing flow. The visible route and searching tone are
  /// present before the first network await; real ringback begins only after
  /// [authorizePlace] confirms the Worker has issued the Stream ring.
  Future<void> place1to1Staged(
    BuildContext context,
    String userId, {
    required bool video,
    String? name,
    String? avatarUrl,
    String? peerEmail,
    String? traceId,
  }) async {
    final attempt = StreamOutgoingAttempt(
      attemptId: StreamCallTelemetry.mintAttemptId(),
      traceId: traceId,
    );
    final mediaMode = video ? 'video' : 'audio';
    Call? stagedCall;
    Analytics.capture('stream_lane_call_requested', {
      ..._base(
        callId: '',
        role: 'caller',
        peerId: userId,
        mediaMode: mediaMode,
        traceId: traceId,
      ),
      'attempt_id': attempt.attemptId,
      'screen_mounted_before_request': true,
    });

    Future<void> cancelAttempt() async {
      final cancelStarted = DateTime.now().millisecondsSinceEpoch;
      try {
        await ApiAuth.postJsonH(
          kStreamCallCancelUrl,
          <String, Object>{
            'attempt_id': attempt.attemptId,
            if (attempt.callId.isNotEmpty) 'call_id': attempt.callId,
          },
          <String, String>{
            if (traceId != null && traceId.isNotEmpty) 'X-Trace-Id': traceId,
          },
          timeout: const Duration(seconds: 3),
        );
        Analytics.capture('stream_lane_call_preparation_cancelled', {
          'attempt_id': attempt.attemptId,
          'call_id': attempt.callId,
          'elapsed_ms':
              DateTime.now().millisecondsSinceEpoch - attempt.startedAtMs,
          'cancel_ack_ms':
              DateTime.now().millisecondsSinceEpoch - cancelStarted,
          'provider': 'stream',
        });
      } catch (e) {
        Analytics.capture('stream_lane_call_preparation_cancel_failed', {
          'attempt_id': attempt.attemptId,
          'call_id': attempt.callId,
          'error': e.toString(),
          'provider': 'stream',
        });
      }
    }

    Future<StreamPreparedOutgoing?> prepare(
      void Function(String stage) onStage,
    ) async {
      // Settle local media readiness before asking the server to issue a ring.
      // The screen is already visible with searching feedback, so this does
      // not delay acknowledgement of the user's tap; it only prevents ringing
      // another phone for a call this phone cannot join.
      onStage('preparing');
      final permsStarted = DateTime.now().millisecondsSinceEpoch;
      final perms = await CallMediaPermissions.ensure(
        video: video,
        surface: 'stream_lane',
        callId: attempt.attemptId,
      );
      Analytics.capture('stream_lane_call_preflight_completed', {
        'attempt_id': attempt.attemptId,
        'call_id': '',
        'provider': 'stream',
        'role': 'caller',
        'peer_id': userId,
        'media_mode': mediaMode,
        'can_proceed': perms.canProceed,
        'latency_ms': DateTime.now().millisecondsSinceEpoch - permsStarted,
      });
      if (attempt.cancelled) return null;
      if (!perms.canProceed) {
        throw StreamOutgoingPreparationException(
          'permission_denied',
          perms.message,
        );
      }
      final authStarted = DateTime.now().millisecondsSinceEpoch;
      final decision = await authorizePlace(
        peerId: userId,
        video: video,
        attemptId: attempt.attemptId,
        traceId: traceId,
      );
      final authMs = DateTime.now().millisecondsSinceEpoch - authStarted;
      attempt.callId = decision.callId;
      Analytics.capture('stream_lane_call_authority_completed', {
        ..._base(
          callId: decision.callId,
          role: 'caller',
          peerId: userId,
          mediaMode: mediaMode,
          traceId: traceId,
        ),
        'attempt_id': attempt.attemptId,
        'approved': decision.approved,
        'issued': decision.created,
        'http_status': decision.httpStatus,
        'latency_ms': authMs,
      });
      if (attempt.cancelled) {
        // The HTTP future completed after hang-up. Re-send now that call_id is
        // known, so even an already-created Stream ring is invalidated.
        await cancelAttempt();
        return null;
      }
      if (!decision.approved) {
        Analytics.capture('stream_lane_call_refused', {
          ..._base(
            callId: '',
            role: 'caller',
            peerId: userId,
            mediaMode: mediaMode,
            traceId: traceId,
          ),
          'attempt_id': attempt.attemptId,
          'code': decision.code,
          'http_status': decision.httpStatus,
          'latency_ms': authMs,
        });
        // A timeout/network refusal is ambiguous: the Worker may have finished
        // after the phone stopped waiting. Fence the attempt before showing a
        // failure so that ambiguous work cannot become a late ring.
        await cancelAttempt();
        throw StreamOutgoingPreparationException(
          decision.code,
          decision.message,
        );
      }
      if (!decision.created) {
        // Production's server-authority contract must create and ring. Falling
        // back to client-side creation would bypass the server's cancel fence
        // and re-introduce late rings.
        throw const StreamOutgoingPreparationException(
          'ring_not_issued',
          "Couldn't start the call. Please try again.",
        );
      }
      if (!StreamLane.instance.isReady) {
        await cancelAttempt();
        throw const StreamOutgoingPreparationException(
          'stream_not_ready',
          'Connecting AvaTOK… Please try again in a moment.',
        );
      }

      late final Call call;
      try {
        call = StreamVideo.instance.makeCall(
          callType: StreamCallType.defaultType(),
          id: decision.callId,
        );
      } catch (_) {
        await cancelAttempt();
        rethrow;
      }
      stagedCall = call;
      _wireRingingEvents(
        call,
        Analytics.currentEmail ?? '',
        role: 'caller',
        peerId: userId,
      );
      Analytics.capture('stream_lane_call_placed', {
        ..._base(
          callId: decision.callId,
          role: 'caller',
          peerId: userId,
          mediaMode: mediaMode,
          traceId: traceId,
        ),
        'attempt_id': attempt.attemptId,
        'created': true,
        'elapsed_ms':
            DateTime.now().millisecondsSinceEpoch - attempt.startedAtMs,
      });
      return StreamPreparedOutgoing(
        call: call,
        callId: decision.callId,
        connect: (_) => call.join(),
      );
    }

    if (!context.mounted) return;
    await Navigator.push(
      context,
      MaterialPageRoute(
        builder: (_) => StreamOutgoingPreparationScreen(
          peerId: userId,
          peerName: name,
          peerAvatarUrl: avatarUrl,
          peerEmail: peerEmail,
          video: video,
          attempt: attempt,
          prepare: prepare,
          cancel: cancelAttempt,
        ),
      ),
    );
    if (stagedCall != null) await disposeCall(stagedCall!);
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
    final callId = call.callCid.value;

    // ── [STREAM-PERM-1 wiring / plan P1.5] ────────────────────────────────
    // Preflight BEFORE the ring screen is replaced, so a denial leaves the
    // user on the ring (where Decline still works) instead of on a dead
    // screen. Mic only: `accept` is not told whether the call is video, and
    // blocking an audio answer on a camera denial would be wrong. A camera
    // denial on a video call still surfaces through the in-screen join error.
    final perms = await CallMediaPermissions.ensure(
      video: false,
      surface: 'stream_lane_accept',
      callId: callId,
    );
    if (!perms.canProceed) {
      Analytics.capture('stream_lane_call_join_failed', {
        ..._base(
            callId: callId, role: 'callee', peerId: peerId, traceId: traceId),
        'stage': 'preflight',
        'reason': 'permission_denied',
        'error': perms.code,
        'blocked_by': perms.blockedBy,
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

    _wireRingingEvents(call, email, role: 'callee', peerId: peerId);
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
                ..._base(
                    callId: callId,
                    role: 'callee',
                    peerId: peerId,
                    traceId: traceId),
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
    required bool outgoing,
    String? peerEmail,
    String? traceId,
  }) {
    Analytics.capture('stream_lane_call_connected', {
      ..._base(
        callId: call.callCid.value,
        role: outgoing ? 'caller' : 'callee',
        peerId: peerId,
        mediaMode: video ? 'video' : 'audio',
        traceId: traceId,
      ),
      'setup_ms': setupMs,
      'local_publishing': localPublishing,
    });
  }

  /// Emitted by [StreamCallScreen] the first time the remote side is heard
  /// (`kind: 'audio'`) or seen (`kind: 'video'`) — i.e. the first moment the
  /// call actually DOES what it is for, distinct from `..._connected` (which
  /// only proves a track was published, not which kind).
  void reportFirstMedia(
    Call call,
    String kind, {
    required String peerId,
    required bool outgoing,
    required int elapsedMs,
    String? traceId,
  }) {
    Analytics.capture('stream_lane_first_${kind}_received', {
      ..._base(
        callId: call.callCid.value,
        role: outgoing ? 'caller' : 'callee',
        peerId: peerId,
        traceId: traceId,
      ),
      'elapsed_ms': elapsedMs,
    });
  }

  /// Emitted when a live call's media drops but the SDK reports a transient/
  /// reconnect-shaped disconnect (see [classifyDisconnect]) rather than a
  /// terminal one — the screen stays up and shows "Reconnecting…".
  void reportReconnecting(
    Call call, {
    required String peerId,
    required bool outgoing,
    String? traceId,
  }) {
    Analytics.capture('stream_lane_call_reconnecting', {
      ..._base(
        callId: call.callCid.value,
        role: outgoing ? 'caller' : 'callee',
        peerId: peerId,
        traceId: traceId,
      ),
    });
  }

  /// Emitted when a call that had entered `reconnecting` sees remote media
  /// flowing again — the other half of `..._reconnecting`, so the two can be
  /// paired to measure outage duration.
  void reportRecovered(
    Call call, {
    required String peerId,
    required bool outgoing,
    String? traceId,
  }) {
    Analytics.capture('stream_lane_call_recovered', {
      ..._base(
        callId: call.callCid.value,
        role: outgoing ? 'caller' : 'callee',
        peerId: peerId,
        traceId: traceId,
      ),
    });
  }

  /// A quality summary — emitted every ~15s while live, and once more at
  /// call end. Never emitted continuously (per the task brief); the caller
  /// (the call screen) owns the cadence, this method just tags and sends
  /// whatever [StreamCallTelemetry.qualityProps] produced.
  void reportQuality(
    Call call,
    Map<String, Object> quality, {
    required String peerId,
    required bool outgoing,
    required bool video,
    String? traceId,
  }) {
    if (quality.isEmpty) return; // nothing measured yet — don't emit noise.
    Analytics.capture('stream_lane_call_quality', {
      ..._base(
        callId: call.callCid.value,
        role: outgoing ? 'caller' : 'callee',
        peerId: peerId,
        mediaMode: video ? 'video' : 'audio',
        traceId: traceId,
      ),
      ...quality,
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
      ..._base(
        callId: call.callCid.value,
        role: outgoing ? 'caller' : 'callee',
        peerId: peerId,
        traceId: traceId,
      ),
      'stage': outgoing ? 'place' : 'accept',
      'reason': reason,
      'attempt': attempt,
      'error': e.toString(),
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
  ///
  /// [reason] is telemetry-only "decline-with-reason" plumbing (task item
  /// 4): the incoming screen still offers a single Decline button (no
  /// reason picker — that is voicemail/receptionist territory, explicitly
  /// out of scope here), so it always passes the default. The SDK signal
  /// sent to the coordinator is always `CallRejectReason.decline()` —
  /// verified: packages/stream_video/lib/src/call/call_reject_reason.dart
  /// ("decline - when the callee intentionally declines the call").
  Future<void> decline(
    Call call, {
    String reason = 'user_declined',
    String? peerId,
    String? traceId,
  }) async {
    final email = Analytics.currentEmail ?? '';
    final callId = call.callCid.value;
    Analytics.capture('stream_lane_call_declined', {
      ..._base(
          callId: callId, role: 'callee', peerId: peerId, traceId: traceId),
      'reason': reason,
    });
    try {
      await call.reject(reason: CallRejectReason.decline());
      _emitEndedOnce(call,
          reason: 'declined', email: email, role: 'callee', peerId: peerId);
    } catch (e, st) {
      await Analytics.captureException(
        e,
        st,
        screen: 'stream_call_service',
        handled: true,
        extra: {'op': 'decline', 'call_id': callId},
      );
    } finally {
      await disposeCall(call);
    }
  }

  /// [AUDIT-5 2026-08-21] Cancel a call the CALLER placed that has not been
  /// answered yet — i.e. stop the callee's phone from ringing.
  ///
  /// verdict: `call.leave()` does NOT do this. verified: packages/
  /// stream_video/lib/src/call/call.dart `leave()` (~L2325) only runs
  /// `_disconnect`, which calls `_session?.leave(...)` (the LOCAL SFU
  /// session) and local `clientEventReporter` bookkeeping — it never calls
  /// `_coordinatorClient`, so nothing is sent to the other party. `reject()`
  /// (~L931) is the one that does: it calls
  /// `_coordinatorClient.rejectCall(cid: ..., reason: ...)` — a real
  /// server-side signal that the coordinator relays to every other call
  /// member over their own state stream (that is how a decline updates the
  /// caller's screen without polling) — and only THEN calls `leave()`
  /// locally to release local media. Independent confirmation from the
  /// SDK's own internal usage: `Call.accept()` (~L903), when the user
  /// answers a second incoming call while they have an outgoing one ringing,
  /// cancels that outgoing call with exactly
  /// `outgoingCall.reject(reason: CallRejectReason.cancel())` — the SDK
  /// authors' own choice for "cancel my ringing outgoing call" is `reject`,
  /// not `leave`.
  ///
  /// So: caller-cancels-before-answer uses `reject(reason:
  /// CallRejectReason.cancel())`, exactly like [decline] uses `reject(reason:
  /// CallRejectReason.decline())`. Established-call hang-up keeps using
  /// [leave] (unchanged semantics, per the task brief) — `end()` was
  /// considered but rejected for that role: it throws for anything that
  /// isn't `CallStatusActive` and ends the call for every participant, which
  /// is a stronger and less reversible action than a single side leaving.
  Future<void> cancelRinging(
    Call call, {
    required DateTime startedAt,
    String? peerId,
    String? traceId,
  }) async {
    final email = Analytics.currentEmail ?? '';
    final callId = call.callCid.value;
    const op = 'reject_cancel';
    try {
      await call.reject(reason: CallRejectReason.cancel());
      Analytics.capture('stream_lane_call_cancelled', {
        ..._base(
            callId: callId, role: 'caller', peerId: peerId, traceId: traceId),
        'op': op,
        'ring_ms': DateTime.now().difference(startedAt).inMilliseconds,
      });
      _emitEndedOnce(call,
          reason: 'caller_cancelled',
          email: email,
          role: 'caller',
          peerId: peerId);
    } catch (e, st) {
      Analytics.capture('stream_lane_call_cancelled', {
        ..._base(
            callId: callId, role: 'caller', peerId: peerId, traceId: traceId),
        'op': op,
        'error': e.toString(),
      });
      await Analytics.captureException(
        e,
        st,
        screen: 'stream_call_service',
        handled: true,
        extra: {'op': 'cancel_ringing', 'call_id': callId},
      );
    } finally {
      await disposeCall(call);
    }
  }

  /// Hang up an ESTABLISHED call. `mic_released` is set ONLY after
  /// `call.leave()` returns without throwing, per the audit requirement that
  /// this event is proof the mic was actually released, not just that a
  /// hangup was requested.
  ///
  /// [role] tags whether the hanging-up side was the caller or callee — the
  /// caller-cancel-before-answer case goes through [cancelRinging] instead
  /// (see its doc comment for why); this method's semantics are otherwise
  /// unchanged from before this task, per the brief.
  Future<void> leave(
    Call call, {
    required DateTime connectedAt,
    required String role,
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
        role: role,
        durationS: durationS,
        micReleased: true,
      );
    } catch (e, st) {
      _emitEndedOnce(
        call,
        reason: reason,
        email: email,
        role: role,
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

  /// Cancel this call's state subscription and forget its dedup entries.
  Future<void> disposeCall(Call call) async {
    final cid = call.callCid.value;
    final sub = _ringSubs.remove(cid);
    _pendingEnd.remove(cid)?.cancel();
    _endedEmitted.remove(cid);
    _roleByCid.remove(cid);
    await sub?.cancel();
  }

  void _emitEndedOnce(
    Call call, {
    required String reason,
    required String email,
    required String role,
    double? durationS,
    bool? micReleased,
    String? peerId,
  }) {
    final cid = call.callCid.value;
    _pendingEnd.remove(cid)?.cancel();
    if (!_endedEmitted.add(cid)) return;
    Analytics.capture('stream_lane_call_ended', {
      ..._base(callId: cid, role: role, peerId: peerId),
      'reason': reason,
      if (durationS != null) 'duration_s': durationS,
      if (micReleased != null) 'mic_released': micReleased,
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
    required String role,
    String? peerId,
  }) {
    final cid = call.callCid.value;
    _roleByCid[cid] = role;
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
          role: _roleByCid[cid] ?? role,
          peerId: peerId,
        );
      });
    });
  }
}
