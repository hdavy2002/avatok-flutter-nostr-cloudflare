import 'package:flutter/material.dart';

import '../../core/analytics.dart';
import '../../core/remote_config.dart';
import '../identity/identity_api.dart';
import '../identity/identity_screen.dart';
import '../explore/explore_home.dart';
import 'my_listings_screen.dart';
import 'sell_listing_flow.dart';

/// P4: before opening the listing composer, ensure the seller is video-liveness
/// verified when [RemoteConfig.listingLivenessGate] is ON. Browsing stays free;
/// only creating a listing needs this. The server route is the real gate (403
/// liveness_required) — this is the friendly UX that sends people to verify first.
Future<void> _openListingComposer(BuildContext context) async {
  Analytics.capture('listing_pipeline_opened', {'via': 'hub'});
  if (RemoteConfig.listingLivenessGate) {
    var verified = await IdentityApi.cachedVerified(); // instant paint
    if (!verified) verified = (await IdentityApi.status())?.verified ?? false;
    if (!context.mounted) return;
    if (!verified) {
      Analytics.capture('liveness_gate_shown', {'via': 'marketplace_hub'});
      final go = await showDialog<bool>(
        context: context,
        builder: (ctx) => AlertDialog(
          title: const Text('Quick verification'),
          content: const Text(
            'To keep the marketplace safe, we verify every seller is a real person — '
            'it takes about a minute. Browsing stays free; this is only to post a listing.',
          ),
          actions: [
            TextButton(onPressed: () => Navigator.of(ctx).pop(false), child: const Text('Not now')),
            FilledButton(onPressed: () => Navigator.of(ctx).pop(true), child: const Text('Verify now')),
          ],
        ),
      );
      if (go == true && context.mounted) {
        Navigator.of(context).push(MaterialPageRoute(builder: (_) => const IdentityScreen()));
      }
      return;
    }
  }
  if (!context.mounted) return;
  Navigator.of(context).push(MaterialPageRoute(builder: (_) => const SellListingFlow()));
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
      appBar: AppBar(title: const Text('Marketplace')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          _Tile(
            icon: Icons.storefront,
            title: 'Browse marketplace',
            subtitle: 'Buy, sell & social listings near you',
            onTap: () {
              Analytics.capture('marketplace_opened', {'via': 'hub_browse'});
              Navigator.of(context).push(MaterialPageRoute(
                builder: (_) => ExploreHome(onMenu: () => Navigator.of(context).maybePop()),
              ));
            },
          ),
          const SizedBox(height: 12),
          _Tile(
            icon: Icons.add_box_outlined,
            title: 'Create listing',
            subtitle: 'Sell, buy or post a social listing',
            onTap: () => _openListingComposer(context),
          ),
          const SizedBox(height: 12),
          _Tile(
            icon: Icons.inventory_2_outlined,
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
    return Card(
      child: ListTile(
        leading: Icon(icon, size: 28),
        title: Text(title, style: const TextStyle(fontWeight: FontWeight.w600)),
        subtitle: Text(subtitle),
        trailing: const Icon(Icons.chevron_right),
        onTap: onTap,
      ),
    );
  }
}
