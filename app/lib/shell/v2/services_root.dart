import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/ui/zine.dart';
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
      backgroundColor: Zine.paper,
      drawer: ShellSidebar(
        current: RootId.services,
        extra: [
          Padding(
            padding: const EdgeInsets.fromLTRB(6, 8, 6, 4),
            child: Text('MARKETPLACE', style: ZineText.kicker()),
          ),
          ShellMenuRow(
            icon: PhosphorIcons.storefront(PhosphorIconsStyle.bold),
            color: Zine.coral,
            title: 'Browse',
            onTap: () {
              Navigator.of(context).maybePop();
              openShellDestination(context, 'marketplace');
            },
          ),
          ShellMenuRow(
            icon: PhosphorIcons.tag(PhosphorIconsStyle.bold),
            color: Zine.blue,
            title: 'My listings',
            onTap: () {
              Navigator.of(context).maybePop();
              openShellDestination(context, 'mylistings');
            },
          ),
          ShellMenuRow(
            icon: PhosphorIcons.plusCircle(PhosphorIconsStyle.bold),
            color: Zine.lime,
            title: 'Sell',
            onTap: () {
              Navigator.of(context).maybePop();
              openShellDestination(context, 'createlisting');
            },
          ),
          ShellMenuRow(
            icon: PhosphorIcons.archive(PhosphorIconsStyle.bold),
            color: Zine.lilac,
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
              color: Zine.mint,
              title: 'Wallet',
              subtitle: 'Balance & AvaCoins',
              onTap: () {
                Navigator.of(context).maybePop();
                openShellDestination(context, 'wallet');
              },
            ),
          if (payoutEntryVisible)
            ShellMenuRow(
              icon: PhosphorIcons.bank(PhosphorIconsStyle.bold),
              color: Zine.blue,
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
        title: Text('Services', style: ZineText.appbar()),
      ),
      body: const MarketplaceBrowse(),
    );
  }
}
