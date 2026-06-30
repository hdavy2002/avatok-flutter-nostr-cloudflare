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
    final title = TextEditingController(text: card.title);
    final desc = TextEditingController(text: card.description ?? '');
    final price = TextEditingController(text: (card.price).toString());
    final saved = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      builder: (ctx) => Padding(
        padding: EdgeInsets.only(
          bottom: MediaQuery.of(ctx).viewInsets.bottom + 16, left: 16, right: 16, top: 16),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          const Text('Edit listing', style: TextStyle(fontWeight: FontWeight.w600)),
          TextField(controller: title, decoration: const InputDecoration(labelText: 'Title')),
          TextField(controller: desc, maxLines: 3, decoration: const InputDecoration(labelText: 'Description')),
          TextField(controller: price, keyboardType: TextInputType.number,
              decoration: const InputDecoration(labelText: 'Price')),
          const SizedBox(height: 12),
          FilledButton(onPressed: () => Navigator.of(ctx).pop(true), child: const Text('Save')),
        ]),
      ),
    );
    if (saved != true || !context.mounted) return;
    // Editing bumps the listing's content version server-side, which reopens the
    // talk-once-per-version negotiation gate (Specs §3 Rule B).
    final ok = await ListingsApi.update(card.id, {
      'title': title.text.trim(),
      'description': desc.text.trim(),
      'price_amount': int.tryParse(price.text.trim()) ?? card.price,
    });
    if (!context.mounted) return;
    Analytics.capture('listing_edited', {'listing_id': card.id});
    if (ok) {
      onChanged();
    } else {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Could not save edits.')));
    }
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
        subtitle: Text('${card.priceLabel} · ${card.status}'),
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
