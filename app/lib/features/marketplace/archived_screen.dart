import 'package:flutter/material.dart';

import '../../core/analytics.dart';
import '../../core/cached_image.dart';
import '../../core/listings_api.dart';

/// AvaMarketplace — Archived. Shows the owner's expired + cancelled listings with
/// a Restore action (→ draft). Restored drafts appear in the "Drafts" section
/// where they can be re-edited (title/description/price) and re-published, which
/// puts them back in the marketplace with a fresh expiry date.
class ArchivedScreen extends StatefulWidget {
  const ArchivedScreen({super.key});
  @override
  State<ArchivedScreen> createState() => _ArchivedScreenState();
}

class _ArchivedScreenState extends State<ArchivedScreen> {
  late Future<List<ListingCard>> _future;

  @override
  void initState() {
    super.initState();
    Analytics.capture('marketplace_archived_opened');
    _future = ListingsApi.mine();
  }

  void _reload() => setState(() => _future = ListingsApi.mine());

  bool _isArchived(ListingCard c) =>
      c.status == 'cancelled' || c.status == 'completed' || c.status == 'sold' ||
      (c.status != 'draft' && c.isExpired);

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Archived')),
      body: RefreshIndicator(
        onRefresh: () async => _reload(),
        child: FutureBuilder<List<ListingCard>>(
          future: _future,
          builder: (context, snap) {
            if (snap.connectionState != ConnectionState.done) {
              return const Center(child: CircularProgressIndicator());
            }
            final all = snap.data ?? const <ListingCard>[];
            // Only marketplace listings belong here.
            final mine = all.where((c) => c.isMarketplace).toList();
            final drafts = mine.where((c) => c.status == 'draft').toList();
            final archived = mine.where(_isArchived).toList();
            if (drafts.isEmpty && archived.isEmpty) {
              return ListView(children: const [
                SizedBox(height: 120),
                Center(child: Text('Nothing archived yet.')),
              ]);
            }
            return ListView(padding: const EdgeInsets.all(12), children: [
              if (drafts.isNotEmpty) ...[
                const _SectionHeader('Restored drafts'),
                for (final c in drafts) _Row(card: c, draft: true, onChanged: _reload),
              ],
              if (archived.isNotEmpty) ...[
                const _SectionHeader('Expired & removed'),
                for (final c in archived) _Row(card: c, draft: false, onChanged: _reload),
              ],
            ]);
          },
        ),
      ),
    );
  }
}

class _SectionHeader extends StatelessWidget {
  final String text;
  const _SectionHeader(this.text);
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.fromLTRB(4, 12, 4, 6),
        child: Text(text.toUpperCase(),
            style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w700, letterSpacing: 0.5)),
      );
}

class _Row extends StatelessWidget {
  final ListingCard card;
  final bool draft;
  final VoidCallback onChanged;
  const _Row({required this.card, required this.draft, required this.onChanged});

  String get _label {
    if (draft) return 'Draft';
    if (card.status == 'cancelled') return 'Removed';
    if (card.status == 'completed' || card.status == 'sold') return 'Sold';
    if (card.isExpired) return 'Expired';
    return card.status;
  }

  Future<void> _restore(BuildContext context) async {
    Analytics.capture('listing_restored', {'listing_id': card.id});
    final res = await ListingsApi.setStatus(card.id, 'draft');
    if (!context.mounted) return;
    if (res['ok'] == true) {
      onChanged();
    } else {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Could not restore.')));
    }
  }

  Future<void> _deleteForever(BuildContext context) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Delete forever?'),
        content: const Text('This permanently removes the listing and its photos everywhere. This cannot be undone.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Delete')),
        ],
      ),
    );
    if (ok != true || !context.mounted) return;
    Analytics.capture('listing_deleted_permanent', {'listing_id': card.id});
    final done = await ListingsApi.cancel(card.id, permanent: true);
    if (!context.mounted) return;
    if (done) {
      onChanged();
    } else {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Could not delete.')));
    }
  }

  Future<void> _republish(BuildContext context) async {
    Analytics.capture('listing_republished', {'listing_id': card.id});
    final res = await ListingsApi.publish(card.id);
    if (!context.mounted) return;
    if (res.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Re-published with a fresh expiry.')));
      onChanged();
    } else {
      ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(res['error']?.toString() ?? res['reason']?.toString() ?? 'Could not publish.')));
    }
  }

  Future<void> _edit(BuildContext context) async {
    final title = TextEditingController(text: card.title);
    final desc = TextEditingController(text: card.description ?? card.oneLiner);
    final price = TextEditingController(text: card.price.toString());
    final saved = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      builder: (ctx) => Padding(
        padding: EdgeInsets.only(bottom: MediaQuery.of(ctx).viewInsets.bottom + 16, left: 16, right: 16, top: 16),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          const Text('Edit draft', style: TextStyle(fontWeight: FontWeight.w600)),
          TextField(controller: title, decoration: const InputDecoration(labelText: 'Title')),
          TextField(controller: desc, maxLines: 3, decoration: const InputDecoration(labelText: 'Description')),
          TextField(controller: price, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: 'Price')),
          const SizedBox(height: 12),
          FilledButton(onPressed: () => Navigator.of(ctx).pop(true), child: const Text('Save')),
        ]),
      ),
    );
    if (saved != true || !context.mounted) return;
    final ok = await ListingsApi.update(card.id, {
      'title': title.text.trim(),
      'description': desc.text.trim(),
      'price_amount': int.tryParse(price.text.trim()) ?? card.price,
    });
    if (!context.mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(ok ? 'Saved.' : 'Could not save.')));
    if (ok) onChanged();
  }

  @override
  Widget build(BuildContext context) {
    return Card(
      child: ListTile(
        leading: card.coverUrl != null
            ? CachedImage(card.coverUrl!, width: 48, height: 48, radius: BorderRadius.circular(6))
            : const Icon(Icons.inventory_2_outlined, size: 32),
        title: Text(card.title, maxLines: 1, overflow: TextOverflow.ellipsis),
        subtitle: Text('${card.displayPrice} · $_label'),
        trailing: draft
            ? Wrap(spacing: 4, children: [
                IconButton(tooltip: 'Edit', icon: const Icon(Icons.edit_outlined), onPressed: () => _edit(context)),
                FilledButton(onPressed: () => _republish(context), child: const Text('Publish')),
              ])
            : Wrap(crossAxisAlignment: WrapCrossAlignment.center, children: [
                TextButton(onPressed: () => _restore(context), child: const Text('Restore')),
                IconButton(tooltip: 'Delete forever', icon: const Icon(Icons.delete_outline), onPressed: () => _deleteForever(context)),
              ]),
      ),
    );
  }
}
