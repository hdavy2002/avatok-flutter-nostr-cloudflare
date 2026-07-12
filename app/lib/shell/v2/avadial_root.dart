import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/ui/zine.dart';
import '../../features/avaphone/ava_phone_screen.dart';
import '../shell_v2.dart';
import 'shell_chrome.dart';

/// AvaDial root — the PSTN phone world (plan §4). Phase 1 is a PLACEHOLDER shell:
/// the five footer tabs exist, but only Dialpad has content (it reuses the
/// existing in-network dialer as a stand-in until the native Android telecom
/// layer lands in Phase 2). The other tabs show themed "coming with AvaDial"
/// empty states. Nothing here touches the real phone network yet.
class AvaDialRoot extends StatefulWidget {
  const AvaDialRoot({super.key});

  @override
  State<AvaDialRoot> createState() => _AvaDialRootState();
}

class _AvaDialRootState extends State<AvaDialRoot> {
  int _tab = 0;

  static const _items = [
    ShellNavItem(Icons.dialpad_outlined, Icons.dialpad, 'Dialpad'),
    ShellNavItem(Icons.person_outline, Icons.person, 'Contacts'),
    ShellNavItem(Icons.history_outlined, Icons.history, 'Logs'),
    ShellNavItem(Icons.sms_outlined, Icons.sms, 'Messages'),
    ShellNavItem(Icons.block_outlined, Icons.block, 'Block'),
  ];

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Zine.paper,
      drawer: const ShellSidebar(current: RootId.avaDial),
      appBar: _bar(context),
      bottomNavigationBar: shellNavBar(
        selectedIndex: _tab,
        items: _items,
        onSelected: (i) => setState(() => _tab = i),
      ),
      body: SafeArea(
        top: false,
        child: IndexedStack(index: _tab, children: [
          // Dialpad — reuses the existing dialer (in-network today; the native
          // PSTN dialpad replaces this in Phase 2).
          const AvaPhoneScreen(),
          const ShellEmptyState(
            icon: Icons.person_outline,
            title: 'Contacts',
            subtitle: 'Your phone book, spam-labelled — coming with AvaDial.',
            color: Zine.blue,
          ),
          const ShellEmptyState(
            icon: Icons.history_outlined,
            title: 'Call logs',
            subtitle: 'Your device call history with friend/spam labels — coming with AvaDial.',
            color: Zine.mint,
          ),
          const ShellEmptyState(
            icon: Icons.sms_outlined,
            title: 'Messages',
            subtitle: 'Carrier SMS lands here once Ava is your SMS app — coming with AvaDial.',
            color: Zine.lilac,
          ),
          const ShellEmptyState(
            icon: Icons.block_outlined,
            title: 'Block list',
            subtitle: 'Blocked numbers and one-tap spam reports — coming with AvaDial.',
            color: Zine.coral,
          ),
        ]),
      ),
    );
  }

  PreferredSizeWidget _bar(BuildContext context) => AppBar(
        backgroundColor: Zine.paper2,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        shape: const Border(bottom: BorderSide(color: Zine.ink, width: Zine.bw)),
        leading: Builder(
          builder: (ctx) => IconButton(
            icon: PhosphorIcon(PhosphorIcons.list(PhosphorIconsStyle.bold), color: Zine.ink),
            onPressed: () => Scaffold.of(ctx).openDrawer(),
          ),
        ),
        title: Text('AvaDial', style: ZineText.appbar()),
      );
}
