import 'package:flutter/material.dart';

import '../../core/analytics.dart';
import '../../core/listings_api.dart';

/// AvaMarketplace P1 — owner's listings list. P4 enriches each row with edit /
/// mark-sold / renew actions; here it loads and shows status so the screen is
/// reachable and useful from day one.
class MyListingsScreen extends StatefulWidget {
  const MyListingsScreen({super.key});
  @override
  State<MyListingsScreen> createState() => _MyListingsScreenState();
}

class _MyListingsScreenState extends State<MyListingsScreen> {
  late Future<List<ListingCard>> _future;

  @override
  void initState() {
    super.initState();
    Analytics.capture('my_listings_opened');
    _future = ListingsApi.mine();
  }

  void _reload() => setState(() => _future = ListingsApi.mine());

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('My listings')),
      body: RefreshIndicator(
        onRefresh: () async => _reload(),
        child: FutureBuilder<List<ListingCard>>(
          future: _future,
          builder: (context, snap) {
            if (snap.connectionState != ConnectionState.done) {
              return const Center(child: CircularProgressIndicator());
            }
            final items = snap.data ?? const <ListingCard>[];
            if (items.isEmpty) {
              return ListView(children: const [
                SizedBox(height: 120),
                Center(child: Text('You have no listings yet.')),
              ]);
            }
            return ListView.separated(
              padding: const EdgeInsets.all(12),
              itemCount: items.length,
              separatorBuilder: (_, __) => const SizedBox(height: 8),
              itemBuilder: (_, i) => _MyListingRow(card: items[i], onChanged: _reload),
            );
          },
        ),
      ),
    );
  }
}

class _MyListingRow extends StatelessWidget {
  final ListingCard card;
  final VoidCallback onChanged;
  const _MyListingRow({required this.card, required this.onChanged});

  @override
  Widget build(BuildContext context) {
    return Card(
      child: ListTile(
        leading: card.coverUrl != null
            ? ClipRRect(
                borderRadius: BorderRadius.circular(6),
                child: Image.network(card.coverUrl!, width: 48, height: 48, fit: BoxFit.cover,
                    errorBuilder: (_, __, ___) => const Icon(Icons.image_not_supported)),
              )
            : const Icon(Icons.inventory_2_outlined, size: 32),
        title: Text(card.title, maxLines: 1, overflow: TextOverflow.ellipsis),
        subtitle: Text('${card.priceLabel} · ${card.status}'),
      ),
    );
  }
}
