import 'dart:async';
import 'dart:convert';
import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter/material.dart';
import 'package:flutter_callkit_incoming/flutter_callkit_incoming.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';
import 'package:uuid/uuid.dart';
import 'package:wakelock_plus/wakelock_plus.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import '../../core/analytics.dart';
import '../../core/api_auth.dart';
import '../../core/avatar.dart';
import '../../core/call_log_store.dart';
import '../../core/call_telemetry.dart';
import '../../core/config.dart';
import '../../core/ice_cache.dart';
import '../../core/receptionist_api.dart';
import '../../core/receptionist_call.dart';
import '../../core/remote_config.dart';
import '../../core/ringback_player.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import '../../push/push_service.dart';

/// True while a 1:1 call is on this device — used to auto-reply "busy" to a
/// second incoming call.
bool gInCall = false;

/// Room id of the call currently on screen (null when idle). The push handler
/// uses it to tell a DUPLICATE push for the same call apart from a genuine
/// second caller, and — together with [gInCallSince] — to detect a STALE
/// [gInCall] left set by a call that never tore down. That stale flag was the
/// "phantom busy" bug: every later incoming call got auto-rejected as busy.
String? gActiveCallId;

/// Epoch-ms when the on-screen call took over. A live call can't plausibly run
/// longer than [kMaxCallLifeMs]; past that, [gInCall] is treated as stale.
int gInCallSince = 0;
const int kMaxCallLifeMs = 2 * 60 * 60 * 1000; // 2 h ceiling

/// Number of [CallScreen]s currently mounted on this device — the GROUND TRUTH
/// for "on a call right now". Incremented in [initState], decremented in
/// [_end]. The old check trusted [gInCall] for a 2 h window, so a flag leaked
/// true by an overlapping/never-torn-down call phantom-busied every later call
/// for up to two hours ("USER IS BUSY, cut out in 2 s" even though the callee
/// was free). A live-screen count can't leak past the process: a hard kill
/// resets it to 0, and every teardown path runs [_end].
int gLiveCallScreens = 0;

/// Ground truth for "the user is genuinely on a call right now", checked before
/// auto-replying busy so a leftover [gInCall] flag can never silently block
/// every future call. Backed by [gLiveCallScreens] (a real mounted-screen
/// count), NOT a time-windowed flag.
bool callIsGenuinelyActive() => gLiveCallScreens > 0;

/// AvaTok 1:1 call — the mockup CallScreen design, wired to real WebRTC P2P
/// over the Cloudflare signaling Worker. Both peers join the same [room].
class CallScreen extends StatefulWidget {
  final String room;
  final String title;
  final String seed;
  final bool video;
  final bool outgoing; // true = caller (show ringback + no-answer timeout)
  final String avatarUrl; // peer's photo ('' = initials)
  // AI Ringback: the callee's current default ringtone URL, resolved at dial
  // time (POST /api/call response). The CALLER plays this locally during the
  // ringing phase. Empty → the bundled default ringback is used instead.
  final String ringbackUrl;
  // Team IVR warm transfer: when this call was placed by the team auto-attendant,
  // these tag the no-answer voicemail so the card reaches the team manager's inbox
  // (Specs/TEAM-RECEPTIONIST-IVR-SPEC.md). Null for ordinary 1:1 calls.
  final String? teamId;
  final int? teamSlot;
  const CallScreen({
    super.key,
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
  @override
  State<CallScreen> createState() => _CallScreenState();
}

class _CallScreenState extends State<CallScreen> {
  final _local = RTCVideoRenderer();
  final _remote = RTCVideoRenderer();
  final _myId = 'app-${const Uuid().v4().substring(0, 6)}';

  WebSocketChannel? _ws;
  RTCPeerConnection? _pc;
  MediaStream? _stream;
  bool _ended = false; // guard: _end() runs exactly once (hangup + dispose race)
  String? _remoteId;
  List<Map<String, dynamic>> _ice = kIceServers;
  Timer? _timer;
  int _secs = 0;
  bool _video = true;
  bool _camOn = true;
  bool _muted = false;
  bool _speaker = true;
  bool _connected = false;
  // ringing | connecting | connected | declined | busy | no-answer | ended
  String _phase = 'connecting';
  Timer? _ringTimeout;
  // AI Ringback: caller-side playback of the callee's tune while ringing, and
  // the busy tone. One player per call; stopped on every end path.
  final RingbackPlayer _ringback = RingbackPlayer();
  ReceptionistCall? _receptionist; // Ava answers if the callee doesn't (audio only)
  // True once we've committed to handing the call to Ava. The ORIGINAL signaling
  // socket is still open at that point, and cancelling the ring makes the callee
  // emit a 'bye' — without this guard that 'bye' (or a socket close) would tear
  // down the live Ava session a second after it started (the "Ava never spoke,
  // call ended in ~1s" bug). When set, signaling teardown events are ignored;
  // the receptionist owns the call and ends it via its own done future.
  bool _receptionistActive = false;
  // v2 activation: probed from /api/receptionist/config at dial time.
  String _receptMode = 'rings';    // rings | first_ring
  int _receptRings = 5;            // Mode A ring count (RemoteConfig-driven)
  StreamSubscription? _statusSub;
  // ICE candidates that arrive before the remote description is set must be
  // buffered — addCandidate throws otherwise and the dropped candidate is often
  // the very one that would have connected the call (esp. over cellular/TURN).
  final List<RTCIceCandidate> _pendingCandidates = [];
  bool _remoteSet = false;
  // Call hardening (Scale proposal Phase 1):
  late final CallTelemetry _telemetry;
  bool _weOffered = false;          // only the offerer drives ICE restarts (no glare)
  int _iceRestarts = 0;             // cap restart attempts per call
  Timer? _failTimer;                // grace window before giving up on 'failed'
  StreamSubscription? _netSub;      // Wi-Fi ⇆ cellular handoff → ICE restart
  // Signaling-socket survival: once the call is P2P-connected the media flows
  // directly, so a dropped room socket (screen off, app backgrounded, mobile
  // DNS) must NOT end the call — we reconnect it in the background and let the
  // RTC media watchdog decide if the call is truly dead. Capped so a genuinely
  // dead network eventually gives up. (Root cause of the ~1-min 'socket-lost'.)
  int _wsReconnects = 0;
  Timer? _wsReconnectTimer;
  // Auto forced-relay fallback (symmetric-NAT / phone-hotspot rescue). On
  // UDP-restricted networks the host/srflx candidate pairs never connect and ICE
  // only falls back to TURN slowly, so the caller gives up before connect (djee's
  // hotspot: connects took 5–12s, or never landed). If we aren't connected within
  // a few seconds, rebuild the PeerConnection TURN-only so the call goes straight
  // through the relay (which Cloudflare TURN serves over UDP/TCP/TLS-443, so it
  // works even on UDP-blocked tethers). Offerer-driven (no glare); fires once.
  Timer? _relayFallbackTimer;
  bool _relayForced = false;

  @override
  void initState() {
    super.initState();
    gLiveCallScreens++;
    gInCall = true;
    gActiveCallId = widget.room;
    gInCallSince = DateTime.now().millisecondsSinceEpoch;
    // Keep the device awake for the whole call. Without this, the screen turning
    // off (or auto-sleep) suspended the isolate and tore the call down after
    // ~1 min — the "screen took over and the call cut" report (issue 6). Released
    // on every teardown path in [_end]. Best-effort: never let it block a call.
    try { WakelockPlus.enable(); } catch (_) {}
    _telemetry = CallTelemetry(callId: widget.room, video: widget.video, outgoing: widget.outgoing);
    _telemetry.started(); // funnel root: started → connected → ended
    // Wi-Fi ⇆ cellular handoff: don't wait for the transport to time out — restart
    // ICE proactively so the call survives leaving the house mid-conversation.
    _netSub = Connectivity().onConnectivityChanged.listen((_) {
      if (_connected && !_ended) {
        _telemetry.onNetChange();
        _tryIceRestart('net-change');
      }
    });
    _video = widget.video;
    _camOn = widget.video;
    _speaker = widget.video;
    _phase = widget.outgoing ? 'ringing' : 'connecting';
    if (widget.outgoing) {
      // Default ring window (Mode A, ~5 rings). Audio calls also probe the
      // callee's receptionist config: if they're on "answer every call on the
      // first ring" (Mode B), we re-arm a short window and hand off to Ava early.
      _ringTimeout = Timer(const Duration(seconds: 35), () {
        if (mounted && !_connected) _onNoAnswer();
      });
      if (!widget.video) {
        // ignore: unawaited_futures
        _probeReceptionist();
      }
      // Caller hears the callee's AI ringback (or the bundled default) while
      // ringing. Gated by the server kill switch (mirrored in RemoteConfig).
      if (RemoteConfig.ringbackEnabled) {
        // ignore: unawaited_futures
        _ringback.playRingback(widget.ringbackUrl);
        Analytics.capture('ringback_played', {
          'source': widget.ringbackUrl.isEmpty ? 'default' : 'custom',
          'video': widget.video,
        });
      }
    }
    // Server-relayed call status (declined / busy / decline-to-Ava) for this call.
    _statusSub = callStatusBus.stream.listen((e) {
      // Once Ava has taken over, ignore call-status pushes — including the
      // 'cancel' WE sent to stop the callee's ring, which echoes back here and
      // would otherwise end the live receptionist session ~2s in (telemetry
      // showed call_ended reason='cancel' killing Ava mid-greeting).
      if (_receptionistActive) {
        if (e.callId == widget.room) {
          Analytics.capture('ava_recept_signal_suppressed',
              {'channel': 'call_status', 'status': e.status, 'call_id': widget.room});
        }
        return;
      }
      // A terminal status from the peer (they hung up / cancelled, or the server
      // relayed 'ended') must tear THIS side down even when already CONNECTED.
      // This is the durable backstop for a lost WS 'bye' that used to leave the
      // other party live and still talking after a hangup.
      if (e.callId == widget.room && mounted && !_ended &&
          (e.status == 'ended' || e.status == 'cancel' || e.status == 'bye')) {
        _endWith('ended', reason: 'remote-ended-push');
        return;
      }
      if (e.callId == widget.room && mounted && !_connected) {
        // v2 Mode C: the callee hit Decline with "let Ava take calls I decline"
        // on → 'decline_ava'. Hand off to the receptionist instead of ending.
        // Audio only. (Standard 2-button incoming UI — Decline IS the trigger.)
        if (e.status == 'decline_ava' && !widget.video && !_ended) {
          _ringTimeout?.cancel();
          // ignore: unawaited_futures
          _handoffToAva('decline');
          return;
        }
        // A busy callee is exactly when a message matters most — route through
        // the receptionist before giving the caller a dead busy tone.
        if (e.status == 'busy') {
          // ignore: unawaited_futures
          _onBusy();
          return;
        }
        // Belt-and-suspenders for decline_ava: a PLAIN decline on an audio call
        // also attempts Ava. If the callee has no receptionist, _tryReceptionist
        // returns false and we fall back to a normal "declined" — so a rejected
        // call never dead-ends when the callee actually has Ava enabled.
        if (e.status == 'decline' && !widget.video && !_ended) {
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
      name: widget.title, seed: widget.seed, video: widget.video,
      dir: widget.outgoing ? CallDir.outgoing : CallDir.incoming,
      ts: DateTime.now().millisecondsSinceEpoch ~/ 1000,
    ));
    _start();
  }

  /// [phase] drives the UI label; [reason] is the exhaustive telemetry taxonomy
  /// (A4.5): local-hangup|remote-bye|peer-left|decline|busy|socket-lost|
  /// rtc-failed|rtc-disconnected|timeout-ringing.
  void _endWith(String phase, {String? reason}) {
    _telemetry.ended(reason ?? phase);
    _ringback.stop(); // silence any ringback on every end path
    // Busy tone: the callee is already on a call (auto-replied 'busy', or the
    // CallRoom DO rejected a 3rd peer). The CALLER hears the bundled busy tone.
    final busy = phase == 'busy' && widget.outgoing && RemoteConfig.ringbackEnabled;
    if (busy) {
      // ignore: unawaited_futures
      _ringback.playBusyTone();
      Analytics.capture('busy_tone_played', const {});
    }

    // Release mic/cam IMMEDIATELY on every end path (remote hangup, decline,
    // busy, no-answer, failure) — not 1.4s later when the route finally pops.
    // This is what stops the green mic indicator lingering after the other side
    // ends the call. _end() is idempotent, so the later dispose() is harmless.
    _end();
    if (!mounted) return;
    setState(() => _phase = phase);
    // Give the busy tone time to be heard before the screen pops (it stops on
    // dispose). Other end states keep the original snappy 1.4s.
    Future.delayed(Duration(milliseconds: busy ? 2600 : 1400), () {
      if (mounted) Navigator.maybePop(context);
    });
  }

  String get _room => widget.room;

  Future<void> _fetchIce() async {
    // Pre-warmed cache (IceCache.prefetch fires when the call becomes likely),
    // so this is usually instant instead of an HTTPS round-trip during setup.
    _ice = await IceCache.get();
  }

  /// FREE LAUNCH §2: tune the Opus encoder on the LOCAL SDP for voice — in-band
  /// FEC (packet-loss resilience), DTX (silence suppression → less bandwidth on
  /// a 1:1 call), and a ~40 kbps average-bitrate cap (the voice sweet spot,
  /// 32–48 kbps band). Only the opus `a=fmtp` line is rewritten; video m-lines
  /// and everything else are untouched. Safe no-op when no opus payload exists.
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

  /// Apply the Opus tuning to a freshly created offer/answer before it becomes
  /// our local description (and is signalled to the peer).
  RTCSessionDescription _tuned(RTCSessionDescription d) =>
      RTCSessionDescription(_tuneOpusSdp(d.sdp), d.type);

  Future<void> _start() async {
    await _local.initialize();
    await _remote.initialize();
    await _fetchIce();
    try {
      // FREE LAUNCH audio quality (Specs/FREE-LAUNCH-DIRECTION.md §2): explicit
      // capture DSP — echo cancellation + noise suppression + auto gain — instead
      // of bare `audio: true`. Both the W3C keys and the legacy goog* mandatory
      // keys are sent so the chain is on across WebRTC backends. Opus FEC/DTX/
      // bitrate are applied separately via _tuneOpusSdp() on the local SDP.
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
        'video': widget.video ? {'facingMode': 'user'} : false,
      });
    } catch (e) {
      // Mic/cam permission denied or device busy — don't hang on "Connecting…".
      // Telemetry: distinct setup-failure reason so support can see "the call
      // never started because mic/cam was blocked" (pulled by the user's email).
      Analytics.error(
        domain: 'call_setup',
        code: 'media_denied',
        message: e.toString(),
        action: widget.video ? 'getUserMedia_av' : 'getUserMedia_audio',
        extra: {'call_id': widget.room, 'video': widget.video},
      );
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
            content: Text('Microphone permission is needed to make a call')));
      }
      _endWith('ended', reason: 'media-denied');
      return;
    }
    _local.srcObject = _stream;
    // Route audio output: speaker for video, earpiece for voice. The in-call
    // speaker button toggles this for real (previously it did nothing).
    try { await Helper.setSpeakerphoneOn(_speaker); } catch (_) {}
    _timer = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted) setState(() => _secs++);
    });
    final url = 'wss://$kSignalingHost/room/$_room?id=$_myId';
    _ws = WebSocketChannel.connect(Uri.parse(url));
    // Zombie-call hotfix (A4.1): a dead signaling socket means hangup/decline
    // can never reach us — never ignore it. (_end() closes the socket itself,
    // so _onSocketLost checks _ended to stay a no-op on normal teardown.)
    _ws!.stream.listen(_onSignal, onError: (_) => _onSocketLost(), onDone: _onSocketLost);
    // Symmetric-NAT / phone-hotspot rescue: if we haven't connected on direct or
    // STUN paths within a few seconds, force a TURN-only path so the call lands
    // via the relay instead of timing out (djee's hotspot never connected).
    _relayFallbackTimer = Timer(const Duration(seconds: 7), () {
      if (mounted && !_connected && !_ended) _forceRelayRestart();
    });
  }

  /// Rebuild the PeerConnection TURN-only and re-offer, so a call that couldn't
  /// connect on direct/STUN paths (symmetric NAT, UDP-blocked tether) routes
  /// straight through the relay. Offerer-driven to avoid glare; fires at most
  /// once per call. The answerer simply answers the new relay offer on its
  /// existing connection — only one side needs to be relay-only for the pair to
  /// traverse the restrictive NAT.
  Future<void> _forceRelayRestart() async {
    if (_ended || _connected || _relayForced) return;
    if (!_weOffered || _remoteId == null) return; // only the offerer drives it
    _relayForced = true;
    _telemetry.onIceRestart();
    Analytics.capture('call_relay_fallback', {'call_id': widget.room, 'video': widget.video});
    try {
      try { await _pc?.close(); } catch (_) {}
      _pc = null;
      _remoteSet = false;
      _pendingCandidates.clear();
      final pc = await _newPC(forceRelay: true);
      final offer = _tuned(await pc.createOffer());
      await pc.setLocalDescription(offer);
      _send({'type': 'offer', 'to': _remoteId, 'sdp': offer.toMap()});
    } catch (_) {/* the ring/fail timers still bound the attempt */}
  }

  void _onSocketLost() {
    // Once Ava has taken over, the original signaling socket is irrelevant —
    // closing/losing it must NOT end the live receptionist session.
    if (_ended) return;
    if (_receptionistActive) {
      Analytics.capture('ava_recept_signal_suppressed',
          {'channel': 'socket_lost', 'call_id': widget.room});
      return;
    }
    // A CONNECTED call runs P2P; the signaling socket is only needed for
    // renegotiation/bye. Losing it (screen off, backgrounded, mobile DNS) must
    // NOT end a live call — reconnect the room in the background. The media
    // watchdog (onConnectionState) is the only thing allowed to end a connected
    // call, and only when the actual media stops.
    if (_connected) {
      Analytics.capture('call_ws_reconnect',
          {'call_id': widget.room, 'attempt': _wsReconnects + 1});
      _reconnectSignaling();
      return;
    }
    // Not connected yet → the handshake can't complete without signaling; end.
    _endWith('ended', reason: 'socket-lost');
  }

  /// Re-open the room signaling socket after it dropped mid-call. Media is P2P
  /// and keeps flowing; this just restores the channel so renegotiation / ICE
  /// restarts / a clean 'bye' can still happen. Backed off and capped.
  void _reconnectSignaling() {
    if (_ended || !_connected) return;
    if (_wsReconnects >= 5) return; // give up — net is genuinely gone
    _wsReconnects++;
    _wsReconnectTimer?.cancel();
    _wsReconnectTimer = Timer(Duration(milliseconds: 600 * _wsReconnects), () {
      if (_ended || !_connected) return;
      try { _ws?.sink.close(); } catch (_) {}
      final url = 'wss://$kSignalingHost/room/$_room?id=$_myId';
      try {
        _ws = WebSocketChannel.connect(Uri.parse(url));
        _ws!.stream.listen(_onSignal, onError: (_) => _onSocketLost(), onDone: _onSocketLost);
      } catch (_) {
        _onSocketLost(); // schedule the next backoff attempt
      }
    });
  }

  void _send(Map<String, dynamic> o) => _ws?.sink.add(jsonEncode(o));

  /// Parse the ICE candidate type ("typ host|srflx|relay|prflx") from a
  /// candidate SDP line, for STUN-vs-TURN reliance telemetry.
  static String _candTypeOf(String? cand) {
    if (cand == null) return '';
    final m = RegExp(r'typ (\w+)').firstMatch(cand);
    return m?.group(1) ?? '';
  }

  Future<RTCPeerConnection> _newPC({bool forceRelay = false}) async {
    final pc = await createPeerConnection({
      'iceServers': _ice,
      // Pre-gather a small candidate pool so the (slower) TURN-relay candidates
      // are ready sooner — shaves setup time on restrictive networks.
      'iceCandidatePoolSize': 2,
      // TURN-only when the diagnostics toggle is on, OR when the auto relay
      // fallback kicks in for a symmetric-NAT / hotspot call that wouldn't
      // connect on direct paths.
      if (CallDiag.turnOnly || forceRelay) 'iceTransportPolicy': 'relay',
    });
    _stream!.getTracks().forEach((t) => pc.addTrack(t, _stream!));
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
    pc.onTrack = (e) {
      if (e.streams.isNotEmpty) {
        _remote.srcObject = e.streams[0];
        _ringTimeout?.cancel();
        _failTimer?.cancel();
        _relayFallbackTimer?.cancel(); // connected — no relay fallback needed
        _ringback.stop(); // call answered — silence the ringback
        _telemetry.connected(pc);
        if (mounted) setState(() { _connected = true; _phase = 'connected'; });
      }
    };
    pc.onConnectionState = (s) {
      if (!mounted || !_connected) return;
      if (s == RTCPeerConnectionState.RTCPeerConnectionStateClosed) {
        _endWith('ended');
      } else if (s == RTCPeerConnectionState.RTCPeerConnectionStateFailed ||
                 s == RTCPeerConnectionState.RTCPeerConnectionStateDisconnected) {
        // Media watchdog (A4.2). `failed` with no restart available ends the
        // call NOW; otherwise try an ICE restart and give it a 10 s grace
        // window before ending with the precise reason.
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
          if (mounted && _connected &&
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

  /// ICE restart (offerer-driven to avoid offer glare): new offer with fresh
  /// candidates over the still-open signaling socket. Capped per call.
  Future<void> _tryIceRestart(String why) async {
    final pc = _pc;
    if (pc == null || _ended || !_weOffered || _remoteId == null) return;
    if (_iceRestarts >= 3) return;
    _iceRestarts++;
    _telemetry.onIceRestart();
    try {
      _ice = await IceCache.get(); // fresh short-lived TURN creds
      final offer = _tuned(await pc.createOffer({'iceRestart': true}));
      await pc.setLocalDescription(offer);
      _send({'type': 'offer', 'to': _remoteId, 'sdp': offer.toMap()});
    } catch (_) {/* transport may already be gone; the fail timer decides */}
  }

  /// Apply any ICE candidates that arrived before the remote description existed.
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
    // Ava owns the call now — ignore any late signaling (bye/peer-left/busy from
    // the cancelled ring) so it can't kill the live receptionist session.
    if (_receptionistActive) {
      String? t;
      try { t = (jsonDecode(raw as String) as Map)['type']?.toString(); } catch (_) {}
      Analytics.capture('ava_recept_signal_suppressed',
          {'channel': 'signaling', if (t != null) 'type': t, 'call_id': widget.room});
      return;
    }
    final d = jsonDecode(raw as String) as Map<String, dynamic>;
    // Peer geo (when the signaling server relays it) → both ends' country on one
    // telemetry row. Best-effort; harmless when absent.
    if (d['country'] is String) _telemetry.setPeerCountry(d['country'] as String);
    switch (d['type']) {
      case 'welcome':
        final peers = (d['peers'] as List).cast<String>();
        if (peers.isNotEmpty) {
          _remoteId = peers.first;
          _weOffered = true; // we drive renegotiation/ICE restarts for this call
          if (_connected && _pc != null) {
            // We RE-joined the room after a signaling-socket drop (issue 1). The
            // P2P media is still live — do NOT build a new PeerConnection (that
            // would tear the call down). Just refresh ICE on the existing one so
            // the restored channel re-establishes connectivity if needed.
            _wsReconnects = 0;
            Analytics.capture('call_ws_reconnected', {'call_id': widget.room});
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
        _remoteId = d['from'] as String;
        final pc = _pc ?? await _newPC();
        await pc.setRemoteDescription(RTCSessionDescription(d['sdp']['sdp'], d['sdp']['type']));
        await _flushCandidates();
        final ans = _tuned(await pc.createAnswer());
        await pc.setLocalDescription(ans);
        _send({'type': 'answer', 'to': _remoteId, 'sdp': ans.toMap()});
        break;
      case 'answer':
        await _pc?.setRemoteDescription(RTCSessionDescription(d['sdp']['sdp'], d['sdp']['type']));
        await _flushCandidates();
        break;
      case 'candidate':
        final c = d['candidate'];
        final cand = RTCIceCandidate(c['candidate'], c['sdpMid'], c['sdpMLineIndex']);
        // Buffer until the remote description is set, else addCandidate throws.
        if (_pc == null || !_remoteSet) {
          _pendingCandidates.add(cand);
        } else {
          await _pc!.addCandidate(cand);
        }
        break;
      case 'decline':
        // Audio decline → try Ava first (she takes a message); fall back to a
        // plain "declined" if the callee has no receptionist. Mirrors the
        // call-status path so the WS and FCM signals behave identically.
        // Guard against a double handoff when BOTH the WS and FCM decline land.
        if (_receptionistActive) break;
        if (!widget.video && !_connected && !_ended) {
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
            // Explicit hangup by the peer → end the call.
            _remote.srcObject = null;
            _endWith('ended', reason: 'remote-bye');
          } else {
            // 'peer-left' = the peer's SIGNALING socket dropped (screen off,
            // backgrounded, mobile DNS) — NOT a hangup. Their P2P media is
            // usually still flowing, so keep the call (and the remote video)
            // alive; the RTC media watchdog ends it only if media truly stops.
            // This is the peer-side half of surviving a signaling blip (issue 1).
            Analytics.capture('call_peer_left_grace', {'call_id': widget.room});
          }
        } else if (isBye) {
          // Hangup-before-connect (the zombie-call race): the remote ended the
          // call while we were still ringing/connecting — end OUR side too
          // instead of sitting in "Connecting…" forever.
          _endWith('ended', reason: 'remote-bye');
        } else if (mounted) {
          setState(() => _connected = false);
        }
        break;
    }
  }

  String get _clock {
    final m = (_secs ~/ 60).toString().padLeft(2, '0');
    final s = (_secs % 60).toString().padLeft(2, '0');
    return '$m:$s';
  }

  void _toggleMute() {
    _muted = !_muted;
    _stream?.getAudioTracks().forEach((t) => t.enabled = !_muted);
    setState(() {});
  }

  void _toggleSpeaker() {
    setState(() => _speaker = !_speaker);
    Helper.setSpeakerphoneOn(_speaker); // earpiece ⇆ loudspeaker (WebRTC path)
    // Route the receptionist's native audio engine too, so the speaker button
    // works while the caller is talking to Ava.
    // ignore: unawaited_futures
    _receptionist?.setSpeaker(_speaker);
  }

  /// Caller gave up before the callee answered → push a 'cancel' so their phone
  /// stops ringing (the WS 'bye' can't reach a callee who never joined the room).
  void _notifyCalleeCanceled() {
    // Post-Nostr-pivot the seed is a uid, not an `npub1…` — so the old
    // `startsWith('npub1')` guard meant this cancel was NEVER sent, and the
    // callee's phone rang until it was dismissed by hand. Send for any non-empty
    // recipient; the server resolves the address.
    if (widget.seed.isEmpty) return;
    ApiAuth.postJson(kCallStatusUrl, {
      'to': widget.seed, 'callId': widget.room, 'status': 'cancel',
    }).ignore();
    Analytics.capture('call_cancel_sent', {'call_id': widget.room});
  }

  void _toggleCam() {
    if (!_video) {
      // upgrade to video
      setState(() { _video = true; _camOn = true; _speaker = true; });
      _restartWithVideo();
      return;
    }
    _camOn = !_camOn;
    _stream?.getVideoTracks().forEach((t) => t.enabled = _camOn);
    setState(() {});
  }

  Future<void> _restartWithVideo() async {
    if (_ended) return;
    try {
      // Add a camera track to the existing audio call.
      final v = await navigator.mediaDevices
          .getUserMedia({'video': {'facingMode': 'user'}, 'audio': false});
      final track = v.getVideoTracks().first;
      await _stream?.addTrack(track);
      _local.srcObject = _stream;
      if (_stream != null) await _pc?.addTrack(track, _stream!);
      // Adding a track REQUIRES renegotiation. Without a fresh offer the peer
      // never learns about the new video m-line — the camera button "did
      // nothing" and the far side stayed audio-only (issue 5). Send a new offer
      // over the still-open signaling socket; the peer answers on its existing
      // PeerConnection and the video starts flowing.
      if (!_ended && _pc != null && _remoteId != null) {
        final offer = _tuned(await _pc!.createOffer());
        await _pc!.setLocalDescription(offer);
        _send({'type': 'offer', 'to': _remoteId, 'sdp': offer.toMap()});
        Analytics.capture('call_video_upgraded', {'call_id': widget.room});
      }
    } catch (_) {/* upgrade is best-effort — the audio call keeps going */}
    if (mounted) setState(() {});
  }

  Future<void> _hangup() async {
    if (_remoteId != null) _send({'type': 'bye', 'to': _remoteId});
    // Durable hangup: the WS 'bye' can be lost (a dead/half-open socket, or the
    // peer on a flaky network), which used to leave the OTHER side LIVE and still
    // talking after we hung up. Also push an 'ended' status through the server so
    // the peer tears down for sure — it lands even when the signaling socket is
    // gone. Best-effort; never blocks closing our own screen.
    if (widget.seed.isNotEmpty) {
      ApiAuth.postJson(kCallStatusUrl, {
        'to': widget.seed, 'callId': widget.room, 'status': 'ended',
      }).ignore();
    }
    _telemetry.ended('local-hangup'); // before _end()'s generic fallback fires
    await _end();
    if (mounted) Navigator.pop(context);
  }

  /// Ring timed out. Before showing "No answer", try Ava Receptionist (audio
  /// calls only, premium callee). If Ava picks up, the caller talks to her here.
  /// Spec: Specs/PROPOSAL-AI-RECEPTIONIST.md.
  Future<void> _onNoAnswer() async {
    _ringback.stop(); // ringing window over — stop before receptionist takeover
    if (!widget.video && !_ended) {
      final started = await _tryReceptionist(
          activationMode: _receptMode == 'first_ring' ? 'first_ring' : 'rings');
      if (started) return;
    }
    if (mounted && !_connected) _endWith('no-answer', reason: 'timeout-ringing');
  }

  /// Callee auto-replied "busy" (already on a call, or the room rejected a 3rd
  /// peer). Before giving the caller a dead busy tone, try the AI receptionist
  /// (audio calls, premium callee) so Ava can still take a message — a busy
  /// callee is the case where voicemail matters most, and the old code skipped
  /// it entirely (busy → tone → end, receptionist never reached). If Ava can't
  /// pick up, fall back to the busy tone + end as before.
  Future<void> _onBusy() async {
    if (_ended || _connected) return;
    _ringTimeout?.cancel();
    _ringback.stop();
    Analytics.capture('call_busy_received', {
      'call_id': widget.room,
      'recept_mode': _receptMode,
      'video': widget.video,
    });
    if (!widget.video) {
      final started = await _tryReceptionist(
          activationMode: _receptMode == 'first_ring' ? 'first_ring' : 'rings');
      if (started) return;
    }
    if (mounted && !_connected && !_ended) _endWith('busy', reason: 'busy');
  }

  /// Probe the callee's receptionist config at dial time (audio only) so we know
  /// HOW to hand off. Mode B ("answer on first ring") shortens the ring window to
  /// one ring; Mode A re-arms to the configured ring count. Best-effort: on any
  /// failure we keep the default 35s no-answer window.
  Future<void> _probeReceptionist() async {
    try {
      final cfg = await ReceptionistApi.configFor(widget.seed);
      if (!mounted || _connected || _ended || cfg == null) return;
      _receptMode = (cfg['mode'] ?? 'rings').toString();
      _receptRings = (cfg['rings'] as num?)?.toInt() ?? 5;
      if (_receptMode == 'first_ring') {
        _ringTimeout?.cancel();
        _ringTimeout = Timer(const Duration(seconds: 6), () {
          if (mounted && !_connected) _onNoAnswer();
        });
      } else {
        // Map ring count to a window (~5s/ring ≈ real ring cadence), capped so a
        // misconfig can't hang. e.g. 3 rings → ~15s before Ava takes over.
        final secs = (_receptRings * 5).clamp(12, 45);
        _ringTimeout?.cancel();
        _ringTimeout = Timer(Duration(seconds: secs), () {
          if (mounted && !_connected) _onNoAnswer();
        });
      }
    } catch (_) {/* keep default window */}
  }

  /// Callee declined the call with decline-to-Ava enabled. Stop ringing and
  /// connect to the receptionist; if she can't pick up, end normally.
  Future<void> _handoffToAva(String activationMode) async {
    _ringback.stop();
    final started = await _tryReceptionist(activationMode: activationMode);
    if (!started && mounted && !_connected) {
      _endWith('declined', reason: 'receptionist-unavailable');
    }
  }

  Future<bool> _tryReceptionist({String activationMode = 'rings'}) async {
    // Commit to Ava: from here, ignore the old signaling socket so a late
    // bye/peer-left from cancelling the ring can't tear down the live session.
    _receptionistActive = true;
    try {
      // Free the WebRTC mic so the PCM recorder can capture (no double-grab).
      try { _stream?.getTracks().forEach((t) => t.stop()); } catch (_) {}
      try { await _pc?.close(); } catch (_) {}
      _pc = null;
      // Caller didn't get an answer → stop the callee's phone ringing; Ava takes it.
      _notifyCalleeCanceled();

      final call = ReceptionistCall(
          calleeUid: widget.seed, callId: widget.room, activationMode: activationMode,
          speaker: _speaker, teamId: widget.teamId, teamSlot: widget.teamSlot);
      call.onStatus = (s) {
        if (!mounted) return;
        setState(() {
          _phase = switch (s) {
            'connecting' => 'receptionist-connecting',
            'connected' => 'receptionist',
            'wrapup' => 'receptionist-wrapup',
            _ => _phase,
          };
        });
      };
      final ok = await call.start();
      if (!ok) return false;
      _receptionist = call;
      call.done.then((_) {
        if (mounted && !_ended) _endWith('ended', reason: 'receptionist-done');
      });
      return true;
    } catch (_) {
      return false;
    }
  }

  Future<void> _end() async {
    if (_ended) return; // idempotent — hangup AND dispose both call this
    try { _receptionist?.hangup(); } catch (_) {}
    try { WakelockPlus.disable(); } catch (_) {} // release the call wakelock
    _ended = true;
    // Decrement the live-screen count (never below 0) and derive [gInCall] from
    // it, so overlapping calls tearing down in any order leave an accurate
    // "on a call" state instead of a leaked flag that phantom-busies later calls.
    if (gLiveCallScreens > 0) gLiveCallScreens--;
    gInCall = gLiveCallScreens > 0;
    if (gActiveCallId == widget.room) {
      gActiveCallId = null;
      gInCallSince = 0;
    }
    _telemetry.ended(_connected ? 'ended' : _phase); // no-op if already reported
    // Outgoing call torn down before it connected → tell the callee to stop ringing.
    if (widget.outgoing && !_connected) _notifyCalleeCanceled();
    _timer?.cancel();
    _ringTimeout?.cancel();
    _failTimer?.cancel();
    _wsReconnectTimer?.cancel();
    _relayFallbackTimer?.cancel();
    _netSub?.cancel();
    // End-path hygiene (A4.4): clear the CallKit/ongoing-call notification +
    // ringtone on EVERY end path, not just the explicit decline. Without this a
    // dead peer leaves a stale "ongoing call" banner on the callee's phone.
    try { await FlutterCallkitIncoming.endCall(widget.room); } catch (_) {}
    // Release the mic/cam FULLY. On Android, track.stop() alone leaves the OS
    // privacy mic indicator (green dot) lit until the MediaStream is disposed
    // AND detached from the renderers — which is why the mic stayed "in use"
    // after hanging up. Order: stop capture → close PC/WS → drop renderer refs
    // → dispose the stream.
    try { _stream?.getTracks().forEach((t) => t.stop()); } catch (_) {}
    try { await _pc?.close(); } catch (_) {}
    try { await _ws?.sink.close(); } catch (_) {}
    try { _local.srcObject = null; } catch (_) {}
    try { _remote.srcObject = null; } catch (_) {}
    try { await _stream?.dispose(); } catch (_) {}
    _stream = null;
    _pc = null;
  }

  String get _statusText => switch (_phase) {
        'ringing' => 'Ringing…',
        'connected' => 'Connected · end-to-end encrypted',
        'declined' => 'Call declined',
        'busy' => 'User is busy',
        'no-answer' => 'No answer',
        'receptionist-connecting' => 'Connecting you to Ava…',
        'receptionist' => 'Ava is taking a message',
        'receptionist-wrapup' => 'Ava is wrapping up…',
        'ended' => 'Call ended',
        _ => 'Connecting…',
      };

  @override
  void dispose() {
    _statusSub?.cancel();
    _ringback.dispose();
    _end();
    _local.dispose();
    _remote.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final showVideo = _video && _camOn;
    final light = !showVideo; // audio call → zine paper screen
    final failed = _phase == 'declined' || _phase == 'busy' || _phase == 'no-answer';
    // Reserve the phone's bottom system inset (gesture pill / 3-button nav) so
    // the call controls always sit ABOVE the device navigation, on every screen.
    final bottomInset = MediaQuery.of(context).padding.bottom;
    final stack = Stack(
      children: [
        if (showVideo) ...[
          Positioned.fill(
            child: _connected
                ? RTCVideoView(_remote, objectFit: RTCVideoViewObjectFit.RTCVideoViewObjectFitCover)
                : Container(color: Zine.ink),
          ),
          // Flat ink-alpha top band (no gradient scrims — zine rule).
          Positioned(top: 0, left: 0, right: 0, height: 128,
              child: Container(color: Zine.ink.withValues(alpha: 0.45))),
          // Self thumbnail — ink ring + hard offset shadow.
          Positioned(
            top: 56, right: 16, width: 78, height: 112,
            child: Container(
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(Zine.rSm),
                border: Zine.border,
                boxShadow: Zine.shadowSm,
              ),
              clipBehavior: Clip.antiAlias,
              child: RTCVideoView(_local, mirror: true,
                  objectFit: RTCVideoViewObjectFit.RTCVideoViewObjectFitCover),
            ),
          ),
        ],

        // header: zine back circle + (video chrome) name + mono state/timer
        SafeArea(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(14, 8, 14, 0),
            child: Row(
              children: [
                ZineBackButton(onTap: _hangup),
                const SizedBox(width: 12),
                if (showVideo)
                  Expanded(
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Text(widget.title,
                          maxLines: 1, overflow: TextOverflow.ellipsis,
                          // White text only inside the ink-alpha band over video.
                          style: ZineText.cardTitle(size: 18, color: Colors.white)),
                      const SizedBox(height: 2),
                      Text((_connected ? _clock : _statusText).toUpperCase(),
                          maxLines: 1, overflow: TextOverflow.ellipsis,
                          style: ZineText.tag(size: 11, color: Colors.white)),
                    ]),
                  ),
              ],
            ),
          ),
        ),

        // audio call: paper screen — ink-ringed avatar w/ hard shadow, Nunito
        // name, mono call-state sticker ('RINGING…', timer, …).
        if (light)
          Center(
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 24),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Container(
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      border: Zine.borderLg,
                      boxShadow: Zine.shadow,
                    ),
                    child: Avatar(seed: widget.seed, name: widget.title, size: 132,
                        avatarUrl: widget.avatarUrl.isEmpty ? null : widget.avatarUrl),
                  ),
                  const SizedBox(height: 24),
                  Text(widget.title, textAlign: TextAlign.center,
                      style: ZineText.hero(size: 30)),
                  const SizedBox(height: 16),
                  ZineSticker(
                    _connected ? _clock : _statusText,
                    kind: failed ? ZineStickerKind.no : ZineStickerKind.plain,
                  ),
                ],
              ),
            ),
          ),

        // control row — bordered zine circles; hang-up = coral circle.
        Positioned(
          left: 0, right: 0, bottom: 0,
          child: Container(
            color: light ? null : Zine.ink.withValues(alpha: 0.45),
            // 20px breathing room + the system nav inset (min 16 when there's
            // no inset, e.g. older 3-button bars that don't report one).
            padding: EdgeInsets.fromLTRB(16, 16, 16, 20 + (bottomInset > 0 ? bottomInset : 16)),
            child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
              _btn(PhosphorIcons.chatCircle(PhosphorIconsStyle.bold), onTap: () {}),
              const SizedBox(width: 14),
              _btn(
                  _speaker
                      ? PhosphorIcons.speakerHigh(PhosphorIconsStyle.bold)
                      : PhosphorIcons.speakerSlash(PhosphorIconsStyle.bold),
                  active: _speaker, onTap: _toggleSpeaker),
              const SizedBox(width: 14),
              ZinePressable(
                onTap: _hangup,
                color: Zine.coral,
                radius: BorderRadius.circular(100),
                boxShadow: Zine.shadowSm,
                child: SizedBox(
                  width: 60, height: 60,
                  child: Center(
                    child: PhosphorIcon(
                        PhosphorIcons.phoneDisconnect(PhosphorIconsStyle.bold),
                        size: 27, color: Colors.white),
                  ),
                ),
              ),
              const SizedBox(width: 14),
              _btn(
                  _video && _camOn
                      ? PhosphorIcons.videoCamera(PhosphorIconsStyle.bold)
                      : PhosphorIcons.videoCameraSlash(PhosphorIconsStyle.bold),
                  active: _video && _camOn, onTap: _toggleCam),
              const SizedBox(width: 14),
              _btn(
                  _muted
                      ? PhosphorIcons.microphoneSlash(PhosphorIconsStyle.bold)
                      : PhosphorIcons.microphone(PhosphorIconsStyle.bold),
                  active: !_muted, onTap: _toggleMute),
            ]),
          ),
        ),
      ],
    );
    return Scaffold(
      backgroundColor: light ? Zine.paper : Zine.ink,
      body: light ? ZinePaper(child: stack) : stack,
    );
  }

  // Zine control circle — ink border, card fill, hard shadow; active = lime.
  Widget _btn(IconData icon, {bool active = false, required VoidCallback onTap}) {
    return ZinePressable(
      onTap: onTap,
      color: active ? Zine.lime : Zine.card,
      pressedColor: Zine.lime,
      radius: BorderRadius.circular(100),
      boxShadow: Zine.shadowXs,
      child: SizedBox(
        width: 48, height: 48,
        child: Center(child: PhosphorIcon(icon, size: 21, color: Zine.ink)),
      ),
    );
  }
}
