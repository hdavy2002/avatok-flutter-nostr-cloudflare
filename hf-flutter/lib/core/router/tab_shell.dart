import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../auth/session.dart';
import '../strings.dart';
import '../theme/hf_theme.dart';
import '../widgets/hf_floating_nav.dart';
import 'pending_intent.dart';
import 'routes.dart';

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
  const _TabSpec(this.branch, this.label, this.icon, this.tint, this.color, this.key);
  final int branch;
  final String label;
  final IconData icon;
  final HfTint tint;
  final Color color;
  final String key;
}

const List<_TabSpec> _allTabs = [
  _TabSpec(
    TabBranch.explore,
    Strings.tabHome,
    Icons.search_rounded,
    HfTint.lavender,
    Color(0xFF7841BD),
    'tab-home',
  ),
  _TabSpec(
    TabBranch.wallet,
    Strings.tabWallet,
    Icons.account_balance_wallet_rounded,
    HfTint.butter,
    Color(0xFFB95A13),
    'tab-wallet',
  ),
  _TabSpec(
    TabBranch.host,
    Strings.tabHost,
    Icons.mic_rounded,
    HfTint.blush,
    Color(0xFFC34079),
    'tab-host',
  ),
  _TabSpec(
    TabBranch.me,
    Strings.tabMe,
    Icons.person_rounded,
    HfTint.sky,
    Color(0xFF16877D),
    'tab-me',
  ),
];

/// The bottom-tab shell with the floating nav. Back from a tab other than Explore goes to Explore; back from Explore
/// asks to exit. Screens scroll under the bar (`extendBody`); use [hfNavPadding] as their bottom padding.
class HfTabShell extends ConsumerWidget {
  const HfTabShell({super.key, required this.navigationShell});

  final StatefulNavigationShell navigationShell;

  Future<void> _onBack(BuildContext context) async {
    if (navigationShell.currentIndex != TabBranch.explore) {
      navigationShell.goBranch(TabBranch.explore);
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

  Future<void> _openMenu(
    BuildContext context,
    WidgetRef ref, {
    required bool hasHost,
  }) async {
    final destination = await showModalBottomSheet<String>(
      context: context,
      useRootNavigator: true,
      useSafeArea: true,
      isScrollControlled: true,
      builder: (sheetContext) => SafeArea(
        top: false,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              ListTile(
                title: const Text('More'),
                trailing: IconButton(
                  tooltip: 'Close menu',
                  icon: const Icon(Icons.close),
                  onPressed: () => Navigator.of(sheetContext).pop(),
                ),
              ),
              ListTile(
                key: const ValueKey<String>('menu-calendar'),
                leading: const Icon(Icons.calendar_month_rounded),
                title: const Text('Calendar'),
                subtitle: const Text('Your booked appointments'),
                onTap: () => Navigator.of(sheetContext).pop(Routes.customerBookings),
              ),
              if (hasHost) ...[
                ListTile(
                  key: const ValueKey<String>('menu-host-bookings'),
                  leading: const Icon(Icons.event_note_rounded),
                  title: const Text('Host bookings'),
                  onTap: () => Navigator.of(sheetContext).pop(Routes.hostBookings),
                ),
                ListTile(
                  key: const ValueKey<String>('menu-availability'),
                  leading: const Icon(Icons.event_available_rounded),
                  title: const Text('Availability'),
                  onTap: () => Navigator.of(sheetContext).pop(Routes.hostAvailability),
                ),
              ],
            ],
          ),
        ),
      ),
    );
    if (destination == null || !context.mounted) return;
    await ref.read(pendingIntentProvider).clear();
    if (!context.mounted) return;
    // Push the existing booking screen so its app-bar and system Back return
    // to the tab the person opened the menu from.
    context.push(destination);
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final hasHost = ref.watch(sessionProvider.select((s) => s.hasHostTab));
    final tabs = _allTabs
        .where((t) => t.branch != TabBranch.host || hasHost)
        .toList();
    final profileStyle = navigationShell.currentIndex == TabBranch.me;
    final systemBottom = MediaQuery.paddingOf(context).bottom;
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) _onBack(context);
      },
      child: Scaffold(
        extendBody: true,
        // The body's bottom padding would include the nav height with extendBody; screens add [hfNavPadding]
        // themselves. Me receives the actual full-width nav inset, including the system safe area.
        body: Builder(
          builder: (inner) {
            final media = MediaQuery.of(inner);
            return MediaQuery(
              data: media.copyWith(
                padding: media.padding.copyWith(
                  bottom: profileStyle ? media.padding.bottom : systemBottom,
                ),
              ),
              child: navigationShell,
            );
          },
        ),
        bottomNavigationBar: HfFloatingNav(
          profileStyle: profileStyle,
          items: [
            for (final t in tabs)
              HfNavItem(
                icon: t.icon,
                label: t.label,
                tint: t.tint,
                color: t.color,
                keyName: t.key,
              ),
            const HfNavItem(
              icon: Icons.menu_rounded,
              label: 'More',
              tint: HfTint.lavender,
              keyName: 'tab-more',
            ),
          ],
          selected: tabs.indexWhere(
            (t) =>
                t.branch ==
                (navigationShell.currentIndex == TabBranch.home
                    ? TabBranch.explore
                    : navigationShell.currentIndex),
          ),
          onTap: (i) async {
            if (i == tabs.length) {
              await _openMenu(context, ref, hasHost: hasHost);
              return;
            }
            final branch = tabs[i].branch;
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
