import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';
import 'package:http/http.dart' as http;
import 'package:uuid/uuid.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import '../../core/avatar.dart';
import '../../core/call_log_store.dart';
import '../../core/config.dart';
import '../../core/theme.dart';
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
  const CallScreen({
    super.key,
    required this.room,
    required this.title,
    required this.seed,
    required this.video,
    this.outgoing = true,
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
  StreamSubscription? _statusSub;

  @override
  void initState() {
    super.initState();
    gInCall = true;
    _video = widget.video;
    _camOn = widget.video;
    _speaker = widget.video;
    _phase = widget.outgoing ? 'ringing' : 'connecting';
    if (widget.outgoing) {
      _ringTimeout = Timer(const Duration(seconds: 35), () {
        if (mounted && !_connected) _endWith('no-answer');
      });
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

  void _endWith(String phase) {
    if (!mounted) return;
    setState(() => _phase = phase);
    Future.delayed(const Duration(milliseconds: 1400), () {
      if (mounted) Navigator.maybePop(context);
    });
  }

  String get _room => widget.room;

  Future<void> _fetchIce() async {
    try {
      final r = await http.get(Uri.parse(kIceUrl)).timeout(const Duration(seconds: 5));
      if (r.statusCode == 200) {
        final data = jsonDecode(r.body) as Map<String, dynamic>;
        final servers = (data['iceServers'] as List).cast<Map<String, dynamic>>();
        if (servers.isNotEmpty) _ice = servers;
      }
    } catch (_) {/* keep STUN fallback */}
  }

  Future<void> _start() async {
    await _local.initialize();
    await _remote.initialize();
    await _fetchIce();
    _stream = await navigator.mediaDevices.getUserMedia({
      'audio': true,
      'video': widget.video ? {'facingMode': 'user'} : false,
    });
    _local.srcObject = _stream;
    _timer = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted) setState(() => _secs++);
    });
    final url = 'wss://$kSignalingHost/room/$_room?id=$_myId';
    _ws = WebSocketChannel.connect(Uri.parse(url));
    _ws!.stream.listen(_onSignal, onError: (_) {}, onDone: () {});
  }

  void _send(Map<String, dynamic> o) => _ws?.sink.add(jsonEncode(o));

  Future<RTCPeerConnection> _newPC() async {
    final pc = await createPeerConnection({'iceServers': _ice});
    _stream!.getTracks().forEach((t) => pc.addTrack(t, _stream!));
    pc.onIceCandidate = (c) {
      if (_remoteId != null) _send({'type': 'candidate', 'to': _remoteId, 'candidate': c.toMap()});
    };
    pc.onTrack = (e) {
      if (e.streams.isNotEmpty) {
        _remote.srcObject = e.streams[0];
        _ringTimeout?.cancel();
        if (mounted) setState(() { _connected = true; _phase = 'connected'; });
      }
    };
    _pc = pc;
    return pc;
  }

  Future<void> _onSignal(dynamic raw) async {
    final d = jsonDecode(raw as String) as Map<String, dynamic>;
    switch (d['type']) {
      case 'welcome':
        final peers = (d['peers'] as List).cast<String>();
        if (peers.isNotEmpty) {
          _remoteId = peers.first;
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
        final ans = await pc.createAnswer();
        await pc.setLocalDescription(ans);
        _send({'type': 'answer', 'to': _remoteId, 'sdp': ans.toMap()});
        break;
      case 'answer':
        await _pc?.setRemoteDescription(RTCSessionDescription(d['sdp']['sdp'], d['sdp']['type']));
        break;
      case 'candidate':
        final c = d['candidate'];
        await _pc?.addCandidate(RTCIceCandidate(c['candidate'], c['sdpMid'], c['sdpMLineIndex']));
        break;
      case 'decline':
        _endWith('declined');
        break;
      case 'busy':
        _endWith('busy');
        break;
      case 'peer-left':
      case 'bye':
        _remote.srcObject = null;
        if (_connected) {
          _endWith('ended');
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
    await _end();
    if (mounted) Navigator.pop(context);
  }

  Future<void> _end() async {
    gInCall = false;
    _timer?.cancel();
    _ringTimeout?.cancel();
    await _pc?.close();
    await _ws?.sink.close();
    _stream?.getTracks().forEach((t) => t.stop());
  }

  String get _statusText => switch (_phase) {
        'ringing' => 'Ringing…',
        'connected' => 'Connected · end-to-end encrypted',
        'declined' => 'Call declined',
        'busy' => 'User is busy',
        'no-answer' => 'No answer',
        'ended' => 'Call ended',
        _ => 'Connecting…',
      };

  @override
  void dispose() {
    _statusSub?.cancel();
    _end();
    _local.dispose();
    _remote.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final showVideo = _video && _camOn;
    final light = !showVideo;
    final fg = light ? AvaColors.ink : Colors.white;
    return Scaffold(
      backgroundColor: light ? const Color(0xFFEFEDF6) : const Color(0xFF1A1A1F),
      body: Stack(
        children: [
          if (showVideo) ...[
            Positioned.fill(
              child: _connected
                  ? RTCVideoView(_remote, objectFit: RTCVideoViewObjectFit.RTCVideoViewObjectFitCover)
                  : Container(color: const Color(0xFF26262C)),
            ),
            // top gradient
            Positioned(top: 0, left: 0, right: 0, height: 160, child: Container(
              decoration: const BoxDecoration(gradient: LinearGradient(
                begin: Alignment.topCenter, end: Alignment.bottomCenter,
                colors: [Color(0x8C000000), Colors.transparent])))),
            // self thumbnail
            Positioned(
              top: 56, right: 16, width: 78, height: 112,
              child: ClipRRect(
                borderRadius: BorderRadius.circular(16),
                child: Container(
                  decoration: BoxDecoration(border: Border.all(color: Colors.white.withValues(alpha: 0.8), width: 2),
                      borderRadius: BorderRadius.circular(16)),
                  child: RTCVideoView(_local, mirror: true,
                      objectFit: RTCVideoViewObjectFit.RTCVideoViewObjectFitCover),
                ),
              ),
            ),
          ],

          // header: back + name + timer
          SafeArea(
            child: Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Row(
                children: [
                  IconButton(
                    icon: Icon(Icons.chevron_left, color: fg, size: 28),
                    onPressed: _hangup,
                  ),
                  Expanded(
                    child: Transform.translate(
                      offset: const Offset(-18, 0),
                      child: Column(
                        children: [
                          Text(widget.title,
                              style: TextStyle(color: fg, fontSize: 17, fontWeight: FontWeight.w800,
                                  shadows: light ? null : const [Shadow(color: Colors.black54, blurRadius: 6)])),
                          const SizedBox(height: 2),
                          Text(_connected ? _clock : _statusText,
                              style: TextStyle(
                                  color: light ? AvaColors.sub : Colors.white.withValues(alpha: 0.9),
                                  fontSize: 13)),
                        ],
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),

          // audio: centered avatar
          if (light)
            Center(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Container(
                    decoration: BoxDecoration(shape: BoxShape.circle, boxShadow: [
                      BoxShadow(color: const Color(0x40503C78), blurRadius: 40, offset: const Offset(0, 18)),
                    ]),
                    child: Avatar(seed: widget.seed, name: widget.title, size: 132),
                  ),
                  const SizedBox(height: 20),
                  Row(mainAxisSize: MainAxisSize.min, children: [
                    Container(width: 8, height: 8, decoration: BoxDecoration(
                        color: _connected
                            ? AvaColors.success
                            : (_phase == 'declined' || _phase == 'busy' || _phase == 'no-answer')
                                ? AvaColors.danger
                                : AvaColors.sub,
                        shape: BoxShape.circle)),
                    const SizedBox(width: 8),
                    Text(_statusText,
                        style: const TextStyle(color: AvaColors.sub, fontSize: 13)),
                  ]),
                ],
              ),
            ),

          // control bar
          Positioned(
            left: 0, right: 0, bottom: 28,
            child: Center(
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                decoration: BoxDecoration(
                  color: light ? Colors.white : Colors.white.withValues(alpha: 0.16),
                  borderRadius: BorderRadius.circular(40),
                  boxShadow: light ? [BoxShadow(color: const Color(0x2E503C78), blurRadius: 30, offset: const Offset(0, 10))] : null,
                ),
                child: Row(mainAxisSize: MainAxisSize.min, children: [
                  _btn(Icons.chat_bubble_outline, light, onTap: () {}),
                  const SizedBox(width: 14),
                  _btn(_speaker ? Icons.volume_up : Icons.volume_off, light,
                      active: _speaker, onTap: () => setState(() => _speaker = !_speaker)),
                  const SizedBox(width: 14),
                  GestureDetector(
                    onTap: _hangup,
                    child: Container(
                      width: 58, height: 58,
                      decoration: const BoxDecoration(color: Color(0xFFF0353B), shape: BoxShape.circle),
                      child: Transform.rotate(
                        angle: 2.356,
                        child: const Icon(Icons.call, color: Colors.white, size: 26)),
                    ),
                  ),
                  const SizedBox(width: 14),
                  _btn(_video && _camOn ? Icons.videocam : Icons.videocam_off, light,
                      active: _video && _camOn, onTap: _toggleCam),
                  const SizedBox(width: 14),
                  _btn(_muted ? Icons.mic_off : Icons.mic, light, active: !_muted, onTap: _toggleMute),
                ]),
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _btn(IconData icon, bool light, {bool active = false, required VoidCallback onTap}) {
    final bg = light ? const Color(0xFFF3F1F8) : Colors.white.withValues(alpha: 0.22);
    final ic = light ? AvaColors.ink : Colors.white;
    return GestureDetector(
      onTap: onTap,
      child: Container(
        width: 46, height: 46,
        decoration: BoxDecoration(color: bg, shape: BoxShape.circle),
        child: Icon(icon, color: ic, size: 21),
      ),
    );
  }
}
