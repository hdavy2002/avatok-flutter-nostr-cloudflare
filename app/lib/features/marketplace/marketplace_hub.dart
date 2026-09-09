import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/messenger_theme.dart';
import '../../core/ui/zine_widgets.dart';
import '../avavoice/avavoice_home.dart';
import '../avavision/avavision_home.dart';
import '../explore/explore_home.dart';
import 'marketplace_browse.dart' show marketplaceTitle;
import 'native_listing/native_listing_wizard_screen.dart';
import 'my_listings_screen.dart';

/// Opens the single native listing wizard. The Worker remains the liveness and
/// eligibility authority when the creator submits.
Future<void> _openListingComposer(BuildContext context) async {
  Analytics.capture('listing_pipeline_opened', {'via': 'hub'});
  // [LIST-EMBED-1 2026-09-05] The hub's "Create Listing" tile opens the same
  // one form as the sidebar action. Routing only the menu would leave a second
  // button in the app creating listings through a different surface with a
  // different field set — the exact drift this change exists to end.
  //
  // The pre-gate below is SKIPPED on this path deliberately: the wizard handles
  // a 403 liveness_required itself with a "Verify now" link on the step that
  // hit it, and the Worker is the real gate either way. Showing a camera check
  // before the creator has seen the form is the drop-off the compose branch in
  // ava_shell.dart already avoids.
  if (!context.mounted) return;
  await Navigator.of(context).push(MaterialPageRoute(
    builder: (_) => const NativeListingWizardScreen(source: 'marketplace_hub'),
  ));
}

/// AvaMarketplace P1 — the hub the sidebar "Marketplace" entry opens.
/// Three destinations: Browse (the existing ExploreHome grid), Create Listing
/// (the listing pipeline) and My Listings. Gated by RemoteConfig.marketplaceEnabled
/// at the shell so this screen only ever mounts when the feature is on.
class MarketplaceHub extends StatelessWidget {
  const MarketplaceHub({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AD.bg,
      // [UI-MARKET-2026] Was a bespoke AppBar painting ADText.appTitle() (ink)
      // on AD.headerFooter (Jodhpur indigo) — i.e. a title that is very nearly
      // invisible since the band flipped dark. Use the shared header instead,
      // which routes its foreground through AD.onBand and ellipsizes the title
      // before the trailing controls overflow.
      appBar: ZineAppBar(
        title: marketplaceTitle(context),
        showBack: Navigator.of(context).canPop(),
      ),
      body: ListView(
        padding: const EdgeInsets.all(Msg.s4),
        children: [
          _Tile(
            icon: PhosphorIcons.storefront(PhosphorIconsStyle.regular),
            title: 'Browse marketplace',
            subtitle: 'Buy, sell & social listings near you',
            onTap: () {
              Analytics.capture('marketplace_opened', {'via': 'hub_browse'});
              Navigator.of(context).push(MaterialPageRoute(
                builder: (_) => ExploreHome(onMenu: () => Navigator.of(context).maybePop()),
              ));
            },
          ),
          const SizedBox(height: Msg.s3),
          _Tile(
            icon: PhosphorIcons.microphone(PhosphorIconsStyle.regular),
            title: 'Voice creator studio',
            subtitle: 'Build and manage AI voice agents',
            onTap: () {
              Analytics.capture('creator_studio_opened', {'studio': 'avavoice'});
              Navigator.of(context).push(MaterialPageRoute(
                builder: (_) => const AvaVoiceHome(),
              ));
            },
          ),
          const SizedBox(height: Msg.s3),
          _Tile(
            icon: PhosphorIcons.eye(PhosphorIconsStyle.regular),
            title: 'Vision creator studio',
            subtitle: 'Build and manage AI vision coaches',
            onTap: () {
              Analytics.capture('creator_studio_opened', {'studio': 'avavision'});
              Navigator.of(context).push(MaterialPageRoute(
                builder: (_) => const AvaVisionHome(),
              ));
            },
          ),
          const SizedBox(height: Msg.s3),
          _Tile(
            icon: PhosphorIcons.plusSquare(PhosphorIconsStyle.regular),
            title: 'Create listing',
            subtitle: 'Sell, buy or post a social listing',
            onTap: () => _openListingComposer(context),
          ),
          const SizedBox(height: Msg.s3),
          _Tile(
            icon: PhosphorIcons.package(PhosphorIconsStyle.regular),
            title: 'My listings',
            subtitle: 'Manage, edit, mark sold or renew',
            onTap: () {
              Navigator.of(context).push(MaterialPageRoute(
                builder: (_) => const MyListingsScreen(),
              ));
            },
          ),
        ],
      ),
    );
  }
}

class _Tile extends StatelessWidget {
  final IconData icon;
  final String title, subtitle;
  final VoidCallback onTap;
  const _Tile({required this.icon, required this.title, required this.subtitle, required this.onTap});

  @override
  Widget build(BuildContext context) {
    return AdCard(
      padding: EdgeInsets.zero,
      child: ListTile(
        leading: Icon(icon, size: 28, color: AD.iconSearch),
        title: Text(title, style: ADText.rowName()),
        subtitle: Text(subtitle, style: ADText.preview()),
        trailing: PhosphorIcon(PhosphorIcons.caretRight(PhosphorIconsStyle.regular), color: AD.textTertiary),
        onTap: onTap,
      ),
    );
  }
}
