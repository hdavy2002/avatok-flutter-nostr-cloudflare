import 'package:flutter/material.dart';

import '../../core/analytics.dart';
import '../../core/listings_api.dart';
import 'edit_listing_screen.dart';

/// Friendly status label (the raw 'published' shows as 'live' to owners).
String _statusLabel(String s) {
  switch (s) {
    case 'published': return 'live';
    case 'completed': return 'sold';
    case 'cancelled': return 'archived';
    default: return s;
  }
}

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
            // Cancelled (deleted) and expired listings live in Archived — keep
            // them OUT of My Listings so they don't appear duplicated (pic 7/9).
            final items = (snap.data ?? const <ListingCard>[])
                .where((c) => c.status != 'cancelled' && !c.isExpired)
                .toList();
            if (items.isEmpty) {
              return ListView(children: const [
                SizedBox(height: 120),
                Center(child: Text('You have no active listings yet.')),
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

  Future<void> _setStatus(BuildContext context, String status, String event) async {
    Analytics.capture(event, {'listing_id': card.id});
    final res = await ListingsApi.setStatus(card.id, status);
    if (!context.mounted) return;
    if (res['ok'] == true) {
      onChanged();
    } else {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Could not update listing.')));
    }
  }

  Future<void> _edit(BuildContext context) async {
    // Full Zine-themed editor (pic 5). Editing bumps the listing's content
    // version server-side, reopening the talk-once-per-version gate (Specs §3 B).
    final saved = await Navigator.of(context).push<bool>(
      MaterialPageRoute(builder: (_) => EditListingScreen(listingId: card.id)),
    );
    if (saved == true) onChanged();
  }

  @override
  Widget build(BuildContext context) {
    final sold = card.status == 'completed' || card.status == 'sold';
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
        subtitle: Text('${card.displayPrice} · ${_statusLabel(card.status)}'),
        trailing: PopupMenuButton<String>(
          onSelected: (v) {
            switch (v) {
              case 'edit': _edit(context); break;
              case 'sold': _setStatus(context, 'completed', 'listing_marked_sold'); break;
              case 'renew': _setStatus(context, 'live', 'listing_renewed'); break;
              case 'delete': _setStatus(context, 'cancelled', 'listing_deleted'); break;
            }
          },
          itemBuilder: (_) => [
            const PopupMenuItem(value: 'edit', child: Text('Edit')),
            if (!sold) const PopupMenuItem(value: 'sold', child: Text('Mark sold')),
            const PopupMenuItem(value: 'renew', child: Text('Renew')),
            const PopupMenuItem(value: 'delete', child: Text('Delete')),
          ],
        ),
      ),
    );
  }
}
