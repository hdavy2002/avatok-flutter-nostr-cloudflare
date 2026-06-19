import 'dart:async';
import 'dart:convert';
import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter/material.dart';
import 'package:flutter_callkit_incoming/flutter_callkit_incoming.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';
import 'package:uuid/uuid.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import '../../core/api_auth.dart';
import '../../core/avatar.dart';
import '../../core/call_log_store.dart';
import '../../core/call_telemetry.dart';
import '../../core/config.dart';
import '../../core/ice_cache.dart';
import '../../core/receptionist_call.dart';
import '../../core/remote_config.dart';
import '../../core/ringback_player.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import '../../push/push_service.dart';

/// True while a 1:1 call is on this device — used to auto-reply "busy" to a
/// second incoming call.
bool gInCall = false;

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
  const CallScreen({
    super.key,
    required this.room,
    required this.title,
    required this.seed,
    required this.video,
    this.outgoing = true,
    this.avatarUrl = '',
    this.ringbackUrl = '',
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

  @override
  void initState() {
    super.initState();
    gInCall = true;
    _telemetry = CallTelemetry(callId: widget.room, video: widget.video, outgoing: widget.outgoing);
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
      _ringTimeout = Timer(const Duration(seconds: 35), () {
        if (mounted && !_connected) _onNoAnswer();
      });
      // Caller hears the callee's AI ringback (or the bundled default) while
      // ringing. Gated by the server kill switch (mirrored in RemoteConfig).
      if (RemoteConfig.ringbackEnabled) {
        // ignore: unawaited_futures
        _ringback.playRingback(widget.ringbackUrl);
      }
    }
    // Server-relayed call status (declined / busy) for this call.
    _statusSub = callStatusBus.stream.listen((e) {
      if (e.callId == widget.room && mounted && !_connected) {
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

    // Release mic/cam IMMEDIATELY on every end path (remote hangup, decline,
    // busy, no-answer, failure) — not 1.4s later when the route finally pops.
    // This is what stops the green mic indicator lingering after the other side
    // ends the call. _end() is idempotent, so the later dispose() is harmless.
    _end();
    if (!mounted) return;
    setState(() => _phase = phase);
    Future.delayed(const Duration(milliseconds: 1400), () {
      if (mounted) Navigator.maybePop(context);
    });
  }

  String get _room => widget.room;

  Future<void> _fetchIce() async {
    // Pre-warmed cache (IceCache.prefetch fires when the call becomes likely),
    // so this is usually instant instead of an HTTPS round-trip during setup.
    _ice = await IceCache.get();
  }

  Future<void> _start() async {
    await _local.initialize();
    await _remote.initialize();
    await _fetchIce();
    try {
      _stream = await navigator.mediaDevices.getUserMedia({
        'audio': true,
        'video': widget.video ? {'facingMode': 'user'} : false,
      });
    } catch (_) {
      // Mic/cam permission denied or device busy — don't hang on "Connecting…".
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
            content: Text('Microphone permission is needed to make a call')));
      }
      _endWith('ended');
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
  }

  void _onSocketLost() {
    if (_ended) return;
    _endWith('ended', reason: 'socket-lost');
  }

  void _send(Map<String, dynamic> o) => _ws?.sink.add(jsonEncode(o));

  Future<RTCPeerConnection> _newPC() async {
    final pc = await createPeerConnection({
      'iceServers': _ice,
      // TURN-only diagnostics mode (Settings → Diagnostics): forces every call
      // through the relay to validate the worst-case path on demand.
      if (CallDiag.turnOnly) 'iceTransportPolicy': 'relay',
    });
    _stream!.getTracks().forEach((t) => pc.addTrack(t, _stream!));
    pc.onIceCandidate = (c) {
      if (_remoteId != null) _send({'type': 'candidate', 'to': _remoteId, 'candidate': c.toMap()});
    };
    pc.onTrack = (e) {
      if (e.streams.isNotEmpty) {
        _remote.srcObject = e.streams[0];
        _ringTimeout?.cancel();
        _failTimer?.cancel();
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
      final offer = await pc.createOffer({'iceRestart': true});
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
    final d = jsonDecode(raw as String) as Map<String, dynamic>;
    switch (d['type']) {
      case 'welcome':
        final peers = (d['peers'] as List).cast<String>();
        if (peers.isNotEmpty) {
          _remoteId = peers.first;
          _weOffered = true; // we drive renegotiation/ICE restarts for this call
          final pc = await _newPC();
          final offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          _send({'type': 'offer', 'to': _remoteId, 'sdp': offer.toMap()});
        }
        break;
      case 'offer':
        _remoteId = d['from'] as String;
        final pc = _pc ?? await _newPC();
        await pc.setRemoteDescription(RTCSessionDescription(d['sdp']['sdp'], d['sdp']['type']));
        await _flushCandidates();
        final ans = await pc.createAnswer();
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
        _endWith('declined', reason: 'decline');
        break;
      case 'busy':
        _endWith('busy');
        break;
      case 'peer-left':
      case 'bye':
        _remote.srcObject = null;
        if (_connected) {
          _endWith('ended', reason: d['type'] == 'bye' ? 'remote-bye' : 'peer-left');
        } else if (d['type'] == 'bye') {
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
    Helper.setSpeakerphoneOn(_speaker); // earpiece ⇆ loudspeaker
  }

  /// Caller gave up before the callee answered → push a 'cancel' so their phone
  /// stops ringing (the WS 'bye' can't reach a callee who never joined the room).
  void _notifyCalleeCanceled() {
    if (!widget.seed.startsWith('npub1')) return;
    ApiAuth.postJson(kCallStatusUrl, {
      'to': widget.seed, 'callId': widget.room, 'status': 'cancel',
    }).ignore();
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
    // Simplest path: add a camera track if none.
    final v = await navigator.mediaDevices.getUserMedia({'video': {'facingMode': 'user'}, 'audio': false});
    final track = v.getVideoTracks().first;
    await _stream?.addTrack(track);
    _local.srcObject = _stream;
    _pc?.addTrack(track, _stream!);
    setState(() {});
  }

  Future<void> _hangup() async {
    if (_remoteId != null) _send({'type': 'bye', 'to': _remoteId});
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
      final started = await _tryReceptionist();
      if (started) return;
    }
    if (mounted && !_connected) _endWith('no-answer', reason: 'timeout-ringing');
  }

  Future<bool> _tryReceptionist() async {
    try {
      // Free the WebRTC mic so the PCM recorder can capture (no double-grab).
      try { _stream?.getTracks().forEach((t) => t.stop()); } catch (_) {}
      try { await _pc?.close(); } catch (_) {}
      _pc = null;
      // Caller didn't get an answer → stop the callee's phone ringing; Ava takes it.
      _notifyCalleeCanceled();

      final call = ReceptionistCall(calleeUid: widget.seed, callId: widget.room);
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
    _ended = true;
    gInCall = false;
    _telemetry.ended(_connected ? 'ended' : _phase); // no-op if already reported
    // Outgoing call torn down before it connected → tell the callee to stop ringing.
    if (widget.outgoing && !_connected) _notifyCalleeCanceled();
    _timer?.cancel();
    _ringTimeout?.cancel();
    _failTimer?.cancel();
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

        // audio call: paper screen — ink-ringed avatar w/ hard shadow, Fredoka
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
            padding: const EdgeInsets.fromLTRB(16, 16, 16, 34),
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
