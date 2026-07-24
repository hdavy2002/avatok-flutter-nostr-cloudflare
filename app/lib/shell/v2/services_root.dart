import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/ui/avatok_dark.dart';
import '../../features/marketplace/marketplace_browse.dart';
import '../shell_v2.dart';
import 'shell_chrome.dart';
import 'shell_destinations.dart';

/// Services root (plan §6) — landing is the existing marketplace browse; the
/// sidebar carries Home, the Marketplace submenus (My Listings / Sell /
/// Archived), Wallet, Payout and Settings. Wallet/Payout entries hide when their
/// existing feature flags disable them.
///
/// NOTE (Phase 1): [MarketplaceBrowse] ships its own Scaffold + AppBar, so this
/// root shows a thin "Services" bar above it purely to reach the shell drawer.
/// Collapsing to a single bar is a Phase-3 cosmetic cleanup (Services tabs are
/// "TBD" in the plan).
class ServicesRoot extends StatelessWidget {
  const ServicesRoot({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AD.bg,
      drawer: ShellSidebar(
        current: RootId.services,
        extra: [
          Padding(
            padding: const EdgeInsets.fromLTRB(6, 8, 6, 4),
            child: Text('SERVICES', style: ADText.sectionLabel()),
          ),
          ShellMenuRow(
            icon: PhosphorIcons.storefront(PhosphorIconsStyle.bold),
            color: AD.danger,
            title: 'Browse',
            onTap: () {
              Navigator.of(context).maybePop();
              openShellDestination(context, 'marketplace');
            },
          ),
          ShellMenuRow(
            icon: PhosphorIcons.tag(PhosphorIconsStyle.bold),
            color: AD.iconSearch,
            title: 'My listings',
            onTap: () {
              Navigator.of(context).maybePop();
              openShellDestination(context, 'mylistings');
            },
          ),
          ShellMenuRow(
            icon: PhosphorIcons.plusCircle(PhosphorIconsStyle.bold),
            color: AD.primaryBadge,
            title: 'Sell',
            onTap: () {
              Navigator.of(context).maybePop();
              openShellDestination(context, 'createlisting');
            },
          ),
          ShellMenuRow(
            icon: PhosphorIcons.archive(PhosphorIconsStyle.bold),
            color: AD.iconVideo,
            title: 'Archived',
            onTap: () {
              Navigator.of(context).maybePop();
              openShellDestination(context, 'archived');
            },
          ),
          const SizedBox(height: 6),
          if (walletEntryVisible)
            ShellMenuRow(
              icon: PhosphorIcons.wallet(PhosphorIconsStyle.bold),
              color: AD.online,
              title: 'Wallet',
              subtitle: 'Balance & Tokens',
              onTap: () {
                Navigator.of(context).maybePop();
                openShellDestination(context, 'wallet');
              },
            ),
          if (payoutEntryVisible)
            ShellMenuRow(
              icon: PhosphorIcons.bank(PhosphorIconsStyle.bold),
              color: AD.iconSearch,
              title: 'Payout',
              subtitle: 'Cash out earnings',
              onTap: () {
                Navigator.of(context).maybePop();
                openShellDestination(context, 'payout');
              },
            ),
        ],
      ),
      appBar: AppBar(
        backgroundColor: AD.headerFooter,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        shape: const Border(bottom: BorderSide(color: AD.borderHairline, width: 1)),
        leading: Builder(
          builder: (ctx) => IconButton(
            icon: PhosphorIcon(PhosphorIcons.list(PhosphorIconsStyle.bold), color: AD.textPrimary),
            onPressed: () => Scaffold.of(ctx).openDrawer(),
          ),
        ),
        title: Text('Services', style: ADText.appTitle()),
      ),
      body: const MarketplaceBrowse(),
    );
  }
}
