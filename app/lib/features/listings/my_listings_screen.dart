import 'package:flutter/material.dart';

import '../../core/listings_api.dart';
import '../../core/theme.dart';
import '../explore/listing_detail.dart';
import '../explore/widgets.dart';
import 'create_listing_flow.dart';

/// "My listings" — the creator's pipeline home: drafts, published, live.
/// Overflow per listing: publish, go live / end, duplicate (A6), cancel.
class MyListingsScreen extends StatefulWidget {
  const MyListingsScreen({super.key});
  @override
  State<MyListingsScreen> createState() => _MyListingsScreenState();
}

class _MyListingsScreenState extends State<MyListingsScreen> {
  List<ListingCard> _items = [];
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final items = await ListingsApi.mine();
    if (!mounted) return;
    setState(() { _items = items; _loading = false; });
  }

  Future<void> _create() async {
    final created = await Navigator.push<bool>(
        context, MaterialPageRoute(builder: (_) => const CreateListingFlow()));
    if (created == true) _load();
  }

  Future<void> _act(ListingCard l, String action) async {
    String? msg;
    switch (action) {
      case 'publish':
        final r = await ListingsApi.publish(l.id);
        msg = r.isEmpty ? 'Published' : (r['detail']?.toString() ?? r['error']?.toString() ?? 'Failed');
      case 'live':
        final r = await ListingsApi.setStatus(l.id, 'live');
        msg = r['ok'] == true ? 'You are LIVE — followers notified' : 'Failed';
      case 'complete':
        final r = await ListingsApi.setStatus(l.id, 'completed');
        msg = r['ok'] == true ? 'Marked completed' : 'Failed';
      case 'duplicate':
        final id = await ListingsApi.duplicate(l.id);
        msg = id != null ? 'Duplicated as a draft — set the new date' : 'Failed';
      case 'cancel':
        msg = await ListingsApi.cancel(l.id) ? 'Cancelled' : 'Failed';
    }
    if (!mounted) return;
    if (msg != null) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
    _load();
  }

  void _menu(ListingCard l) {
    showModalBottomSheet(context: context, builder: (s) => SafeArea(child: Column(mainAxisSize: MainAxisSize.min, children: [
      if (l.status == 'draft')
        ListTile(leading: const Icon(Icons.publish_outlined), title: const Text('Publish'),
            onTap: () { Navigator.pop(s); _act(l, 'publish'); }),
      if (l.status == 'published' && l.kind == 'live_event')
        ListTile(leading: const Icon(Icons.podcasts, color: AvaColors.coral), title: const Text('Go live now'),
            onTap: () { Navigator.pop(s); _act(l, 'live'); }),
      if (l.status == 'live')
        ListTile(leading: const Icon(Icons.stop_circle_outlined), title: const Text('End & mark completed'),
            onTap: () { Navigator.pop(s); _act(l, 'complete'); }),
      ListTile(leading: const Icon(Icons.copy_outlined), title: const Text('Duplicate listing'),
          onTap: () { Navigator.pop(s); _act(l, 'duplicate'); }),
      if (l.status != 'cancelled' && l.status != 'completed')
        ListTile(leading: const Icon(Icons.cancel_outlined, color: AvaColors.danger), title: const Text('Cancel listing'),
            onTap: () { Navigator.pop(s); _act(l, 'cancel'); }),
    ])));
  }

  Color _statusColor(String s) => switch (s) {
        'live' => AvaColors.coral,
        'published' => AvaColors.success,
        'draft' => AvaColors.sub,
        _ => AvaColors.sub,
      };

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.white,
      appBar: AppBar(backgroundColor: Colors.white, elevation: 0, foregroundColor: AvaColors.ink,
          title: const Text('My listings')),
      floatingActionButton: FloatingActionButton.extended(
        backgroundColor: AvaColors.brand,
        onPressed: _create,
        icon: const Icon(Icons.add, color: Colors.white),
        label: const Text('New listing', style: TextStyle(color: Colors.white, fontWeight: FontWeight.w800)),
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _items.isEmpty
              ? const Center(child: Padding(padding: EdgeInsets.all(24),
                  child: Text('No listings yet.\nCreate a live event or consultation offering — it shows up in AvaExplore the moment you publish.',
                      textAlign: TextAlign.center, style: TextStyle(color: AvaColors.sub))))
              : RefreshIndicator(
                  onRefresh: _load,
                  child: ListView.separated(
                    padding: const EdgeInsets.fromLTRB(16, 8, 16, 90),
                    itemCount: _items.length,
                    separatorBuilder: (_, __) => const Divider(height: 1),
                    itemBuilder: (_, i) {
                      final l = _items[i];
                      return ListTile(
                        contentPadding: const EdgeInsets.symmetric(vertical: 6),
                        leading: SizedBox(width: 56, height: 56,
                            child: CoverImage(url: l.coverUrl, seed: l.id.hashCode, radius: BorderRadius.circular(12))),
                        title: Text(l.title, maxLines: 1, overflow: TextOverflow.ellipsis,
                            style: const TextStyle(fontWeight: FontWeight.w700)),
                        subtitle: Row(children: [
                          Container(
                            margin: const EdgeInsets.only(top: 2),
                            padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
                            decoration: BoxDecoration(
                                color: _statusColor(l.status).withValues(alpha: .12),
                                borderRadius: BorderRadius.circular(8)),
                            child: Text(l.status.toUpperCase(),
                                style: TextStyle(fontSize: 10, fontWeight: FontWeight.w800, color: _statusColor(l.status))),
                          ),
                          const SizedBox(width: 8),
                          Flexible(child: Text(
                            '${l.priceLabel}${l.startsAt != null ? ' · ${fmtWhen(l.startsAt)}' : ''}${l.joinedCount > 0 ? ' · ${l.joinedCount} joined' : ''}',
                            maxLines: 1, overflow: TextOverflow.ellipsis,
                            style: const TextStyle(fontSize: 12, color: AvaColors.sub))),
                        ]),
                        trailing: IconButton(icon: const Icon(Icons.more_vert), onPressed: () => _menu(l)),
                        onTap: l.status == 'draft' ? () => _menu(l)
                            : () => Navigator.push(context, MaterialPageRoute(builder: (_) => ListingDetailScreen(listingId: l.id))),
                      );
                    },
                  ),
                ),
    );
  }
}
