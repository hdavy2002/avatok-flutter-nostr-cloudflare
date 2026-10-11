import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../auth/session.dart';
import '../strings.dart';
import '../theme/hf_theme.dart';
import '../widgets/hf_floating_nav.dart';
import 'pending_intent.dart';

/// Branch indexes of the shell, in router order. The Host tab always has a branch (so `/host` works as a
/// deep link) but its button shows only when the person has a host profile.
abstract final class TabBranch {
  static const int home = 0;
  static const int explore = 1;
  static const int wallet = 2;
  static const int host = 3;
  static const int me = 4;
}

/// Space the floating nav takes: its 68 px bar plus the 20 px gap under it.
const double kHfNavReserved = 68 + 20;

/// Bottom padding for a scrolling screen inside the shell, so its last item can clear the floating nav.
/// The shell hands each tab the system bottom inset only (not the nav height), so this does not double count.
double hfNavPadding(BuildContext c) =>
    kHfNavReserved + MediaQuery.paddingOf(c).bottom + 12;

class _TabSpec {
  const _TabSpec(this.branch, this.label, this.icon, this.tint, this.key);
  final int branch;
  final String label;
  final IconData icon;
  final HfTint tint;
  final String key;
}

const List<_TabSpec> _allTabs = [
  _TabSpec(
    TabBranch.home,
    Strings.tabHome,
    Icons.search_rounded,
    HfTint.lavender,
    'tab-home',
  ),
  _TabSpec(
    TabBranch.wallet,
    Strings.tabWallet,
    Icons.account_balance_wallet_rounded,
    HfTint.butter,
    'tab-wallet',
  ),
  _TabSpec(
    TabBranch.host,
    Strings.tabHost,
    Icons.mic_rounded,
    HfTint.blush,
    'tab-host',
  ),
  _TabSpec(
    TabBranch.me,
    Strings.tabMe,
    Icons.person_rounded,
    HfTint.sky,
    'tab-me',
  ),
];

/// The bottom-tab shell with the floating nav. Back from a tab other than Home goes to Home; back from Home
/// asks to exit. Screens scroll under the bar (`extendBody`); use [hfNavPadding] as their bottom padding.
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
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: const Text(Strings.exitNo),
          ),
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(true),
            child: const Text(Strings.exitYes),
          ),
        ],
      ),
    );
    if (leave == true) await SystemNavigator.pop();
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final hasHost = ref.watch(sessionProvider.select((s) => s.hasHostTab));
    final tabs = _allTabs
        .where((t) => t.branch != TabBranch.host || hasHost)
        .toList();
    final systemBottom = MediaQuery.paddingOf(context).bottom;
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) _onBack(context);
      },
      child: Scaffold(
        extendBody: true,
        // The body's bottom padding would include the nav height with extendBody; screens add [hfNavPadding]
        // themselves, so give them the system inset only.
        body: Builder(
          builder: (inner) {
            final media = MediaQuery.of(inner);
            return MediaQuery(
              data: media.copyWith(
                padding: media.padding.copyWith(bottom: systemBottom),
              ),
              child: navigationShell,
            );
          },
        ),
        bottomNavigationBar: HfFloatingNav(
          items: [
            for (final t in tabs)
              HfNavItem(
                icon: t.icon,
                label: t.label,
                tint: t.tint,
                keyName: t.key,
              ),
          ],
          selected: tabs.indexWhere(
            (t) =>
                t.branch ==
                (navigationShell.currentIndex == TabBranch.explore
                    ? TabBranch.home
                    : navigationShell.currentIndex),
          ),
          onTap: (i) async {
            final branch = tabs[i].branch;
            if (branch == TabBranch.home &&
                navigationShell.currentIndex == TabBranch.explore) {
              return;
            }
            await ref.read(pendingIntentProvider).clear();
            if (!context.mounted) return;
            navigationShell.goBranch(
              branch,
              initialLocation: branch == navigationShell.currentIndex,
            );
          },
        ),
      ),
    );
  }
}
