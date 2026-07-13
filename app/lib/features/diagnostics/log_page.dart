import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/ava_log.dart';
import '../../core/ice_cache.dart';
import '../../core/ui/avatok_dark.dart';
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
      backgroundColor: AD.bg,
      appBar: PreferredSize(
        preferredSize: const Size.fromHeight(76),
        child: Container(
          decoration: const BoxDecoration(
            color: AD.headerFooter,
            border: Border(bottom: BorderSide(color: AD.borderHairline, width: 1)),
          ),
          child: SafeArea(
            bottom: false,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(8, 6, 12, 10),
              child: Row(children: [
                AdBackButton(onTap: () => Navigator.of(context).maybePop()),
                const SizedBox(width: 6),
                Expanded(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text.rich(
                        TextSpan(children: [
                          const TextSpan(text: 'Diag'),
                          const TextSpan(text: 'nostics',
                              style: TextStyle(color: AD.primaryBadge)),
                        ]),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: ADText.appTitle().copyWith(fontSize: 22, height: 1.08),
                      ),
                      Text('IN-APP LOG', style: ADText.sectionLabel()),
                    ],
                  ),
                ),
                AdBackButton(
                  icon: PhosphorIcons.copy(PhosphorIconsStyle.bold),
                  onTap: () async {
                    await Clipboard.setData(ClipboardData(text: text));
                    if (context.mounted) {
                      ScaffoldMessenger.of(context).showSnackBar(
                        const SnackBar(content: Text('Log copied — paste it back to share')));
                    }
                  },
                ),
                const SizedBox(width: 4),
                AdBackButton(
                  icon: PhosphorIcons.trash(PhosphorIconsStyle.bold),
                  onTap: () => AvaLog.I.clear(),
                ),
              ]),
            ),
          ),
        ),
      ),
      body: Column(children: [
        // TURN-only test mode: forces calls through the relay (iceTransportPolicy:
        // 'relay') to validate the worst-case media path on demand. Device-level
        // tester knob — not per-account data.
        Padding(
          padding: const EdgeInsets.fromLTRB(18, 14, 18, 12),
          child: AdCard(
            radius: AD.rListCard,
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 11),
            boxShadow: const [],
            child: Row(children: [
              Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('Force TURN relay on calls',
                    style: ADText.rowName().copyWith(fontSize: 13.5)),
                const SizedBox(height: 2),
                Text('Test the worst-case path: media is forced through the relay',
                    style: ADText.preview().copyWith(fontSize: 11.5)),
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
                  child: Column(mainAxisSize: MainAxisSize.min, children: [
                    Container(
                      width: 64, height: 64,
                      decoration: BoxDecoration(
                        borderRadius: BorderRadius.circular(AD.rListCard),
                        border: Border.all(color: AD.borderControl, width: 1),
                      ),
                      child: Icon(PhosphorIcons.terminalWindow(PhosphorIconsStyle.bold),
                          size: 30, color: AD.textTertiary),
                    ),
                    const SizedBox(height: 12),
                    Text('No log yet. Open a chat and send a message.',
                        style: ADText.preview(c: AD.textSecondary),
                        textAlign: TextAlign.center),
                  ]),
                )
              : Padding(
                  padding: const EdgeInsets.fromLTRB(18, 0, 18, 12),
                  child: AdCard(
                    radius: AD.rListCard,
                    padding: EdgeInsets.zero,
                    boxShadow: const [],
                    child: Scrollbar(
                      child: SingleChildScrollView(
                        padding: const EdgeInsets.all(12),
                        child: SelectableText(
                          text,
                          style: const TextStyle(
                              fontFamily: ADText.family, fontSize: 11.5,
                              height: 1.45, color: AD.textPrimary),
                        ),
                      ),
                    ),
                  ),
                ),
        ),
      ]),
      floatingActionButton: AdButton(
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
