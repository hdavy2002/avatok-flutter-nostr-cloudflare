/// [CALL-RTK-3] Cloudflare RealtimeKit implementation of the `RtcProvider` seam.
///
/// Spec: `Specs/CALL-REALTIMEKIT-MIGRATION.md` §3.2. This is the CLIENT half of
/// the migration: a headless (`realtimekit_core`, NOT `realtimekit_ui`) adapter
/// that turns a server-minted RealtimeKit `authToken` into a joined meeting and
/// normalizes the SDK's callbacks onto [RtcSessionEvent].
///
/// Three things about this file are load-bearing and easy to undo by accident:
///
/// 1. **Nothing RealtimeKit-specific leaves this file.** Callers see
///    [RtcProvider]/[RtcSession]/[RtcJoinTicket] only, per the contract in
///    `rtc_provider.dart`. That is what makes a rollback a flag flip.
///
/// 2. **AUDIO ROUTE OWNERSHIP IS NOT SETTLED BY CODE HERE — IT CANNOT BE.**
///    `realtimekit_core` 0.1.6 exposes NO option to hand the audio session back
///    to the app: `RtkMeetingInfo` takes only `authToken` / `baseDomain` /
///    `displayName` / `enableAudio` / `enableVideo`, and the only audio-device
///    surface is `RtkSelfParticipant.setAudioDevice/getAudioDevices`, i.e. the
///    SDK drives the native route itself. The mitigation this file CAN apply is
///    negative: we never call `setAudioDevice`, never enumerate devices, and
///    never react to a route change — `CallAudioController` /
///    `NativeVoiceAudio` stay the single route owner from the app's side. If a
///    device test shows RTK stealing the route (the boot-media-vs-Speaker-press
///    race that already bit us once), that is a STOP for the 1:1 rollout, not a
///    tuning problem. See the spec's §6 "Audio-route double ownership".
///
/// 3. **No silent catch.** Every failure path emits either an
///    `Analytics.captureException` or an outcome-carrying `rtk_join` event, so
///    "it just didn't connect" is never the whole record.
library;

import 'dart:async';
import 'dart:convert';

import 'package:realtimekit_core/realtimekit_core.dart';

import '../../analytics.dart';
import '../../api_auth.dart';
import '../../ava_log.dart';
import '../../config.dart';
import 'rtc_provider.dart';

/// The `provider` string carried on an [RtcJoinTicket] and stamped on every
/// event this file emits. Deliberately distinct from the legacy `cloudflare`
/// value used by the raw-SFU path, so a PostHog reader can tell the two
/// Cloudflare transports apart without guessing from a build number.
const String kRtkProviderName = 'realtimekit';

/// Thrown for any non-200 from `/api/callrtk/*`. Mirrors `CallSfuException`
/// (`call_sfu_api.dart`) on purpose — including [unavailable], which is the
/// server saying "the flag is off / RTK is unconfigured", a deliberate refusal
/// that must route the call back to the legacy path rather than fail it.
class RtkException implements Exception {
  RtkException(this.error, this.status);
  final String error;
  final int status;

  bool get unavailable => error == 'rtk_unavailable' || status == 503;

  @override
  String toString() => 'RtkException($error, $status)';
}

/// A server-minted RealtimeKit join credential.
class RtkJoinCredential {
  RtkJoinCredential({
    required this.authToken,
    required this.meetingId,
    this.baseDomain = '',
  });

  final String authToken;
  final String meetingId;

  /// Optional override for `RtkMeetingInfo.baseDomain`. Empty means "use the
  /// SDK default" — we must NOT pass an empty string through, because the SDK's
  /// default is a real value (`dyte.io`) and an empty one would break the join.
  final String baseDomain;

  static RtkJoinCredential fromJson(Map<String, dynamic> j) => RtkJoinCredential(
        authToken: (j['authToken'] ?? j['auth_token'] ?? '').toString(),
        meetingId: (j['meetingId'] ?? j['meeting_id'] ?? '').toString(),
        baseDomain: (j['baseDomain'] ?? j['base_domain'] ?? '').toString(),
      );
}

/// Thin client for `POST $kApiBase/callrtk/<room>/join`. Same shape, same
/// discipline as [CallSfuApi]: the server owns the contract, we pass it on.
class CallRtkApi {
  CallRtkApi._();

  static String get _base => '$kApiBase/callrtk';

  static const Duration _t = Duration(seconds: 12);

  static Future<RtkJoinCredential> join(String room) async {
    final res = await ApiAuth.postJson('$_base/$room/join', const {}, timeout: _t);
    if (res.statusCode != 200) {
      String err = 'http_${res.statusCode}';
      try {
        final j = jsonDecode(res.body);
        if (j is Map && j['error'] is String) err = j['error'] as String;
      } catch (_) {
        // Non-JSON body: keep http_<status>. Deliberately not swallowed —
        // the throw below still carries the status.
      }
      throw RtkException(err, res.statusCode);
    }
    return RtkJoinCredential.fromJson(jsonDecode(res.body) as Map<String, dynamic>);
  }
}

/// One joined RealtimeKit meeting, normalized onto [RtcSession].
class RealtimeKitRtcSession implements RtcSession {
  RealtimeKitRtcSession._({
    required RealtimekitClient client,
    required this.callId,
    required RtcMode mode,
  })  : _client = client,
        _mode = mode;

  final RealtimekitClient _client;

  @override
  final String callId;

  RtcMode _mode;

  @override
  RtcMode get mode => _mode;

  final StreamController<RtcSessionEvent> _events =
      StreamController<RtcSessionEvent>.broadcast();
  final StreamController<RtcSessionEvent> _trackEvents =
      StreamController<RtcSessionEvent>.broadcast();

  bool _left = false;
  RtcTransportState _transport = RtcTransportState.connected;

  _RtkRoomListener? _roomListener;
  _RtkParticipantsListener? _participantsListener;

  @override
  Stream<RtcSessionEvent> get events => _events.stream;

  @override
  Stream<RtcSessionEvent> get remoteTrackEvents => _trackEvents.stream;

  void _emit(RtcSessionEvent e) {
    if (_events.isClosed) return;
    _events.add(e);
  }

  void _emitTrack(RtcSessionEvent e) {
    if (!_trackEvents.isClosed) _trackEvents.add(e);
    _emit(e);
  }

  @override
  Future<void> publishMic({required bool enabled}) async {
    try {
      if (enabled) {
        _client.localUser.enableAudio();
      } else {
        _client.localUser.disableAudio();
      }
    } catch (e, s) {
      await Analytics.captureException(e, s,
          screen: 'realtimekit_provider', handled: true,
          extra: {'op': 'publish_mic', 'call_id': callId, 'enabled': enabled});
    }
  }

  @override
  Future<void> publishCam({required bool enabled}) async {
    // §4.6: an audio-locked session must never publish video. Enforcement is
    // ultimately the server's (the preset caps it), but refusing here keeps the
    // client from even asking.
    if (enabled && _mode == RtcMode.audioLocked) {
      throw StateError('publishCam refused: session is ${_mode.wireValue}');
    }
    try {
      if (enabled) {
        _client.localUser.enableVideo();
      } else {
        _client.localUser.disableVideo();
      }
    } catch (e, s) {
      await Analytics.captureException(e, s,
          screen: 'realtimekit_provider', handled: true,
          extra: {'op': 'publish_cam', 'call_id': callId, 'enabled': enabled});
    }
  }

  @override
  Future<void> setMode(RtcMode mode) async {
    // audioLocked is a one-way degrade (owner decision D7) — never climb back.
    if (_mode == RtcMode.audioLocked && mode == RtcMode.video) return;
    _mode = mode;
    if (mode != RtcMode.video) {
      await publishCam(enabled: false);
    }
    _emit(RtcSessionEvent.modeChanged);
  }

  @override
  RtcStatsSnapshot stats() => RtcStatsSnapshot(
        // realtimekit_core 0.1.6 exposes no normalized WebRTC stats surface, so
        // every numeric field stays at its -1/0 "unknown" sentinel rather than
        // being invented. Only the transport states are real, and they come
        // from the socket-connection callback.
        publishState: _transport,
        subscribeState: _transport,
      );

  @override
  Future<void> leave() async {
    if (_left) return;
    _left = true;
    try {
      _client.leaveRoom();
    } catch (e, s) {
      await Analytics.captureException(e, s,
          screen: 'realtimekit_provider', handled: true,
          extra: {'op': 'leave_room', 'call_id': callId});
    }
    try {
      final room = _roomListener;
      if (room != null) _client.removeMeetingRoomEventListener(room);
      final parts = _participantsListener;
      if (parts != null) _client.removeParticipantsEventListener(parts);
      _client.cleanAllNativeListeners();
      await _client.release();
    } catch (e, s) {
      await Analytics.captureException(e, s,
          screen: 'realtimekit_provider', handled: true,
          extra: {'op': 'release', 'call_id': callId});
    }
    _emit(RtcSessionEvent.disconnected);
    await _events.close();
    await _trackEvents.close();
  }
}

/// Meeting-room callbacks → normalized events + the handover telemetry the
/// whole migration is being judged on.
class _RtkRoomListener extends RtkMeetingRoomEventListener {
  _RtkRoomListener(this._session);

  final RealtimeKitRtcSession _session;

  /// Wall-clock ms at which the socket last reported a DROP, so the
  /// `call_network_handover` event can carry how long the gap actually was.
  int _dropAtMs = 0;

  @override
  void onMeetingEnded() {
    _session._emit(RtcSessionEvent.disconnected);
  }

  @override
  void onMeetingRoomLeaveCompleted() {
    _session._emit(RtcSessionEvent.disconnected);
  }

  @override
  void onSocketConnectionUpdate(SocketConnectionState state) {
    // THE WHATSAPP TEST (spec §5 Phase 2). A WiFi↔cellular switch mid-call is
    // exactly what the hand-rolled CALL-SURVIVE ladder never fixed; this is the
    // event that says whether RealtimeKit fixed it. `outcome` is the value to
    // assert — not the mere arrival of the event (ship-gate rule 3).
    if (state.isReconnectionFailure) {
      _session._transport = RtcTransportState.failed;
      _session._emit(RtcSessionEvent.error);
      Analytics.capture('call_network_handover', {
        'call_id': _session.callId,
        'provider': kRtkProviderName,
        'outcome': 'failed',
        'attempt': state.reconnectionAttempt,
        'socket_state': state.socketState.name,
        if (_dropAtMs > 0)
          'gap_ms': DateTime.now().millisecondsSinceEpoch - _dropAtMs,
      });
      AvaLog.I.error('call', 'rtk reconnection failed after '
          '${state.reconnectionAttempt} attempt(s)');
      _dropAtMs = 0;
      return;
    }
    if (state.reconnected) {
      _session._transport = RtcTransportState.connected;
      _session._emit(RtcSessionEvent.connected);
      Analytics.capture('call_network_handover', {
        'call_id': _session.callId,
        'provider': kRtkProviderName,
        'outcome': 'survived',
        'attempt': state.reconnectionAttempt,
        'socket_state': state.socketState.name,
        if (_dropAtMs > 0)
          'gap_ms': DateTime.now().millisecondsSinceEpoch - _dropAtMs,
      });
      _dropAtMs = 0;
      return;
    }
    if (state.reconnectionAttempt > 0) {
      if (_dropAtMs == 0) _dropAtMs = DateTime.now().millisecondsSinceEpoch;
      _session._transport = RtcTransportState.connecting;
      _session._emit(RtcSessionEvent.reconnecting);
      AvaLog.I.warn('call',
          'rtk reconnecting (attempt ${state.reconnectionAttempt})');
    }
  }
}

/// Participant callbacks → the normalized remote-track/roster events.
class _RtkParticipantsListener extends RtkParticipantsEventListener {
  _RtkParticipantsListener(this._session);

  final RealtimeKitRtcSession _session;

  @override
  void onParticipantJoin(RtkRemoteParticipant participant) {
    _session._emit(RtcSessionEvent.remoteJoin);
  }

  @override
  void onParticipantLeave(RtkRemoteParticipant participant) {
    _session._emit(RtcSessionEvent.remoteLeave);
  }

  @override
  void onAudioUpdate(RtkRemoteParticipant participant, bool isEnabled) {
    _session._emitTrack(
        isEnabled ? RtcSessionEvent.trackAdded : RtcSessionEvent.trackRemoved);
  }

  @override
  void onVideoUpdate(RtkRemoteParticipant participant, bool isEnabled) {
    _session._emitTrack(
        isEnabled ? RtcSessionEvent.trackAdded : RtcSessionEvent.trackRemoved);
  }
}

/// The provider. One instance per join; [join] is not re-entrant.
class RealtimeKitRtcProvider implements RtcProvider {
  RealtimeKitRtcProvider();

  @override
  String get name => kRtkProviderName;

  @override
  RtcCapabilities get capabilities => const RtcCapabilities(
        supportsSimulcast: true,
        supportsDynacast: false,
        supportsServerMute: true,
        // Server-side recording export exists but is a separate, PAID, deferred
        // decision (spec §4) — advertising it would let UI offer a button that
        // costs money nobody approved.
        supportsRecording: false,
        supportsScreenshare: true,
        // The provider ceiling. The PRODUCT cap is 25 and is enforced by the
        // preset + the Worker; do not read this as permission to exceed it.
        maxParticipants: 25,
        maxPublishedTracks: 3,
        maxSubscriptions: 25,
      );

  /// Ask the Worker for a join credential and wrap it in the provider-agnostic
  /// ticket the seam speaks. Kept separate from [join] so a caller can fetch
  /// (and fail fast, to its own fallback) before touching the SDK at all.
  static Future<RtcJoinTicket> fetchTicket(
    String room, {
    required RtcMode mode,
  }) async {
    final cred = await CallRtkApi.join(room);
    if (cred.authToken.isEmpty) {
      throw RtkException('empty_auth_token', 200);
    }
    return RtcJoinTicket(
      provider: kRtkProviderName,
      // The seam's `url` is "provider connection endpoint". For RealtimeKit
      // that is the base domain the SDK dials; empty means "SDK default".
      url: cred.baseDomain,
      token: cred.authToken,
      mode: mode,
      callId: room,
    );
  }

  @override
  Future<RtcSession> join(
    RtcJoinTicket ticket, {
    required RtcMode mode,
    String displayName = 'AvaTOK',
    Duration timeout = const Duration(seconds: 10),
  }) async {
    final t0 = DateTime.now().millisecondsSinceEpoch;
    final client = RealtimekitClient();
    final wantVideo = mode == RtcMode.video;

    // NOTE: `baseDomain` is only passed when the server supplied one. The SDK
    // default is a real domain, so forwarding an empty string would break the
    // join in a way that looks like a token problem.
    final info = ticket.url.isEmpty
        ? RtkMeetingInfo(
            authToken: ticket.token,
            displayName: displayName,
            enableAudio: true,
            enableVideo: wantVideo,
          )
        : RtkMeetingInfo(
            authToken: ticket.token,
            baseDomain: ticket.url,
            displayName: displayName,
            enableAudio: true,
            enableVideo: wantVideo,
          );

    Future<void> fail(String outcome, Object error, StackTrace? stack) async {
      Analytics.capture('rtk_join', {
        'call_id': ticket.callId,
        'provider': kRtkProviderName,
        'outcome': outcome,
        'join_ms': DateTime.now().millisecondsSinceEpoch - t0,
        'mode': mode.wireValue,
      });
      await Analytics.captureException(error, stack,
          screen: 'realtimekit_provider',
          handled: true,
          extra: {'op': outcome, 'call_id': ticket.callId});
    }

    try {
      final inited = Completer<void>();
      client.init(
        info,
        onSuccess: () {
          if (!inited.isCompleted) inited.complete();
        },
        onError: (e) {
          if (!inited.isCompleted) {
            inited.completeError(
                StateError('rtk_init_failed: ${e ?? 'unknown'}'));
          }
        },
      );
      await inited.future.timeout(timeout);

      final joined = Completer<void>();
      client.joinRoom(
        onSuccess: () {
          if (!joined.isCompleted) joined.complete();
        },
        onError: (e) {
          if (!joined.isCompleted) {
            joined.completeError(
                StateError('rtk_join_failed: ${e ?? 'unknown'}'));
          }
        },
      );
      await joined.future.timeout(timeout);

      final session = RealtimeKitRtcSession._(
        client: client,
        callId: ticket.callId,
        mode: mode,
      );
      final room = _RtkRoomListener(session);
      final parts = _RtkParticipantsListener(session);
      session._roomListener = room;
      session._participantsListener = parts;
      client.addMeetingRoomEventListener(room);
      client.addParticipantsEventListener(parts);

      final joinMs = DateTime.now().millisecondsSinceEpoch - t0;
      Analytics.capture('rtk_join', {
        'call_id': ticket.callId,
        'provider': kRtkProviderName,
        'outcome': 'joined',
        'join_ms': joinMs,
        'mode': mode.wireValue,
      });
      // Spec §5 Phase 2 success assertion, verbatim: `call_connected` carrying
      // `provider=realtimekit`. Emitted HERE (not at the call-session fork) so
      // the group path proves the same thing with the same event.
      Analytics.capture('call_connected', {
        'call_id': ticket.callId,
        'provider': kRtkProviderName,
        'join_ms': joinMs,
        'mode': mode.wireValue,
      });
      AvaLog.I.log('call', 'rtk joined ${ticket.callId} in ${joinMs}ms');
      session._emit(RtcSessionEvent.connected);
      return session;
    } on TimeoutException catch (e, s) {
      await fail('timeout', e, s);
      await _bestEffortRelease(client, ticket.callId);
      rethrow;
    } catch (e, s) {
      await fail('error', e, s);
      await _bestEffortRelease(client, ticket.callId);
      rethrow;
    }
  }

  /// Teardown after a FAILED join. Never throws — a failed join must fall back
  /// to the legacy path, and a cleanup error must not be what stops it.
  static Future<void> _bestEffortRelease(
      RealtimekitClient client, String callId) async {
    try {
      client.cleanAllNativeListeners();
      await client.release();
    } catch (e, s) {
      await Analytics.captureException(e, s,
          screen: 'realtimekit_provider',
          handled: true,
          extra: {'op': 'release_after_failed_join', 'call_id': callId});
    }
  }
}
