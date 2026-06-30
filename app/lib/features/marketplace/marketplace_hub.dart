import 'package:flutter/material.dart';

import '../../core/analytics.dart';
import '../explore/explore_home.dart';
import '../listings/create_listing_flow.dart';
import 'my_listings_screen.dart';

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
            onTap: () {
              Analytics.capture('listing_pipeline_opened', {'via': 'hub'});
              Navigator.of(context).push(MaterialPageRoute(
                builder: (_) => const CreateListingFlow(),
              ));
            },
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
