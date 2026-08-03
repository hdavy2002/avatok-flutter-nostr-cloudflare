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

import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:uuid/uuid.dart';
import 'package:wakelock_plus/wakelock_plus.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import '../../core/analytics.dart';
import '../../core/audio_tuning.dart';
import '../../core/ava_log.dart';
import '../../core/call_log_store.dart'; // [GCALL-W4-LOG]
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
  /// [GCALL-W4-MUTE] Server-known mute state. The UI used to infer "muted" from
  /// `audioTrack == null`, which is only ever true BEFORE someone's first
  /// publish — so everyone permanently looked unmuted no matter what they did.
  final bool muted;
  const CfParticipant({
    required this.uid,
    required this.session,
    required this.audioTrack,
    required this.videoTrack,
    required this.videoEnabled,
    this.muted = false,
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
  /// Group name — shown on the ongoing-call notification the foreground
  /// service posts. Without it the notification cannot say which call it is.
  final String title;
  final bool wantVideo;
  final bool starter;
  final int maxVideoSubs;
  /// Optional call-owned capture source. Migration/warm-up paths pass the
  /// existing 1:1 source here so joining the SFU never prompts for a second
  /// microphone or reconfigures the active capturer.
  final MediaStream? sharedLocalStream;

  CloudflareConferenceController({
    required this.gid,
    required this.wantVideo,
    required this.starter,
    this.title = 'Group call',
    this.maxVideoSubs = kDefaultMaxVideoSubs,
    this.sharedLocalStream,
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
  bool _ownsLocalStream = false;
  WebSocketChannel? _ws;
  StreamSubscription<dynamic>? _wsSub;
  int _wsEpoch = 0;
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
  Set<String> _activeAudioUids = {};
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

  // ---- [GCALL-W1-EFFMEDIA] effective vs requested media --------------------------
  //
  // `wantVideo` is the REQUEST, not the truth. Two things can downgrade a video
  // call to audio-only after the user has asked for video:
  //   1. the camera permission is denied while the mic is granted, and
  //   2. the server says `media.video:false` because the call's media_kind was
  //      fixed to `audio` by whoever started it.
  // Both used to be fatal: the controller published video regardless, and the
  // Worker rejected the WHOLE publish (not just the camera), failing the entire
  // join. `_effectiveVideo` is what the controller actually does, and it is what
  // drives capture, publish, reconnect, the camera controls and the pull policy.
  bool _effectiveVideo = false;
  bool get effectiveVideo => _effectiveVideo;

  /// Non-fatal condition worth showing the user (camera downgrade, degraded
  /// relay). Cleared by the screen once shown; never blocks the call.
  String? notice;

  /// True when the join was refused for a missing OS permission, so the screen
  /// can offer an "Open settings" action instead of a dead-end error.
  bool permissionDenied = false;

  /// Cloudflare reported no usable TURN relay for this join — media may still
  /// work over STUN/host candidates, but quality/connectivity is at risk.
  bool relayDegraded = false;

  // ---- [GCALL-TEL] queryable group-call telemetry ---------------------------------
  //
  // `CloudflareConferenceTelemetry` implements the formal contract (hashed ids,
  // strict event names) and is the right tool for funnel analysis. This helper
  // is the OTHER thing you need at 2am: a plain event you can find in PostHog by
  // a tester's email without knowing the contract. Analytics._base already
  // stamps email + phone on every event, so one of these is retrievable by
  // whoever's phone it came from — which is the whole point when several testers
  // are on different devices and a call bug is a conversation between two of them.
  void _ev(String name, [Map<String, Object> extra = const {}]) {
    Analytics.capture(name, {
      'gid_hash': gid.hashCode.toString(),
      'call_id': _join?.callId ?? 'pending',
      'generation': _generation,
      'role': starter ? 'starter' : 'joiner',
      'media_requested': wantVideo ? 'audio_video' : 'audio',
      'media_effective': _effectiveVideo ? 'audio_video' : 'audio',
      'participants': _roster.length + 1,
      'state': state.name,
      ...extra,
    });
  }

  bool get muted => _muted;
  bool get cameraOn => _cameraOn;
  bool get speakerOn => _speaker;
  List<CfParticipant> get roster => _roster.values.toList(growable: false);
  RTCVideoRenderer? rendererFor(String uid) => _remoteVideoRenderers[uid];
  String? get dominantSpeakerUid => _dominantSpeakerUid;
  bool get hasMediaEvidence => state == CfConnState.connected && (_lastAudioBytes != null || _lastVideoFrames != null);

  // ---- lifecycle ---------------------------------------------------------------

  /// [GCALL-W1-ORDER] Join sequence. The ORDER here is the whole feature:
  ///
  ///   permissions -> /join -> WS open -> **await `welcome`** -> publish
  ///
  /// It used to be `/join` -> publish -> WS (fire-and-forget). The Worker
  /// refuses `/publish` unless the caller's socket is already attached to the
  /// GroupCallRoom DO (`session_check` -> 409 "not connected to this call"), so
  /// publishing first failed 100% of the time — for every user, on every
  /// attempt, since the feature shipped. Opening the socket is not enough
  /// either: the attachment only exists once the DO has accepted the upgrade,
  /// which the `welcome` frame is the proof of. Hence the awaited handshake.
  Future<void> connect() async {
    final t0 = DateTime.now().millisecondsSinceEpoch;
    activeGid = gid;
    // [GCALL-W1-TEL] Telemetry exists BEFORE the first network call. It was
    // previously constructed after /join returned, so a failing /join emitted
    // nothing at all client-side — the one stage most likely to fail was the
    // one stage that was invisible. The constructor needs a call identity that
    // only /join can supply, so it starts with a placeholder and the identity
    // fields are mutated in place once /join answers. Never reallocate the
    // instance: a fresh one resets the §0.5 error-dedup map.
    _tel = CloudflareConferenceTelemetry(
      groupId: gid,
      callId: 'pending',
      callTraceId: 'pending',
      generation: 0,
      mediaKindRequested: wantVideo ? 'audio_video' : 'audio',
    );
    try {
      await localRenderer.initialize();
      _localRendererReady = true;

      CloudflareConferenceTelemetry.providerSelected(
        groupId: gid,
        decidedProvider: RemoteConfig.cloudflareConferenceEnabled ? 'cloudflare_realtime' : 'disabled',
        cloudflareEnabled: RemoteConfig.cloudflareConferenceEnabled,
        mediaKindRequested: wantVideo ? 'audio_video' : 'audio',
      );

      // 1. Permissions FIRST. Asking after /join meant a denial arrived once the
      //    Worker had already minted an SFU session, an authority and a ticket —
      //    so saying "no" to a prompt wedged the room for everyone.
      final perm = await _preflightPermissions();
      if (!perm.mic) {
        permissionDenied = true;
        _ev('groupcall_failed', {'stage': 'permission_denied', 'denied': 'microphone'});
        _tel?.error(stage: 'permission_denied', direction: 'ticket', recoverable: false);
        state = CfConnState.failed;
        statusText = 'AvaTOK needs microphone access to join a call.';
        _safeNotify();
        return;
      }
      _effectiveVideo = wantVideo && perm.camera;
      if (wantVideo && !perm.camera) {
        // Camera denied, mic granted: join audio-only rather than failing. The
        // single combined getUserMedia used to kill audio along with video.
        notice = 'Camera access is off — joining with audio only.';
        _ev('groupcall_media_downgraded', {'reason': 'camera_permission_denied'});
        _tel?.error(stage: 'camera_permission_downgrade', direction: 'publish', recoverable: true);
      }

      // 2. /join.
      final join = await CloudflareConferenceApi.join(gid, video: _effectiveVideo);
      _join = join;
      _ticketIssuedAtMs = DateTime.now().millisecondsSinceEpoch;
      _generation = join.generation;
      _tel?.callId = join.callId;
      _tel?.callTraceId = join.callTraceId;
      _tel?.generation = join.generation;

      // The call's media_kind is owned by whoever started it. Honour it: a video
      // publish into an audio call is rejected wholesale by the Worker.
      if (!join.mediaVideo && _effectiveVideo) {
        _effectiveVideo = false;
        notice = 'This is an audio call — your camera stays off.';
        _ev('groupcall_media_downgraded', {'reason': 'call_is_audio_only'});
      }
      relayDegraded = join.relayDegraded;
      // Cloudflare Realtime normally works without TURN, so a degraded relay is
      // not automatically a problem — it only bites on restrictive networks.
      // Word it as the caveat it is rather than an alarm.
      if (relayDegraded) notice = 'No relay server available — the call may not connect on a restricted network.';

      // [GCALL-W2-HOLD] Hold the process and the screen for the duration of the
      // call. Neither wakelock_plus nor CallForegroundService was used anywhere
      // in features/conference, though 1:1 calls use both: the screen slept
      // mid-call, and on Android a backgrounded conference had nothing keeping
      // the process alive, so mic capture and the call were subject to
      // background kill with no notification to get back. Started here, right
      // after /join, because that is the first moment a real call id exists.
      await _startForegroundHold(join);
      _startNetworkWatch();
      _startInterruptionWatch();

      // 3. WS open + awaited `welcome` — the DO attachment publish depends on.
      await _joinConnectWs(join, route: 'join');

      // 4. Capture and publish, now that the server will accept it.
      await _createPcAndPublish(join, generationAtStart: _generation);

      _startLevelReporting();
      _startBillingBeat();
      _startHealthSampler();
      _joinedAtMs = DateTime.now().millisecondsSinceEpoch;
      state = CfConnState.connected;
      statusText = 'Connected';
      _ev('groupcall_connected', {
        'elapsed_ms': DateTime.now().millisecondsSinceEpoch - t0,
        'relay_degraded': relayDegraded,
      });
      _tel?.joined(elapsedMs: DateTime.now().millisecondsSinceEpoch - t0, rosterSizeOnJoin: _roster.length);
      _safeNotify();
    } catch (e, st) {
      AvaLog.I.log('cfconf', 'connect failed: $e');
      // The single most useful row when someone says "group calls don't work":
      // which STAGE failed, on whose phone, with the server's own words.
      _ev('groupcall_failed', {
        'stage': e is TimeoutException ? 'welcome_timeout' : 'join_or_publish',
        'elapsed_ms': DateTime.now().millisecondsSinceEpoch - t0,
        'error': e.toString().length > 200 ? e.toString().substring(0, 200) : e.toString(),
        'http_status': e is CloudflareConferenceException ? e.status : -1,
      });
      _tel?.error(stage: 'session_create_failed', direction: 'ticket', recoverable: false, exception: e, stack: st);
      state = CfConnState.failed;
      // Show what the server actually said. Rendering every failure as one
      // generic line is why "calls are switched off", "this group is too big"
      // and "the call ended" were indistinguishable to the person holding the
      // phone — and to whoever they reported it to.
      statusText = _userFacingError(e);
      _safeNotify();
    }
  }

  String _userFacingError(Object e) {
    if (e is CloudflareConferenceException) {
      final m = e.message.trim();
      if (m.isNotEmpty && !m.startsWith('Group call error')) {
        return m.substring(0, 1).toUpperCase() + m.substring(1);
      }
      if (e.status == 503) return 'Group calls are temporarily unavailable.';
      if (e.status == 403) return 'You can\'t join this call.';
      if (e.status == 409) return 'This call is full.';
    }
    if (e is TimeoutException) return 'The call server didn\'t respond. Check your connection and try again.';
    return 'Could not join the call';
  }

  // ---- [GCALL-W2-HOLD] process + screen hold ------------------------------------

  bool _holdStarted = false;

  Future<void> _startForegroundHold(CfJoinResult join) async {
    if (_holdStarted || _ended) return;
    _holdStarted = true;
    try { await WakelockPlus.enable(); } catch (_) {/* unsupported platform */}
    try {
      await NativeVoiceAudio.instance.startCallForegroundService(
        callId: join.callId,
        peerName: title,
        isVideo: _effectiveVideo,
        at: 'conference_join',
      );
    } catch (_) {/* never let the notification block the call */}
  }

  Future<void> _stopForegroundHold(String reason) async {
    if (!_holdStarted) return;
    _holdStarted = false;
    try { await WakelockPlus.disable(); } catch (_) {}
    try { await NativeVoiceAudio.instance.stopCallForegroundService(reason: reason); } catch (_) {}
  }

  // ---- [GCALL-W2-NET] network-change recovery -----------------------------------

  StreamSubscription<dynamic>? _netSub;

  /// A WiFi→cellular switch used to be detected only when the peer connection
  /// finally gave up — 15-30 seconds of dead audio before anything happened.
  /// Watch the network directly, but do NOT recover on the event alone: a
  /// connectivity change proves the network CLASS changed, not that media
  /// broke. Take one health sample first and act only if it is actually
  /// unhealthy, mirroring how 1:1 calls gate their recovery.
  ///
  /// NOTE: this triggers a targeted reconnect, not an ICE restart. Cloudflare
  /// Realtime's renegotiate contract is server-offers / client-answers (see
  /// developers.cloudflare.com/realtime/sfu/https-api), so there is no
  /// client-initiated re-offer to carry `iceRestart` on this transport the way
  /// there is for the 1:1 P2P path. Adding one would be a Worker contract
  /// change, deliberately not smuggled into this wave.
  void _startNetworkWatch() {
    _netSub ??= Connectivity().onConnectivityChanged.listen((_) {
      if (_ended || _reconnecting || state != CfConnState.connected) return;
      _tel?.error(stage: 'network_changed', direction: 'socket', recoverable: true);
      unawaited(_pollMediaHealth().then((_) {
        if (_ended || _reconnecting || state != CfConnState.connected) return;
        // Only meaningful if we are actually subscribed to someone. A call you
        // are alone in has no inbound RTP by definition, so it always reads
        // `no_rtp` — without this guard every network blip in a one-person call
        // would tear down and rebuild a perfectly healthy session.
        final expectingMedia = _pulledAudioMid.isNotEmpty || _pulledVideoMid.isNotEmpty;
        final unhealthy = expectingMedia &&
            (_lastMediaHealthClass == 'no_rtp' || _lastMediaHealthClass == 'render_no_playout');
        _ev('groupcall_network_changed', {
          'health': _lastMediaHealthClass,
          'acted': unhealthy,
          'expecting_media': expectingMedia,
        });
        if (unhealthy) {
          _reconnectTry = 0;
          unawaited(_attemptReconnect(reason: 'network_changed', forceRecreate: true));
        }
      }));
    });
  }

  // ---- [GCALL-W4-INTERRUPT] GSM calls and audio-focus loss ------------------------

  StreamSubscription<Map<String, dynamic>>? _telephonySub;
  bool _heldByPhone = false;
  bool _heldByFocus = false;

  /// A cellular call, or anything else that steals audio focus, takes the
  /// microphone away. 1:1 calls have handled this since CALLFIX-23; the
  /// conference subscribed to neither stream, so a GSM call silently took the
  /// mic and the conference carried on "publishing" silence with no hold state
  /// and nothing to tell the other participants.
  void _startInterruptionWatch() {
    if (!NativeVoiceAudio.isSupported) return;
    try {
      NativeVoiceAudio.instance.onAudioFocusLost = () {
        if (_ended) return;
        _heldByFocus = true;
        _ev('groupcall_interrupted', {'source': 'audio_focus', 'phase': 'held'});
        unawaited(_setMuted(true, source: 'audio_focus_lost'));
        notice = 'Paused — another app took the microphone.';
        _safeNotify();
      };
      NativeVoiceAudio.instance.onAudioFocusRegained = () {
        if (_ended) return;
        _heldByFocus = false;
        if (!_heldByPhone) {
          unawaited(_setMuted(false, source: 'audio_focus_regained'));
          notice = null;
          _safeNotify();
        }
      };
      unawaited(NativeVoiceAudio.instance.startTelephonyMonitoring());
      _telephonySub = NativeVoiceAudio.instance.telephonyEventStream.listen((e) {
        if (_ended) return;
        final state = (e['state'] ?? '').toString();
        if (state == 'held') {
          _heldByPhone = true;
          _ev('groupcall_interrupted', {'source': 'cellular', 'phase': 'held'});
          unawaited(_setMuted(true, source: 'cellular_hold'));
          notice = 'On hold — you have a phone call.';
          _safeNotify();
        } else if (state == 'resumed') {
          _heldByPhone = false;
          _ev('groupcall_interrupted', {'source': 'cellular', 'phase': 'resumed'});
          if (!_heldByFocus) {
            unawaited(_setMuted(false, source: 'cellular_resume'));
            notice = null;
            _safeNotify();
          }
        }
      });
    } catch (e) {
      AvaLog.I.log('cfconf', 'interruption watch unavailable: $e');
    }
  }

  void _stopInterruptionWatch() {
    unawaited(_telephonySub?.cancel());
    _telephonySub = null;
    try {
      NativeVoiceAudio.instance.onAudioFocusLost = null;
      NativeVoiceAudio.instance.onAudioFocusRegained = null;
    } catch (_) {/* already torn down */}
  }

  /// The app went to the background. The foreground service keeps the call
  /// alive, so this does NOT leave — it only records the transition. Before
  /// [GCALL-W2-HOLD] there was no lifecycle handling beyond `resumed` at all,
  /// so backgrounding neither left cleanly nor survived: the user simply became
  /// a ghost in everyone else's roster until the sweep evicted them.
  void onBackgrounded() {
    if (_ended) return;
    _tel?.error(stage: 'app_backgrounded', direction: 'socket', recoverable: true);
  }

  /// [GCALL-W1-PERM] Ask for exactly what this call needs, before any server
  /// state exists. An audio call asks for the microphone ONLY — it previously
  /// demanded the camera too, via a combined `getUserMedia`, so joining an
  /// audio call prompted for a camera the call would never use.
  Future<({bool mic, bool camera})> _preflightPermissions() async {
    // A shared capture source (1:1 hand-off / warm-up) is already permitted and
    // running; re-requesting would prompt again for no reason.
    if (sharedLocalStream != null) return (mic: true, camera: wantVideo);
    try {
      final wanted = <Permission>[Permission.microphone, if (wantVideo) Permission.camera];
      final res = await wanted.request();
      return (
        mic: res[Permission.microphone]?.isGranted ?? false,
        camera: wantVideo && (res[Permission.camera]?.isGranted ?? false),
      );
    } catch (e) {
      // Platform without permission_handler support: fall through and let
      // getUserMedia be the gate, exactly as before this change.
      AvaLog.I.log('cfconf', 'permission preflight unavailable: $e');
      return (mic: true, camera: wantVideo);
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

    _localStream = sharedLocalStream ?? await navigator.mediaDevices.getUserMedia({
      'audio': avaMicConstraints(),
      'video': _effectiveVideo
          ? {
              'facingMode': 'user',
              'width': {'ideal': 640},
              'height': {'ideal': 360},
              'frameRate': {'ideal': 24, 'max': 30},
            }
          : false,
    });
    _ownsLocalStream = sharedLocalStream == null;
    // Validate live tracks before publishing (Phase 3 requirement).
    final audioTracks = _localStream!.getAudioTracks();
    if (audioTracks.isEmpty || !audioTracks.first.enabled) {
      throw StateError('local audio capture failed');
    }
    _cameraOn = _effectiveVideo && _localStream!.getVideoTracks().isNotEmpty;
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
    _announcePublishedTracks(join);
  }

  /// [GCALL-W1-TRACKFRAME] Tell the DO which track names we just published.
  ///
  /// The DO learns a member's `audioTrack`/`videoTrack` ONLY from this frame —
  /// it is what populates the roster other clients pull from, and
  /// `/authority/pull` rejects a pull with 403 "publisher is not publishing
  /// that track" when it is missing. The controller only ever sent this frame
  /// from `toggleCamera`, never after the initial publish, so every roster
  /// entry carried `audio_track: null`. That was invisible while the join
  /// itself could not complete; with the ordering fixed it would have been the
  /// next wall — a call that connects and stays permanently silent.
  void _announcePublishedTracks(CfJoinResult join) {
    _send({'t': 'track', 'kind': 'audio', 'trackName': 'audio-${join.sessionId}', 'enabled': true});
    if (_cameraOn) {
      _send({'t': 'track', 'kind': 'video', 'trackName': 'video-${join.sessionId}', 'enabled': true});
    }
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

  // ---- [GCALL-W1-ORDER] awaited `welcome` handshake -------------------------------
  //
  // The completer is keyed to `_wsEpoch`, NOT to the generation: a fresh join
  // may reuse the same generation value the previous socket ran under (the same
  // reason `_joinConnectWs` already retires the old subscription by epoch), so
  // a `welcome` left over from a superseded socket could otherwise satisfy the
  // wait of a brand-new one and let it publish against an attachment that does
  // not exist.
  Completer<void>? _welcomeCompleter;
  int _welcomeEpoch = 0;
  static const Duration _welcomeTimeout = Duration(seconds: 10);

  void _completeWelcome(int epoch) {
    if (epoch != _welcomeEpoch) return;
    final c = _welcomeCompleter;
    if (c != null && !c.isCompleted) c.complete();
  }

  void _failWelcome(int epoch, Object error) {
    if (epoch != _welcomeEpoch) return;
    final c = _welcomeCompleter;
    if (c != null && !c.isCompleted) c.completeError(error);
  }

  /// Opens the signalling socket and resolves only once the DO has answered
  /// with `welcome` — i.e. once this device is genuinely attached to the call.
  /// Throws on socket error/close, a `full` rejection, or timeout.
  Future<void> _joinConnectWs(CfJoinResult join, {required String route}) async {
    final ticketAge = DateTime.now().millisecondsSinceEpoch - _ticketIssuedAtMs;
    _tel?.joinStarted(route: route, ticketAgeMs: ticketAge);
    // A rejoin can happen while the previous socket is still delivering its
    // close/error callback. Retire both the stream and the channel before
    // publishing the replacement; generation alone is insufficient because a
    // fresh join may reuse the same generation value from the server.
    final oldSub = _wsSub;
    _wsSub = null;
    unawaited(oldSub?.cancel());
    try { _ws?.sink.close(); } catch (_) {}

    final wsEpoch = ++_wsEpoch;
    final completer = Completer<void>();
    _welcomeCompleter = completer;
    _welcomeEpoch = wsEpoch;
    // A late completeError with no listener left (e.g. after the timeout below
    // has already thrown) would surface as an unhandled async error.
    unawaited(completer.future.catchError((_) {}));

    final ws = WebSocketChannel.connect(Uri.parse(join.wsUrl));
    _ws = ws;
    final generationAtOpen = _generation;
    final sub = ws.stream.listen(
      (raw) => _onWsMessage(raw, generationAtOpen, wsEpoch),
      onError: (e) {
        _failWelcome(wsEpoch, StateError('signalling socket error: $e'));
        if (wsEpoch == _wsEpoch && !_ended) unawaited(_attemptReconnect(reason: 'socket_error'));
      },
      onDone: () {
        _failWelcome(wsEpoch, StateError('signalling socket closed before handshake'));
        if (wsEpoch == _wsEpoch && !_ended) unawaited(_attemptReconnect(reason: 'socket_closed'));
      },
    );
    _wsSub = sub;
    _send({'t': 'hello'});

    await completer.future.timeout(_welcomeTimeout, onTimeout: () {
      _tel?.error(stage: 'welcome_timeout', direction: 'socket', recoverable: true);
      throw TimeoutException('call server did not confirm the join', _welcomeTimeout);
    });
  }

  void _send(Map<String, dynamic> m) {
    try { _ws?.sink.add(jsonEncode(m)); } catch (_) {}
  }

  Future<void> _onWsMessage(dynamic raw, int generationAtOpen, int wsEpoch) async {
    if (wsEpoch != _wsEpoch) return; // superseded socket, ignore
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
        // The DO has accepted the upgrade and our attachment exists — this, and
        // only this, is what makes a /publish legal.
        _completeWelcome(wsEpoch);
        break;
      case 'roster':
        _applyRoster((d['roster'] as List?) ?? const []);
        break;
      case 'speakers':
        final uids = ((d['uids'] as List?) ?? const [])
            .map((e) => e.toString())
            .where((u) => !_isSelf(u))
            .toList();
        _activeAudioUids = uids.take(6).toSet();
        _dominantSpeakerUid = uids.isNotEmpty ? uids.first : null;
        unawaited(_applyAudioSubscriptionPolicy());
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
        _failWelcome(wsEpoch, StateError(statusText));
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
          muted: r['muted'] == true,
        );
      }
    }
    final nowUids = _roster.keys.toSet();
    for (final uid in nowUids.difference(prevUids)) {
      if (_isSelf(uid)) continue; // defense-in-depth; _roster never holds self
      _tel?.participantJoined(subjectUid: uid, rosterSizeAfter: _roster.length);
    }
    unawaited(_applyAudioSubscriptionPolicy());
    unawaited(_applyVideoSubscriptionPolicy());
    _safeNotify();
  }

  // Audio subscriptions follow the server's debounced loudest-speaker set.
  // The old implementation pulled every roster member until the server's cap
  // rejected the rest, making roster order decide who could be heard.
  // [GCALL-W4-CLIP] How long an audio pull is kept open after its owner drops
  // out of the active-speaker set. Closing immediately is why the first word
  // after someone unmutes (or after a pause) was clipped: the pull had already
  // been torn down, so speaking again cost a full pull + renegotiate round trip
  // before anyone heard them. Holding the subscription briefly costs one idle
  // audio stream and removes the clipping entirely.
  static const Duration _audioPullLinger = Duration(seconds: 20);
  final Map<String, DateTime> _audioIdleSince = {};

  Future<void> _applyAudioSubscriptionPolicy() async {
    final wanted = _activeAudioUids.where((uid) {
      final p = _roster[uid];
      return p != null && p.audioTrack != null && p.audioTrack!.isNotEmpty;
    }).toSet();
    final now = DateTime.now();
    for (final uid in _pulledAudioMid.keys.toList()) {
      if (wanted.contains(uid)) { _audioIdleSince.remove(uid); continue; }
      // Someone who has LEFT the call is dropped at once — the linger is for
      // people who merely stopped talking, not for people who aren't there.
      final stillHere = _roster.containsKey(uid);
      final since = _audioIdleSince[uid] ??= now;
      if (stillHere && now.difference(since) < _audioPullLinger) continue;
      _audioIdleSince.remove(uid);
      await _closeAudioPull(uid);
    }
    for (final uid in wanted) {
      if (_pulledAudioMid.containsKey(uid)) continue;
      final p = _roster[uid];
      if (p == null || p.audioTrack == null) continue;
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
    if (!_effectiveVideo || (_join?.mediaVideo ?? false) == false) return;
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
    // Gate on the EFFECTIVE mode: `wantVideo` is only what was asked for, and a
    // camera-denied or audio-only call has no video sender to toggle.
    if (!_effectiveVideo) return;
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
    await _setMuted(!_muted, source: 'user');
  }

  /// [GCALL-W4-MUTE] Mute is now announced. It used to be purely local — no
  /// frame, no roster field — so nobody else could tell, and people talked over
  /// each other believing they were being heard.
  Future<void> _setMuted(bool value, {required String source}) async {
    if (_muted == value) return;
    _muted = value;
    for (final t in _localStream?.getAudioTracks() ?? const <MediaStreamTrack>[]) {
      t.enabled = !_muted;
    }
    _send({'t': 'mute', 'muted': _muted});
    Analytics.capture('groupcall_mute_toggled', {
      'gid_hash': gid.hashCode.toString(), 'muted': _muted, 'source': source,
    });
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

  // [GCALL-W1-RETRY] Bounded reconnect retry. Recovery used to be ONE shot: a
  // WiFi→cellular switch or a brief tunnel fires the single attempt while the
  // network is still down, it fails, and the call is declared dead — with the
  // user looking at a frozen screen. Three attempts over ~14s covers the
  // ordinary blips. A connectivity listener and ICE restart (both of which 1:1
  // calls already have) remain Wave 2; this is the minimum that makes the
  // corrected rejoin path reachable at all.
  static const List<int> _reconnectBackoffSec = [2, 4, 8];
  int _reconnectTry = 0;
  Timer? _reconnectRetryTimer;

  Future<void> _attemptReconnect({required String reason, bool forceRecreate = false}) async {
    if (_ended || _reconnecting) return;
    _reconnectRetryTimer?.cancel();
    _reconnectRetryTimer = null;
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
      // The fast path is tried first, but it is NOT allowed to silently succeed
      // without a handshake: `/rejoin` only mints a ticket for a session whose
      // DO attachment still exists, and that attachment can lose the race with
      // its own close event. If the awaited `welcome` doesn't arrive, fall
      // through to the full join (which mints a brand-new SFU session) rather
      // than reporting Connected over a socket the DO never accepted.
      var fastPathDone = false;
      if (ticketFresh) {
        try {
          // Ticket nonces are consumed by the DO on websocket upgrade. Mint a
          // fresh ticket for every reconnect while keeping the media PC alive.
          final refreshed = await CloudflareConferenceApi.rejoin(gid, sessionId: _join!.sessionId);
          _join = refreshed;
          _ticketIssuedAtMs = DateTime.now().millisecondsSinceEpoch;
          _generation = refreshed.generation;
          await _joinConnectWs(refreshed, route: 'rejoin');
          _announcePublishedTracks(refreshed);
          fastPathDone = true;
          _tel?.reconnectCompleted(
              attemptId: attemptId, mediaKeptAlive: true,
              elapsedMs: DateTime.now().millisecondsSinceEpoch - t0, pcRecreated: false);
        } catch (e) {
          AvaLog.I.log('cfconf', 'fast rejoin failed, falling back to full join: $e');
          _tel?.error(stage: 'rejoin_fastpath_failed', direction: 'socket', recoverable: true, exception: e);
        }
      }
      if (!fastPathDone) {
        // Ticket expired (or PC Failed): mint a fresh ticket via /join,
        // reusing the existing PC — we only recreate the PC once the NEW
        // path has produced remote media evidence (a track event), never
        // eagerly. The old PC is held in `_pendingRetirePc`, a field (not a
        // local var), so it can never be silently forgotten: a bounded timer
        // force-closes it if remote media never shows up, the catch block
        // below closes it if `_publish` throws, and leave()/dispose() close
        // it as a last resort.
        _retirePendingPcNow(); // safety: retire any earlier still-pending PC first
        // [GCALL-W2-CLOSE] Capture what the OUTGOING session holds before the
        // new one replaces it, so it can be retired instead of abandoned.
        final oldSessionId = _join?.sessionId;
        final oldMids = _join == null ? const <String>[] : _openMids();
        // Re-join with the EFFECTIVE media mode, not the original request: after
        // an audio-downgraded join (camera denied, or an audio-only call), a
        // reconnect that re-requested video would walk straight back into the
        // publish rejection this wave exists to remove.
        final rejoin = await CloudflareConferenceApi.join(gid, video: _effectiveVideo);
        if (_ended) return;
        if (!rejoin.mediaVideo && _effectiveVideo) _effectiveVideo = false;
        relayDegraded = rejoin.relayDegraded;
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
        _cameraOn = _cameraOn && _effectiveVideo;
        final specs = <CfTrackSpec>[
          CfTrackSpec(mid: '0', kind: 'audio', trackName: 'audio-${rejoin.sessionId}'),
          if (_cameraOn) CfTrackSpec(mid: '1', kind: 'video', trackName: 'video-${rejoin.sessionId}'),
        ];
        // [GCALL-W1-ORDER] Same defect, second site: this branch published
        // BEFORE opening the socket, so every PC-failure and ticket-expiry
        // reconnect 409'd exactly like the original join did. Socket and
        // handshake first, publish second.
        await _joinConnectWs(rejoin, route: 'join');
        await _publish(rejoin, specs, attempt: 1, generationAtStart: _generation);
        _announcePublishedTracks(rejoin);
        // The new path is publishing; the old session is now dead weight.
        // Best-effort and never awaited into the recovery critical path.
        if (oldSessionId != null && oldSessionId != rejoin.sessionId) {
          unawaited(_closeSupersededSession(oldSessionId, oldMids));
        }
        _tel?.reconnectCompleted(
            attemptId: attemptId, mediaKeptAlive: true,
            elapsedMs: DateTime.now().millisecondsSinceEpoch - t0, pcRecreated: true);
      }
      state = CfConnState.connected;
      statusText = 'Connected';
      _reconnectTry = 0;
    } catch (e, st) {
      // `_publish` (or an earlier await) threw mid-rejoin: the old PC must
      // not leak just because the new path failed to complete.
      _retirePendingPcNow();
      final willRetry = !_ended && _reconnectTry < _reconnectBackoffSec.length;
      _tel?.reconnectFailed(
          attemptId: attemptId, elapsedMs: DateTime.now().millisecondsSinceEpoch - t0,
          terminalReason: 'socket_reconnect_timeout');
      _tel?.error(stage: 'socket_reconnect_failed', direction: 'socket', recoverable: willRetry, exception: e, stack: st);
      if (willRetry) {
        final delay = Duration(seconds: _reconnectBackoffSec[_reconnectTry]);
        _reconnectTry++;
        state = CfConnState.reconnecting;
        statusText = 'Reconnecting…';
        _reconnectRetryTimer?.cancel();
        _reconnectRetryTimer = Timer(delay, () {
          if (_ended) return;
          // A retry always takes the full recreate path: whatever the original
          // trigger was, the previous attempt has just proven the cheap route
          // isn't coming back on its own.
          unawaited(_attemptReconnect(reason: 'retry:$reason', forceRecreate: true));
        });
      } else {
        state = CfConnState.failed;
        statusText = 'Connection lost';
      }
    } finally {
      _reconnecting = false;
      _safeNotify();
    }
  }

  // ---- media health sampler (mirrors call_session.dart's _pollPlayoutHealth) -----

  void _startHealthSampler() {
    _healthTimer?.cancel();
    // Migration preparation has a four-second deadline; a five-second sampler
    // cannot produce evidence in time. Keep the sample interval at or below the
    // one-second contract used by sfu_ready.
    _healthTimer = Timer.periodic(const Duration(seconds: 1), (_) => _pollMediaHealth());
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
      if (_effectiveVideo && videoFramesDecoded != null) {
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
      // Coming back to the foreground is a new chance, not a continuation of a
      // budget spent while the screen was off.
      _reconnectTry = 0;
      unawaited(_attemptReconnect(reason: 'app_foregrounded'));
    }
  }

  // ---- [GCALL-W2-CLOSE] SFU track/session teardown --------------------------------

  /// Every mid this session currently holds open: our published local tracks
  /// (mid 0 audio, mid 1 video, matching the publish specs) plus every remote
  /// track we have pulled.
  List<String> _openMids() {
    final mids = <String>{
      '0',
      if (_cameraOn) '1',
      ..._pulledAudioMid.values,
      ..._pulledVideoMid.values,
    };
    return mids.toList(growable: false);
  }

  /// Pulled-track descriptors, so the DO can free the per-client pull slots it
  /// counts against the audio/video caps rather than waiting for the socket to
  /// drop.
  List<Map<String, String>> _pulledTrackRefs() {
    final out = <Map<String, String>>[];
    for (final uid in _pulledAudioMid.keys) {
      final t = _roster[uid]?.audioTrack;
      if (t != null && t.isNotEmpty) out.add({'kind': 'audio', 'trackName': t});
    }
    for (final uid in _pulledVideoMid.keys) {
      final t = _roster[uid]?.videoTrack;
      if (t != null && t.isNotEmpty) out.add({'kind': 'video', 'trackName': t});
    }
    return out;
  }

  /// Retire the SFU session a reconnect is replacing. Every reconnect minted a
  /// brand-new session and simply abandoned the previous one, so a call that
  /// reconnected a few times left a trail of sessions still holding a publisher
  /// slot until Cloudflare's own 30s track GC caught up.
  Future<void> _closeSupersededSession(String sessionId, List<String> mids) async {
    if (mids.isEmpty) return;
    await CloudflareConferenceApi.close(gid, sessionId, mids);
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
    // A pending reconnect retry must never outlive the call it was retrying,
    // and a handshake still being awaited must not hang the leave path.
    _reconnectRetryTimer?.cancel();
    _reconnectRetryTimer = null;
    _failWelcome(_welcomeEpoch, StateError('call ended'));

    try {
      final senders = await _pc?.getSenders() ?? const [];
      for (final s in senders) { try { await _pc?.removeTrack(s); } catch (_) {} }
    } catch (_) {}

    try { _ws?.sink.close(); } catch (_) {}
    await _wsSub?.cancel();
    _wsSub = null;
    _wsEpoch++;
    await _netSub?.cancel();
    _netSub = null;
    _stopInterruptionWatch();
    // [GCALL-W2-CLOSE] Close the tracks we actually hold. This passed an EMPTY
    // mids list, which makes `PUT /tracks/close` a no-op — so nothing was ever
    // closed on leave: not our published mic/camera, not any of the remote
    // tracks we had pulled. Cloudflare garbage-collects a track ~30s after its
    // media stops (and bills on egress, not sessions, so this was never a cost
    // leak), but leaving it to the GC means ghost publishers linger and the
    // DO's pull-cap bookkeeping stays wrong. Send the real mids, plus the
    // track metadata that lets the DO release the pull slots precisely.
    if (_join != null) {
      await CloudflareConferenceApi.close(
        gid, _join!.sessionId, _openMids(),
        tracks: _pulledTrackRefs(),
      );
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

    if (_ownsLocalStream) {
      try {
        for (final t in _localStream?.getTracks() ?? const <MediaStreamTrack>[]) { await t.stop(); }
      } catch (_) {}
      try { await _localStream?.dispose(); } catch (_) {}
    }

    if (RemoteConfig.callAudioControllerV2 && _join != null) {
      try { await NativeVoiceAudio.instance.endP2pSession(callId: _join!.callId); } catch (_) {}
    }
    await _stopForegroundHold(reason);

    _tel?.conferenceLeft(leaveReason: reason, sessionDurationMs: durationMs, finalMediaHealthClass: _lastMediaHealthClass);
    Analytics.capture('groupcall_leave_cf', {'gid_hash': gid.hashCode.toString(), 'duration_ms': durationMs});
    // The closing row of the call's story: how it ended, how long it ran, whether
    // media ever actually flowed, and how many reconnects it took to get there.
    _ev('groupcall_ended', {
      'reason': reason,
      'duration_ms': durationMs,
      'media_health': _lastMediaHealthClass,
      'ever_connected': _joinedAtMs > 0,
      'reconnect_attempts': _reconnectTry,
      'relay_degraded': relayDegraded,
    });
    // [GCALL-W4-LOG] Write the call to the call log. Group calls left NO trace
    // anywhere: only the 1:1 paths ever touched CallLogStore, so a group call
    // you took simply never happened as far as your history was concerned.
    // Only logged if the call actually got going — a failed join is not a call.
    if (_joinedAtMs > 0) {
      unawaited(CallLogStore().add(CallEntry(
        name: title,
        seed: gid,
        video: _effectiveVideo,
        dir: starter ? CallDir.outgoing : CallDir.incoming,
        ts: _joinedAtMs ~/ 1000,
      )).catchError((_) {/* the log is best-effort, never blocks a hang-up */}));
    }
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
