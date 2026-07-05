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
// The 1:1 call/glare globals (gInCall, gActiveCallId, gLiveCallScreens,
// gOutgoing*, gInCallSince) that gate phantom-busy/glare live in call_screen.dart
// and are DRIVEN from here. Imported for scope; call_screen.dart also imports
// this file — Dart permits the library cycle. See call_screen.dart:33-108.
import '../../features/avatok/call_screen.dart';

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
  /// [TRACE-ID-1] Correlation id minted at the dial boundary (caller) or carried
  /// in the incoming push (callee). '' when unknown → the session mints one so a
  /// trace always exists. Rides every call event + the reliability score.
  final String traceId;
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
    this.traceId = '',
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
/// [CALL-REG-SEAL-1] Capability token that authorizes constructing a
/// [CallSession]. The ONLY instance is [CallSessionManager]'s private
/// [CallSessionManager.sessionToken]; because this class has a private
/// constructor, no code outside `call_session.dart` can mint one. Passing it to
/// [CallSession.internalByManager] is therefore proof the caller is the manager
/// — the sealed-registry invariant (§#4 of DETERMINISTIC-CORE-ARCH) is enforced
/// at the type level, not just by convention.
class CallSessionToken {
  const CallSessionToken._();
}

/// [CALL-REG-SEAL-1] The single token the manager presents to build sessions.
const CallSessionToken kCallSessionToken = CallSessionToken._();

class CallSession {
  /// [CALL-REG-SEAL-1] Sealed construction. A [CallSession] may be built ONLY by
  /// [CallSessionManager], which is the sole holder of a [CallSessionToken]
  /// (mintable only inside this library). This preserves the [CALL-DUP-SESSION-1]
  /// registry invariant: every session is created through `manager.attach()`, so
  /// the `_byRoom` dedup map can never be bypassed by a stray direct construction.
  /// The name is deliberately awkward ("internalByManager") to signal at every
  /// (would-be) call site that this is not a public API. The assert is a
  /// debug-build tripwire in case a token is ever smuggled out.
  CallSession.internalByManager(CallSessionToken token, this.config)
      : assert(identical(token, kCallSessionToken),
            'CallSession must be constructed via CallSessionManager.attach()');

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

  // [CALL-DUP-SESSION-1] Wired by CallSessionManager. Returns true when ANOTHER
  // live (non-ended) CallSession for THIS room already owns the room on this
  // device — i.e. this session is a duplicate/non-primary leg. Used to (a) make
  // a 'busy' signal that lands on this duplicate leg self-immune (never trigger
  // the receptionist or cancel/end fan-out that would kill the real call), and
  // (b) suppress bye/cancel/ended signalling from this leg's teardown so it can
  // never tear down the genuine call owned by the other session. Null → treat as
  // the sole owner (default single-session behaviour, unchanged).
  bool Function()? anotherLiveSessionOwnsRoom;
  bool get _anotherOwns {
    try { return anotherLiveSessionOwnsRoom?.call() ?? false; } catch (_) { return false; }
  }

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
  // [TRACE-ID-1] This call's correlation id (adopted from config or minted in
  // start()). Published to Analytics.currentTraceId for the call's lifetime.
  String _traceId = '';
  bool _gotWelcome = false;
  // CALL-GEN-1: our current generation, handed to us by the CallRoom DO in every
  // 'welcome'. We stamp it on every outbound signaling frame; the DO drops frames
  // stamped with a gen below our current one (stale zombie sockets). We also drop
  // any INBOUND frame whose gen is present and lower than ours. Null until the
  // first welcome / when talking to an old server that never sends gen — in that
  // case we omit it and behave exactly as before (backward compatible).
  int? _gen;
  bool _onCellularHold = false;
  StreamSubscription? _telephonySub;

  // ── CALL-RC-D2: post-connect reconnect state machine ────────────────────
  // Distinct from the pre-connect `_wsReconnects`/`_reconnectSignaling` path
  // above (kept untouched for ringing/connecting drops). This machine only
  // engages once the call was `connected` and the signaling WS drops: phase
  // goes to `reconnecting`, retries back off 0.5/1/2/4/8/8… s, capped at 30s
  // total elapsed, then gives up via hangup('reconnect_failed'). Reuses the
  // SAME `_myId` WS tag so the DO (CallRoom, CALL-RC-D1) recognizes the
  // rejoin and replays buffered signaling.
  static const List<double> _kReconnectBackoffSec = [0.5, 1, 2, 4, 8, 8, 8];
  static const Duration _kReconnectGiveUp = Duration(seconds: 30);
  bool _reconnecting = false;
  int _reconnectAttempt = 0;
  int? _reconnectStartMs;
  Timer? _reconnectRetryTimer;
  Timer? _reconnectGiveUpTimer;
  Timer? _pingTimer;

  // ── [CALL-MEDIA-WATCH-1] mid-call media-flow watchdog ───────────────────
  // Detects the "connected but silent" failure mode: ICE stays Connected and
  // the timer keeps ticking, yet inbound audio bytes stop growing (a dead RTP
  // path the ICE state machine never notices). Polls getStats() every 5s
  // while _connected and not ended; two consecutive stale polls (~10s) kicks
  // an ICE restart via the EXISTING _tryIceRestart ladder (same cap/guards as
  // net-change/transport-state triggers); four stale polls (~20s) ends the
  // call cleanly via the existing _endWith path, instead of leaving a zombie
  // call with dead audio. Never throws; every await is try/catch-guarded.
  Timer? _mediaWatchTimer;
  int _mediaStaleCount = 0;
  int? _lastInboundAudioBytes;
  bool _mediaStalledFlagged = false;
  int? _mediaStallStartMs;
  // [CALL-RELSCORE-1] Cumulative count of distinct media-stall episodes over the
  // whole call — a reliability_score input on call_ended.
  int _mediaStalls = 0;

  void _startMediaWatchdog() {
    _mediaWatchTimer?.cancel();
    _mediaStaleCount = 0;
    _lastInboundAudioBytes = null;
    _mediaStalledFlagged = false;
    _mediaStallStartMs = null;
    _mediaWatchTimer = Timer.periodic(const Duration(seconds: 5), (_) => _pollMediaWatchdog());
  }

  void _stopMediaWatchdog() {
    _mediaWatchTimer?.cancel();
    _mediaWatchTimer = null;
    _mediaStaleCount = 0;
    _lastInboundAudioBytes = null;
    _mediaStalledFlagged = false;
    _mediaStallStartMs = null;
  }

  Future<void> _pollMediaWatchdog() async {
    try {
      if (_ended || !_connected) return;
      // Media is intentionally paused/replaced during these phases — never
      // false-trigger the watchdog there.
      if (isReceptDuo || _onCellularHold) return;
      // A post-connect signaling reconnect is already handling recovery via
      // its own ladder; don't double-trigger an ICE restart or end the call
      // out from under it.
      if (_reconnecting) return;
      final pc = _pc;
      if (pc == null) return;
      int inboundAudioBytes = 0;
      bool sawInboundAudio = false;
      final stats = await pc.getStats();
      for (final s in stats) {
        if (s.type != 'inbound-rtp') continue;
        final v = s.values;
        final kindRaw = v['kind'] ?? v['mediaType'];
        final kind = kindRaw?.toString();
        if (kind != 'audio') continue;
        sawInboundAudio = true;
        final b = v['bytesReceived'];
        if (b is num) inboundAudioBytes += b.toInt();
      }
      if (!sawInboundAudio) return; // no inbound audio stat yet — don't judge
      final prev = _lastInboundAudioBytes;
      _lastInboundAudioBytes = inboundAudioBytes;
      if (prev != null && inboundAudioBytes <= prev) {
        _mediaStaleCount++;
      } else {
        if (_mediaStaleCount > 0) {
          // Recovered.
          final stalledForS = _mediaStallStartMs == null
              ? 0
              : ((DateTime.now().millisecondsSinceEpoch - _mediaStallStartMs!) / 1000).round();
          Analytics.capture('call_media_recovered', {
            'call_id': config.room,
            'stalled_for_s': stalledForS,
          });
          if (_mediaStalledFlagged && !_ended && _connected) {
            _setPhase('connected');
          }
        }
        _mediaStaleCount = 0;
        _mediaStalledFlagged = false;
        _mediaStallStartMs = null;
        return;
      }
      if (_mediaStaleCount == 1) {
        _mediaStallStartMs = DateTime.now().millisecondsSinceEpoch;
      }
      if (_mediaStaleCount == 2 && !_mediaStalledFlagged) {
        _mediaStalledFlagged = true;
        _mediaStalls++; // [CALL-RELSCORE-1] count distinct stall episodes
        Analytics.capture('call_media_stalled', {
          'call_id': config.room,
          'stale_s': 10,
          'video': config.video,
        });
        _setPhase('reconnecting');
        // ignore: unawaited_futures
        _tryIceRestart('media-stalled');
      } else if (_mediaStaleCount >= 4) {
        Analytics.capture('call_media_stalled', {
          'call_id': config.room,
          'stale_s': 20,
          'video': config.video,
        });
        if (!_reconnecting) {
          _endWith('ended', reason: 'media-stalled');
        }
      }
    } catch (_) {
      // Never let watchdog polling throw or keep a call alive.
    }
  }

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
    // [TRACE-ID-1] Adopt the trace id handed to us (dial boundary on the caller,
    // incoming push on the callee) or mint one so a trace always exists. Publish
    // it globally so EVERY Analytics.capture for the life of this call — here AND
    // in CallTelemetry (call_started/call_connected/call_ended) — carries it,
    // stitching both devices + the server under one trace_id. Cleared in teardown.
    _traceId = config.traceId.isNotEmpty ? config.traceId : TraceContext.mint();
    Analytics.currentTraceId = _traceId;
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
      case 'network-error':
        return CallPhase.ended;
      case 'reconnecting':
        return CallPhase.reconnecting;
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
        await NativeVoiceAudio.instance.startCallForegroundService(
          callId: config.room,
          peerName: config.title,
          isVideo: config.video,
          at: config.outgoing ? 'dial' : 'accept',
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
    _startPingTimer();
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
          // [CALL-DIAL-FAIL-1] The /api/call POST returned OK but the signaling
          // WS never got a 'welcome' within 8s (dead/flaky connection after the
          // dial). Distinct terminal phase (not generic 'ended') so the caller
          // sees a clear network sticker/snackbar instead of silently dying —
          // and we skip straight to it instead of waiting out the full ring
          // window + a pointless receptionist attempt.
          Analytics.capture('call_place_failed', {
            'call_id': config.room,
            'stage': 'no_server_confirm',
            'kind': config.video ? 'video' : 'audio',
          });
          _placeCallFailedNotice?.call();
          _endWith('network-error', reason: 'place-call-timeout');
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
      // CALL-RC-D2: post-connect drop → the exponential-backoff reconnect
      // state machine (phase=reconnecting), not the legacy pre-connect path.
      _beginReconnect();
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

  // ── CALL-RC-D2: post-connect reconnect state machine ────────────────────

  /// Signaling WS dropped while `connected`. Enter `reconnecting`, arm the
  /// 30s give-up timer, and kick off the first retry attempt.
  void _beginReconnect() {
    if (_ended) return;
    _stopPingTimer();
    // [CALL-MEDIA-WATCH-1] the signaling reconnect ladder owns recovery now;
    // stop polling stats so the watchdog can't race it with its own ICE
    // restart / end-call decision. Re-armed in _completeReconnect.
    _stopMediaWatchdog();
    if (!_reconnecting) {
      _reconnecting = true;
      _reconnectAttempt = 0;
      _reconnectStartMs = DateTime.now().millisecondsSinceEpoch;
      _setPhase('reconnecting');
      // peerAway is a separate signal (the OTHER peer's socket state, driven
      // by peer-away/peer-rejoined below); our own drop doesn't imply theirs.
      Analytics.capture('call_reconnect_start', {'call_id': config.room, 'video': config.video});
      _reconnectGiveUpTimer?.cancel();
      _reconnectGiveUpTimer = Timer(_kReconnectGiveUp, () {
        if (_ended || !_reconnecting) return;
        Analytics.capture('call_reconnect_fail', {
          'call_id': config.room,
          'elapsed_ms': DateTime.now().millisecondsSinceEpoch - (_reconnectStartMs ?? 0),
          'attempts': _reconnectAttempt,
        });
        _endWith('ended', reason: 'reconnect_failed');
      });
    }
    _scheduleReconnectAttempt();
  }

  void _scheduleReconnectAttempt() {
    if (_ended || !_reconnecting) return;
    _reconnectRetryTimer?.cancel();
    final idx = _reconnectAttempt.clamp(0, _kReconnectBackoffSec.length - 1);
    final delay = Duration(milliseconds: (_kReconnectBackoffSec[idx] * 1000).round());
    _reconnectAttempt++;
    _reconnectRetryTimer = Timer(delay, _attemptReconnect);
  }

  void _attemptReconnect() {
    if (_ended || !_reconnecting) return;
    // Give-up timer is the source of truth for the 30s cap; just try again.
    try { _ws?.sink.close(); } catch (_) {}
    final url = 'wss://$kSignalingHost/room/$_room?id=$_myId';
    try {
      _ws = WebSocketChannel.connect(Uri.parse(url));
      _ws!.stream.listen(_onSignal, onError: (_) => _onSocketLost(), onDone: _onSocketLost);
    } catch (_) {
      // Connection attempt itself threw synchronously — schedule the next retry.
      _scheduleReconnectAttempt();
      return;
    }
    // If this attempt doesn't yield a 'welcome' before the next backoff tick,
    // schedule the following retry; a successful 'welcome' calls
    // _completeReconnect() (which flips _reconnecting off) before it fires,
    // so the guard at the top of _scheduleReconnectAttempt no-ops it.
    _scheduleReconnectAttempt();
  }

  /// Called from the `welcome` signal handler when we reconnect mid-call
  /// (i.e. we were the one who dropped and re-attached with the same `id`).
  void _completeReconnect() {
    if (!_reconnecting) return;
    _reconnecting = false;
    _reconnectRetryTimer?.cancel();
    _reconnectGiveUpTimer?.cancel();
    final ms = DateTime.now().millisecondsSinceEpoch - (_reconnectStartMs ?? DateTime.now().millisecondsSinceEpoch);
    Analytics.capture('call_reconnect_ok', {
      'call_id': config.room,
      'ms': ms,
      'attempts': _reconnectAttempt,
    });
    _reconnectStartMs = null;
    _reconnectAttempt = 0;
    if (!_ended) {
      _setPhase('connected');
      _startPingTimer();
      // [CALL-MEDIA-WATCH-1] re-arm now that the reconnect ladder has handed
      // control back; fresh baseline avoids judging staleness across the gap.
      _startMediaWatchdog();
    }
  }

  /// 15s client ping over the signaling WS, matching the DO's
  /// `setWebSocketAutoResponse({type:"ping"}->{type:"pong"})` (CALL-RC-D1).
  /// No manual pong handling needed client-side — the DO answers without
  /// waking, and stray {"type":"pong"} frames are ignored by `_onSignal`'s
  /// switch (no matching case).
  void _startPingTimer() {
    _pingTimer?.cancel();
    _pingTimer = Timer.periodic(const Duration(seconds: 15), (_) {
      if (_ended) return;
      _send({'type': 'ping'});
    });
  }

  void _stopPingTimer() {
    _pingTimer?.cancel();
    _pingTimer = null;
  }

  void _send(Map<String, dynamic> o) {
    // CALL-GEN-1: stamp our current generation on every frame so the DO can drop
    // frames from a superseded transport. Omitted until we've received a 'welcome'
    // with a gen (old server / pre-connect) — an old server ignores the field and
    // an old client never sees it, so this is fully backward compatible.
    if (_gen != null && !o.containsKey('gen')) o['gen'] = _gen;
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
        // [CALL-MEDIA-WATCH-1] arm the media-flow watchdog now that we're live.
        _startMediaWatchdog();
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
    // CALL-GEN-1: drop stale-generation inbound frames. If a frame carries a
    // numeric `gen` LOWER than our current gen, it originated from a superseded
    // transport (a zombie socket that we've since reconnected past) — ignore it so
    // it can't disrupt the live call. Frames without a gen (old server / old peer)
    // are processed as today. 'welcome' is exempt: it CARRIES our new gen and may
    // legitimately raise it (adopted below), so it's never judged against the old.
    final dynamic gv = d['gen'];
    if (gv is num && _gen != null && gv < _gen! && d['type'] != 'welcome') {
      Analytics.capture('invariant_protected', {
        'kind': 'stale_generation_rejected',
        'side': 'client',
        'frame_gen': gv,
        'current_gen': _gen!,
        'frame_type': d['type']?.toString() ?? 'unknown',
        'call_id': config.room,
      });
      return;
    }
    if (d['country'] is String) _telemetry.setPeerCountry(d['country'] as String);
    switch (d['type']) {
      case 'welcome':
        _gotWelcome = true;
        // CALL-GEN-1: adopt the generation the DO assigned us. On a reconnect the
        // DO bumps our gen, so this raises _gen and our subsequent frames outrank
        // any lingering old-socket frames. Absent on old servers → stays null.
        if (d['gen'] is num) _gen = (d['gen'] as num).toInt();
        _placeCallTimeout?.cancel();
        final peers = (d['peers'] as List).cast<String>();
        if (peers.isNotEmpty) {
          _remoteId = peers.first;
          _weOffered = true;
          if (_connected && _pc != null) {
            _wsReconnects = 0;
            peerAway.value = false;
            Analytics.capture('call_ws_reconnected', {'call_id': config.room});
            // CALL-RC-D2: this `welcome` is the CallRoom DO recognizing OUR
            // rejoin (same `id` tag) after a signaling drop — complete the
            // reconnect state machine (phase back to connected, cancel the
            // give-up timer) before the ICE restart so the UI clears
            // "Reconnecting…" promptly.
            _completeReconnect();
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
      // CALL-RC-D1/D2: the CallRoom DO now grades a dropped peer's socket
      // through a 30s away/rejoin window instead of ending the call instantly.
      // 'peer-away' = the peer's signaling socket dropped; media may still be
      // flowing. 'peer-rejoined' = they re-attached within the window (their
      // OWN reconnect, distinct from a 'welcome' answering OUR reconnect).
      // 'peer-left' now ONLY arrives after the 30s alarm expires with no
      // rejoin — i.e. a real end, not a grace signal.
      case 'peer-away':
        if (_connected) {
          peerAway.value = true;
          Analytics.capture('call_peer_away', {'call_id': config.room});
        }
        break;
      case 'peer-rejoined':
        if (_connected) {
          peerAway.value = false;
          Analytics.capture('call_peer_rejoined', {'call_id': config.room});
          // The peer's transport blipped and recovered; proactively re-offer
          // an ICE restart from our side too (harmless if already healthy —
          // _tryIceRestart no-ops unless we're the offerer with a live pc).
          // ignore: unawaited_futures
          _tryIceRestart('peer-rejoined');
        }
        break;
      case 'peer-left':
        // Alarm expired with no rejoin — the call is over for real.
        peerAway.value = false;
        if (_connected) {
          _endWith('ended', reason: 'peer-left');
        } else {
          _connected = false;
          _bump();
        }
        break;
      case 'bye':
        remoteRenderer.srcObject = null;
        _endWith('ended', reason: 'remote-bye');
        break;
      case 'ping':
      case 'pong':
        // WS-layer keepalive frames (server auto-response / our own 15s
        // ping). Nothing to do client-side.
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
    // [CALL-DUP-SESSION-1] Never fan out a 'cancel' for a room that ANOTHER live
    // session owns. This is the teardown of a duplicate/non-primary leg (e.g. a
    // busy-rejected 3rd peer, or a redundant restore session losing the `_active`
    // slot). Sending 'cancel' here pushed a terminal status the real session
    // acted on and ended the genuine call for both parties.
    if (_anotherOwns) {
      Analytics.capture('call_cancel_suppressed_dup', {'call_id': config.room});
      return;
    }
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

  /// Red button / notification "Hang up".
  /// CALL-UI-DEAD-1: pop the UI IMMEDIATELY, then run the durable teardown in
  /// the background. The old order (`await hangup()` THEN pop) meant a
  /// half-dead WS/PC or wedged native channel hung the await forever and the
  /// red button appeared to do nothing, forcing users to kill the app.
  Future<void> endByUser() async {
    Analytics.capture('call_end_pressed', {
      'call_id': config.room,
      'phase': _phase,
      'connected': _connected,
    });
    final pop = onRequestPop;
    onRequestPop = null; // consumed here — teardown must not double-fire it
    pop?.call();
    if (_remoteId != null) _send({'type': 'bye', 'to': _remoteId});
    if (config.seed.isNotEmpty) {
      ApiAuth.postJson(kCallStatusUrl, {
        'to': config.seed, 'callId': config.room, 'status': 'ended',
      }).ignore();
    }
    _telemetry.ended('local-hangup');
    await hangup('local-hangup');
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
    // [CALL-DUP-SESSION-1] Self-inflicted-busy immunity. A 'busy' that lands on a
    // DUPLICATE/non-primary leg (this session is NOT the one connected, but
    // another live session for the same room IS connected/answered on this
    // device) is the room's 2-peer cap rejecting OUR OWN extra leg — NOT the
    // remote callee being busy. Honouring it here used to trigger the
    // receptionist + a cancel/ended fan-out that destroyed the genuine live call
    // (PostHog avatok-cdcc815d / avatok-23692246). Ignore it and let this
    // duplicate leg wither without side effects.
    if (_anotherOwns) {
      Analytics.capture('call_self_busy_ignored', {
        'call_id': config.room,
        'reason': 'another_live_session_owns_room',
      });
      return;
    }
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
    // [CALL-DUP-SESSION-1] A duplicate/non-primary leg for a room another live
    // session owns must NEVER start the receptionist — doing so would send a
    // 'bye'/cancel over the shared room and hand the caller to Ava mid-call,
    // killing the genuine connected call. Refuse without side effects.
    if (_anotherOwns) {
      Analytics.capture('ava_recept_suppressed_dup_session', {'call_id': config.room});
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

  // CALL-UI-DEAD-1: every teardown await is time-boxed so a wedged native
  // method channel, half-dead RTCPeerConnection or dead WebSocket can never
  // hang the hangup path indefinitely. Failures/timeouts are swallowed — the
  // resources are being destroyed anyway.
  Future<void> _safeAwait(Future<void>? Function() f, {int ms = 2000}) async {
    try {
      final fut = f();
      if (fut != null) await fut.timeout(Duration(milliseconds: ms));
    } catch (_) {}
  }

  Future<void> _teardown({String? reason}) async {
    if (_ended) return;
    final sw = Stopwatch()..start();
    try { _receptionist?.hangup(); } catch (_) {}
    try { WakelockPlus.disable(); } catch (_) {}
    await _safeAwait(() => NativeVoiceAudio().stopP2pAudioMode());
    await _safeAwait(() => NativeVoiceAudio().stopBluetoothSco());
    await _safeAwait(() => NativeVoiceAudio().stopProximitySensor());
    await _safeAwait(() => NativeVoiceAudio.instance
        .stopCallForegroundService(reason: reason ?? 'hangup'));
    await _safeAwait(() => NativeVoiceAudio().stopTelephonyMonitoring());
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
    // [CALL-RELSCORE-1] Hand the telemetry the session-level resilience signals it
    // can't see (mid-call reconnect attempts, forced TURN relay, callee-unreachable
    // push failure) so call_ended carries a single reliability_score + its
    // components. media_stalls + packet-loss are already tracked telemetry-side.
    _telemetry.setReliabilityInputs(
      reconnectAttempts: _reconnectAttempt,
      mediaStalls: _mediaStalls,
      relayForced: _relayForced,
      unreachable: _callUnreachable,
    );
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
    // CALL-RC-D2: cancel every reconnect/ping timer so nothing keeps firing
    // after teardown (acceptance criterion — no leaked timers post-hangup).
    _reconnecting = false;
    _reconnectRetryTimer?.cancel();
    _reconnectGiveUpTimer?.cancel();
    _stopPingTimer();
    // [CALL-MEDIA-WATCH-1]
    _stopMediaWatchdog();
    await _safeAwait(() => FlutterCallkitIncoming.endCall(config.room));
    try { _stream?.getTracks().forEach((t) => t.stop()); } catch (_) {}
    await _safeAwait(() => _pc?.close(), ms: 3000);
    await _safeAwait(() => _ws?.sink.close());
    try { localRenderer.srcObject = null; } catch (_) {}
    try { remoteRenderer.srcObject = null; } catch (_) {}
    await _safeAwait(() => _stream?.dispose());
    _stream = null;
    _pc = null;
    _ringback.dispose();
    phase.value = CallPhase.ended;
    // Dispose the renderers (they are owned by the session, not any view).
    await _safeAwait(() => localRenderer.dispose());
    await _safeAwait(() => remoteRenderer.dispose());
    if (sw.elapsedMilliseconds > 5000) {
      Analytics.capture('call_teardown_slow', {
        'call_id': config.room,
        'ms': sw.elapsedMilliseconds,
        'reason': reason ?? 'hangup',
      });
    }
    // [TRACE-ID-1] Stop stamping this call's trace on subsequent (non-call) events
    // once the call is fully torn down — but only if it's still ours (a newer
    // action may already have taken the global).
    if (Analytics.currentTraceId == _traceId) Analytics.currentTraceId = null;
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
        // [CALL-DIAL-FAIL-1]
        'network-error' => "Can't reach the network — check your connection",
        'ava-countdown' => 'Ava is taking your call…',
        'receptionist-connecting' => 'Connecting you to Ava…',
        'receptionist' => 'Ava is taking a message',
        'receptionist-wrapup' => 'Ava is wrapping up…',
        'reconnecting' => 'Reconnecting…',
        'ended' => 'Call ended',
        _ => 'Connecting…',
      };
}
