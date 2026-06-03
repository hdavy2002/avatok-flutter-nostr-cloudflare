import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:permission_handler/permission_handler.dart';
import 'package:realtimekit_ui/realtimekit_ui.dart';

import 'main.dart' show kJoinUrl, kBrand, kSub;

/// Join (or start) a 1:20 consult room → RealtimeKit meeting.
class JoinScreen extends StatefulWidget {
  final String role; // host | participant
  const JoinScreen({super.key, required this.role});
  @override
  State<JoinScreen> createState() => _JoinScreenState();
}

class _JoinScreenState extends State<JoinScreen> {
  final _room = TextEditingController(text: 'consult-001');
  final _name = TextEditingController(text: 'Me');
  bool _busy = false;
  String? _error;

  Future<void> _join() async {
    final s = await [Permission.camera, Permission.microphone].request();
    if (!s.values.every((x) => x.isGranted)) {
      setState(() => _error = 'Camera & microphone permission required');
      return;
    }
    setState(() { _busy = true; _error = null; });
    try {
      final res = await http.post(Uri.parse(kJoinUrl),
          headers: {'Content-Type': 'application/json'},
          body: jsonEncode({'room': _room.text.trim(), 'name': _name.text.trim(), 'role': widget.role}));
      if (res.statusCode != 200) throw 'Server ${res.statusCode}: ${res.body}';
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
  Widget build(BuildContext context) {
    final host = widget.role == 'host';
    return Scaffold(
      appBar: AppBar(
        backgroundColor: Colors.transparent,
        elevation: 0,
        foregroundColor: kBrand,
        title: Text(host ? 'Start a consult' : 'Join a consult'),
      ),
      body: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Room', style: TextStyle(fontWeight: FontWeight.w700)),
            const SizedBox(height: 8),
            TextField(controller: _room, decoration: const InputDecoration(hintText: 'room code')),
            const SizedBox(height: 16),
            const Text('Your name', style: TextStyle(fontWeight: FontWeight.w700)),
            const SizedBox(height: 8),
            TextField(controller: _name, decoration: const InputDecoration(hintText: 'name')),
            if (_error != null) ...[
              const SizedBox(height: 16),
              Text(_error!, style: const TextStyle(color: Colors.red, fontSize: 12)),
            ],
            const Spacer(),
            SizedBox(
              width: double.infinity,
              child: FilledButton.icon(
                onPressed: _busy ? null : _join,
                icon: _busy
                    ? const SizedBox(height: 18, width: 18, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                    : Icon(host ? Icons.video_call : Icons.login),
                label: Text(_busy ? 'Connecting…' : (host ? 'Start consult' : 'Join consult')),
              ),
            ),
            const SizedBox(height: 12),
            const Center(child: Text('Up to 20 participants · RealtimeKit SFU',
                style: TextStyle(color: kSub, fontSize: 12))),
          ],
        ),
      ),
    );
  }
}
