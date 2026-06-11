import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/listings_api.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import '../explore/listing_detail.dart';
import '../explore/widgets.dart';
import 'create_listing_flow.dart';
import 'creator_insights_screen.dart';

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
    Widget item(IconData icon, String label, VoidCallback onTap, {Color color = Zine.ink}) => ListTile(
          leading: PhosphorIcon(icon, color: color),
          title: Text(label, style: ZineText.value(size: 15, color: color, weight: FontWeight.w700)),
          onTap: onTap,
        );
    showModalBottomSheet(context: context, backgroundColor: Zine.paper,
        shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(24))),
        builder: (s) => SafeArea(child: Column(mainAxisSize: MainAxisSize.min, children: [
      if (l.status == 'draft')
        item(PhosphorIcons.paperPlaneTilt(PhosphorIconsStyle.bold), 'Publish',
            () { Navigator.pop(s); _act(l, 'publish'); }),
      if (l.status == 'published' && l.kind == 'live_event')
        item(PhosphorIcons.broadcast(PhosphorIconsStyle.bold), 'Go live now',
            () { Navigator.pop(s); _act(l, 'live'); }, color: Zine.coral),
      if (l.status == 'live')
        item(PhosphorIcons.stopCircle(PhosphorIconsStyle.bold), 'End & mark completed',
            () { Navigator.pop(s); _act(l, 'complete'); }),
      item(PhosphorIcons.copy(PhosphorIconsStyle.bold), 'Duplicate listing',
          () { Navigator.pop(s); _act(l, 'duplicate'); }),
      if (l.status != 'cancelled' && l.status != 'completed')
        item(PhosphorIcons.xCircle(PhosphorIconsStyle.bold), 'Cancel listing',
            () { Navigator.pop(s); _act(l, 'cancel'); }, color: Zine.coral),
    ])));
  }

  // Status stickers: draft = hint (ghost), live = ok (lime), the rest plain.
  ZineStickerKind _stickerKind(String s) => switch (s) {
        'live' => ZineStickerKind.ok,
        'published' => ZineStickerKind.ok,
        'draft' => ZineStickerKind.hint,
        _ => ZineStickerKind.plain,
      };

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Zine.paper,
      appBar: ZineAppBar(
        title: 'My listings',
        markWord: 'listings',
        tag: 'creator',
        actions: [
          // Creator Insights — views, audience countries/ages, conversion.
          ZineBackButton(
            icon: PhosphorIcons.chartBar(PhosphorIconsStyle.bold),
            onTap: () => Navigator.push(context,
                MaterialPageRoute(builder: (_) => const CreatorInsightsScreen())),
          ),
        ],
      ),
      floatingActionButton: ZineButton(
        label: 'New listing',
        icon: PhosphorIcons.plus(PhosphorIconsStyle.bold),
        trailingIcon: false,
        onPressed: _create,
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator(color: Zine.blueInk))
          : _items.isEmpty
              ? Center(child: Padding(padding: const EdgeInsets.all(24),
                  child: ZineEmptyState(
                      icon: PhosphorIcons.storefront(PhosphorIconsStyle.bold),
                      text: 'No listings yet — create a live event or consultation and it shows up in AvaExplore the moment you publish.')))
              : RefreshIndicator(
                  onRefresh: _load,
                  color: Zine.blueInk,
                  child: ListView.separated(
                    padding: const EdgeInsets.fromLTRB(16, 14, 16, 96),
                    itemCount: _items.length,
                    separatorBuilder: (_, __) => const SizedBox(height: 12),
                    itemBuilder: (_, i) {
                      final l = _items[i];
                      return ZineCard(
                        radius: Zine.rSm,
                        padding: const EdgeInsets.all(10),
                        boxShadow: Zine.shadowXs,
                        onTap: l.status == 'draft' ? () => _menu(l)
                            : () => Navigator.push(context, MaterialPageRoute(builder: (_) => ListingDetailScreen(listingId: l.id))),
                        child: Row(children: [
                          CoverImage(url: l.coverUrl, seed: l.id.hashCode, width: 56, height: 56,
                              radius: BorderRadius.circular(12)),
                          const SizedBox(width: 11),
                          Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                            Text(l.title, maxLines: 1, overflow: TextOverflow.ellipsis,
                                style: ZineText.value(size: 14.5, weight: FontWeight.w800)),
                            const SizedBox(height: 5),
                            Row(children: [
                              ZineSticker(l.status, kind: _stickerKind(l.status)),
                              const SizedBox(width: 8),
                              Flexible(child: Text(
                                '${l.priceLabel}${l.startsAt != null ? ' · ${fmtWhen(l.startsAt)}' : ''}${l.joinedCount > 0 ? ' · ${l.joinedCount} joined' : ''}',
                                maxLines: 1, overflow: TextOverflow.ellipsis,
                                style: ZineText.sub(size: 11.5))),
                            ]),
                          ])),
                          GestureDetector(
                            onTap: () => _menu(l),
                            behavior: HitTestBehavior.opaque,
                            child: Padding(
                              padding: const EdgeInsets.all(6),
                              child: PhosphorIcon(PhosphorIcons.dotsThreeVertical(PhosphorIconsStyle.bold),
                                  size: 20, color: Zine.ink),
                            ),
                          ),
                        ]),
                      );
                    },
                  ),
                ),
    );
  }
}
