import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:permission_handler/permission_handler.dart';
import 'package:realtimekit_ui/realtimekit_ui.dart';

import '../../core/config.dart';
import '../../core/theme.dart';

/// AvaTok group call (SFU) via Cloudflare RealtimeKit.
/// Calls the avatok-calls Worker for a participant token, then drops into the
/// RealtimeKit default meeting UI.
class GroupCallEntry extends StatefulWidget {
  const GroupCallEntry({super.key});
  @override
  State<GroupCallEntry> createState() => _GroupCallEntryState();
}

class _GroupCallEntryState extends State<GroupCallEntry> {
  final _room = TextEditingController(text: 'team42');
  final _name = TextEditingController(text: 'Me');
  String _role = 'participant';
  bool _busy = false;
  String? _error;

  Future<void> _join() async {
    final statuses = await [Permission.camera, Permission.microphone].request();
    if (!statuses.values.every((s) => s.isGranted)) {
      setState(() => _error = 'Camera & microphone permission required');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final res = await http.post(
        Uri.parse(kCallsJoinUrl),
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({
          'room': _room.text.trim(),
          'name': _name.text.trim(),
          'role': _role,
        }),
      );
      if (res.statusCode != 200) {
        throw 'Server ${res.statusCode}: ${res.body}';
      }
      final data = jsonDecode(res.body) as Map<String, dynamic>;
      final authToken = data['authToken'] as String;
      if (!mounted) return;

      final meetingInfo = RtkMeetingInfo(authToken: authToken);
      final uiKitInfo = RealtimeKitUIInfo(meetingInfo);
      final rtkUI = RealtimeKitUIBuilder.build(uiKitInfo: uiKitInfo);

      await Navigator.push(context, MaterialPageRoute(builder: (_) => rtkUI));
      RealtimeKitUIBuilder.dispose();
    } catch (e) {
      setState(() => _error = '$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        backgroundColor: Colors.transparent,
        elevation: 0,
        foregroundColor: AvaColors.ink,
        title: const Text('Group call'),
      ),
      body: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Multi-party video', style: Theme.of(context).textTheme.headlineSmall),
            const SizedBox(height: 4),
            const Text('Everyone who joins the same room lands in one SFU meeting.',
                style: TextStyle(color: AvaColors.sub)),
            const SizedBox(height: 28),
            const Text('Room', style: TextStyle(fontWeight: FontWeight.w700)),
            const SizedBox(height: 8),
            TextField(controller: _room, decoration: const InputDecoration(hintText: 'room code')),
            const SizedBox(height: 16),
            const Text('Your name', style: TextStyle(fontWeight: FontWeight.w700)),
            const SizedBox(height: 8),
            TextField(controller: _name, decoration: const InputDecoration(hintText: 'name')),
            const SizedBox(height: 16),
            const Text('Role', style: TextStyle(fontWeight: FontWeight.w700)),
            const SizedBox(height: 8),
            SegmentedButton<String>(
              segments: const [
                ButtonSegment(value: 'host', label: Text('Host')),
                ButtonSegment(value: 'participant', label: Text('Participant')),
                ButtonSegment(value: 'guest', label: Text('Guest')),
              ],
              selected: {_role},
              onSelectionChanged: (s) => setState(() => _role = s.first),
            ),
            if (_error != null) ...[
              const SizedBox(height: 16),
              Text(_error!, style: const TextStyle(color: AvaColors.danger, fontSize: 12)),
            ],
            const Spacer(),
            SizedBox(
              width: double.infinity,
              child: FilledButton.icon(
                onPressed: _busy ? null : _join,
                icon: _busy
                    ? const SizedBox(
                        height: 18, width: 18,
                        child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                    : const Icon(Icons.groups),
                label: Text(_busy ? 'Joining…' : 'Join group call'),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
