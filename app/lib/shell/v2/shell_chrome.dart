import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import '../shell_v2.dart';
import 'shell_destinations.dart';

/// A single destination in a shell footer (app switcher on Home, app tabs inside
/// a sub-app).
class ShellNavItem {
  final IconData icon;
  final IconData selectedIcon;
  final String label;
  const ShellNavItem(this.icon, this.selectedIcon, this.label);
}

/// The bordered, paper-2 [NavigationBar] used by every shell root, styled to
/// match the existing messenger footer (ink top border, lime indicator).
Widget shellNavBar({
  required int selectedIndex,
  required List<ShellNavItem> items,
  required ValueChanged<int> onSelected,
}) {
  return Container(
    decoration: const BoxDecoration(
      border: Border(top: BorderSide(color: Zine.ink, width: Zine.bw)),
    ),
    child: NavigationBar(
      selectedIndex: selectedIndex,
      onDestinationSelected: onSelected,
      backgroundColor: Zine.paper2,
      surfaceTintColor: Colors.transparent,
      indicatorColor: Zine.lime,
      destinations: [
        for (final it in items)
          NavigationDestination(
            icon: PhosphorIcon(it.icon),
            selectedIcon: PhosphorIcon(it.selectedIcon),
            label: it.label,
          ),
      ],
    ),
  );
}

/// A themed empty state used by placeholder tabs ("coming with AvaDial", card
/// unavailable states, etc.).
class ShellEmptyState extends StatelessWidget {
  final IconData icon;
  final String title;
  final String subtitle;
  final Color color;
  const ShellEmptyState({
    super.key,
    required this.icon,
    required this.title,
    required this.subtitle,
    this.color = Zine.blue,
  });

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 36),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          ZineIconBadge(icon: icon, color: color, size: 56),
          const SizedBox(height: 16),
          Text(title, textAlign: TextAlign.center, style: ZineText.cardTitle(size: 18)),
          const SizedBox(height: 8),
          Text(subtitle, textAlign: TextAlign.center, style: ZineText.sub(size: 14)),
        ]),
      ),
    );
  }
}

/// The cross-app sidebar shared by the Home, AvaDial and Services roots. Carries
/// the app switcher (Home + the OTHER three apps), an Ask Ava entry, Settings,
/// plus any app-specific [extra] rows the root passes in. Reuses the AvaSidebar
/// visual language (ink-bordered pressable rows) without depending on its
/// messenger-specific state.
class ShellSidebar extends StatelessWidget {
  /// The root currently showing this sidebar (its own app row is omitted).
  final RootId current;

  /// App-specific menu rows shown under the app switcher (e.g. Services →
  /// Marketplace/Wallet/Payout; Home → Cards/Identity/Backup/About/Update).
  final List<Widget> extra;

  const ShellSidebar({super.key, required this.current, this.extra = const []});

  @override
  Widget build(BuildContext context) {
    final scope = ShellScope.of(context);

    void go(RootId r) {
      Navigator.of(context).maybePop(); // close the drawer
      scope.switchRoot(r);
    }

    Widget appRow(RootId r, String name, String sub, IconData icon, Color color) {
      if (r == current) return const SizedBox.shrink();
      return _SidebarRow(
        icon: icon,
        color: color,
        title: name,
        subtitle: sub,
        onTap: () => go(r),
      );
    }

    return Drawer(
      backgroundColor: Zine.paper2,
      shape: const Border(right: BorderSide(color: Zine.ink, width: Zine.bw)),
      width: MediaQuery.of(context).size.width * 0.82,
      child: SafeArea(
        child: Column(children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(18, 16, 14, 10),
            child: Row(children: [
              const ZineLogoMark(size: 22),
              const SizedBox(width: 8),
              Text.rich(
                TextSpan(
                  style: const TextStyle(
                      fontFamily: ZineText.display,
                      fontWeight: FontWeight.w600,
                      fontSize: 19,
                      letterSpacing: -0.38,
                      color: Zine.ink),
                  children: const [
                    TextSpan(text: 'Ava'),
                    TextSpan(text: 'TOK', style: TextStyle(color: Zine.blueInk)),
                  ],
                ),
              ),
              const Spacer(),
              ZineBackButton(
                icon: PhosphorIcons.x(PhosphorIconsStyle.bold),
                onTap: () => Navigator.of(context).maybePop(),
              ),
            ]),
          ),
          Expanded(
            child: ListView(padding: const EdgeInsets.fromLTRB(14, 0, 14, 10), children: [
              Padding(
                  padding: const EdgeInsets.fromLTRB(6, 6, 6, 8),
                  child: Text('APPS', style: ZineText.kicker())),
              appRow(RootId.home, 'Home', 'Dashboard', PhosphorIcons.house(PhosphorIconsStyle.bold), Zine.lime),
              appRow(RootId.avaDial, 'AvaDial', 'Phone & spam shield',
                  PhosphorIcons.phone(PhosphorIconsStyle.bold), Zine.blue),
              appRow(RootId.avaTalk, 'AvaTalk', 'Messages & in-network calls',
                  PhosphorIcons.chatCircle(PhosphorIconsStyle.bold), Zine.mint),
              appRow(RootId.services, 'Services', 'Marketplace & wallet',
                  PhosphorIcons.storefront(PhosphorIconsStyle.bold), Zine.coral),
              _SidebarRow(
                icon: PhosphorIcons.sparkle(PhosphorIconsStyle.bold),
                color: Zine.lilac,
                title: 'Ask Ava',
                subtitle: 'Universal assistant',
                onTap: () {
                  Navigator.of(context).maybePop();
                  scope.askAva();
                },
              ),
              if (extra.isNotEmpty) ...[
                const SizedBox(height: 6),
                ...extra,
              ],
              const SizedBox(height: 6),
              _SidebarRow(
                icon: PhosphorIcons.gearSix(PhosphorIconsStyle.bold),
                color: Zine.paper,
                title: 'Settings',
                onTap: () {
                  Navigator.of(context).maybePop();
                  openShellDestination(context, 'settings');
                },
              ),
            ]),
          ),
          Container(
            decoration: const BoxDecoration(
              border: Border(top: BorderSide(color: Zine.ink, width: Zine.bw)),
            ),
            padding: const EdgeInsets.fromLTRB(14, 10, 14, 10),
            child: GestureDetector(
              behavior: HitTestBehavior.opaque,
              onTap: scope.onSignOut,
              child: Row(children: [
                ZineIconBadge(
                    icon: PhosphorIcons.signOut(PhosphorIconsStyle.bold), color: Zine.coral, size: 30),
                const SizedBox(width: 12),
                Text('Log out', style: ZineText.value(size: 15, color: Zine.coral)),
              ]),
            ),
          ),
        ]),
      ),
    );
  }
}

/// A sidebar/menu row helper. Public within v2 so roots can build their own
/// app-specific entries (Cards, Marketplace, etc.) with the same look.
class ShellMenuRow extends StatelessWidget {
  final IconData icon;
  final Color color;
  final String title;
  final String? subtitle;
  final VoidCallback onTap;
  const ShellMenuRow({
    super.key,
    required this.icon,
    required this.color,
    required this.title,
    required this.onTap,
    this.subtitle,
  });

  @override
  Widget build(BuildContext context) => _SidebarRow(
        icon: icon,
        color: color,
        title: title,
        subtitle: subtitle,
        onTap: onTap,
      );
}

class _SidebarRow extends StatelessWidget {
  final IconData icon;
  final Color color;
  final String title;
  final String? subtitle;
  final VoidCallback onTap;
  const _SidebarRow({
    required this.icon,
    required this.color,
    required this.title,
    required this.onTap,
    this.subtitle,
  });

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 4),
        child: ZinePressable(
          onTap: onTap,
          color: Zine.card,
          radius: BorderRadius.circular(Zine.rSm),
          boxShadow: Zine.shadowXs,
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
          child: Row(children: [
            ZineIconBadge(icon: icon, color: color),
            const SizedBox(width: 12),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(title, style: ZineText.cardTitle(size: 15.5)),
                if (subtitle != null) ...[
                  const SizedBox(height: 1),
                  Text(subtitle!, style: ZineText.tag(size: 10.5, color: Zine.inkSoft)),
                ],
              ]),
            ),
            PhosphorIcon(PhosphorIcons.caretRight(PhosphorIconsStyle.bold), size: 14, color: Zine.inkSoft),
          ]),
        ),
      );
}
