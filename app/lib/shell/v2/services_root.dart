import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/ui/avatok_dark.dart';
import '../../core/remote_config.dart';
import '../../features/marketplace/marketplace_browse.dart';
import '../shell_v2.dart';
import 'shell_chrome.dart';
import 'shell_destinations.dart';
import '../../core/ui/messenger_theme.dart';

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
          if (RemoteConfig.marketplaceVisible) Padding(
            padding: const EdgeInsets.fromLTRB(Msg.s2, Msg.s2, Msg.s2, Msg.s1),
            child: Text('MARKETPLACE', style: ADText.sectionLabel()),
          ),
          if (RemoteConfig.marketplaceVisible) ShellMenuRow(
            icon: PhosphorIcons.storefront(PhosphorIconsStyle.bold),
            color: AD.danger,
            title: 'Browse',
            onTap: () {
              Navigator.of(context).maybePop();
              openShellDestination(context, 'marketplace');
            },
          ),
          if (RemoteConfig.marketplaceVisible) ShellMenuRow(
            icon: PhosphorIcons.tag(PhosphorIconsStyle.bold),
            color: AD.iconSearch,
            title: 'My listings',
            onTap: () {
              Navigator.of(context).maybePop();
              openShellDestination(context, 'mylistings');
            },
          ),
          if (RemoteConfig.marketplaceVisible) ShellMenuRow(
            icon: PhosphorIcons.plusCircle(PhosphorIconsStyle.bold),
            color: AD.primaryBadge,
            title: 'Sell',
            onTap: () {
              Navigator.of(context).maybePop();
              openShellDestination(context, 'createlisting');
            },
          ),
          if (RemoteConfig.marketplaceVisible) ShellMenuRow(
            icon: PhosphorIcons.archive(PhosphorIconsStyle.bold),
            color: AD.iconVideo,
            title: 'Archived',
            onTap: () {
              Navigator.of(context).maybePop();
              openShellDestination(context, 'archived');
            },
          ),
          const SizedBox(height: Msg.s1),
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
      // [UI-HEADER-2026] Was a hand-rolled `AppBar` whose leading icon and title
      // were drawn in `AD.textPrimary` — INK on the indigo band, i.e. very
      // nearly invisible since [RAJ-INDIGO-1] flipped `headerFooter` from
      // turquoise to indigo. It is now the SHARED header, so the foreground
      // goes through `AD.onBand`, the title ellipsizes to `Market…` on a narrow
      // phone, and the wallet chip / profile avatar / bell appear here exactly
      // as they do on the messenger root.
      appBar: AvaTokHeader(
        title: RemoteConfig.marketplaceVisible ? 'Marketplace' : 'Services',
      ),
      body: const MarketplaceBrowse(),
    );
  }
}
