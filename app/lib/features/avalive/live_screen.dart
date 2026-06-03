import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';
import 'package:http/http.dart' as http;
import 'package:permission_handler/permission_handler.dart';

import '../../core/config.dart';
import '../../core/theme.dart';

/// AvaLive — broadcast over Cloudflare Stream Live.
/// Host publishes via WebRTC WHIP; viewers watch via WHEP. Both reuse the
/// flutter_webrtc stack (no second engine).
class LiveScreen extends StatefulWidget {
  final String? initialRoom;
  final bool autoWatch;
  const LiveScreen({super.key, this.initialRoom, this.autoWatch = false});
  @override
  State<LiveScreen> createState() => _LiveScreenState();
}

class _LiveScreenState extends State<LiveScreen> {
  final _renderer = RTCVideoRenderer();
  late final TextEditingController _room;
  RTCPeerConnection? _pc;
  MediaStream? _stream;
  bool _busy = false;
  String _status = 'idle';
  String? _mode; // host | viewer

  static const _ice = [
    {'urls': 'stun:stun.cloudflare.com:3478'},
    {'urls': 'stun:stun.l.google.com:19302'},
  ];

  @override
  void initState() {
    super.initState();
    _room = TextEditingController(text: widget.initialRoom ?? 'avalive-demo');
    _renderer.initialize();
    if (widget.autoWatch && widget.initialRoom != null) {
      WidgetsBinding.instance.addPostFrameCallback((_) => _watch());
    }
  }

  Future<Map<String, dynamic>> _live({bool announce = false}) async {
    final res = await http.post(Uri.parse(kLiveUrl),
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({
          'room': _room.text.trim(),
          if (announce) ...{'announce': true, 'title': _room.text.trim(), 'host': 'Creator'},
        }));
    if (res.statusCode != 200) throw 'Server ${res.statusCode}: ${res.body}';
    return jsonDecode(res.body) as Map<String, dynamic>;
  }

  Future<String> _signal(String url, String offerSdp) async {
    final res = await http.post(Uri.parse(url),
        headers: {'Content-Type': 'application/sdp'}, body: offerSdp);
    if (res.statusCode >= 300) throw 'WHIP/WHEP ${res.statusCode}';
    return res.body;
  }

  Future<void> _goLive() async {
    await _reset();
    setState(() { _busy = true; _mode = 'host'; _status = 'creating stream…'; });
    try {
      final s = await [Permission.camera, Permission.microphone].request();
      if (!s.values.every((x) => x.isGranted)) throw 'Camera & mic permission required';
      final live = await _live(announce: true);
      final whip = live['whip'] as String?;
      if (whip == null) throw 'No WHIP URL (Stream not ready)';
      _stream = await navigator.mediaDevices.getUserMedia({'audio': true, 'video': {'facingMode': 'user'}});
      _renderer.srcObject = _stream;
      setState(() => _status = 'connecting…');
      final pc = await createPeerConnection({'iceServers': _ice});
      _pc = pc;
      _stream!.getTracks().forEach((t) => pc.addTrack(t, _stream!));
      final offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      final answer = await _signal(whip, offer.sdp!);
      await pc.setRemoteDescription(RTCSessionDescription(answer, 'answer'));
      pc.onConnectionState = (st) => setState(() => _status = st.toString().split('.').last);
      setState(() => _status = 'LIVE');
    } catch (e) {
      setState(() => _status = 'error: $e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _watch() async {
    await _reset();
    setState(() { _busy = true; _mode = 'viewer'; _status = 'finding stream…'; });
    try {
      final live = await _live();
      final whep = live['whep'] as String?;
      if (whep == null) throw 'No WHEP URL';
      final pc = await createPeerConnection({'iceServers': _ice});
      _pc = pc;
      pc.onTrack = (e) {
        if (e.streams.isNotEmpty) {
          _renderer.srcObject = e.streams[0];
          setState(() => _status = 'watching');
        }
      };
      await pc.addTransceiver(
          kind: RTCRtpMediaType.RTCRtpMediaTypeAudio,
          init: RTCRtpTransceiverInit(direction: TransceiverDirection.RecvOnly));
      await pc.addTransceiver(
          kind: RTCRtpMediaType.RTCRtpMediaTypeVideo,
          init: RTCRtpTransceiverInit(direction: TransceiverDirection.RecvOnly));
      final offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      final answer = await _signal(whep, offer.sdp!);
      await pc.setRemoteDescription(RTCSessionDescription(answer, 'answer'));
      setState(() => _status = 'connecting…');
    } catch (e) {
      setState(() => _status = 'error: $e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _reset() async {
    await _pc?.close();
    _pc = null;
    _stream?.getTracks().forEach((t) => t.stop());
    _stream = null;
    _renderer.srcObject = null;
    setState(() { _mode = null; _status = 'idle'; });
  }

  @override
  void dispose() {
    if (_mode == 'host') {
      // Best-effort: clear our stream from discovery when the host leaves.
      http.post(Uri.parse(kLiveEndUrl),
          headers: {'Content-Type': 'application/json'},
          body: jsonEncode({'room': _room.text.trim()})).ignore();
    }
    _pc?.close();
    _stream?.getTracks().forEach((t) => t.stop());
    _renderer.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final live = _status == 'LIVE' || _status == 'watching';
    return Scaffold(
      backgroundColor: const Color(0xFF101015),
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(18),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(children: [
                IconButton(
                  icon: const Icon(Icons.chevron_left, color: Colors.white, size: 28),
                  onPressed: () => Navigator.pop(context),
                ),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                  decoration: BoxDecoration(
                      color: live ? AvaColors.danger : Colors.white24,
                      borderRadius: BorderRadius.circular(8)),
                  child: Row(mainAxisSize: MainAxisSize.min, children: [
                    const Icon(Icons.sensors, color: Colors.white, size: 14),
                    const SizedBox(width: 5),
                    Text(live ? 'LIVE' : 'AvaLive',
                        style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w800, fontSize: 13)),
                  ]),
                ),
                const Spacer(),
                Text(_status, style: const TextStyle(color: Colors.white54, fontSize: 12)),
              ]),
              const SizedBox(height: 12),
              Expanded(
                child: ClipRRect(
                  borderRadius: BorderRadius.circular(20),
                  child: Container(
                    color: const Color(0xFF1A1A1F),
                    child: _renderer.srcObject != null
                        ? RTCVideoView(_renderer, mirror: _mode == 'host',
                            objectFit: RTCVideoViewObjectFit.RTCVideoViewObjectFitCover)
                        : const Center(child: Icon(Icons.videocam_off, color: Colors.white24, size: 46)),
                  ),
                ),
              ),
              const SizedBox(height: 14),
              TextField(
                controller: _room,
                style: const TextStyle(color: Colors.white),
                decoration: InputDecoration(
                  hintText: 'Stream room',
                  hintStyle: const TextStyle(color: Colors.white38),
                  filled: true, fillColor: const Color(0xFF1E1E25),
                  border: OutlineInputBorder(borderRadius: BorderRadius.circular(14), borderSide: BorderSide.none),
                ),
              ),
              const SizedBox(height: 12),
              Row(children: [
                Expanded(
                  child: OutlinedButton.icon(
                    style: OutlinedButton.styleFrom(
                        foregroundColor: Colors.white,
                        side: const BorderSide(color: Colors.white24),
                        padding: const EdgeInsets.symmetric(vertical: 14)),
                    onPressed: _busy ? null : _watch,
                    icon: const Icon(Icons.visibility),
                    label: const Text('Watch'),
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  flex: 2,
                  child: FilledButton.icon(
                    style: FilledButton.styleFrom(backgroundColor: AvaColors.danger,
                        padding: const EdgeInsets.symmetric(vertical: 14)),
                    onPressed: _busy ? null : _goLive,
                    icon: _busy
                        ? const SizedBox(height: 18, width: 18, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                        : const Icon(Icons.sensors),
                    label: Text(_busy ? '…' : 'Go Live'),
                  ),
                ),
              ]),
            ],
          ),
        ),
      ),
    );
  }
}
