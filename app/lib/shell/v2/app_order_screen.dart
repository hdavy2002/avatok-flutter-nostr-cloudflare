import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import '../shell_v2.dart';
import 'root_order_store.dart';

/// Home → App order (AVA-SHELL-8). A drag-to-reorder list of the four app-switcher
/// roots (Home · AvaDial · AvaTalk · Services) plus a reset-to-default button. This
/// mirrors the Home footer drag on a fuller surface for discoverability, and the
/// FIRST row is the landing app on cold open.
///
/// Both this screen and the footer commit through the SAME [ShellScope.setRootOrder]
/// path, so the footer, the landing decision and this list are always consistent.
/// The AI action is a global action (not a root) and never appears here.
class AppOrderScreen extends StatelessWidget {
  const AppOrderScreen({super.key});

  static const Map<RootId, (IconData, String, String, Color)> _meta = {
    RootId.avaDial: (Icons.phone, 'AvaDialer', 'Phone, spam shield & device contacts', Zine.blue),
    RootId.avaTalk: (Icons.chat_bubble, 'AvaTOK', 'Messages & in-network calls', Zine.mint),
    RootId.services: (Icons.storefront, 'Marketplace', 'Browse & wallet', Zine.coral),
  };

  @override
  Widget build(BuildContext context) {
    final scope = ShellScope.of(context);
    final order = scope.rootOrder;

    void reorder(int oldIndex, int newIndex) {
      final next = List<RootId>.from(order);
      if (newIndex > oldIndex) newIndex -= 1;
      final moved = next.removeAt(oldIndex);
      next.insert(newIndex, moved);
      scope.setRootOrder(next);
    }

    return Scaffold(
      backgroundColor: Zine.paper,
      appBar: AppBar(
        backgroundColor: Zine.paper2,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        shape: const Border(bottom: BorderSide(color: Zine.ink, width: Zine.bw)),
        title: Text('App order', style: ZineText.appbar()),
        actions: [
          TextButton(
            onPressed: () => scope.setRootOrder(List<RootId>.from(RootOrderPrefs.defaultOrder)),
            child: Text('Reset', style: ZineText.value(size: 14, color: Zine.blueInk)),
          ),
        ],
      ),
      body: Column(children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
          child: Align(
            alignment: Alignment.centerLeft,
            child: Text(
              'Drag to reorder your apps. The first app opens automatically when you launch AvaTOK.',
              style: ZineText.sub(size: 14),
            ),
          ),
        ),
        Expanded(
          child: ReorderableListView.builder(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
            itemCount: order.length,
            onReorder: reorder,
            proxyDecorator: (child, index, animation) =>
                Material(color: Colors.transparent, child: child),
            itemBuilder: (context, i) => _row(order[i], i, i == 0),
          ),
        ),
      ]),
    );
  }

  Widget _row(RootId root, int index, bool isLanding) {
    final m = _meta[root]!;
    return Padding(
      key: ValueKey(root.key),
      padding: const EdgeInsets.only(bottom: 12),
      child: ZineCard(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        child: Row(children: [
          ReorderableDragStartListener(
            index: index,
            child: Padding(
              padding: const EdgeInsets.only(right: 10),
              child: PhosphorIcon(PhosphorIcons.dotsSixVertical(PhosphorIconsStyle.bold),
                  size: 18, color: Zine.inkSoft),
            ),
          ),
          ZineIconBadge(icon: m.$1, color: m.$4),
          const SizedBox(width: 12),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(m.$2, style: ZineText.cardTitle(size: 15.5)),
              const SizedBox(height: 1),
              Text(m.$3, style: ZineText.tag(size: 10.5, color: Zine.inkSoft)),
            ]),
          ),
          if (isLanding)
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
              decoration: BoxDecoration(
                color: Zine.lime,
                borderRadius: BorderRadius.circular(999),
                border: Border.all(color: Zine.ink, width: Zine.bw),
              ),
              child: Text('Opens at launch', style: ZineText.tag(size: 9.5, color: Zine.ink)),
            ),
        ]),
      ),
    );
  }
}
