import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/ui/zine_widgets.dart';
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/messenger_theme.dart';
import '../../core/remote_config.dart';
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

  // NOT const: `PhosphorIcons.x(...)` is a function call, so this map has to be
  // `final`. The value type stays `IconData`, so every consumer is unaffected.
  static final Map<RootId, (IconData, String, String, Color)> _meta = {
    RootId.avaDial: (
      PhosphorIcons.phone(PhosphorIconsStyle.regular),
      // [IOS-PORT-DISABLE-1] 2026-08-14 owner rename: 'AvaDialer' → 'Calls'
      // (display-only; RootId.key stays 'avadial'). The device-phone-app layer
      // is retired on all platforms; this root is AvaTOK-network calls.
      'Calls',
      'AvaTOK calls, contacts & voicemail',
      AD.iconSearch
    ),
    // 2026-07-14 owner rename: 'AvaTOK' → 'AvaTalk' (display-only; RootId.key
    // stays 'avatalk'). Mirror of shell/v2/app_switcher_bar.dart `_meta`.
    RootId.avaTalk: (
      PhosphorIcons.chatCircle(PhosphorIconsStyle.regular),
      'AvaTalk',
      'Messages & in-network calls',
      AD.online
    ),
    RootId.services: (
      PhosphorIcons.storefront(PhosphorIconsStyle.regular),
      'Marketplace',
      'Buy, sell, manage listings & wallet',
      AD.danger
    ),
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
      backgroundColor: AD.bg,
      appBar: AppBar(
        backgroundColor: AD.headerFooter,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        shape: const Border(bottom: BorderSide(color: AD.borderHairline, width: 1)),
        title: Text('App order', style: ADText.appTitle()),
        actions: [
          TextButton(
            onPressed: () => scope.setRootOrder(List<RootId>.from(RootOrderPrefs.defaultOrder)),
            child: Text('Reset', style: ADText.rowName(c: AD.iconSearch)),
          ),
        ],
      ),
      body: Column(children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
          child: Align(
            alignment: Alignment.centerLeft,
            child: Text(
              'Drag to reorder your apps. The first app opens automatically when you launch AvaTalk.',
              style: ADText.preview(),
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
      child: AdCard(
        padding: const EdgeInsets.symmetric(horizontal: Msg.s4, vertical: Msg.s3),
        child: Row(children: [
          ReorderableDragStartListener(
            index: index,
            child: Padding(
              padding: const EdgeInsets.only(right: Msg.s3),
              child: PhosphorIcon(PhosphorIcons.dotsSixVertical(PhosphorIconsStyle.bold),
                  size: 18, color: AD.textTertiary),
            ),
          ),
          ZineIconBadge(icon: m.$1, color: m.$4),
          const SizedBox(width: 12),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(root == RootId.services && !RemoteConfig.marketplaceVisible
                  ? 'Services'
                  : m.$2, style: ADText.rowName()),
              const SizedBox(height: 1),
              Text(m.$3, style: ADText.statCaption()),
            ]),
          ),
          if (isLanding)
            Container(
              padding: const EdgeInsets.symmetric(horizontal: Msg.s2, vertical: Msg.s1),
              decoration: BoxDecoration(
                color: AD.primaryBadge,
                borderRadius: Msg.brPill,
                border: Border.all(color: AD.borderControl, width: 1),
              ),
              child: Text('Opens at launch', style: ADText.statCaption(c: Colors.white)),
            ),
        ]),
      ),
    );
  }
}
