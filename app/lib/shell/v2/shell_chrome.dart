import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/ui/zine_widgets.dart';
import '../../core/ui/avatok_dark.dart';
import '../../core/remote_config.dart';
import '../../core/update_service.dart';
import '../shell_v2.dart';
import 'app_order_screen.dart';
import 'shell_destinations.dart';
import '../../core/ui/messenger_theme.dart';
import '../../core/ui/rajasthani_motifs.dart';

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
  Color? indicatorColor, // Home passes the user's accent (personalisation §D)
}) {
  // [RAJ-SEAMS-1] Footer seam — one hook covering every shell root, since
  // `shellNavBar()` is the single function they all call for the bottom bar
  // (design/seams/patches.md §5). The TorranDivider that used to be here is
  // retired: the owner replaced the drape with five seam styles, and the
  // footer's is always the flipped Double wave on an INDIGO band.
  //
  // The band moved turquoise -> indigo, which is why every label and icon below
  // is now routed through `AD.onBand`. Indigo is a DARK band, so ink type on it
  // is nearly invisible; the nav's foreground was ink only because the footer
  // used to be turquoise.
  //
  // DEVIATION FROM THE PATCH, deliberate and carried over: patches.md §5 writes
  // the band as a raw `Color(0xFF2E4A8C)` literal, which the design guard fails
  // on — `AD.bandIndigo` is that same value. `indicatorColor` is left alone: it
  // is the SELECTED-PILL accent (Home passes the user's personalisation accent),
  // not the band, so it must not be fed to the seam.
  const band = AD.bandIndigo;
  final onBand = AD.onBand(band);
  return Column(
    mainAxisSize: MainAxisSize.min,
    children: [
      const DoubleWaveSeam(bandColor: band, flip: true),
      Container(
        decoration: const BoxDecoration(color: band),
        // [RAJ-SEAMS-1] `labelTextStyle` and `iconTheme` live on
        // NavigationBarThemeData, NOT on the NavigationBar widget — passing
        // either directly to the widget does not compile. This wrapper is the
        // pattern already proven in features/avaphone/ava_phone_screen.dart.
        // The icon colour is ALSO set per-destination below, because the theme
        // only reaches icons that don't carry their own colour.
        child: NavigationBarTheme(
          data: NavigationBarThemeData(
            backgroundColor: band,
            labelTextStyle:
                WidgetStatePropertyAll(ADText.sectionLabel(c: onBand)),
            iconTheme: WidgetStatePropertyAll(IconThemeData(color: onBand)),
          ),
          child: NavigationBar(
            selectedIndex: selectedIndex,
            onDestinationSelected: onSelected,
            backgroundColor: band,
            surfaceTintColor: Colors.transparent,
            indicatorColor: indicatorColor ?? AD.primaryBadge,
            destinations: [
              for (final it in items)
                NavigationDestination(
                  icon: PhosphorIcon(it.icon, color: onBand),
                  selectedIcon: PhosphorIcon(it.selectedIcon, color: onBand),
                  label: it.label,
                ),
            ],
          ),
        ),
      ),
    ],
  );
}

/// A themed empty state used by placeholder tabs ("coming with AvaDial", card
/// unavailable states, etc.).
class ShellEmptyState extends StatelessWidget {
  final IconData icon;
  final String title;
  final String subtitle;
  final Color color;
  /// [RAJ-SEAMS-1] Optional illustration asset (see `core/ui/illustrations.dart`).
  /// When set it replaces the icon badge; when null every existing call site
  /// renders exactly as before. Decorative only — it always sits above the
  /// title, so it is excluded from semantics.
  final String? illustration;
  const ShellEmptyState({
    super.key,
    required this.icon,
    required this.title,
    required this.subtitle,
    this.color = AD.iconSearch,
    this.illustration,
  });

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 36),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          if (illustration != null)
            SvgPicture.asset(illustration!,
                height: 140, fit: BoxFit.contain, excludeFromSemantics: true)
          else
            ZineIconBadge(icon: icon, color: color, size: 56),
          const SizedBox(height: 16),
          Text(title, textAlign: TextAlign.center, style: ADText.threadName().copyWith(fontSize: 18)),
          const SizedBox(height: 8),
          Text(subtitle, textAlign: TextAlign.center,
              style: ADText.preview(c: AD.textSecondary).copyWith(fontSize: 14)),
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
      backgroundColor: AD.menu,
      shape: const Border(right: BorderSide(color: AD.borderHairline, width: 1)),
      width: MediaQuery.of(context).size.width * 0.82,
      child: SafeArea(
        child: Column(children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(Msg.s5, Msg.s4, Msg.s4, Msg.s3),
            child: Row(children: [
              const ZineLogoMark(size: 22),
              const SizedBox(width: 8),
              Text.rich(
                TextSpan(
                  style: TextStyle(
                      fontFamily: ADText.family,
                      fontWeight: FontWeight.w700,
                      fontSize: 19,
                      letterSpacing: -0.38,
                      color: AD.textPrimary),
                  children: [
                    const TextSpan(text: 'Ava'),
                    TextSpan(text: 'TOK', style: TextStyle(color: AD.iconSearch)),
                  ],
                ),
              ),
              const Spacer(),
              AdBackButton(
                icon: PhosphorIcons.x(PhosphorIconsStyle.bold),
                onTap: () => Navigator.of(context).maybePop(),
              ),
            ]),
          ),
          Expanded(
            child: ListView(padding: const EdgeInsets.fromLTRB(Msg.s4, 0, Msg.s4, Msg.s3), children: [
              Padding(
                  padding: const EdgeInsets.fromLTRB(Msg.s2, Msg.s2, Msg.s2, Msg.s2),
                  child: Text('APPS', style: ADText.sectionLabel(c: AD.textTertiary))),
              // 2026-07-14 owner rename: 'AvaTOK' → 'AvaTalk' (display-only;
              // RootId.key stays 'avatalk'). Mirror of app_switcher_bar `_meta`.
              appRow(RootId.avaTalk, 'AvaTalk', 'Messages & in-network calls',
                  PhosphorIcons.chatCircle(PhosphorIconsStyle.bold), AD.online),
              // [IOS-PORT-DISABLE-1] 2026-08-14 owner rename: 'AvaDialer' →
              // 'Calls' (display-only; RootId.key stays 'avadial'). Mirror of
              // app_switcher_bar `_meta`.
              appRow(RootId.avaDial, 'Calls', 'AvaTOK calls, contacts & voicemail',
                  PhosphorIcons.phone(PhosphorIconsStyle.bold), AD.iconSearch),
              appRow(RootId.services,
                  RemoteConfig.marketplaceVisible ? 'Marketplace' : 'Services',
                  'Buy, sell, manage listings & wallet',
                  PhosphorIcons.storefront(PhosphorIconsStyle.bold), AD.danger),
              _SidebarRow(
                icon: PhosphorIcons.sparkle(PhosphorIconsStyle.bold),
                color: AD.iconVideo,
                // 2026-07-14 owner rename: 'Ask Ava' → 'AvaBrain', matching the
                // fixed AI action label in app_switcher_bar. Display-only — the
                // analytics key stays `askava`.
                title: 'AvaBrain',
                subtitle: 'Universal assistant',
                onTap: () {
                  Navigator.of(context).maybePop();
                  scope.askAva(current.key); // seed the assistant with this app's context
                },
              ),
              if (extra.isNotEmpty) ...[
                const SizedBox(height: Msg.s1),
                ...extra,
              ],
              const SizedBox(height: Msg.s1),
              Padding(
                  padding: const EdgeInsets.fromLTRB(Msg.s2, Msg.s2, Msg.s2, Msg.s2),
                  child: Text('MORE', style: ADText.sectionLabel(c: AD.textTertiary))),
              // Rescued from the retired Home dashboard drawer (2026-07-12 nav
              // rebrand) so they stay reachable from every app, not just Home.
              _SidebarRow(
                icon: PhosphorIcons.listNumbers(PhosphorIconsStyle.bold),
                color: AD.iconVideo,
                title: 'App order',
                subtitle: 'Reorder apps & pick your landing app',
                onTap: () {
                  Navigator.of(context).maybePop();
                  Navigator.of(context)
                      .push(MaterialPageRoute(builder: (_) => const AppOrderScreen()));
                },
              ),
              _SidebarRow(
                icon: PhosphorIcons.identificationCard(PhosphorIconsStyle.bold),
                color: AD.iconSearch,
                title: 'Identity',
                onTap: () {
                  Navigator.of(context).maybePop();
                  openShellDestination(context, 'identity');
                },
              ),
              _SidebarRow(
                icon: PhosphorIcons.chartPieSlice(PhosphorIconsStyle.bold),
                color: AD.online,
                title: 'Backup',
                onTap: () {
                  Navigator.of(context).maybePop();
                  openShellDestination(context, 'avastorage');
                },
              ),
              _SidebarRow(
                icon: PhosphorIcons.info(PhosphorIconsStyle.bold),
                color: AD.iconVideo,
                title: 'About',
                onTap: () {
                  Navigator.of(context).maybePop();
                  openShellDestination(context, 'about');
                },
              ),
              _SidebarRow(
                icon: PhosphorIcons.arrowsClockwise(PhosphorIconsStyle.bold),
                color: AD.danger,
                title: 'Update',
                onTap: () {
                  Navigator.of(context).maybePop();
                  UpdateService.runManual();
                },
              ),
              const SizedBox(height: Msg.s1),
              _SidebarRow(
                icon: PhosphorIcons.gearSix(PhosphorIconsStyle.bold),
                color: AD.textTertiary,
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
              border: Border(top: BorderSide(color: AD.borderHairline, width: 1)),
            ),
            padding: const EdgeInsets.fromLTRB(Msg.s4, Msg.s3, Msg.s4, Msg.s3),
            child: GestureDetector(
              behavior: HitTestBehavior.opaque,
              onTap: scope.onSignOut,
              child: Row(children: [
                ZineIconBadge(
                    icon: PhosphorIcons.signOut(PhosphorIconsStyle.bold), color: AD.danger, size: 30),
                const SizedBox(width: 12),
                Text('Log out', style: ADText.rowName(c: AD.danger).copyWith(fontSize: 15)),
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
          color: AD.card,
          borderColor: AD.borderControl,
          borderWidth: 1,
          radius: BorderRadius.circular(AD.rListCard),
          boxShadow: const [],
          padding: const EdgeInsets.symmetric(horizontal: Msg.s3, vertical: Msg.s3),
          child: Row(children: [
            ZineIconBadge(icon: icon, color: color),
            const SizedBox(width: 12),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(title, style: ADText.threadName().copyWith(fontSize: 15)),
                if (subtitle != null) ...[
                  const SizedBox(height: 1),
                  Text(subtitle!, style: ADText.statCaption(c: AD.textSecondary).copyWith(fontSize: 10)),
                ],
              ]),
            ),
            PhosphorIcon(PhosphorIcons.caretRight(PhosphorIconsStyle.bold), size: 14, color: AD.textSecondary),
          ]),
        ),
      );
}
