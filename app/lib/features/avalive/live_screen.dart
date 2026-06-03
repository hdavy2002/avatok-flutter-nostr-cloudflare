import 'package:flutter/material.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';
import 'package:permission_handler/permission_handler.dart';

import '../../core/theme.dart';

/// AvaLive — broadcast. (No detailed mockup; designed in the AvaTOK language.)
/// Camera preview works now; live ingest is wired next once we pick the path
/// (RealtimeKit-only or Cloudflare Stream Live) — kept off flutter_webrtc's
/// stack for now to avoid the dual-WebRTC crash.
class LiveScreen extends StatefulWidget {
  const LiveScreen({super.key});
  @override
  State<LiveScreen> createState() => _LiveScreenState();
}

class _LiveScreenState extends State<LiveScreen> {
  final _renderer = RTCVideoRenderer();
  MediaStream? _stream;
  bool _preview = false;

  @override
  void initState() {
    super.initState();
    _renderer.initialize();
  }

  Future<void> _togglePreview() async {
    if (_preview) {
      _stream?.getTracks().forEach((t) => t.stop());
      _renderer.srcObject = null;
      setState(() => _preview = false);
      return;
    }
    final s = await [Permission.camera, Permission.microphone].request();
    if (!s.values.every((x) => x.isGranted)) return;
    _stream = await navigator.mediaDevices.getUserMedia({'audio': true, 'video': {'facingMode': 'user'}});
    _renderer.srcObject = _stream;
    setState(() => _preview = true);
  }

  @override
  void dispose() {
    _stream?.getTracks().forEach((t) => t.stop());
    _renderer.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
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
                  decoration: BoxDecoration(color: AvaColors.danger, borderRadius: BorderRadius.circular(8)),
                  child: const Row(mainAxisSize: MainAxisSize.min, children: [
                    Icon(Icons.sensors, color: Colors.white, size: 14),
                    SizedBox(width: 5),
                    Text('AvaLive', style: TextStyle(color: Colors.white, fontWeight: FontWeight.w800, fontSize: 13)),
                  ]),
                ),
              ]),
              const SizedBox(height: 12),
              Expanded(
                child: ClipRRect(
                  borderRadius: BorderRadius.circular(20),
                  child: Container(
                    color: const Color(0xFF1A1A1F),
                    child: _preview
                        ? RTCVideoView(_renderer, mirror: true,
                            objectFit: RTCVideoViewObjectFit.RTCVideoViewObjectFitCover)
                        : const Center(
                            child: Column(mainAxisSize: MainAxisSize.min, children: [
                              Icon(Icons.videocam_off, color: Colors.white24, size: 46),
                              SizedBox(height: 10),
                              Text('Camera preview off', style: TextStyle(color: Colors.white38)),
                            ])),
                  ),
                ),
              ),
              const SizedBox(height: 14),
              OutlinedButton.icon(
                style: OutlinedButton.styleFrom(
                    foregroundColor: Colors.white,
                    side: const BorderSide(color: Colors.white24),
                    padding: const EdgeInsets.symmetric(vertical: 14)),
                onPressed: _togglePreview,
                icon: Icon(_preview ? Icons.videocam_off : Icons.videocam),
                label: Text(_preview ? 'Stop preview' : 'Preview camera'),
              ),
              const SizedBox(height: 10),
              SizedBox(
                width: double.infinity,
                child: FilledButton.icon(
                  style: FilledButton.styleFrom(backgroundColor: AvaColors.danger,
                      padding: const EdgeInsets.symmetric(vertical: 16)),
                  onPressed: () => ScaffoldMessenger.of(context).showSnackBar(
                      const SnackBar(content: Text('Go Live ingest wires up next (Stream Live / RealtimeKit)'))),
                  icon: const Icon(Icons.sensors),
                  label: const Text('Go Live'),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
