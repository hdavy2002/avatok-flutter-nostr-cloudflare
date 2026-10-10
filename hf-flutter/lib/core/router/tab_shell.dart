import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../auth/session.dart';
import '../strings.dart';
import '../theme/hf_tokens.dart';

/// Branch indexes of the shell, in router order. The Host tab always has a branch (so `/host` works as a
/// deep link) but its button shows only when the person has a host profile.
abstract final class TabBranch {
  static const int home = 0;
  static const int explore = 1;
  static const int wallet = 2;
  static const int host = 3;
  static const int me = 4;
}

class _TabSpec {
  const _TabSpec(this.branch, this.label, this.icon, this.iconSelected, this.key);
  final int branch;
  final String label;
  final IconData icon;
  final IconData iconSelected;
  final String key;
}

const List<_TabSpec> _allTabs = [
  _TabSpec(TabBranch.home, Strings.tabHome, Icons.home_outlined, Icons.home_rounded, 'tab-home'),
  _TabSpec(TabBranch.explore, Strings.tabExplore, Icons.explore_outlined, Icons.explore_rounded, 'tab-explore'),
  _TabSpec(TabBranch.wallet, Strings.tabWallet, Icons.account_balance_wallet_outlined,
      Icons.account_balance_wallet_rounded, 'tab-wallet'),
  _TabSpec(TabBranch.host, Strings.tabHost, Icons.storefront_outlined, Icons.storefront_rounded, 'tab-host'),
  _TabSpec(TabBranch.me, Strings.tabMe, Icons.person_outline_rounded, Icons.person_rounded, 'tab-me'),
];

/// The bottom-tab shell. Back from a tab other than Home goes to Home; back from Home asks to exit.
class HfTabShell extends ConsumerWidget {
  const HfTabShell({super.key, required this.navigationShell});

  final StatefulNavigationShell navigationShell;

  Future<void> _onBack(BuildContext context) async {
    if (navigationShell.currentIndex != TabBranch.home) {
      navigationShell.goBranch(TabBranch.home);
      return;
    }
    final leave = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text(Strings.exitTitle),
        actions: [
          TextButton(onPressed: () => Navigator.of(ctx).pop(false), child: const Text(Strings.exitNo)),
          TextButton(onPressed: () => Navigator.of(ctx).pop(true), child: const Text(Strings.exitYes)),
        ],
      ),
    );
    if (leave == true) await SystemNavigator.pop();
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final hasHost = ref.watch(sessionProvider.select((s) => s.hasHostTab));
    final tabs = _allTabs.where((t) => t.branch != TabBranch.host || hasHost).toList();
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) _onBack(context);
      },
      child: Scaffold(
        body: navigationShell,
        bottomNavigationBar: HfTabBar(
          tabs: [for (final t in tabs) HfTabItem(key: t.key, label: t.label, icon: t.icon, iconSelected: t.iconSelected)],
          selected: tabs.indexWhere((t) => t.branch == navigationShell.currentIndex),
          onTap: (i) {
            final branch = tabs[i].branch;
            navigationShell.goBranch(branch, initialLocation: branch == navigationShell.currentIndex);
          },
        ),
      ),
    );
  }
}

class HfTabItem {
  const HfTabItem({required this.key, required this.label, required this.icon, required this.iconSelected});
  final String key;
  final String label;
  final IconData icon;
  final IconData iconSelected;
}

/// 64 dp bar, a lilac pill behind the selected icon, 14 sp labels (the floor), text scale clamped to 1.15
/// so a large system font never overflows the bar.
class HfTabBar extends StatelessWidget {
  const HfTabBar({super.key, required this.tabs, required this.selected, required this.onTap});

  final List<HfTabItem> tabs;

  /// Index into [tabs], or -1 when the current page has no tab (for example `/host` without a host profile).
  final int selected;
  final ValueChanged<int> onTap;

  @override
  Widget build(BuildContext context) {
    final media = MediaQuery.of(context);
    final scale = media.textScaler.clamp(maxScaleFactor: 1.15);
    return MediaQuery(
      data: media.copyWith(textScaler: scale),
      child: Material(
        color: HfColors.white,
        elevation: 8,
        shadowColor: const Color(0x2246113E),
        child: SafeArea(
          top: false,
          child: SizedBox(
            height: 64,
            child: Row(
              children: [
                for (var i = 0; i < tabs.length; i++)
                  Expanded(
                    child: _TabButton(item: tabs[i], selected: i == selected, onTap: () => onTap(i)),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _TabButton extends StatelessWidget {
  const _TabButton({required this.item, required this.selected, required this.onTap});

  final HfTabItem item;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      selected: selected,
      label: item.label,
      excludeSemantics: true,
      child: InkWell(
        key: ValueKey<String>(item.key),
        onTap: onTap,
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            AnimatedContainer(
              duration: const Duration(milliseconds: 180),
              width: 56,
              height: 30,
              decoration: BoxDecoration(
                color: selected ? HfColors.lilac : Colors.transparent,
                borderRadius: BorderRadius.circular(HfRadius.pill),
              ),
              child: Icon(
                selected ? item.iconSelected : item.icon,
                size: 24,
                color: selected ? HfColors.orchid : HfColors.mauve,
              ),
            ),
            const SizedBox(height: 2),
            Text(
              item.label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: HfText.label.copyWith(
                fontWeight: selected ? FontWeight.w700 : FontWeight.w500,
                color: selected ? HfColors.plum : HfColors.mauve,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
