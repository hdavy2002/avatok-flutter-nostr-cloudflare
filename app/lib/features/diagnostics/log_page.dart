import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../core/ava_log.dart';
import '../../core/ice_cache.dart';

/// Diagnostics / logs screen reachable from the sidebar. Shows the latest
/// in-app log and lets the user copy it to paste back for debugging.
class LogPage extends StatefulWidget {
  const LogPage({super.key});
  @override
  State<LogPage> createState() => _LogPageState();
}

class _LogPageState extends State<LogPage> {
  @override
  void initState() {
    super.initState();
    AvaLog.I.changes.listen((_) { if (mounted) setState(() {}); });
  }

  @override
  Widget build(BuildContext context) {
    final text = AvaLog.I.dump();
    return Scaffold(
      appBar: AppBar(
        title: const Text('Diagnostics'),
        actions: [
          IconButton(
            tooltip: 'Copy log',
            icon: const Icon(Icons.copy_all),
            onPressed: () async {
              await Clipboard.setData(ClipboardData(text: text));
              if (context.mounted) {
                ScaffoldMessenger.of(context).showSnackBar(
                  const SnackBar(content: Text('Log copied — paste it back to share')));
              }
            },
          ),
          IconButton(
            tooltip: 'Clear',
            icon: const Icon(Icons.delete_outline),
            onPressed: () => AvaLog.I.clear(),
          ),
        ],
      ),
      body: Column(children: [
        // TURN-only test mode: forces calls through the relay (iceTransportPolicy:
        // 'relay') to validate the worst-case media path on demand. Device-level
        // tester knob — not per-account data.
        SwitchListTile(
          dense: true,
          title: const Text('Force TURN relay on calls', style: TextStyle(fontSize: 13.5)),
          subtitle: const Text('Test the worst-case path: media is forced through the relay', style: TextStyle(fontSize: 11.5)),
          value: CallDiag.turnOnly,
          onChanged: (v) async {
            await CallDiag.setTurnOnly(v);
            AvaLog.I.log('call', 'diag: TURN-only mode ${v ? 'ON' : 'OFF'}');
            if (mounted) setState(() {});
          },
        ),
        const Divider(height: 1),
        Expanded(
          child: text.isEmpty
              ? const Center(child: Text('No log yet. Open a chat and send a message.'))
              : Scrollbar(
                  child: SingleChildScrollView(
                    padding: const EdgeInsets.all(12),
                    child: SelectableText(
                      text,
                      style: const TextStyle(fontFamily: 'monospace', fontSize: 11.5, height: 1.45),
                    ),
                  ),
                ),
        ),
      ]),
      floatingActionButton: FloatingActionButton.extended(
        icon: const Icon(Icons.copy),
        label: Text('Copy (${AvaLog.I.length})'),
        onPressed: () async {
          await Clipboard.setData(ClipboardData(text: text));
          if (context.mounted) {
            ScaffoldMessenger.of(context).showSnackBar(
              const SnackBar(content: Text('Log copied to clipboard')));
          }
        },
      ),
    );
  }
}
