import 'dart:async';
import 'dart:convert';

import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter_callkit_incoming/flutter_callkit_incoming.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';
import 'package:uuid/uuid.dart';
import 'package:wakelock_plus/wakelock_plus.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import '../analytics.dart';
import '../api_auth.dart';
import '../call_log_store.dart';
import '../call_telemetry.dart';
import '../config.dart';
import '../ice_cache.dart';
import '../profile_store.dart';
import '../receptionist_api.dart';
import '../receptionist_call.dart';
import '../remote_config.dart';
import '../ringback_player.dart';
import '../voice/native_voice_audio.dart';
import '../../push/push_service.dart';

/// Coarse call lifecycle exposed via [CallSession.phase]. Wave 2 (PiP/pill,
/// reconnect, Gemini parity) keys off THIS enum; the full call view also reads
/// the fine-grained [CallSession.uiPhase] string for its status label.
/// See Specs/CALL-SESSION-API.md.
enum CallPhase { dialing, ringing, connecting, connected, reconnecting, ended }

/// Immutable inputs for a 1:1 call, mirroring the old `CallScreen` widget fields
/// so the session is constructed from the same params the launch sites pass.
class CallSessionConfig {
  final String room;
  final String title;
  final String seed;
  final bool video;
  final bool outgoing;
  final String avatarUrl;
  final String ringbackUrl;
  final String? teamId;
  final int? teamSlot;
  const CallSessionConfig({
    required this.room,
    required this.title,
    required this.seed,
    required this.video,
    this.outgoing = true,
    this.avatarUrl = '',
    this.ringbackUrl = '',
    this.teamId,
    this.teamSlot,
  });
}

/// The one true owner of a 1:1 P2P call: RTCPeerConnection, the signaling
/// WebSocket to the CallRoom DO, MediaStreams, renderers, mute/speaker/camera
/// state, call timer, ringback, CallKit sync, foreground-service start/stop and
/// telemetry. Created ONLY by [CallSessionManager]. A view attaches to it and
/// listens; the view NEVER destroys resources. [hangup] is the single teardown
/// path — see Specs/CALL-SESSION-API.md.
///
/// This is a verbatim extraction of the logic that used to live in
/// `_CallScreenState`; the hard-won phantom-busy/glare protections
/// (call_screen.dart:33–108) and every teardown-race guard are preserved.
class CallSession {
  CallSession(this.config);

  final CallSessionConfig config;
  String get room => config.room;
  bool get video => config.video;
  bool get outgoing => config.outgoing;

  // ── Renderers (owned; survive view detach — disposed only in hangup) ────────
  final RTCVideoRenderer localRenderer = RTCVideoRenderer();
  final RTCVideoRenderer remoteRenderer = RTCVideoRenderer();
  final String _myId = 'app-${const Uuid().v4().substring(0, 6)}';

  // ── Public notifiers (listen; never dispose from a view) ────────────────────
  final ValueNotifier<CallPhase> phase = ValueNotifier<CallPhase>(CallPhase.connecting);
  /// Fine-grained UI label string (the old `_phase`). Values: ringing |
  /// connecting | connected | declined | busy | no-answer | ava-countdown |
  /// receptionist-connecting | receptionist | receptionist-wrapup | ended.
  final ValueNotifier<String> uiPhase = ValueNotifier<String>('connecting');
  final ValueNotifier<bool> minimized = ValueNotifier<bool>(false);
  final ValueNotifier<int> elapsedSeconds = ValueNotifier<int>(0);
  final ValueNotifier<bool> muted = ValueNotifier<bool>(false);
  final ValueNotifier<bool> speakerOn = ValueNotifier<bool>(true);
  final ValueNotifier<bool> cameraOn = ValueNotifier<bool>(true);
  final ValueNotifier<bool> videoActive = ValueNotifier<bool>(true);
  final ValueNotifier<bool> onCellularHold = ValueNotifier<bool>(false);
  /// SEAM for WS-D/C: true while the peer's signaling socket is gone but media
  /// may still be flowing (today: set on 'peer-left', cleared on reconnect /
  /// 'welcome'). WS-D wires the grace-period semantics onto it.
  final ValueNotifier<bool> peerAway = ValueNotifier<bool>(false);
  /// Generic "session changed" tick so a view can rebuild on anything (e.g. the
  /// receptionist duo appearing). Bumped whenever notable non-notifier state moves.
  final ValueNotifier<int> revision = ValueNotifier<int>(0);
  void _bump() => revision.value++;

  ReceptionistCall? get receptionist => _receptionist;
  String get myName => _myName;
  String get myAvatar => _myAvatar;
  String get mySeed => _mySeed;

  /// Callback the session uses to ask the currently-attached view to pop its
  /// route (set by the manager/view). Never owns navigation itself.
  void Function()? onRequestPop;

  // ── Internal call state (ex-_CallScreenState fields, verbatim) ──────────────
  WebSocketChannel? _ws;
  RTCPeerConnection? _pc;
  MediaStream? _stream;
  bool _ended = false; // guard: teardown runs exactly once
  bool _started = false; // guard: start() runs exactly once (re-attach safe)
  String? _remoteId;
  List<Map<String, dynamic>> _ice = kIceServers;
  Timer? _timer;
  int _secs = 0;
  bool _video = true;
  bool _camOn = true;
  bool _muted = false;
  bool _speaker = true;
  bool _connected = false;
  String _phase = 'connecting';
  Timer? _ringTimeout;
  final RingbackPlayer _ringback = RingbackPlayer();
  ReceptionistCall? _receptionist;
  bool _receptionistActive = false;
  int _avaCount = 0;
  bool _avaCountingDown = false;
  String _myAvatar = '';
  String _myName = 'You';
  String _mySeed = 'me';
  String _receptMode = 'rings';
  int _receptRings = 5;
  StreamSubscription? _statusSub;
  bool _takeoverGuard = false;
  Duration? _pendingRingWindow;
  Timer? _ringAckFallback;
  bool _ringAckHandled = false;
  bool? _pendingAckResult;
  bool _callUnreachable = false;
  final List<RTCIceCandidate> _pendingCandidates = [];
  bool _remoteSet = false;
  late final CallTelemetry _telemetry;
  bool _weOffered = false;
  int _iceRestarts = 0;
  Timer? _failTimer;
  StreamSubscription? _netSub;
  int _wsReconnects = 0;
  Timer? _wsReconnectTimer;
  Timer? _relayFallbackTimer;
  bool _relayForced = false;
  Timer? _placeCallTimeout;
  bool _gotWelcome = false;
  bool _onCellularHold = false;
  StreamSubscription? _telephonySub;

  int get avaCount => _avaCount; // for the countdown ring in the view
  bool get isEnded => _ended;
  bool get isConnected => _connected;
  int get secs => _secs;

  // ─────────────────────────────────────────────────────────────────────────
  //  START
  // ─────────────────────────────────────────────────────────────────────────

  /// Acquire media, open signaling, arm timers/ringback, publish busy/glare
  /// globals and start the foreground service at call SETUP. Idempotent so a
  /// re-attaching view can't re-run it.
  Future<void> start() async {
    if (_started) return;
    _started = true;
    gLiveCallScreens++;
    gInCall = true;
    gActiveCallId = config.room;
    gInCallSince = DateTime.now().millisecondsSinceEpoch;
    Analytics.capture('call_session_extracted', {
      'call_id': config.room,
      'video': config.video,
      'outgoing': config.outgoing,
    });
    // Keep the device awake for the whole call (released in _teardown).
    try { WakelockPlus.enable(); } catch (_) {}
    _takeoverGuard = RemoteConfig.receptTakeoverGuard;
    _telemetry = CallTelemetry(callId: config.room, video: config.video, outgoing: config.outgoing);
    _telemetry.started();
    // My own profile (best-effort) for the receptionist duo's "You" icon.
    ProfileStore().load().then((p) {
      if (_ended) return;
      _myAvatar = p.avatarUrl;
      if (p.displayName.trim().isNotEmpty) _myName = p.displayName.trim();
      _mySeed = p.handle.isNotEmpty ? p.handle : (p.displayName.isNotEmpty ? p.displayName : 'me');
      _bump();
    }).catchError((_) {});
    // Wi-Fi ⇆ cellular handoff → proactive ICE restart.
    _netSub = Connectivity().onConnectivityChanged.listen((_) {
      if (_connected && !_ended) {
        _telemetry.onNetChange();
        _tryIceRestart('net-change');
      }
    });
    _video = config.video;
    _camOn = config.video;
    _speaker = config.video;
    videoActive.value = _video;
    cameraOn.value = _camOn;
    speakerOn.value = _speaker;
    _setPhase(config.outgoing ? 'ringing' : 'connecting');
    if (config.outgoing) {
      // CALL-GLARE-1: publish our pending outgoing dial for the incoming-push
      // handler's glare detection. Cleared on connect + on teardown.
      gOutgoingCallTo = config.seed;
      gOutgoingCallId = config.room;
      gOutgoingSince = DateTime.now().millisecondsSinceEpoch;
      _ringTimeout = Timer(const Duration(seconds: 35), () {
        if (!_ended && !_connected) _onNoAnswer();
      });
      if (!config.video) {
        // ignore: unawaited_futures
        _probeReceptionist();
      }
      if (RemoteConfig.ringbackEnabled) {
        // ignore: unawaited_futures
        _ringback.playRingback(config.ringbackUrl);
        Analytics.capture('ringback_played', {
          'source': config.ringbackUrl.isEmpty ? 'default' : 'custom',
          'video': config.video,
        });
      }
    }
    // Server-relayed call status (declined / busy / decline-to-Ava) for this call.
    _statusSub = callStatusBus.stream.listen((e) {
      if (_receptionistActive) {
        if (e.callId == config.room) {
          Analytics.capture('ava_recept_signal_suppressed',
              {'channel': 'call_status', 'status': e.status, 'call_id': config.room});
        }
        return;
      }
      if (e.callId == config.room && !_ended && e.status == 'glare-yield') {
        Analytics.capture('call_glare_yielded', {'call_id': config.room});
        _endWith('ended', reason: 'glare-yield');
        return;
      }
      if (e.callId == config.room && !_ended &&
          (e.status == 'ended' || e.status == 'cancel' || e.status == 'bye')) {
        _endWith('ended', reason: 'remote-ended-push');
        return;
      }
      if (e.callId == config.room && !_connected) {
        if (e.status == 'decline_ava' && !config.video && !_ended) {
          _ringTimeout?.cancel();
          // ignore: unawaited_futures
          _handoffToAva('decline');
          return;
        }
        if (e.status == 'busy') {
          // ignore: unawaited_futures
          _onBusy();
          return;
        }
        if (e.status == 'decline' && !config.video && !_ended) {
          _ringTimeout?.cancel();
          // ignore: unawaited_futures
          _handoffToAva('decline');
          return;
        }
        _endWith(e.status == 'decline' ? 'declined' : e.status);
      }
    });
    // Log to call history.
    CallLogStore().add(CallEntry(
      name: config.title, seed: config.seed, video: config.video,
      dir: config.outgoing ? CallDir.outgoing : CallDir.incoming,
      ts: DateTime.now().millisecondsSinceEpoch ~/ 1000,
    ));
    await _bootMedia();
  }

  /// Sync the coarse enum + fine label + view tick from a fine phase string.
  void _setPhase(String p) {
    _phase = p;
    uiPhase.value = p;
    phase.value = _coarse(p);
    _bump();
  }

  static CallPhase _coarse(String p) {
    switch (p) {
      case 'ringing':
        return CallPhase.ringing;
      case 'connected':
      case 'receptionist':
      case 'receptionist-connecting':
      case 'receptionist-wrapup':
      case 'ava-countdown':
        return CallPhase.connected;
      case 'ended':
      case 'declined':
      case 'busy':
      case 'no-answer':
        return CallPhase.ended;
      default:
        return CallPhase.connecting;
    }
  }

  /// [phase] drives the UI label; [reason] is the exhaustive telemetry taxonomy.
  void _endWith(String phase, {String? reason}) {
    _telemetry.ended(reason ?? phase);
    _ringback.stop();
    final busy = phase == 'busy' && config.outgoing && RemoteConfig.ringbackEnabled;
    if (busy) {
      // ignore: unawaited_futures
      _ringback.playBusyTone();
      Analytics.capture('busy_tone_played', const {});
    }
    // Release mic/cam IMMEDIATELY on every end path — this is the ONE teardown.
    // Fire-and-forget: _teardown is idempotent and async, but the UI label +
    // pop scheduling below must happen synchronously (as the old _endWith did).
    // ignore: unawaited_futures
    _teardown(reason: reason ?? phase);
    _setPhase(phase);
    // Give the busy tone time to be heard before the view pops; other states 1.4s.
    Future.delayed(Duration(milliseconds: busy ? 2600 : 1400), () {
      onRequestPop?.call();
    });
  }

  String get _room => config.room;

  Future<void> _fetchIce() async {
    _ice = await IceCache.get();
  }

  /// FREE LAUNCH §2: tune the Opus encoder on the LOCAL SDP for voice.
  static String _tuneOpusSdp(String? sdp) {
    if (sdp == null || sdp.isEmpty) return sdp ?? '';
    final pts = RegExp(r'a=rtpmap:(\d+) opus/', caseSensitive: false)
        .allMatches(sdp)
        .map((m) => m.group(1)!)
        .toSet();
    if (pts.isEmpty) return sdp;
    const want = <String, String>{
      'useinbandfec': '1',
      'usedtx': '1',
      'maxaveragebitrate': '40000',
      'stereo': '0',
    };
    final lines = sdp.split(RegExp(r'\r\n|\n'));
    for (var i = 0; i < lines.length; i++) {
      for (final pt in pts) {
        final prefix = 'a=fmtp:$pt ';
        if (!lines[i].startsWith(prefix)) continue;
        final params = <String, String>{};
        for (final kv in lines[i].substring(prefix.length).split(';')) {
          final t = kv.trim();
          if (t.isEmpty) continue;
          final eq = t.indexOf('=');
          if (eq < 0) {
            params[t] = '';
          } else {
            params[t.substring(0, eq)] = t.substring(eq + 1);
          }
        }
        params.addAll(want);
        lines[i] = prefix +
            params.entries
                .map((e) => e.value.isEmpty ? e.key : '${e.key}=${e.value}')
                .join(';');
      }
    }
    return lines.join('\r\n');
  }

  RTCSessionDescription _tuned(RTCSessionDescription d) =>
      RTCSessionDescription(_tuneOpusSdp(d.sdp), d.type);

  Future<void> _bootMedia() async {
    await localRenderer.initialize();
    await remoteRenderer.initialize();
    await _fetchIce();
    try {
      _stream = await navigator.mediaDevices.getUserMedia({
        'audio': {
          'echoCancellation': true,
          'noiseSuppression': true,
          'autoGainControl': true,
          'mandatory': {
            'googEchoCancellation': true,
            'googNoiseSuppression': true,
            'googAutoGainControl': true,
            'googHighpassFilter': true,
          },
          'optional': [],
        },
        'video': config.video ? {'facingMode': 'user'} : false,
      });
    } catch (e) {
      Analytics.error(
        domain: 'call_setup',
        code: 'media_denied',
        message: e.toString(),
        action: config.video ? 'getUserMedia_av' : 'getUserMedia_audio',
        extra: {'call_id': config.room, 'video': config.video},
      );
      _mediaDeniedNotice?.call();
      _endWith('ended', reason: 'media-denied');
      return;
    }
    localRenderer.srcObject = _stream;
    try { await Helper.setSpeakerphoneOn(_speaker); } catch (_) {}
    try { await NativeVoiceAudio().startP2pAudioMode(); } catch (_) {}
    try { await NativeVoiceAudio().startBluetoothSco(); } catch (_) {}
    if (NativeVoiceAudio.isSupported) {
      final route = (await NativeVoiceAudio().getAudioRoute()) ?? 'unknown';
      if (route == 'earpiece') {
        Analytics.capture('call_audio_route', {'route': 'earpiece', 'auto': true});
        try { await NativeVoiceAudio().startProximitySensor(); } catch (_) {}
      } else {
        Analytics.capture('call_audio_route', {'route': route, 'auto': true});
      }
    }
    // WS-B: start the foreground service at call SETUP (not on connect) so a call
    // backgrounded while ringing/connecting keeps its FGS and survives.
    if (NativeVoiceAudio.isSupported) {
      try {
        await NativeVoiceAudio().startCallForegroundService(
          callId: config.room,
          peerName: config.title,
        );
      } catch (_) {}
    }
    if (NativeVoiceAudio.isSupported) {
      try {
        await NativeVoiceAudio().startTelephonyMonitoring();
        _telephonySub = NativeVoiceAudio().telephonyEventStream.listen((event) {
          final state = (event['state'] ?? '').toString();
          if (state == 'held' && !_onCellularHold) {
            _onCellularHold = true;
            onCellularHold.value = true;
            if (!_muted) {
              _muted = true;
              muted.value = true;
              _send({'type': 'mute', 'muted': true});
            }
            Analytics.capture('call_cellular_held', {'call_id': config.room});
          } else if (state == 'resumed' && _onCellularHold) {
            _onCellularHold = false;
            onCellularHold.value = false;
            if (_muted) {
              _muted = false;
              muted.value = false;
              _send({'type': 'mute', 'muted': false});
            }
            Analytics.capture('call_cellular_resumed', {'call_id': config.room});
          }
        });
      } catch (_) {}
    }
    _timer = Timer.periodic(const Duration(seconds: 1), (_) {
      if (_ended) return;
      _secs++;
      elapsedSeconds.value = _secs;
    });
    final url = 'wss://$kSignalingHost/room/$_room?id=$_myId';
    _ws = WebSocketChannel.connect(Uri.parse(url));
    _ws!.stream.listen(_onSignal, onError: (_) => _onSocketLost(), onDone: _onSocketLost);
    if (config.outgoing) {
      _placeCallTimeout = Timer(const Duration(seconds: 8), () {
        if (!_gotWelcome && !_ended && _phase == 'ringing') {
          if (_wsReconnects > 0) {
            if (_placeCallTimeout == null) {
              _placeCallTimeout = Timer(const Duration(seconds: 4), () {});
            }
            return;
          }
          _ringback.stop();
          Analytics.capture('call_place_failed', {
            'stage': 'no_server_confirm',
            'kind': config.video ? 'video' : 'audio',
          });
          _placeCallFailedNotice?.call();
          _endWith('ended', reason: 'place-call-timeout');
        }
      });
    }
    _relayFallbackTimer = Timer(const Duration(seconds: 4), () {
      if (!_connected && !_ended) _forceRelayRestart();
    });
  }

  // ── View notice hooks (snackbars) — set by the attached view. ───────────────
  void Function()? _mediaDeniedNotice;
  void Function()? _placeCallFailedNotice;
  void Function()? _unreachableNotice;
  /// The view registers user-facing snackbar callbacks. Cleared on detach.
  void setNoticeHooks({
    void Function()? mediaDenied,
    void Function()? placeCallFailed,
    void Function()? unreachable,
  }) {
    _mediaDeniedNotice = mediaDenied;
    _placeCallFailedNotice = placeCallFailed;
    _unreachableNotice = unreachable;
  }

  Future<void> _forceRelayRestart() async {
    if (_ended || _connected || _relayForced) return;
    if (!_weOffered || _remoteId == null) return;
    _relayForced = true;
    _telemetry.onIceRestart();
    Analytics.capture('call_relay_fallback', {'call_id': config.room, 'video': config.video});
    try {
      try { await _pc?.close(); } catch (_) {}
      _pc = null;
      _remoteSet = false;
      _pendingCandidates.clear();
      final pc = await _newPC(forceRelay: true);
      final offer = _tuned(await pc.createOffer());
      await pc.setLocalDescription(offer);
      _send({'type': 'offer', 'to': _remoteId, 'sdp': offer.toMap()});
    } catch (_) {}
  }

  void _onSocketLost() {
    if (_ended) return;
    if (_receptionistActive) {
      Analytics.capture('ava_recept_signal_suppressed',
          {'channel': 'socket_lost', 'call_id': config.room});
      return;
    }
    if (_connected) {
      Analytics.capture('call_ws_reconnect',
          {'call_id': config.room, 'attempt': _wsReconnects + 1, 'phase': 'connected'});
      _reconnectSignaling(isConnected: true);
      return;
    }
    if ((_phase == 'ringing' || _phase == 'connecting') && _wsReconnects < 3) {
      Analytics.capture('call_ws_reconnect_preconnect',
          {'call_id': config.room, 'phase': _phase, 'attempt': _wsReconnects + 1});
      _reconnectSignaling(isConnected: false);
      return;
    }
    _endWith('ended', reason: 'socket-lost');
  }

  void _reconnectSignaling({required bool isConnected}) {
    if (_ended) return;
    if (isConnected && !_connected) return;
    if (!isConnected && (_phase != 'ringing' && _phase != 'connecting')) return;
    if (_wsReconnects >= (isConnected ? 5 : 3)) return;
    _wsReconnects++;
    _wsReconnectTimer?.cancel();
    final delayMs = isConnected
        ? 600 * _wsReconnects
        : [1000, 2000, 4000][_wsReconnects - 1];
    _wsReconnectTimer = Timer(Duration(milliseconds: delayMs), () {
      if (_ended) return;
      if (isConnected && !_connected) return;
      if (!isConnected && (_phase != 'ringing' && _phase != 'connecting')) return;
      try { _ws?.sink.close(); } catch (_) {}
      final url = 'wss://$kSignalingHost/room/$_room?id=$_myId';
      try {
        _ws = WebSocketChannel.connect(Uri.parse(url));
        _ws!.stream.listen(_onSignal, onError: (_) => _onSocketLost(), onDone: _onSocketLost);
      } catch (_) {
        _onSocketLost();
      }
    });
  }

  void _send(Map<String, dynamic> o) {
    try { _ws?.sink.add(jsonEncode(o)); } catch (_) {/* socket closed / gone */}
  }

  Future<void> _preferResolutionOnVideo(RTCPeerConnection pc) async {
    try {
      final senders = await pc.getSenders();
      for (final s in senders) {
        if (s.track?.kind != 'video') continue;
        final params = s.parameters;
        params.degradationPreference = RTCDegradationPreference.MAINTAIN_RESOLUTION;
        await s.setParameters(params);
      }
    } catch (_) {}
  }

  static String _candTypeOf(String? cand) {
    if (cand == null) return '';
    final m = RegExp(r'typ (\w+)').firstMatch(cand);
    return m?.group(1) ?? '';
  }

  Future<RTCPeerConnection> _newPC({bool forceRelay = false}) async {
    final pc = await createPeerConnection({
      'iceServers': _ice,
      'iceCandidatePoolSize': 2,
      if (CallDiag.turnOnly || forceRelay) 'iceTransportPolicy': 'relay',
    });
    _stream!.getTracks().forEach((t) => pc.addTrack(t, _stream!));
    if (config.video) await _preferResolutionOnVideo(pc);
    _telemetry.onIceGatheringStart();
    pc.onIceCandidate = (c) {
      _telemetry.onLocalCandidate(_candTypeOf(c.candidate));
      if (_remoteId != null) _send({'type': 'candidate', 'to': _remoteId, 'candidate': c.toMap()});
    };
    pc.onIceGatheringState = (s) {
      if (s == RTCIceGatheringState.RTCIceGatheringStateComplete) {
        _telemetry.onIceGatheringDone();
      }
    };
    pc.onTrack = (e) async {
      if (e.streams.isNotEmpty) {
        remoteRenderer.srcObject = e.streams[0];
        _ringTimeout?.cancel();
        _failTimer?.cancel();
        _relayFallbackTimer?.cancel();
        _ringback.stop();
        _telemetry.connected(pc);
        HapticFeedback.mediumImpact();
        if (gOutgoingCallId == config.room) {
          gOutgoingCallTo = null; gOutgoingCallId = null; gOutgoingSince = 0;
        }
        _connected = true;
        peerAway.value = false;
        _setPhase('connected');
      }
    };
    pc.onConnectionState = (s) {
      if (_ended || !_connected) return;
      if (s == RTCPeerConnectionState.RTCPeerConnectionStateClosed) {
        _endWith('ended');
      } else if (s == RTCPeerConnectionState.RTCPeerConnectionStateFailed ||
                 s == RTCPeerConnectionState.RTCPeerConnectionStateDisconnected) {
        final isFailed = s == RTCPeerConnectionState.RTCPeerConnectionStateFailed;
        final canRestart = _weOffered && _iceRestarts < 3 && _remoteId != null;
        if (isFailed && !canRestart) {
          _endWith('ended', reason: 'rtc-failed');
          return;
        }
        _tryIceRestart('transport-$s');
        _failTimer?.cancel();
        _failTimer = Timer(const Duration(seconds: 10), () {
          final st = _pc?.connectionState;
          if (!_ended && _connected &&
              st != RTCPeerConnectionState.RTCPeerConnectionStateConnected) {
            _endWith('ended', reason: isFailed ? 'rtc-failed' : 'rtc-disconnected');
          }
        });
      } else if (s == RTCPeerConnectionState.RTCPeerConnectionStateConnected) {
        _failTimer?.cancel();
      }
    };
    _pc = pc;
    return pc;
  }

  Future<void> _tryIceRestart(String why) async {
    final pc = _pc;
    if (pc == null || _ended || !_weOffered || _remoteId == null) return;
    if (_iceRestarts >= 3) return;
    _iceRestarts++;
    _telemetry.onIceRestart();
    try {
      _ice = await IceCache.get();
      final offer = _tuned(await pc.createOffer({'iceRestart': true}));
      await pc.setLocalDescription(offer);
      _send({'type': 'offer', 'to': _remoteId, 'sdp': offer.toMap()});
    } catch (_) {}
  }

  Future<void> _flushCandidates() async {
    _remoteSet = true;
    final pc = _pc;
    if (pc == null) return;
    final pending = List<RTCIceCandidate>.of(_pendingCandidates);
    _pendingCandidates.clear();
    for (final c in pending) {
      try { await pc.addCandidate(c); } catch (_) {}
    }
  }

  Future<void> _onSignal(dynamic raw) async {
    if (_receptionistActive) {
      String? t;
      try { t = (jsonDecode(raw as String) as Map)['type']?.toString(); } catch (_) {}
      Analytics.capture('ava_recept_signal_suppressed',
          {'channel': 'signaling', if (t != null) 'type': t, 'call_id': config.room});
      return;
    }
    if (_ended) return;
    final d = jsonDecode(raw as String) as Map<String, dynamic>;
    if (d['country'] is String) _telemetry.setPeerCountry(d['country'] as String);
    switch (d['type']) {
      case 'welcome':
        _gotWelcome = true;
        _placeCallTimeout?.cancel();
        final peers = (d['peers'] as List).cast<String>();
        if (peers.isNotEmpty) {
          _remoteId = peers.first;
          _weOffered = true;
          if (_connected && _pc != null) {
            _wsReconnects = 0;
            peerAway.value = false;
            Analytics.capture('call_ws_reconnected', {'call_id': config.room});
            await _tryIceRestart('ws-reconnect');
          } else {
            final pc = await _newPC();
            final offer = _tuned(await pc.createOffer());
            await pc.setLocalDescription(offer);
            _send({'type': 'offer', 'to': _remoteId, 'sdp': offer.toMap()});
          }
        }
        break;
      case 'offer':
        try {
          _remoteId = d['from'] as String;
          final pc = _pc ?? await _newPC();
          await pc.setRemoteDescription(RTCSessionDescription(d['sdp']['sdp'], d['sdp']['type']));
          await _flushCandidates();
          final ans = _tuned(await pc.createAnswer());
          await pc.setLocalDescription(ans);
          _send({'type': 'answer', 'to': _remoteId, 'sdp': ans.toMap()});
        } catch (_) {}
        break;
      case 'answer':
        try {
          await _pc?.setRemoteDescription(RTCSessionDescription(d['sdp']['sdp'], d['sdp']['type']));
          await _flushCandidates();
        } catch (_) {}
        break;
      case 'candidate':
        final c = d['candidate'];
        final cand = RTCIceCandidate(c['candidate'], c['sdpMid'], c['sdpMLineIndex']);
        if (_pc == null || !_remoteSet) {
          _pendingCandidates.add(cand);
        } else {
          try { await _pc!.addCandidate(cand); } catch (_) {}
        }
        break;
      case 'ring-ack':
        _onRingAck(d['ok'] == true);
        break;
      case 'decline':
        if (_receptionistActive) break;
        if (!config.video && !_connected && !_ended) {
          _ringTimeout?.cancel();
          // ignore: unawaited_futures
          _handoffToAva('decline');
        } else {
          _endWith('declined', reason: 'decline');
        }
        break;
      case 'busy':
        // ignore: unawaited_futures
        _onBusy();
        break;
      case 'peer-left':
      case 'bye':
        final isBye = d['type'] == 'bye';
        if (_connected) {
          if (isBye) {
            remoteRenderer.srcObject = null;
            _endWith('ended', reason: 'remote-bye');
          } else {
            // 'peer-left' = the peer's SIGNALING socket dropped — not a hangup.
            // Keep the call; the RTC watchdog decides. SEAM: mark peer away.
            peerAway.value = true;
            Analytics.capture('call_peer_left_grace', {'call_id': config.room});
          }
        } else if (isBye) {
          _endWith('ended', reason: 'remote-bye');
        } else {
          _connected = false;
          _bump();
        }
        break;
    }
  }

  String get clock {
    final m = (_secs ~/ 60).toString().padLeft(2, '0');
    final s = (_secs % 60).toString().padLeft(2, '0');
    return '$m:$s';
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  View-facing controls
  // ─────────────────────────────────────────────────────────────────────────

  void toggleMute() {
    _muted = !_muted;
    _stream?.getAudioTracks().forEach((t) => t.enabled = !_muted);
    muted.value = _muted;
  }

  void toggleSpeaker() {
    _speaker = !_speaker;
    speakerOn.value = _speaker;
    Helper.setSpeakerphoneOn(_speaker);
    // ignore: unawaited_futures
    _receptionist?.setSpeaker(_speaker);
  }

  void _notifyCalleeCanceled() {
    if (config.seed.isEmpty) return;
    ApiAuth.postJson(kCallStatusUrl, {
      'to': config.seed, 'callId': config.room, 'status': 'cancel',
    }).ignore();
    Analytics.capture('call_cancel_sent', {'call_id': config.room});
  }

  void toggleCamera() {
    if (!_video) {
      _video = true; _camOn = true; _speaker = true;
      videoActive.value = true; cameraOn.value = true; speakerOn.value = true;
      _restartWithVideo();
      return;
    }
    _camOn = !_camOn;
    _stream?.getVideoTracks().forEach((t) => t.enabled = _camOn);
    cameraOn.value = _camOn;
  }

  Future<void> _restartWithVideo() async {
    if (_ended) return;
    try {
      final v = await navigator.mediaDevices
          .getUserMedia({'video': {'facingMode': 'user'}, 'audio': false});
      final track = v.getVideoTracks().first;
      await _stream?.addTrack(track);
      localRenderer.srcObject = _stream;
      if (_stream != null) await _pc?.addTrack(track, _stream!);
      if (_pc != null) await _preferResolutionOnVideo(_pc!);
      if (!_ended && _pc != null && _remoteId != null) {
        final offer = _tuned(await _pc!.createOffer());
        await _pc!.setLocalDescription(offer);
        _send({'type': 'offer', 'to': _remoteId, 'sdp': offer.toMap()});
        Analytics.capture('call_video_upgraded', {'call_id': config.room});
      }
    } catch (_) {}
    _bump();
  }

  /// Red button / notification "Hang up": durable hangup then request pop.
  Future<void> endByUser() async {
    if (_remoteId != null) _send({'type': 'bye', 'to': _remoteId});
    if (config.seed.isNotEmpty) {
      ApiAuth.postJson(kCallStatusUrl, {
        'to': config.seed, 'callId': config.room, 'status': 'ended',
      }).ignore();
    }
    _telemetry.ended('local-hangup');
    await hangup('local-hangup');
    onRequestPop?.call();
  }

  Future<void> _onNoAnswer() async {
    _ringback.stop();
    if (!config.video && !_ended) {
      final started = await _tryReceptionist(
          activationMode: _receptMode == 'first_ring' ? 'first_ring' : 'rings');
      if (started) return;
    }
    if (!_ended && !_connected) _endWith('no-answer', reason: 'timeout-ringing');
  }

  Future<void> _onBusy() async {
    if (_ended || _connected) return;
    _ringTimeout?.cancel();
    _ringback.stop();
    Analytics.capture('call_busy_received', {
      'call_id': config.room,
      'recept_mode': _receptMode,
      'video': config.video,
    });
    if (!config.video) {
      final started = await _tryReceptionist(
          activationMode: _receptMode == 'first_ring' ? 'first_ring' : 'rings');
      if (started) return;
    }
    if (!_connected && !_ended) _endWith('busy', reason: 'busy');
  }

  Future<void> _probeReceptionist() async {
    try {
      final cfg = await ReceptionistApi.configFor(config.seed);
      if (_connected || _ended || cfg == null) return;
      _receptMode = (cfg['mode'] ?? 'rings').toString();
      _receptRings = (cfg['rings'] as num?)?.toInt() ?? 5;
      final Duration window = _receptMode == 'first_ring'
          ? const Duration(seconds: 6)
          : Duration(seconds: (_receptRings * 5).clamp(20, 45));
      _armNoAnswerWindow(window);
    } catch (_) {}
  }

  void _armNoAnswerWindow(Duration window) {
    if (!_takeoverGuard) { _startRingWindow(window); return; }
    _pendingRingWindow = window;
    if (_pendingAckResult != null) { _applyRingAck(_pendingAckResult!); return; }
    _ringAckHandled = false;
    _ringAckFallback?.cancel();
    _ringAckFallback = Timer(const Duration(seconds: 5), () {
      if (_ringAckHandled || _connected || _ended) return;
      _ringAckHandled = true;
      Analytics.capture('call_ring_ack', {'call_id': config.room, 'source': 'fallback'});
      _startRingWindow(window);
    });
  }

  void _startRingWindow(Duration window) {
    _ringTimeout?.cancel();
    _ringTimeout = Timer(window, () { if (!_ended && !_connected) _onNoAnswer(); });
  }

  void _onRingAck(bool ok) {
    if (!_takeoverGuard || _connected || _ended) return;
    if (_pendingRingWindow == null) { _pendingAckResult = ok; return; }
    _applyRingAck(ok);
  }

  void _applyRingAck(bool ok) {
    if (_ringAckHandled) return;
    _ringAckHandled = true;
    _ringAckFallback?.cancel();
    Analytics.capture('call_ring_ack', {'call_id': config.room, 'ok': ok, 'source': 'server'});
    if (ok) {
      _startRingWindow(_pendingRingWindow ?? const Duration(seconds: 20));
    } else if (!_connected) {
      _ringback.stop();
      _callUnreachable = true;
      _unreachableNotice?.call();
      _onNoAnswer();
    }
  }

  Future<void> _handoffToAva(String activationMode) async {
    _ringback.stop();
    final started = await _tryReceptionist(activationMode: activationMode);
    if (!started && !_connected) {
      _endWith('declined', reason: 'receptionist-unavailable');
    }
  }

  Future<bool> _tryReceptionist({String activationMode = 'rings'}) async {
    if (_connected) {
      Analytics.capture('ava_recept_signal_suppressed',
          {'channel': 'connected_race', 'call_id': config.room});
      return false;
    }
    if (_receptionistActive || _receptionist != null || _avaCountingDown) {
      Analytics.capture('ava_recept_reattach_blocked', {
        'call_id': config.room,
        'activation_mode': activationMode,
        'stage': 'client',
        'reason': _receptionist != null
            ? 'session_live'
            : (_avaCountingDown ? 'countdown' : 'already_committed'),
      });
      return true;
    }
    _receptionistActive = true;
    try {
      _send({'type': 'bye'});
      try { _stream?.getTracks().forEach((t) => t.stop()); } catch (_) {}
      try { await _pc?.close(); } catch (_) {}
      _pc = null;
      _notifyCalleeCanceled();

      final call = ReceptionistCall(
          calleeUid: config.seed, callId: config.room, activationMode: activationMode,
          speaker: _speaker, teamId: config.teamId, teamSlot: config.teamSlot);
      call.onStatus = (s) {
        if (_ended || _avaCountingDown) return;
        _setPhase(switch (s) {
          'connecting' => 'receptionist-connecting',
          'connected' => 'receptionist',
          'wrapup' => 'receptionist-wrapup',
          _ => _phase,
        });
      };
      _avaCountingDown = true;
      call.beginHold();
      final startFut = call.start();
      await _runAvaCountdown();
      final ok = await startFut;
      _avaCountingDown = false;
      if (!ok) return false;
      _receptionist = call;
      _setPhase('receptionist');
      call.release();
      call.done.then((_) {
        if (!_ended) _endWith('ended', reason: 'receptionist-done');
      });
      return true;
    } catch (_) {
      return false;
    }
  }

  Future<void> _runAvaCountdown() async {
    for (var n = 3; n >= 1; n--) {
      if (_ended) return;
      _avaCount = n;
      _setPhase('ava-countdown');
      await Future<void>.delayed(const Duration(seconds: 1));
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  TEARDOWN — the single destroy path
  // ─────────────────────────────────────────────────────────────────────────

  /// The ONLY method that destroys resources. Idempotent. Every end path routes
  /// here. [reason] feeds the telemetry taxonomy. Sets phase to ended.
  Future<void> hangup(String reason) async {
    if (_ended) {
      // Ensure terminal phase even on a repeat call.
      phase.value = CallPhase.ended;
      return;
    }
    await _teardown(reason: reason);
  }

  Future<void> _teardown({String? reason}) async {
    if (_ended) return;
    try { _receptionist?.hangup(); } catch (_) {}
    try { WakelockPlus.disable(); } catch (_) {}
    try { await NativeVoiceAudio().stopP2pAudioMode(); } catch (_) {}
    try { await NativeVoiceAudio().stopBluetoothSco(); } catch (_) {}
    try { await NativeVoiceAudio().stopProximitySensor(); } catch (_) {}
    try { await NativeVoiceAudio().stopCallForegroundService(); } catch (_) {}
    try { await NativeVoiceAudio().stopTelephonyMonitoring(); } catch (_) {}
    _telephonySub?.cancel();
    _ended = true;
    if (gLiveCallScreens > 0) gLiveCallScreens--;
    gInCall = gLiveCallScreens > 0;
    if (gActiveCallId == config.room) {
      gActiveCallId = null;
      gInCallSince = 0;
    }
    if (gOutgoingCallId == config.room) {
      gOutgoingCallTo = null; gOutgoingCallId = null; gOutgoingSince = 0;
    }
    _telemetry.ended(reason ?? (_connected ? 'ended' : _phase));
    if (config.outgoing && !_connected) _notifyCalleeCanceled();
    _timer?.cancel();
    _ringTimeout?.cancel();
    _ringAckFallback?.cancel();
    _failTimer?.cancel();
    _wsReconnectTimer?.cancel();
    _relayFallbackTimer?.cancel();
    _placeCallTimeout?.cancel();
    _netSub?.cancel();
    _statusSub?.cancel();
    try { await FlutterCallkitIncoming.endCall(config.room); } catch (_) {}
    try { _stream?.getTracks().forEach((t) => t.stop()); } catch (_) {}
    try { await _pc?.close(); } catch (_) {}
    try { await _ws?.sink.close(); } catch (_) {}
    try { localRenderer.srcObject = null; } catch (_) {}
    try { remoteRenderer.srcObject = null; } catch (_) {}
    try { await _stream?.dispose(); } catch (_) {}
    _stream = null;
    _pc = null;
    _ringback.dispose();
    phase.value = CallPhase.ended;
    // Dispose the renderers (they are owned by the session, not any view).
    try { await localRenderer.dispose(); } catch (_) {}
    try { await remoteRenderer.dispose(); } catch (_) {}
    _bump();
  }

  bool get isReceptDuo =>
      _phase == 'receptionist' ||
      _phase == 'receptionist-connecting' ||
      _phase == 'receptionist-wrapup';

  String get statusText => switch (_phase) {
        'ringing' => 'Ringing…',
        'connected' => _onCellularHold ? 'On hold — cellular call' : 'Connected · end-to-end encrypted',
        'declined' => 'Call declined',
        'busy' => 'User is busy',
        'no-answer' => 'No answer',
        'ava-countdown' => 'Ava is taking your call…',
        'receptionist-connecting' => 'Connecting you to Ava…',
        'receptionist' => 'Ava is taking a message',
        'receptionist-wrapup' => 'Ava is wrapping up…',
        'ended' => 'Call ended',
        _ => 'Connecting…',
      };
}
