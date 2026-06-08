import 'package:flutter/material.dart';

import '../../core/avatar.dart';
import '../../core/call_log_store.dart';
import '../../core/theme.dart';
import 'call_screen.dart';
import 'contacts.dart';

/// AvaTok Calls tab — real 1:1 call history; tap to call back.
class CallsScreen extends StatefulWidget {
  const CallsScreen({super.key});
  @override
  State<CallsScreen> createState() => _CallsScreenState();
}

class _CallsScreenState extends State<CallsScreen> {
  final _store = CallLogStore();
  List<CallEntry> _calls = [];
  Map<String, String> _avatars = {}; // npub → photo URL (from contacts)
  bool _loaded = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final c = await _store.load();
    final contacts = await ContactsStore().load();
    final avatars = {for (final x in contacts) if (x.avatarUrl.isNotEmpty) x.npub: x.avatarUrl};
    if (mounted) setState(() { _calls = c; _avatars = avatars; _loaded = true; });
  }

  void _callBack(CallEntry c) {
    Navigator.push(context, MaterialPageRoute(
      builder: (_) => CallScreen(room: 'avatok-${c.seed}', title: c.name, seed: c.seed, video: c.video, avatarUrl: _avatars[c.seed] ?? ''),
    )).then((_) => _load());
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
          child: !_loaded
              ? const Center(child: CircularProgressIndicator(color: AvaColors.brand))
              : _calls.isEmpty
                  ? const Center(child: Padding(
                      padding: EdgeInsets.all(24),
                      child: Text('No calls yet — start one from a chat',
                          style: TextStyle(color: AvaColors.sub)),
                    ))
                  : RefreshIndicator(
                      onRefresh: _load,
                      child: ListView.builder(
                        itemCount: _calls.length,
                        itemBuilder: (_, i) {
                          final c = _calls[i];
                          final missed = c.dir == CallDir.missed;
                          return ListTile(
                            contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
                            leading: Avatar(seed: c.seed, name: c.name, size: 48, avatarUrl: _avatars[c.seed]),
                            title: Text(c.name,
                                style: TextStyle(fontWeight: FontWeight.w700, fontSize: 15.5,
                                    color: missed ? AvaColors.danger : AvaColors.ink)),
                            subtitle: Row(children: [
                              Icon(_dirIcon(c.dir), size: 15, color: missed ? AvaColors.danger : AvaColors.sub),
                              const SizedBox(width: 5),
                              Text('${_dirLabel(c.dir)} · ${c.timeLabel}',
                                  style: const TextStyle(color: AvaColors.sub, fontSize: 12.5)),
                            ]),
                            trailing: IconButton(
                              icon: Icon(c.video ? Icons.videocam : Icons.call, color: AvaColors.brand),
                              onPressed: () => _callBack(c),
                            ),
                          );
                        },
                      ),
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
