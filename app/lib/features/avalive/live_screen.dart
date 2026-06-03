import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';
import 'package:http/http.dart' as http;
import 'package:permission_handler/permission_handler.dart';
import 'package:realtimekit_ui/realtimekit_ui.dart';

import '../../core/config.dart';
import '../../core/theme.dart';

/// AvaLive — broadcast. (No detailed mockup exists; designed in the AvaTOK
/// language.) Wired to Cloudflare RealtimeKit livestream presets via avatok-calls.
class LiveScreen extends StatefulWidget {
  const LiveScreen({super.key});
  @override
  State<LiveScreen> createState() => _LiveScreenState();
}

class _LiveScreenState extends State<LiveScreen> {
  final _renderer = RTCVideoRenderer();
  final _room = TextEditingController(text: 'avalive-demo');
  MediaStream? _stream;
  bool _preview = false;
  bool _busy = false;
  String? _error;

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

  Future<void> _go(String role) async {
    setState(() { _busy = true; _error = null; });
    try {
      final res = await http.post(Uri.parse(kCallsJoinUrl),
          headers: {'Content-Type': 'application/json'},
          body: jsonEncode({'room': _room.text.trim(), 'name': role == 'live_host' ? 'Host' : 'Viewer', 'role': role}));
      if (res.statusCode != 200) throw 'Server ${res.statusCode}';
      final token = (jsonDecode(res.body) as Map<String, dynamic>)['authToken'] as String;
      if (!mounted) return;
      final ui = RealtimeKitUIBuilder.build(uiKitInfo: RealtimeKitUIInfo(RtkMeetingInfo(authToken: token)));
      await Navigator.push(context, MaterialPageRoute(builder: (_) => ui));
      RealtimeKitUIBuilder.dispose();
    } catch (e) {
      setState(() => _error = '$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
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
              if (_error != null) ...[
                const SizedBox(height: 8),
                Text(_error!, style: const TextStyle(color: AvaColors.danger, fontSize: 12)),
              ],
              const SizedBox(height: 12),
              Row(children: [
                Expanded(
                  child: OutlinedButton.icon(
                    style: OutlinedButton.styleFrom(
                        foregroundColor: Colors.white,
                        side: const BorderSide(color: Colors.white24),
                        padding: const EdgeInsets.symmetric(vertical: 14)),
                    onPressed: _togglePreview,
                    icon: Icon(_preview ? Icons.videocam_off : Icons.videocam),
                    label: Text(_preview ? 'Stop' : 'Preview'),
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: OutlinedButton.icon(
                    style: OutlinedButton.styleFrom(
                        foregroundColor: Colors.white,
                        side: const BorderSide(color: Colors.white24),
                        padding: const EdgeInsets.symmetric(vertical: 14)),
                    onPressed: _busy ? null : () => _go('live_viewer'),
                    icon: const Icon(Icons.visibility),
                    label: const Text('Watch'),
                  ),
                ),
              ]),
              const SizedBox(height: 10),
              SizedBox(
                width: double.infinity,
                child: FilledButton.icon(
                  style: FilledButton.styleFrom(backgroundColor: AvaColors.danger,
                      padding: const EdgeInsets.symmetric(vertical: 16)),
                  onPressed: _busy ? null : () => _go('live_host'),
                  icon: _busy
                      ? const SizedBox(height: 18, width: 18, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                      : const Icon(Icons.sensors),
                  label: Text(_busy ? 'Connecting…' : 'Go Live'),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
