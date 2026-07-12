import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/ui/zine.dart';
import '../../core/update_service.dart';
import '../shell_v2.dart';
import 'card_manager_screen.dart';
import 'home_cards.dart';
import 'shell_chrome.dart';
import 'shell_destinations.dart';

/// Home root (plan §3) — a scrollable dashboard of cards, with the footer acting
/// as the app switcher (Home · AvaDial · AvaTalk · Services · AI). AI is a GLOBAL
/// ACTION (opens the universal Ask Ava overlay), NOT a navigator root.
class HomeRoot extends StatelessWidget {
  const HomeRoot({super.key});

  static const _items = [
    ShellNavItem(Icons.home_outlined, Icons.home, 'Home'),
    ShellNavItem(Icons.phone_outlined, Icons.phone, 'AvaDial'),
    ShellNavItem(Icons.chat_bubble_outline, Icons.chat_bubble, 'AvaTalk'),
    ShellNavItem(Icons.storefront_outlined, Icons.storefront, 'Services'),
    ShellNavItem(Icons.auto_awesome_outlined, Icons.auto_awesome, 'AI'),
  ];

  @override
  Widget build(BuildContext context) {
    final scope = ShellScope.of(context);

    void onFooter(int i) {
      switch (i) {
        case 0:
          break; // already Home
        case 1:
          scope.switchRoot(RootId.avaDial);
          break;
        case 2:
          scope.switchRoot(RootId.avaTalk);
          break;
        case 3:
          scope.switchRoot(RootId.services);
          break;
        case 4:
          scope.askAva(); // global action — not a root
          break;
      }
    }

    return Scaffold(
      backgroundColor: Zine.paper,
      drawer: ShellSidebar(
        current: RootId.home,
        extra: [
          Padding(
            padding: const EdgeInsets.fromLTRB(6, 8, 6, 4),
            child: Text('THIS DEVICE', style: ZineText.kicker()),
          ),
          ShellMenuRow(
            icon: PhosphorIcons.squaresFour(PhosphorIconsStyle.bold),
            color: Zine.lime,
            title: 'Cards',
            subtitle: 'Choose what shows on Home',
            onTap: () {
              Navigator.of(context).maybePop();
              Navigator.of(context)
                  .push(MaterialPageRoute(builder: (_) => const HomeCardsManagerScreen()));
            },
          ),
          ShellMenuRow(
            icon: PhosphorIcons.identificationCard(PhosphorIconsStyle.bold),
            color: Zine.blue,
            title: 'Identity',
            onTap: () {
              Navigator.of(context).maybePop();
              openShellDestination(context, 'identity');
            },
          ),
          ShellMenuRow(
            icon: PhosphorIcons.chartPieSlice(PhosphorIconsStyle.bold),
            color: Zine.mint,
            title: 'Backup',
            onTap: () {
              Navigator.of(context).maybePop();
              openShellDestination(context, 'avastorage');
            },
          ),
          ShellMenuRow(
            icon: PhosphorIcons.info(PhosphorIconsStyle.bold),
            color: Zine.lilac,
            title: 'About',
            onTap: () {
              Navigator.of(context).maybePop();
              openShellDestination(context, 'about');
            },
          ),
          ShellMenuRow(
            icon: PhosphorIcons.arrowsClockwise(PhosphorIconsStyle.bold),
            color: Zine.coral,
            title: 'Update',
            onTap: () {
              Navigator.of(context).maybePop();
              UpdateService.runManual();
            },
          ),
        ],
      ),
      appBar: AppBar(
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
        title: Text('Home', style: ZineText.appbar()),
      ),
      bottomNavigationBar: shellNavBar(
        selectedIndex: 0,
        items: _items,
        onSelected: onFooter,
      ),
      body: const SafeArea(top: false, child: HomeCards()),
    );
  }
}
