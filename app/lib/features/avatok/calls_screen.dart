import 'package:flutter/material.dart';

import '../../core/avatar.dart';
import '../../core/theme.dart';
import 'call_screen.dart';

enum CallDir { incoming, outgoing, missed }

class CallLog {
  final String name;
  final String seed;
  final bool video;
  final CallDir dir;
  final String time;
  const CallLog(this.name, this.seed, this.video, this.dir, this.time);
}

const _demoCalls = <CallLog>[
  CallLog('Dr. Willow', 'willow', true, CallDir.outgoing, '13:41'),
  CallLog('Priya Sharma', 'priya', false, CallDir.incoming, '11:58'),
  CallLog('Alex Chen', 'alex', false, CallDir.missed, '09:14'),
  CallLog('Maya Patel', 'maya', true, CallDir.incoming, 'Yesterday'),
  CallLog('Arjun Mehta', 'arjun', false, CallDir.missed, 'Yesterday'),
];

/// AvaTok Calls tab — 1:1 call history; tap to call back.
class CallsScreen extends StatelessWidget {
  const CallsScreen({super.key});

  void _callBack(BuildContext context, CallLog c) {
    Navigator.push(context, MaterialPageRoute(
      builder: (_) => CallScreen(
        room: 'avatok-${c.seed}', title: c.name, seed: c.seed, video: c.video),
    ));
  }

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      bottom: false,
      child: Column(children: [
        Container(
          height: 56,
          alignment: Alignment.centerLeft,
          padding: const EdgeInsets.symmetric(horizontal: 16),
          decoration: const BoxDecoration(border: Border(bottom: BorderSide(color: AvaColors.line))),
          child: const Text('Calls',
              style: TextStyle(color: AvaColors.brand, fontSize: 22, fontWeight: FontWeight.w900, letterSpacing: -0.5)),
        ),
        Expanded(
          child: ListView.builder(
            itemCount: _demoCalls.length,
            itemBuilder: (_, i) {
              final c = _demoCalls[i];
              final missed = c.dir == CallDir.missed;
              return ListTile(
                contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
                leading: Avatar(seed: c.seed, name: c.name, size: 48),
                title: Text(c.name,
                    style: TextStyle(fontWeight: FontWeight.w700, fontSize: 15.5,
                        color: missed ? AvaColors.danger : AvaColors.ink)),
                subtitle: Row(children: [
                  Icon(_dirIcon(c.dir), size: 15,
                      color: missed ? AvaColors.danger : AvaColors.sub),
                  const SizedBox(width: 5),
                  Text('${_dirLabel(c.dir)} · ${c.time}',
                      style: const TextStyle(color: AvaColors.sub, fontSize: 12.5)),
                ]),
                trailing: IconButton(
                  icon: Icon(c.video ? Icons.videocam : Icons.call, color: AvaColors.brand),
                  onPressed: () => _callBack(context, c),
                ),
              );
            },
          ),
        ),
      ]),
    );
  }

  IconData _dirIcon(CallDir d) => switch (d) {
        CallDir.incoming => Icons.call_received,
        CallDir.outgoing => Icons.call_made,
        CallDir.missed => Icons.call_missed,
      };
  String _dirLabel(CallDir d) => switch (d) {
        CallDir.incoming => 'Incoming',
        CallDir.outgoing => 'Outgoing',
        CallDir.missed => 'Missed',
      };
}
