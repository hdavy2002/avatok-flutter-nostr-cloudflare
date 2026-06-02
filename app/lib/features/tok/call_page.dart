import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';
import 'package:uuid/uuid.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import '../../core/config.dart';

/// AvaTok 1:1 P2P call. Signaling via the Cloudflare Worker (Stage 1);
/// migrates to NIP-100 over the relay in Stage 3.
class CallPage extends StatefulWidget {
  final String room;
  const CallPage({super.key, required this.room});
  @override
  State<CallPage> createState() => _CallPageState();
}

class _CallPageState extends State<CallPage> {
  final _localRenderer = RTCVideoRenderer();
  final _remoteRenderer = RTCVideoRenderer();
  final _myId = 'app-${const Uuid().v4().substring(0, 6)}';

  WebSocketChannel? _ws;
  RTCPeerConnection? _pc;
  MediaStream? _localStream;
  String? _remoteId;
  String _status = 'starting…';
  bool _micOn = true;
  bool _camOn = true;

  @override
  void initState() {
    super.initState();
    _start();
  }

  void _log(String m) {
    if (mounted) setState(() => _status = m);
  }

  Future<void> _start() async {
    await _localRenderer.initialize();
    await _remoteRenderer.initialize();

    _localStream = await navigator.mediaDevices.getUserMedia({
      'audio': true,
      'video': {'facingMode': 'user'},
    });
    _localRenderer.srcObject = _localStream;

    final url =
        'wss://$kSignalingHost/room/${Uri.encodeComponent(widget.room)}?id=$_myId';
    _ws = WebSocketChannel.connect(Uri.parse(url));
    _log('connecting…');
    _ws!.stream.listen(_onSignal,
        onError: (e) => _log('ws error: $e'), onDone: () => _log('ws closed'));
  }

  void _send(Map<String, dynamic> o) => _ws?.sink.add(jsonEncode(o));

  Future<RTCPeerConnection> _newPC() async {
    final pc = await createPeerConnection({'iceServers': kIceServers});
    _localStream!.getTracks().forEach((t) => pc.addTrack(t, _localStream!));
    pc.onIceCandidate = (c) {
      if (_remoteId != null) {
        _send({'type': 'candidate', 'to': _remoteId, 'candidate': c.toMap()});
      }
    };
    pc.onTrack = (e) {
      if (e.streams.isNotEmpty) {
        _remoteRenderer.srcObject = e.streams[0];
        _log('connected');
      }
    };
    pc.onConnectionState = (s) => _log('pc: ${s.toString().split('.').last}');
    _pc = pc;
    return pc;
  }

  Future<void> _onSignal(dynamic raw) async {
    final d = jsonDecode(raw as String) as Map<String, dynamic>;
    switch (d['type']) {
      case 'welcome':
        final peers = (d['peers'] as List).cast<String>();
        _log('in room. peers: ${peers.length}');
        if (peers.isNotEmpty) {
          _remoteId = peers.first;
          final pc = await _newPC();
          final offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          _send({'type': 'offer', 'to': _remoteId, 'sdp': offer.toMap()});
          _log('calling…');
        } else {
          _log('waiting for peer…');
        }
        break;
      case 'peer-joined':
        _log('peer joined');
        break;
      case 'offer':
        _remoteId = d['from'] as String;
        final pc = _pc ?? await _newPC();
        await pc.setRemoteDescription(
            RTCSessionDescription(d['sdp']['sdp'], d['sdp']['type']));
        final answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        _send({'type': 'answer', 'to': _remoteId, 'sdp': answer.toMap()});
        _log('answering…');
        break;
      case 'answer':
        await _pc?.setRemoteDescription(
            RTCSessionDescription(d['sdp']['sdp'], d['sdp']['type']));
        break;
      case 'candidate':
        final c = d['candidate'];
        await _pc?.addCandidate(
            RTCIceCandidate(c['candidate'], c['sdpMid'], c['sdpMLineIndex']));
        break;
      case 'peer-left':
      case 'bye':
        _remoteRenderer.srcObject = null;
        _log('peer left');
        break;
    }
  }

  void _toggleMic() {
    _micOn = !_micOn;
    _localStream?.getAudioTracks().forEach((t) => t.enabled = _micOn);
    setState(() {});
  }

  void _toggleCam() {
    _camOn = !_camOn;
    _localStream?.getVideoTracks().forEach((t) => t.enabled = _camOn);
    setState(() {});
  }

  Future<void> _switchCam() async {
    final track = _localStream?.getVideoTracks().firstOrNull;
    if (track != null) await Helper.switchCamera(track);
  }

  Future<void> _hangup() async {
    if (_remoteId != null) _send({'type': 'bye', 'to': _remoteId});
    await _pc?.close();
    await _ws?.sink.close();
    _localStream?.getTracks().forEach((t) => t.stop());
    if (mounted) Navigator.pop(context);
  }

  @override
  void dispose() {
    _pc?.close();
    _ws?.sink.close();
    _localStream?.getTracks().forEach((t) => t.stop());
    _localRenderer.dispose();
    _remoteRenderer.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFF11131A),
      body: SafeArea(
        child: Stack(
          children: [
            Positioned.fill(
              child: RTCVideoView(_remoteRenderer,
                  objectFit: RTCVideoViewObjectFit.RTCVideoViewObjectFitCover),
            ),
            Positioned(
              right: 16,
              top: 16,
              width: 110,
              height: 150,
              child: ClipRRect(
                borderRadius: BorderRadius.circular(14),
                child: RTCVideoView(_localRenderer,
                    mirror: true,
                    objectFit: RTCVideoViewObjectFit.RTCVideoViewObjectFitCover),
              ),
            ),
            Positioned(
              left: 16,
              top: 20,
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                decoration: BoxDecoration(
                  color: Colors.black.withValues(alpha: 0.5),
                  borderRadius: BorderRadius.circular(20),
                ),
                child: Text('Room ${widget.room} · $_status',
                    style: const TextStyle(color: Colors.white, fontSize: 12)),
              ),
            ),
            Positioned(
              left: 0,
              right: 0,
              bottom: 28,
              child: Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  _ctrl(_micOn ? Icons.mic : Icons.mic_off, Colors.white24, _toggleMic),
                  const SizedBox(width: 16),
                  _ctrl(_camOn ? Icons.videocam : Icons.videocam_off, Colors.white24, _toggleCam),
                  const SizedBox(width: 16),
                  _ctrl(Icons.cameraswitch, Colors.white24, _switchCam),
                  const SizedBox(width: 16),
                  _ctrl(Icons.call_end, const Color(0xFFEF4444), _hangup),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _ctrl(IconData icon, Color bg, VoidCallback onTap) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        width: 58,
        height: 58,
        decoration: BoxDecoration(color: bg, shape: BoxShape.circle),
        child: Icon(icon, color: Colors.white, size: 26),
      ),
    );
  }
}

extension FirstOrNull<E> on List<E> {
  E? get firstOrNull => isEmpty ? null : first;
}
