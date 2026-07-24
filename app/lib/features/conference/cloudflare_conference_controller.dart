// [CF-CALL-003/004] conference_media_controller — the Cloudflare Realtime A/V
// group-call controller (Specs/CLOUDFLARE-ONLY-REALTIME-MEDIA-MIGRATION-
// PROPOSAL-2026-07-24.md Phase 3/4). Owns ONE RTCPeerConnection per the CF
// Realtime pattern (one local offer carrying audio + optional video; remote
// tracks are pulled onto the SAME PC via renegotiation) — this mirrors how
// `sfu_group_call_screen.dart` already talks to the SFU, extended from
// audio-only to audio/video with generation guards, an op queue, and a
// viewport-aware video subscription policy.
//
// Requirements honored here (Phase 3):
//  - init camera/mic before publishing, validate live tracks
//  - await every addTrack/sender call
//  - generation guards on every PC/track/renderer callback
//  - publish/pull/renegotiate serialized via ONE op queue (never interleaved)
//  - track-added/removed handled independently for audio/video
//  - camera on/off via the WS track frame, WITHOUT a new session
//  - signaling-WS reconnect WITHOUT killing healthy media; recreate the PC
//    only after the new path has remote media evidence
//  - deterministic dispose order: timers -> senders -> PC -> renderers -> streams
import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';
import 'package:uuid/uuid.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import '../../core/analytics.dart';
import '../../core/audio_tuning.dart';
import '../../core/ava_log.dart';
import '../../core/remote_config.dart';
import '../../core/voice/native_voice_audio.dart';
import 'cloudflare_conference_api.dart';
import 'cloudflare_conference_telemetry.dart';

/// One roster member as seen locally.
class CfParticipant {
  final String uid;
  final String session;
  final String? audioTrack;
  final String? videoTrack;
  final bool videoEnabled;
  const CfParticipant({
    required this.uid,
    required this.session,
    required this.audioTrack,
    required this.videoTrack,
    required this.videoEnabled,
  });
}

enum CfConnState { connecting, connected, reconnecting, ended, failed }

/// Simultaneous video-subscription cap by device class / viewport. Default 9
/// (Phase 2/4: "never pull every 25 video tracks at full quality on a mobile
/// device"); the Worker/DO enforce a hard ceiling of 12 regardless.
const int kDefaultMaxVideoSubs = 9;

class CloudflareConferenceController extends ChangeNotifier {
  /// The gid of the one CF conference this device is currently in (a phone is
  /// in <=1 call at a time — the only group-call transport as of CF-CALL-007).
  /// No minimize/resume support in this pass (deviation — see CF-CALL-003
  /// report); leaving the screen always leaves the call.
  static String? activeGid;

  final String gid;
  final bool wantVideo;
  final bool starter;
  final int maxVideoSubs;

  CloudflareConferenceController({
    required this.gid,
    required this.wantVideo,
    required this.starter,
    this.maxVideoSubs = kDefaultMaxVideoSubs,
  });

  // Local placeholder id used only before the server's `welcome` frame
  // arrives (op-queue bookkeeping pre-join). Once the WS handshake completes,
  // `_selfUid` (the ticket-authenticated uid the server actually assigns,
  // `d['you']` on the welcome frame) is the one true self identity — every
  // roster/pull/policy/telemetry self-filter MUST use `_isSelf`, never
  // compare against `_myId` directly, or the controller pulls its own
  // audio/video back (echo + duplicate self tile).
  final String _myId = const Uuid().v4().substring(0, 12);
  String? _selfUid;
  String get myId => _selfUid ?? _myId;
  bool _isSelf(String uid) => uid == (_selfUid ?? _myId);

  RTCPeerConnection? _pc;
  // Held during a ticket-expiry rejoin: the PC being retired in favor of a
  // freshly-created one. Field (not a local var) so leave()/dispose() and a
  // bounded timer can always find and close it, even if the new PC never
  // sees remote media or `_publish` throws mid-rejoin (BLOCKER 2 leak fix).
  RTCPeerConnection? _pendingRetirePc;
  Timer? _retireTimer;
  MediaStream? _localStream;
  WebSocketChannel? _ws;
  CfJoinResult? _join;
  int _ticketIssuedAtMs = 0;
  int _generation = 1;

  // Op queue: publish/pull/renegotiate never interleave.
  Future<void> _opQueue = Future.value();

  final Map<String, CfParticipant> _roster = {};
  final Map<String, RTCVideoRenderer> _remoteVideoRenderers = {};
  final Map<String, String> _pulledAudioMid = {}; // uid -> mid
  final Map<String, String> _pulledVideoMid = {}; // uid -> mid
  Set<String> _visibleUids = {};
  String? _dominantSpeakerUid;

  final RTCVideoRenderer localRenderer = RTCVideoRenderer();
  bool _localRendererReady = false;

  Timer? _levelTimer;
  Timer? _billingTimer;
  int _billingBeatSeq = 0;
  int _joinedAtMs = 0;
  bool _muted = false;
  bool _cameraOn = false;
  bool _speaker = true;
  bool _ended = false;
  bool _disposed = false;
  CfConnState state = CfConnState.connecting;
  String statusText = 'Connecting…';

  CloudflareConferenceTelemetry? _tel;
  String _lastMediaHealthClass = 'unknown';
  Timer? _healthTimer;
  int? _lastAudioBytes, _lastVideoFrames, _lastPlayout;

  bool get muted => _muted;
  bool get cameraOn => _cameraOn;
  bool get speakerOn => _speaker;
  List<CfParticipant> get roster => _roster.values.toList(growable: false);
  RTCVideoRenderer? rendererFor(String uid) => _remoteVideoRenderers[uid];
  String? get dominantSpeakerUid => _dominantSpeakerUid;

  // ---- lifecycle ---------------------------------------------------------------

  Future<void> connect() async {
    final t0 = DateTime.now().millisecondsSinceEpoch;
    activeGid = gid;
    try {
      await localRenderer.initialize();
      _localRendererReady = true;

      CloudflareConferenceTelemetry.providerSelected(
        groupId: gid,
        decidedProvider: RemoteConfig.cloudflareConferenceEnabled ? 'cloudflare_realtime' : 'disabled',
        cloudflareEnabled: RemoteConfig.cloudflareConferenceEnabled,
        livekitEnabled: RemoteConfig.livekitConferenceEnabled,
        mediaKindRequested: wantVideo ? 'audio_video' : 'audio',
      );

      final join = await CloudflareConferenceApi.join(gid, video: wantVideo);
      _join = join;
      _ticketIssuedAtMs = DateTime.now().millisecondsSinceEpoch;
      _generation = join.generation;
      _tel = CloudflareConferenceTelemetry(
        groupId: gid,
        callId: join.callId,
        callTraceId: join.callTraceId,
        generation: join.generation,
        mediaKindRequested: join.mediaVideo ? 'audio_video' : 'audio',
      );

      await _createPcAndPublish(join, generationAtStart: _generation);

      _joinConnectWs(join, route: 'join');
      _startLevelReporting();
      _startBillingBeat();
      _startHealthSampler();
      _joinedAtMs = DateTime.now().millisecondsSinceEpoch;
      state = CfConnState.connected;
      statusText = 'Connected';
      _tel?.joined(elapsedMs: DateTime.now().millisecondsSinceEpoch - t0, rosterSizeOnJoin: _roster.length);
      _safeNotify();
    } catch (e, st) {
      AvaLog.I.log('cfconf', 'connect failed: $e');
      _tel?.error(stage: 'session_create_failed', direction: 'ticket', recoverable: false, exception: e, stack: st);
      state = CfConnState.failed;
      statusText = 'Could not join the call';
      _safeNotify();
    }
  }

  Future<void> _createPcAndPublish(CfJoinResult join, {required int generationAtStart}) async {
    final pc = await createPeerConnection({
      'iceServers': join.iceServers,
      'sdpSemantics': 'unified-plan',
    });
    _pc = pc;

    pc.onConnectionState = (s) {
      if (generationAtStart != _generation || _ended) return; // stale-generation guard
      if (s == RTCPeerConnectionState.RTCPeerConnectionStateFailed) {
        // ICE/ DTLS actually died here — reopening just the WS with a fresh
        // ticket (the "ticket still fresh" fast path) would report
        // Connected while media stays dead. A PC Failed must always go
        // through the full rejoin/PC-recreate path, regardless of ticket
        // age (FOLLOW-UP 3).
        unawaited(_attemptReconnect(reason: 'pc_failed', forceRecreate: true));
      }
    };

    // Track-added/removed handled independently per kind (Phase 3 requirement).
    pc.onTrack = (RTCTrackEvent e) {
      if (generationAtStart != _generation || _ended) return;
      if (e.track.kind == 'video') {
        _onRemoteVideoTrack(e);
      } else if (e.track.kind == 'audio') {
        AvaLog.I.log('cfconf', 'remote audio track bound');
      }
    };

    _localStream = await navigator.mediaDevices.getUserMedia({
      'audio': avaMicConstraints(),
      'video': wantVideo
          ? {
              'facingMode': 'user',
              'width': {'ideal': 640},
              'height': {'ideal': 360},
              'frameRate': {'ideal': 24, 'max': 30},
            }
          : false,
    });
    // Validate live tracks before publishing (Phase 3 requirement).
    final audioTracks = _localStream!.getAudioTracks();
    if (audioTracks.isEmpty || !audioTracks.first.enabled) {
      throw StateError('local audio capture failed');
    }
    _cameraOn = wantVideo && _localStream!.getVideoTracks().isNotEmpty;
    if (_cameraOn) localRenderer.srcObject = _localStream;

    final specs = <CfTrackSpec>[
      CfTrackSpec(mid: '0', kind: 'audio', trackName: 'audio-${join.sessionId}'),
      if (_cameraOn) CfTrackSpec(mid: '1', kind: 'video', trackName: 'video-${join.sessionId}'),
    ];
    for (final t in audioTracks) {
      await pc.addTrack(t, _localStream!);
    }
    if (_cameraOn) {
      for (final t in _localStream!.getVideoTracks()) {
        await pc.addTrack(t, _localStream!);
      }
    }

    if (RemoteConfig.callAudioControllerV2) {
      await NativeVoiceAudio.instance.beginP2pSession(callId: join.callId, video: _cameraOn);
      // Conference calls default-route to speaker regardless of video (unlike
      // 1:1 calls, which default audio-only to earpiece) — matches
      // ConferenceScreen's `_speaker = true` default and the telemetry
      // contract's cloudflare_route_state note ("conference calls default-
      // route to speaker").
      final r = await NativeVoiceAudio.instance.selectRoute(
        CallAudioRoute.speaker,
        source: 'initial',
      );
      _speaker = r.active == CallAudioRoute.speaker;
      _tel?.routeState(activeRoute: r.active.name, routeConfirmed: true);
    } else {
      try { await Helper.setSpeakerphoneOn(_speaker); } catch (_) {}
    }

    await _publish(join, specs, attempt: 1, generationAtStart: generationAtStart);
  }

  Future<void> _publish(CfJoinResult join, List<CfTrackSpec> specs,
      {required int attempt, required int generationAtStart}) {
    final op = _opQueue.then((_) => _publishInternal(join, specs, attempt, generationAtStart));
    _opQueue = op.catchError((_) {});
    return op;
  }

  Future<void> _publishInternal(
      CfJoinResult join, List<CfTrackSpec> specs, int attempt, int generationAtStart) async {
    if (generationAtStart != _generation || _ended || _pc == null) return;
    final t0 = DateTime.now().millisecondsSinceEpoch;
    final trackKind = specs.length > 1 ? CfTrackKind.audioVideo : CfTrackKind.audio;
    _tel?.publishStarted(trackKind: trackKind, midCount: specs.length, attempt: attempt);
    try {
      final offer = await _pc!.createOffer();
      final tuned = RTCSessionDescription(tuneOpusSdp(offer.sdp), offer.type);
      await _pc!.setLocalDescription(tuned);
      final res = await CloudflareConferenceApi.publish(gid, join.sessionId, tuned.sdp ?? '', specs, attempt: attempt);
      if (generationAtStart != _generation || _ended) return; // superseded mid-flight
      final ans = res.answer;
      if (ans != null) {
        await _pc!.setRemoteDescription(RTCSessionDescription(ans['sdp'].toString(), ans['type'].toString()));
      }
      _tel?.publishCompleted(
          trackKind: trackKind, attempt: attempt, elapsedMs: DateTime.now().millisecondsSinceEpoch - t0);
    } catch (e, st) {
      _tel?.publishFailed(
          trackKind: trackKind,
          attempt: attempt,
          elapsedMs: DateTime.now().millisecondsSinceEpoch - t0,
          failureCode: 'publish_sdp_failed');
      _tel?.error(stage: 'publish_sdp_failed', direction: 'publish', recoverable: attempt < 3, exception: e, stack: st);
      rethrow;
    }
  }

  // ---- signaling WS --------------------------------------------------------------

  void _joinConnectWs(CfJoinResult join, {required String route}) {
    final ticketAge = DateTime.now().millisecondsSinceEpoch - _ticketIssuedAtMs;
    _tel?.joinStarted(route: route, ticketAgeMs: ticketAge);
    _ws = WebSocketChannel.connect(Uri.parse(join.wsUrl));
    final generationAtOpen = _generation;
    _ws!.stream.listen(
      (raw) => _onWsMessage(raw, generationAtOpen),
      onError: (_) {
        if (!_ended) unawaited(_attemptReconnect(reason: 'socket_error'));
      },
      onDone: () {
        if (!_ended) unawaited(_attemptReconnect(reason: 'socket_closed'));
      },
    );
    _send({'t': 'hello'});
  }

  void _send(Map<String, dynamic> m) {
    try { _ws?.sink.add(jsonEncode(m)); } catch (_) {}
  }

  Future<void> _onWsMessage(dynamic raw, int generationAtOpen) async {
    if (generationAtOpen != _generation || _ended) return; // stale socket, ignore
    if (raw is! String) return;
    Map<String, dynamic> d;
    try { d = jsonDecode(raw) as Map<String, dynamic>; } catch (_) { return; }
    switch (d['t']) {
      case 'welcome':
        // The ticket uid the server actually assigned us — the ONLY correct
        // self identity. `_myId` is a random local placeholder and is never
        // equal to this; relying on it left self unfiltered from the roster
        // (self audio echo, duplicate self video tile, self as dominant
        // speaker, participantJoined firing for self).
        final you = d['you']?.toString();
        if (you != null && you.isNotEmpty) _selfUid = you;
        _applyRoster((d['roster'] as List?) ?? const []);
        break;
      case 'roster':
        _applyRoster((d['roster'] as List?) ?? const []);
        break;
      case 'speakers':
        final uids = ((d['uids'] as List?) ?? const [])
            .map((e) => e.toString())
            .where((u) => !_isSelf(u))
            .toList();
        _dominantSpeakerUid = uids.isNotEmpty ? uids.first : null;
        await _applyVideoSubscriptionPolicy();
        _safeNotify();
        break;
      case 'left':
        final uid = d['uid']?.toString();
        if (uid != null) {
          _roster.remove(uid);
          await _closePulled(uid);
          _tel?.participantLeft(subjectUid: uid, rosterSizeAfter: _roster.length, leaveReason: 'disconnected');
          _safeNotify();
        }
        break;
      case 'full':
        state = CfConnState.failed;
        statusText = d['reason']?.toString() ?? 'Call is full';
        _tel?.error(stage: 'capacity_rejected', direction: 'socket', recoverable: false);
        _safeNotify();
        await leave(reason: 'capacity_evicted');
        break;
    }
  }

  void _applyRoster(List<dynamic> raw) {
    final prevUids = _roster.keys.toSet();
    _roster.clear();
    for (final r in raw) {
      if (r is Map && r['uid'] != null) {
        final uid = r['uid'].toString();
        // Never insert self into the local roster — self is filtered here
        // once, at the source, so every consumer (screen participant count,
        // pull sites, video policy, telemetry) is automatically correct
        // without needing its own self-guard.
        if (_isSelf(uid)) continue;
        _roster[uid] = CfParticipant(
          uid: uid,
          session: r['session']?.toString() ?? '',
          audioTrack: r['audio_track']?.toString(),
          videoTrack: r['video_track']?.toString(),
          videoEnabled: r['video_enabled'] == true,
        );
      }
    }
    final nowUids = _roster.keys.toSet();
    for (final uid in nowUids.difference(prevUids)) {
      if (_isSelf(uid)) continue; // defense-in-depth; _roster never holds self
      _tel?.participantJoined(subjectUid: uid, rosterSizeAfter: _roster.length);
    }
    unawaited(_pullAudioForRoster());
    unawaited(_applyVideoSubscriptionPolicy());
    _safeNotify();
  }

  // Active-speaker audio pull (mirrors sfu_group_call_screen's fan-out, extended
  // to the ticket-authenticated pull contract).
  Future<void> _pullAudioForRoster() async {
    for (final p in _roster.values) {
      if (_isSelf(p.uid) || p.audioTrack == null || p.audioTrack!.isEmpty) continue;
      if (_pulledAudioMid.containsKey(p.uid)) continue;
      await _pullTrack(p, kind: 'audio', trackName: p.audioTrack!, qualityPolicy: 'high', reason: 'active_speaker_audio');
    }
  }

  // ---- [CF-CALL-004] video subscription/adaptation policy -----------------------
  //
  // - dominant speaker: high quality (rid passthrough where supported)
  // - visible grid tiles: low/medium
  // - off-screen tiles: stopped/downgraded
  // - simultaneous video subs capped at [maxVideoSubs] (device-class/viewport
  //   aware; caller sets this via the constructor). Never pulls every 25 videos
  //   at full quality — the Worker/DO also hard-cap at 12 regardless.
  void setVisibleTiles(Set<String> uids) {
    // The screen re-registers the visible set on every frame
    // (`addPostFrameCallback`), so without this guard an unchanged set still
    // re-runs the full pull/stop policy pass every frame.
    if (setEquals(_visibleUids, uids)) return;
    _visibleUids = uids;
    unawaited(_applyVideoSubscriptionPolicy());
  }

  Future<void> _applyVideoSubscriptionPolicy() async {
    if (!wantVideo || (_join?.mediaVideo ?? false) == false) return;
    final dominant = _dominantSpeakerUid;
    final wanted = <String>{
      if (dominant != null) dominant,
      ..._visibleUids,
    }..removeWhere(_isSelf);

    // Cap: dominant speaker always wins a slot; fill remaining slots with
    // visible tiles in roster order.
    final ordered = <String>[
      if (dominant != null && wanted.contains(dominant)) dominant,
      ..._visibleUids.where((u) => u != dominant && !_isSelf(u)),
    ];
    final capped = ordered.take(maxVideoSubs).toSet();

    // Stop/downgrade off-screen or over-cap tiles.
    final toStop = _pulledVideoMid.keys.where((u) => !capped.contains(u)).toList();
    for (final u in toStop) {
      await _closeVideoPull(u);
    }
    // Pull newly-visible tiles.
    for (final uid in capped) {
      if (_pulledVideoMid.containsKey(uid)) continue;
      final p = _roster[uid];
      if (p == null || p.videoTrack == null || !p.videoEnabled) continue;
      final quality = uid == dominant ? 'high' : 'low';
      final reason = uid == dominant ? 'dominant_speaker' : 'visible_grid_tile';
      await _pullTrack(p, kind: 'video', trackName: p.videoTrack!, qualityPolicy: quality, reason: reason,
          rid: uid == dominant ? null : 'q'); // low-quality simulcast rid hint, best-effort
    }
  }

  Future<void> _pullTrack(CfParticipant p, {
    required String kind,
    required String trackName,
    required String qualityPolicy,
    required String reason,
    String? rid,
    int attempt = 1,
  }) async {
    final join = _join;
    if (join == null || _pc == null) return;
    final generationAtStart = _generation;
    final op = _opQueue.then((_) => _pullInternal(
        p, kind: kind, trackName: trackName, qualityPolicy: qualityPolicy, reason: reason, rid: rid,
        attempt: attempt, generationAtStart: generationAtStart));
    _opQueue = op.catchError((_) {});
    return op;
  }

  Future<void> _pullInternal(CfParticipant p, {
    required String kind,
    required String trackName,
    required String qualityPolicy,
    required String reason,
    String? rid,
    required int attempt,
    required int generationAtStart,
  }) async {
    if (generationAtStart != _generation || _ended || _pc == null || _join == null) return;
    final t0 = DateTime.now().millisecondsSinceEpoch;
    _tel?.pullStarted(trackKind: kind, qualityPolicy: qualityPolicy, subscriptionReason: reason, attempt: attempt);
    try {
      final res = await CloudflareConferenceApi.pull(
        gid,
        sessionId: _join!.sessionId,
        remoteSessionId: p.session,
        remoteUid: p.uid,
        kind: kind,
        trackName: trackName,
        maxVideo: kind == 'video' ? maxVideoSubs : null,
        rid: rid,
        attempt: attempt,
      );
      if (generationAtStart != _generation || _ended) return;
      if (res.offer != null && res.renegotiate) {
        await _pc!.setRemoteDescription(RTCSessionDescription(res.offer!['sdp'].toString(), res.offer!['type'].toString()));
        final answer = await _pc!.createAnswer();
        await _pc!.setLocalDescription(answer);
        await CloudflareConferenceApi.renegotiate(gid, _join!.sessionId, answer.sdp ?? '');
      }
      final mid = res.tracks.isNotEmpty && res.tracks.first is Map ? res.tracks.first['mid']?.toString() : null;
      if (mid != null) {
        if (kind == 'video') { _pulledVideoMid[p.uid] = mid; } else { _pulledAudioMid[p.uid] = mid; }
      }
      _tel?.pullCompleted(trackKind: kind, attempt: attempt, elapsedMs: DateTime.now().millisecondsSinceEpoch - t0);
    } catch (e, st) {
      _tel?.pullFailed(
          trackKind: kind, attempt: attempt, elapsedMs: DateTime.now().millisecondsSinceEpoch - t0,
          failureCode: kind == 'video' ? 'pull_sdp_failed' : 'pull_sdp_failed');
      _tel?.error(stage: 'pull_sdp_failed', direction: 'pull', recoverable: attempt < 3, exception: e, stack: st, trackKind: kind);
    }
  }

  Future<void> _closeVideoPull(String uid) async {
    final mid = _pulledVideoMid.remove(uid);
    _remoteVideoRenderers.remove(uid)?.dispose();
    if (mid == null || _join == null) return;
    await CloudflareConferenceApi.close(gid, _join!.sessionId, [mid]);
  }

  Future<void> _closeAudioPull(String uid) async {
    final mid = _pulledAudioMid.remove(uid);
    if (mid == null || _join == null) return;
    await CloudflareConferenceApi.close(gid, _join!.sessionId, [mid]);
  }

  Future<void> _closePulled(String uid) async {
    await _closeAudioPull(uid);
    await _closeVideoPull(uid);
  }

  void _onRemoteVideoTrack(RTCTrackEvent e) {
    if (e.streams.isEmpty) return;
    // FOLLOW-UP 4: correlate by transceiver mid against the mid CF Realtime's
    // /pull response already gave us in `_pulledVideoMid[uid]`. The previous
    // `p.session == e.streams.first.id` check assumed CF Realtime echoes the
    // publisher's sessionId as the remote stream's msid — it does not; msid
    // is unrelated to sessionId for this transport, so that match essentially
    // never hit and silently fell through to the "first pending pull without
    // a renderer" fallback for every track. Mid is the value CF Realtime
    // actually correlates pulls by, so match on it first and keep the old
    // best-effort fallback only as a last resort for a mid CF didn't echo.
    final trackMid = e.transceiver?.mid;
    String? uid;
    if (trackMid != null) {
      for (final entry in _pulledVideoMid.entries) {
        if (entry.value == trackMid) { uid = entry.key; break; }
      }
    }
    // Last-resort fallback: first pending video-pull without a renderer yet.
    uid ??= _pulledVideoMid.keys.firstWhere((u) => !_remoteVideoRenderers.containsKey(u), orElse: () => '');
    if (uid.isEmpty) return;
    final resolvedUid = uid;
    final generationAtBind = _generation;
    // Dispose a pre-existing renderer for this uid before overwriting it
    // (FOLLOW-UP 6) — otherwise a re-pull (e.g. quality change) leaks the
    // old renderer's platform texture.
    final stale = _remoteVideoRenderers.remove(resolvedUid);
    if (stale != null) unawaited(stale.dispose());
    final renderer = RTCVideoRenderer();
    _tel?.rendererState(state: 'binding');
    renderer.initialize().then((_) {
      if (_ended || generationAtBind != _generation) { renderer.dispose(); return; }
      renderer.srcObject = e.streams.first;
      _remoteVideoRenderers[resolvedUid] = renderer;
      _tel?.rendererState(state: 'bound');
      _safeNotify();
    });
  }

  // ---- camera-off (WITHOUT a new session) ----------------------------------------

  Future<void> toggleCamera() async {
    if (!wantVideo) return;
    _cameraOn = !_cameraOn;
    for (final t in _localStream?.getVideoTracks() ?? const <MediaStreamTrack>[]) {
      t.enabled = _cameraOn;
    }
    // Camera-off = {kind:"video", trackName:null, enabled:false}: clears/disables
    // ONLY the video track; never touches audioTrack; never a new session/publish.
    _send({
      't': 'track',
      'kind': 'video',
      'trackName': _cameraOn ? 'video-${_join?.sessionId}' : null,
      'enabled': _cameraOn,
    });
    _safeNotify();
  }

  Future<void> toggleMute() async {
    _muted = !_muted;
    for (final t in _localStream?.getAudioTracks() ?? const <MediaStreamTrack>[]) {
      t.enabled = !_muted;
    }
    _safeNotify();
  }

  Future<void> toggleSpeaker() async {
    _speaker = !_speaker;
    if (RemoteConfig.callAudioControllerV2) {
      final r = await NativeVoiceAudio.instance.selectRoute(
        _speaker ? CallAudioRoute.speaker : CallAudioRoute.earpiece,
        source: 'user',
      );
      _speaker = r.active == CallAudioRoute.speaker;
      _tel?.routeState(activeRoute: r.active.name, routeConfirmed: true);
    } else {
      try { await Helper.setSpeakerphoneOn(_speaker); } catch (_) {}
    }
    _safeNotify();
  }

  Future<void> flipCamera() async {
    for (final t in _localStream?.getVideoTracks() ?? const <MediaStreamTrack>[]) {
      try { await Helper.switchCamera(t); } catch (_) {}
      return;
    }
  }

  // ---- reconnect: WS reconnect WITHOUT killing healthy media ---------------------

  bool _reconnecting = false;

  /// Bounded window (BLOCKER 2) for a pending-retire PC: if the new path
  /// never produces remote-media evidence (or `_publish` throws before it
  /// can), the old PC is force-closed anyway instead of leaking forever.
  static const Duration _pendingRetireTimeout = Duration(seconds: 5);

  void _armPendingRetireTimer() {
    _retireTimer?.cancel();
    _retireTimer = Timer(_pendingRetireTimeout, () {
      final pc = _pendingRetirePc;
      _pendingRetirePc = null;
      if (pc != null) unawaited(pc.close());
    });
  }

  void _retirePendingPcNow() {
    _retireTimer?.cancel();
    _retireTimer = null;
    final pc = _pendingRetirePc;
    _pendingRetirePc = null;
    if (pc != null) unawaited(pc.close());
  }

  Future<void> _attemptReconnect({required String reason, bool forceRecreate = false}) async {
    if (_ended || _reconnecting) return;
    _reconnecting = true;
    state = CfConnState.reconnecting;
    statusText = 'Reconnecting…';
    _safeNotify();
    final attemptId = const Uuid().v4();
    final ticketAge = DateTime.now().millisecondsSinceEpoch - _ticketIssuedAtMs;
    // Ticket TTL is 60s; if still fresh AND the PC itself is healthy, just
    // reopen the SAME socket/ticket — media (PC/tracks) is untouched
    // (media_kept_alive:true, pc_recreated:false). A PC-Failed reconnect
    // (forceRecreate:true) always takes the full rejoin/recreate path below,
    // even with a fresh ticket, because "fresh ticket" says nothing about
    // whether ICE/DTLS on the existing PC is still alive.
    final ticketFresh = !forceRecreate && ticketAge < 55000 && _join != null;
    _tel?.reconnectStarted(attemptId: attemptId, reason: reason, mediaKeptAlive: true);
    final t0 = DateTime.now().millisecondsSinceEpoch;
    try {
      if (ticketFresh) {
        _joinConnectWs(_join!, route: 'join');
        _tel?.reconnectCompleted(
            attemptId: attemptId, mediaKeptAlive: true,
            elapsedMs: DateTime.now().millisecondsSinceEpoch - t0, pcRecreated: false);
      } else {
        // Ticket expired (or PC Failed): mint a fresh ticket via /join,
        // reusing the existing PC — we only recreate the PC once the NEW
        // path has produced remote media evidence (a track event), never
        // eagerly. The old PC is held in `_pendingRetirePc`, a field (not a
        // local var), so it can never be silently forgotten: a bounded timer
        // force-closes it if remote media never shows up, the catch block
        // below closes it if `_publish` throws, and leave()/dispose() close
        // it as a last resort.
        _retirePendingPcNow(); // safety: retire any earlier still-pending PC first
        final rejoin = await CloudflareConferenceApi.join(gid, video: wantVideo);
        if (_ended) return;
        _pendingRetirePc = _pc;
        _armPendingRetireTimer();
        _join = rejoin;
        _ticketIssuedAtMs = DateTime.now().millisecondsSinceEpoch;
        _generation = rejoin.generation;
        // Mutate the existing telemetry instance's identity fields rather
        // than reallocating it (FOLLOW-UP 5) — a fresh instance would reset
        // the §0.5 error-dedup map, so a genuinely-repeating failure across a
        // reconnect would re-emit as a brand-new Issue instead of bumping
        // repeat_count on the same one.
        _tel?.callId = rejoin.callId;
        _tel?.callTraceId = rejoin.callTraceId;
        _tel?.generation = rejoin.generation;
        final newPc = await createPeerConnection({'iceServers': rejoin.iceServers, 'sdpSemantics': 'unified-plan'});
        final generationAtRecreate = _generation;
        // Wire the same Failed-state handler onto the recreated PC — without
        // this, a second ICE/DTLS failure after a rejoin would go completely
        // undetected (the old PC's handler is gone once it's closed/retired).
        newPc.onConnectionState = (s) {
          if (generationAtRecreate != _generation || _ended) return;
          if (s == RTCPeerConnectionState.RTCPeerConnectionStateFailed) {
            unawaited(_attemptReconnect(reason: 'pc_failed', forceRecreate: true));
          }
        };
        newPc.onTrack = (e) {
          if (generationAtRecreate != _generation || _ended) return;
          if (_pendingRetirePc != null) {
            // Evidence of remote media on the new path: safe to retire the old PC.
            _retirePendingPcNow();
          }
          if (e.track.kind == 'video') {
            _onRemoteVideoTrack(e);
          } else if (e.track.kind == 'audio') {
            AvaLog.I.log('cfconf', 'remote audio track bound (post-rejoin)');
          }
        };
        for (final t in _localStream?.getAudioTracks() ?? const <MediaStreamTrack>[]) {
          await newPc.addTrack(t, _localStream!);
        }
        if (_cameraOn) {
          for (final t in _localStream?.getVideoTracks() ?? const <MediaStreamTrack>[]) {
            await newPc.addTrack(t, _localStream!);
          }
        }
        _pc = newPc;
        final specs = <CfTrackSpec>[
          CfTrackSpec(mid: '0', kind: 'audio', trackName: 'audio-${rejoin.sessionId}'),
          if (_cameraOn) CfTrackSpec(mid: '1', kind: 'video', trackName: 'video-${rejoin.sessionId}'),
        ];
        await _publish(rejoin, specs, attempt: 1, generationAtStart: _generation);
        _joinConnectWs(rejoin, route: 'join');
        _tel?.reconnectCompleted(
            attemptId: attemptId, mediaKeptAlive: true,
            elapsedMs: DateTime.now().millisecondsSinceEpoch - t0, pcRecreated: true);
      }
      state = CfConnState.connected;
      statusText = 'Connected';
    } catch (e, st) {
      // `_publish` (or an earlier await) threw mid-rejoin: the old PC must
      // not leak just because the new path failed to complete.
      _retirePendingPcNow();
      _tel?.reconnectFailed(
          attemptId: attemptId, elapsedMs: DateTime.now().millisecondsSinceEpoch - t0,
          terminalReason: 'socket_reconnect_timeout');
      _tel?.error(stage: 'socket_reconnect_failed', direction: 'socket', recoverable: false, exception: e, stack: st);
      state = CfConnState.failed;
      statusText = 'Connection lost';
    } finally {
      _reconnecting = false;
      _safeNotify();
    }
  }

  // ---- media health sampler (mirrors call_session.dart's _pollPlayoutHealth) -----

  void _startHealthSampler() {
    _healthTimer?.cancel();
    _healthTimer = Timer.periodic(const Duration(seconds: 5), (_) => _pollMediaHealth());
  }

  Future<void> _pollMediaHealth() async {
    final pc = _pc;
    if (pc == null || _ended) return;
    try {
      final stats = await pc.getStats();
      int? audioBytes, videoFramesDecoded, playout;
      double? jitterSec, lossPct, concealment;
      for (final s in stats) {
        final v = s.values;
        if (s.type == 'inbound-rtp') {
          final kind = (v['kind'] ?? v['mediaType'])?.toString();
          if (kind == 'audio') {
            final b = v['bytesReceived'];
            if (b is num) audioBytes = b.toInt();
            final j = v['jitter'];
            if (j is num) jitterSec = j.toDouble();
            final jbe = v['jitterBufferEmittedCount'];
            if (jbe is num) playout = jbe.toInt();
            final cs = v['concealedSamples'];
            final tsr = v['totalSamplesReceived'];
            if (cs is num && tsr is num && tsr > 0) concealment = (cs / tsr) * 100;
            final pl = v['packetsLost'];
            final pr = v['packetsReceived'];
            if (pl is num && pr is num && (pl + pr) > 0) lossPct = (pl / (pl + pr)) * 100;
          } else if (kind == 'video') {
            final fd = v['framesDecoded'];
            if (fd is num) videoFramesDecoded = fd.toInt();
          }
        }
      }
      // Class distinguishes RTP receipt from decode/render/playout (contract §4.1).
      String cls = 'no_rtp';
      String invariant = 'local_capture_started';
      if (audioBytes != null && (_lastAudioBytes == null || audioBytes > _lastAudioBytes!)) {
        invariant = 'subscribe_progressing';
        cls = 'healthy';
        if (playout != null && (_lastPlayout == null || playout > _lastPlayout!)) {
          invariant = 'audio_playout_progressing';
        } else {
          cls = 'render_no_playout';
        }
      }
      if (_lastMediaHealthClass != cls) {
        _tel?.mediaHealth(
          trackKind: 'audio',
          cls: cls,
          fromClass: _lastMediaHealthClass,
          invariantReached: invariant,
          rtpBytesDelta: audioBytes != null && _lastAudioBytes != null ? audioBytes - _lastAudioBytes! : null,
          playoutDelta: playout != null && _lastPlayout != null ? playout - _lastPlayout! : null,
          concealmentPct: concealment,
          jitterMs: jitterSec != null ? jitterSec * 1000 : null,
          lossPct: lossPct,
        );
        _lastMediaHealthClass = cls;
      }
      if (wantVideo && videoFramesDecoded != null) {
        final decodeDelta = _lastVideoFrames != null ? videoFramesDecoded - _lastVideoFrames! : null;
        if (decodeDelta != null && decodeDelta > 0) {
          _tel?.mediaHealth(trackKind: 'video', cls: 'healthy', invariantReached: 'video_decode_progressing', decodeFramesDelta: decodeDelta);
        }
      }
      _lastAudioBytes = audioBytes ?? _lastAudioBytes;
      _lastVideoFrames = videoFramesDecoded ?? _lastVideoFrames;
      _lastPlayout = playout ?? _lastPlayout;
    } catch (_) {/* best-effort sampler */}
  }

  // ---- level reporting (mic level -> DO active-speaker computation) -------------

  static const double _localSpeechFloor = 0.04;
  void _startLevelReporting() {
    _levelTimer?.cancel();
    _tickLevel();
  }

  void _tickLevel() {
    if (_ended) return;
    void reschedule(double lvl) {
      if (_ended) return;
      final next = lvl >= _localSpeechFloor ? 250 : 500;
      _levelTimer = Timer(Duration(milliseconds: next), _tickLevel);
    }
    if (_pc == null || _muted) { _send({'t': 'level', 'v': 0}); reschedule(0); return; }
    _pc!.getStats().then((stats) {
      double level = 0;
      for (final r in stats) {
        final v = r.values['audioLevel'];
        if (v is num && r.type == 'media-source') level = v.toDouble();
      }
      _send({'t': 'level', 'v': level});
      reschedule(level);
    }).catchError((_) { reschedule(0); });
  }

  // ---- billing beat (acceptance-matrix "background/foreground") ------------------

  void _startBillingBeat() {
    _billingTimer?.cancel();
    _billingTimer = Timer.periodic(const Duration(seconds: 30), (_) {
      if (_ended) return;
      _billingBeatSeq++;
      _tel?.billingBeat(beatSeq: _billingBeatSeq, billedMsInterval: 30000);
    });
  }

  void onForegroundResume() {
    if (_ended) return;
    final drift = 0; // no server-authoritative counter wired client-side yet
    _tel?.billingReconciled(reconcileReason: 'foreground_resume', driftMs: drift);
    if (state != CfConnState.connected && !_reconnecting) {
      unawaited(_attemptReconnect(reason: 'app_foregrounded'));
    }
  }

  // ---- leave / dispose: deterministic order --------------------------------------
  // timers -> senders -> PC -> renderers -> streams

  Future<void> leave({String reason = 'voluntary'}) async {
    if (_ended) return;
    _ended = true;
    state = CfConnState.ended;
    final durationMs = _joinedAtMs > 0 ? DateTime.now().millisecondsSinceEpoch - _joinedAtMs : 0;

    _levelTimer?.cancel();
    _billingTimer?.cancel();
    _healthTimer?.cancel();
    _retireTimer?.cancel();
    _retireTimer = null;

    try {
      final senders = await _pc?.getSenders() ?? const [];
      for (final s in senders) { try { await _pc?.removeTrack(s); } catch (_) {} }
    } catch (_) {}

    try { _ws?.sink.close(); } catch (_) {}
    if (_join != null) {
      await CloudflareConferenceApi.close(gid, _join!.sessionId, const []);
    }
    try { await _pc?.close(); } catch (_) {}
    // Last-resort close for a still-pending retired PC (BLOCKER 2): normally
    // already closed by the bounded timer or by remote-media evidence, but
    // guard the case where leave() races the rejoin flow.
    try { await _pendingRetirePc?.close(); } catch (_) {}
    _pendingRetirePc = null;

    for (final r in _remoteVideoRenderers.values) { try { r.dispose(); } catch (_) {} }
    _remoteVideoRenderers.clear();
    if (_localRendererReady) { try { localRenderer.srcObject = null; localRenderer.dispose(); } catch (_) {} }

    try {
      for (final t in _localStream?.getTracks() ?? const <MediaStreamTrack>[]) { await t.stop(); }
    } catch (_) {}
    try { await _localStream?.dispose(); } catch (_) {}

    if (RemoteConfig.callAudioControllerV2 && _join != null) {
      try { await NativeVoiceAudio.instance.endP2pSession(callId: _join!.callId); } catch (_) {}
    }

    _tel?.conferenceLeft(leaveReason: reason, sessionDurationMs: durationMs, finalMediaHealthClass: _lastMediaHealthClass);
    Analytics.capture('groupcall_leave_cf', {'gid_hash': gid.hashCode.toString(), 'duration_ms': durationMs});
    if (activeGid == gid) activeGid = null;
    _safeNotify();
  }

  void _safeNotify() {
    if (_disposed) return;
    notifyListeners();
  }

  @override
  void dispose() {
    if (!_ended) unawaited(leave(reason: 'dispose'));
    _disposed = true;
    super.dispose();
  }
}
