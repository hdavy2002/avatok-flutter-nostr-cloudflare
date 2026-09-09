import 'package:flutter/material.dart';

import '../../core/ui/avatok_dark.dart';
import '../../core/remote_config.dart';
import '../../features/marketplace/marketplace_browse.dart';
import '../ava_sidebar.dart'; // [SIDEBAR-UNIFY-1] AvaSidebarForShell
import 'shell_chrome.dart';

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
      // [SIDEBAR-UNIFY-1] AvaSidebar is now the only sidebar (owner decision
      // 2026-08-28) — was `ShellSidebar(current: RootId.services, extra: [...])`
      // carrying Marketplace/Wallet/Payout rows. AvaSidebar already has its own
      // Marketplace group (Browse/Create/My listings/Archived, gated on
      // `RemoteConfig.marketplaceVisible`, same as here) and its own Wallet row;
      // Payout had no AvaSidebar equivalent, so a matching row (gated on
      // `RemoteConfig.billingEnabled`, same as `payoutEntryVisible` below) was
      // added to `AvaSidebar` itself rather than dropped. See ava_sidebar.dart.
      drawer: const AvaSidebarForShell(),
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
      // [UI-MARKET-2026] `embedded` is PASSED, not inferred. MarketplaceBrowse
      // can infer it from being the first route of its navigator, which is true
      // here today — but a refactor that changes how this root is routed would
      // silently resurrect the stacked double title. Say it explicitly.
      body: const MarketplaceBrowse(embedded: true),
    );
  }
}
