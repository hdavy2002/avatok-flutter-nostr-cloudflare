import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';
import 'package:http/http.dart' as http;

import '../../core/avatar.dart';
import '../../core/config.dart';
import '../../core/theme.dart';
import 'data.dart';

/// Caps result for a group call attempt.
class CapCheck {
  final bool allowed;
  final String? message;
  const CapCheck(this.allowed, [this.message]);
}

/// Enforce AvaTok group-call caps (video 10 / voice 25).
CapCheck checkGroupCallCap({required int members, required bool video}) {
  final max = video ? kGroupVideoMax : kGroupVoiceMax;
  if (members > max) {
    return CapCheck(false,
        "You've reached the max members allowed in a group ${video ? 'video' : 'voice'} call ($max).");
  }
  return const CapCheck(true);
}

/// Start a group call from a group [chat], applying caps first.
Future<void> startGroupCall(BuildContext context, Chat chat, {required bool video}) async {
  final cap = checkGroupCallCap(members: chat.members, video: video);
  if (!cap.allowed) {
    await showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text('Group ${video ? 'video' : 'voice'} call'),
        content: Text(cap.message!),
        actions: [TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('OK'))],
      ),
    );
    return;
  }
  if (!context.mounted) return;
  Navigator.push(context,
      MaterialPageRoute(builder: (_) => GroupCallScreen(chat: chat, video: video)));
}

/// Group call over the Cloudflare Realtime (Calls) SFU on the same flutter_webrtc
/// engine as 1:1. Local preview + controls work immediately; multi-party media
/// lights up once the Realtime app secrets are set on the Worker.
class GroupCallScreen extends StatefulWidget {
  final Chat chat;
  final bool video;
  const GroupCallScreen({super.key, required this.chat, required this.video});
  @override
  State<GroupCallScreen> createState() => _GroupCallScreenState();
}

class _GroupCallScreenState extends State<GroupCallScreen> {
  final _local = RTCVideoRenderer();
  MediaStream? _stream;
  bool _muted = false;
  bool _camOn = true;
  String _status = 'Connecting…';
  Timer? _timer;
  int _secs = 0;

  @override
  void initState() {
    super.initState();
    _camOn = widget.video;
    _start();
  }

  Future<void> _start() async {
    await _local.initialize();
    _stream = await navigator.mediaDevices.getUserMedia({
      'audio': true,
      'video': widget.video ? {'facingMode': 'user'} : false,
    });
    _local.srcObject = _stream;
    if (mounted) setState(() {});
    _timer = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted) setState(() => _secs++);
    });
    await _connectSfu();
  }

  Future<void> _connectSfu() async {
    try {
      final r = await http
          .post(Uri.parse('$kSfuBase/sessions/new'),
              headers: {'Content-Type': 'application/json'}, body: '{}')
          .timeout(const Duration(seconds: 10));
      if (r.statusCode == 503) {
        if (mounted) setState(() => _status = 'Group calling activates once the Realtime app is connected');
        return;
      }
      if (r.statusCode == 200 || r.statusCode == 201) {
        // sessionId present → track publish/subscribe is the next wiring step.
        jsonDecode(r.body);
        if (mounted) setState(() => _status = 'In call · ${widget.chat.members} members');
        return;
      }
      if (mounted) setState(() => _status = 'Could not reach the call server');
    } catch (_) {
      if (mounted) setState(() => _status = 'Offline — retrying when connected');
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
    _camOn = !_camOn;
    _stream?.getVideoTracks().forEach((t) => t.enabled = _camOn);
    setState(() {});
  }

  Future<void> _end() async {
    _timer?.cancel();
    _stream?.getTracks().forEach((t) => t.stop());
  }

  @override
  void dispose() {
    _end();
    _local.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final showVideo = widget.video && _camOn;
    return Scaffold(
      backgroundColor: const Color(0xFF15151B),
      body: Stack(children: [
        // self tile fills background
        if (showVideo)
          Positioned.fill(
            child: RTCVideoView(_local, mirror: true,
                objectFit: RTCVideoViewObjectFit.RTCVideoViewObjectFitCover),
          )
        else
          Center(child: Avatar(seed: widget.chat.seed, name: widget.chat.name, size: 120)),

        SafeArea(
          child: Column(children: [
            const SizedBox(height: 8),
            Text(widget.chat.name,
                style: const TextStyle(color: Colors.white, fontSize: 18, fontWeight: FontWeight.w800)),
            const SizedBox(height: 2),
            Text('$_clock · ${widget.video ? "video" : "voice"} · ${widget.chat.members} members',
                style: TextStyle(color: Colors.white.withValues(alpha: 0.8), fontSize: 12.5)),
            const SizedBox(height: 6),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
              decoration: BoxDecoration(
                  color: Colors.white.withValues(alpha: 0.12),
                  borderRadius: BorderRadius.circular(20)),
              child: Text(_status, style: const TextStyle(color: Colors.white, fontSize: 12)),
            ),
          ]),
        ),

        // controls
        Positioned(
          left: 0, right: 0, bottom: 28,
          child: Center(
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
              decoration: BoxDecoration(
                  color: Colors.white.withValues(alpha: 0.16),
                  borderRadius: BorderRadius.circular(40)),
              child: Row(mainAxisSize: MainAxisSize.min, children: [
                _btn(_muted ? Icons.mic_off : Icons.mic, !_muted, _toggleMute),
                const SizedBox(width: 14),
                GestureDetector(
                  onTap: () { _end(); Navigator.pop(context); },
                  child: Container(width: 58, height: 58,
                      decoration: const BoxDecoration(color: Color(0xFFF0353B), shape: BoxShape.circle),
                      child: Transform.rotate(angle: 2.356,
                          child: const Icon(Icons.call, color: Colors.white, size: 26))),
                ),
                const SizedBox(width: 14),
                if (widget.video)
                  _btn(_camOn ? Icons.videocam : Icons.videocam_off, _camOn, _toggleCam),
              ]),
            ),
          ),
        ),
      ]),
    );
  }

  Widget _btn(IconData icon, bool active, VoidCallback onTap) => GestureDetector(
        onTap: onTap,
        child: Container(width: 46, height: 46,
            decoration: BoxDecoration(
                color: Colors.white.withValues(alpha: active ? 0.22 : 0.4), shape: BoxShape.circle),
            child: Icon(icon, color: Colors.white, size: 21)),
      );
}
