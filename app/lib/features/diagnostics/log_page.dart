import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/ava_log.dart';
import '../../core/ice_cache.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';

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
      backgroundColor: Zine.paper,
      appBar: ZineAppBar(
        title: 'Diagnostics',
        markWord: 'Diag',
        tag: 'in-app log',
        actions: [
          ZineBackButton(
            icon: PhosphorIcons.copy(PhosphorIconsStyle.bold),
            onTap: () async {
              await Clipboard.setData(ClipboardData(text: text));
              if (context.mounted) {
                ScaffoldMessenger.of(context).showSnackBar(
                  const SnackBar(content: Text('Log copied — paste it back to share')));
              }
            },
          ),
          const SizedBox(width: 10),
          ZineBackButton(
            icon: PhosphorIcons.trash(PhosphorIconsStyle.bold),
            onTap: () => AvaLog.I.clear(),
          ),
        ],
      ),
      body: Column(children: [
        // TURN-only test mode: forces calls through the relay (iceTransportPolicy:
        // 'relay') to validate the worst-case media path on demand. Device-level
        // tester knob — not per-account data.
        Padding(
          padding: const EdgeInsets.fromLTRB(18, 14, 18, 12),
          child: ZineCard(
            radius: Zine.rSm,
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 11),
            boxShadow: Zine.shadowXs,
            child: Row(children: [
              Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('Force TURN relay on calls', style: ZineText.value(size: 13.5)),
                const SizedBox(height: 2),
                Text('Test the worst-case path: media is forced through the relay',
                    style: ZineText.sub(size: 11.5)),
              ])),
              const SizedBox(width: 10),
              ZineToggle(
                value: CallDiag.turnOnly,
                onChanged: (v) async {
                  await CallDiag.setTurnOnly(v);
                  AvaLog.I.log('call', 'diag: TURN-only mode ${v ? 'ON' : 'OFF'}');
                  if (mounted) setState(() {});
                },
              ),
            ]),
          ),
        ),
        Expanded(
          child: text.isEmpty
              ? Center(
                  child: ZineEmptyState(
                    icon: PhosphorIcons.terminalWindow(PhosphorIconsStyle.bold),
                    text: 'No log yet. Open a chat and send a message.',
                  ),
                )
              : Padding(
                  padding: const EdgeInsets.fromLTRB(18, 0, 18, 12),
                  child: ZineCard(
                    radius: Zine.rSm,
                    padding: EdgeInsets.zero,
                    boxShadow: Zine.shadowXs,
                    child: Scrollbar(
                      child: SingleChildScrollView(
                        padding: const EdgeInsets.all(12),
                        child: SelectableText(
                          text,
                          style: const TextStyle(
                              fontFamily: ZineText.mono, fontSize: 11.5,
                              height: 1.45, color: Zine.ink),
                        ),
                      ),
                    ),
                  ),
                ),
        ),
      ]),
      floatingActionButton: ZineButton(
        label: 'Copy (${AvaLog.I.length})',
        fontSize: 16,
        icon: PhosphorIcons.copy(PhosphorIconsStyle.bold),
        trailingIcon: false,
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
