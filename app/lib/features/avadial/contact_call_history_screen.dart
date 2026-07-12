import 'package:flutter/material.dart';

import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import 'device_call_log.dart';
import 'device_contacts.dart';

/// "Call history" screen for a single Calls-app contact/number — every device
/// call-log row that matches this number (by [DeviceContacts.normKey] suffix),
/// newest first.
class ContactCallHistoryScreen extends StatefulWidget {
  final String number;
  final String? name;
  const ContactCallHistoryScreen({super.key, required this.number, this.name});

  @override
  State<ContactCallHistoryScreen> createState() => _ContactCallHistoryScreenState();
}

class _ContactCallHistoryScreenState extends State<ContactCallHistoryScreen> {
  late Future<List<DeviceCall>> _future = _load();

  Future<List<DeviceCall>> _load() async {
    final all = await DeviceCallLog.I.load();
    final key = DeviceContacts.normKey(widget.number);
    final matches = all.where((e) => DeviceContacts.normKey(e.number) == key).toList()
      ..sort((a, b) => b.date.compareTo(a.date));
    return matches;
  }

  IconData _iconFor(DeviceCallType t) => switch (t) {
        DeviceCallType.outgoing => Icons.call_made,
        DeviceCallType.missed => Icons.call_missed,
        DeviceCallType.rejected => Icons.call_end,
        DeviceCallType.blocked => Icons.block,
        _ => Icons.call_received,
      };

  Color _colorFor(DeviceCallType t) => switch (t) {
        DeviceCallType.missed || DeviceCallType.rejected || DeviceCallType.blocked => Zine.coral,
        DeviceCallType.outgoing => Zine.mint,
        _ => Zine.blue,
      };

  String _when(DateTime d) =>
      '${d.day}/${d.month}/${d.year} · ${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';

  String _durationLabel(Duration d) {
    if (d.inSeconds <= 0) return '';
    final m = d.inMinutes;
    final s = d.inSeconds % 60;
    return m > 0 ? '${m}m ${s}s' : '${s}s';
  }

  @override
  Widget build(BuildContext context) {
    final title = (widget.name?.isNotEmpty ?? false) ? widget.name! : widget.number;
    return Scaffold(
      backgroundColor: Zine.paper,
      appBar: AppBar(
        backgroundColor: Zine.paper2,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        shape: const Border(bottom: BorderSide(color: Zine.ink, width: Zine.bw)),
        title: Text('Call history', style: ZineText.appbar()),
      ),
      body: FutureBuilder<List<DeviceCall>>(
        future: _future,
        builder: (context, snap) {
          if (snap.connectionState != ConnectionState.done) {
            return const Center(child: CircularProgressIndicator(color: Zine.ink));
          }
          final calls = snap.data ?? const [];
          return ListView(
            padding: const EdgeInsets.fromLTRB(14, 12, 14, 24),
            children: [
              Text(title, style: ZineText.cardTitle(size: 20)),
              Text(widget.number, style: ZineText.sub(size: 13)),
              const SizedBox(height: 4),
              Text('${calls.length} call${calls.length == 1 ? '' : 's'}', style: ZineText.tag(size: 11.5)),
              const SizedBox(height: 12),
              if (calls.isEmpty)
                Padding(
                  padding: const EdgeInsets.only(top: 40),
                  child: Center(child: Text('No calls with this number yet', style: ZineText.sub(size: 14))),
                )
              else
                for (final c in calls)
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 4),
                    child: ZineCard(
                      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                      child: Row(children: [
                        ZineIconBadge(icon: _iconFor(c.type), color: _colorFor(c.type)),
                        const SizedBox(width: 12),
                        Expanded(
                          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                            Text(c.type.name[0].toUpperCase() + c.type.name.substring(1),
                                style: ZineText.cardTitle(size: 14.5)),
                            Text(_when(c.date), style: ZineText.sub(size: 12)),
                          ]),
                        ),
                        if (_durationLabel(c.duration).isNotEmpty)
                          Text(_durationLabel(c.duration), style: ZineText.tag(size: 11.5)),
                      ]),
                    ),
                  ),
            ],
          );
        },
      ),
    );
  }
}
