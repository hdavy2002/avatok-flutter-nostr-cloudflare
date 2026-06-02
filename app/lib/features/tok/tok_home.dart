import 'package:flutter/material.dart';
import 'package:permission_handler/permission_handler.dart';

import '../../core/theme.dart';
import 'call_page.dart';

/// AvaTok home — enter a room code and start a 1:1 call.
class TokHome extends StatefulWidget {
  const TokHome({super.key});
  @override
  State<TokHome> createState() => _TokHomeState();
}

class _TokHomeState extends State<TokHome> {
  final _room = TextEditingController(text: 'test123');

  Future<void> _join() async {
    final statuses = await [Permission.camera, Permission.microphone].request();
    if (!statuses.values.every((s) => s.isGranted)) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Camera & microphone permission required')),
        );
      }
      return;
    }
    final code = _room.text.trim().isEmpty ? 'test123' : _room.text.trim();
    if (!mounted) return;
    Navigator.push(context, MaterialPageRoute(builder: (_) => CallPage(room: code)));
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
                color: AvaColors.brand, borderRadius: BorderRadius.circular(9)),
              child: const Icon(Icons.videocam, color: Colors.white, size: 18),
            ),
            const SizedBox(width: 10),
            Text('AvaTok', style: Theme.of(context).textTheme.titleLarge),
          ],
        ),
      ),
      body: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const SizedBox(height: 8),
            Text('1:1 video calls', style: Theme.of(context).textTheme.headlineSmall),
            const SizedBox(height: 4),
            const Text('Peer-to-peer, end-to-end media. Enter a shared room code.',
                style: TextStyle(color: AvaColors.sub)),
            const SizedBox(height: 32),
            const Text('Room code', style: TextStyle(fontWeight: FontWeight.w700)),
            const SizedBox(height: 8),
            TextField(controller: _room, decoration: const InputDecoration(hintText: 'e.g. test123')),
            const SizedBox(height: 20),
            SizedBox(
              width: double.infinity,
              child: FilledButton.icon(
                onPressed: _join,
                icon: const Icon(Icons.video_call),
                label: const Text('Start call'),
              ),
            ),
            const Spacer(),
            Container(
              padding: const EdgeInsets.all(14),
              decoration: BoxDecoration(
                color: AvaColors.brand50, borderRadius: BorderRadius.circular(14)),
              child: const Text(
                'Tip: open the same room code on a second device (or the browser '
                'test page) to connect. Same Wi-Fi for now — TURN for mobile data '
                'arrives in a later stage.',
                style: TextStyle(fontSize: 12, color: Color(0xFF0F6E6E)),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
