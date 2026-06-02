import 'package:flutter/material.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';
import 'package:permission_handler/permission_handler.dart';

import '../../core/theme.dart';

/// AvaLive home — broadcast scaffold. Camera preview works now; actual
/// RTMPS/WebRTC ingest to Cloudflare Stream Live lands in Stage 7.
class LiveHome extends StatefulWidget {
  const LiveHome({super.key});
  @override
  State<LiveHome> createState() => _LiveHomeState();
}

class _LiveHomeState extends State<LiveHome> {
  final _renderer = RTCVideoRenderer();
  MediaStream? _stream;
  bool _previewing = false;

  @override
  void initState() {
    super.initState();
    _renderer.initialize();
  }

  Future<void> _togglePreview() async {
    if (_previewing) {
      _stream?.getTracks().forEach((t) => t.stop());
      _renderer.srcObject = null;
      setState(() => _previewing = false);
      return;
    }
    final statuses = await [Permission.camera, Permission.microphone].request();
    if (!statuses.values.every((s) => s.isGranted)) return;
    _stream = await navigator.mediaDevices.getUserMedia({
      'audio': true,
      'video': {'facingMode': 'user'},
    });
    _renderer.srcObject = _stream;
    setState(() => _previewing = true);
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
      appBar: AppBar(
        backgroundColor: Colors.transparent,
        elevation: 0,
        foregroundColor: AvaColors.ink,
        title: Row(
          children: [
            Container(
              width: 30, height: 30,
              decoration: BoxDecoration(
                color: AvaColors.danger, borderRadius: BorderRadius.circular(9)),
              child: const Icon(Icons.sensors, color: Colors.white, size: 18),
            ),
            const SizedBox(width: 10),
            Text('AvaLive', style: Theme.of(context).textTheme.titleLarge),
          ],
        ),
      ),
      body: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Expanded(
              child: ClipRRect(
                borderRadius: BorderRadius.circular(20),
                child: Container(
                  color: const Color(0xFF11131A),
                  child: _previewing
                      ? RTCVideoView(_renderer,
                          mirror: true,
                          objectFit:
                              RTCVideoViewObjectFit.RTCVideoViewObjectFitCover)
                      : const Center(
                          child: Column(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              Icon(Icons.videocam_off, color: Colors.white24, size: 48),
                              SizedBox(height: 10),
                              Text('Camera preview off',
                                  style: TextStyle(color: Colors.white38)),
                            ],
                          ),
                        ),
                ),
              ),
            ),
            const SizedBox(height: 16),
            Row(
              children: [
                Expanded(
                  child: OutlinedButton.icon(
                    onPressed: _togglePreview,
                    icon: Icon(_previewing ? Icons.videocam_off : Icons.videocam),
                    label: Text(_previewing ? 'Stop preview' : 'Preview camera'),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: FilledButton.icon(
                    style: FilledButton.styleFrom(backgroundColor: AvaColors.danger),
                    onPressed: () {
                      ScaffoldMessenger.of(context).showSnackBar(
                        const SnackBar(
                          content: Text('Go Live needs Cloudflare Stream Live (Stage 7)'),
                        ),
                      );
                    },
                    icon: const Icon(Icons.sensors),
                    label: const Text('Go Live'),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 12),
            const Text(
              'Broadcast pipeline (RTMPS/WebRTC ingest → HLS playback) wires up in '
              'Stage 7 once Cloudflare Stream Live is enabled.',
              style: TextStyle(fontSize: 12, color: AvaColors.sub),
            ),
          ],
        ),
      ),
    );
  }
}
