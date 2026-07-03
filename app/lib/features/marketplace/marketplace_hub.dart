import 'package:flutter/material.dart';

import '../../core/analytics.dart';
import '../../core/remote_config.dart';
import '../identity/listing_liveness_gate.dart';
import '../explore/explore_home.dart';
import 'my_listings_screen.dart';
import 'sell_listing_flow.dart';

/// P4 / 2026-07-03: before opening the listing composer, an unverified seller
/// must pass the one-time liveness "human check" when [RemoteConfig.listingLivenessGate]
/// is ON. Browsing stays free; only creating a listing needs it. The server route
/// is the real gate (403 liveness_required) — this is the friendly UX that runs
/// the check first so a verified user goes straight in and never sees a raw error.
Future<void> _openListingComposer(BuildContext context) async {
  Analytics.capture('listing_pipeline_opened', {'via': 'hub'});
  if (RemoteConfig.listingLivenessGate) {
    final ok = await ensureListingLiveness(context);
    if (!context.mounted) return;
    if (!ok) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Verify you\'re a real person to start selling.')));
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
