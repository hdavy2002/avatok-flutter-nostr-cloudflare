// AvaLive landing — Phase 7: REAL marketplace data (the Phase-6 live-now feed),
// not the old demo rooms. Watching opens the paid viewer (the worker refuses
// non-payers — tapping an unbooked event routes to its booking page instead).
// "Go Live" lists the creator's own upcoming live events → broadcast HUD.
import 'package:flutter/material.dart';

import '../../core/avatar.dart';
import '../../core/listings_api.dart';
import '../../core/session_api.dart';
import '../../core/theme.dart';
import '../explore/listing_detail.dart';
import 'live_host_screen.dart';
import 'live_viewer_screen.dart';

class AvaLiveDiscovery extends StatefulWidget {
  const AvaLiveDiscovery({super.key});
  @override
  State<AvaLiveDiscovery> createState() => _AvaLiveDiscoveryState();
}

class _AvaLiveDiscoveryState extends State<AvaLiveDiscovery> {
  List<ListingCard> _live = [];
  List<ListingCard> _upcoming = [];
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _loading = true);
    try {
      final live = await ListingsApi.liveNow();
      final all = await ListingsApi.explore(kind: 'live_event');
      _live = live;
      _upcoming = all.where((l) => l.status == 'published').toList();
    } catch (_) {
      _live = [];
      _upcoming = [];
    }
    if (mounted) setState(() => _loading = false);
  }

  Future<void> _watch(ListingCard l) async {
    // Paid order → straight into the player. No order → booking page first.
    try {
      await SessionApi.liveJoin(l.id);
      if (!mounted) return;
      await Navigator.push(context, MaterialPageRoute(builder: (_) => LiveViewerScreen(listingId: l.id)));
    } on SessionApiError catch (e) {
      if (!mounted) return;
      if (e.status == 403) {
        await Navigator.push(context, MaterialPageRoute(builder: (_) => ListingDetailScreen(listingId: l.id)));
      } else {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
      }
    }
    _load();
  }

  Future<void> _goLive() async {
    // My startable live events (mine + kind live_event + published/live).
    List<ListingCard> mine = [];
    try {
      mine = (await ListingsApi.mine())
          .where((l) => l.kind == 'live_event' && (l.status == 'published' || l.status == 'live'))
          .toList();
    } catch (_) {}
    if (!mounted) return;
    if (mine.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('No startable live event — create & publish one in My Listings first.')));
      return;
    }
    final l = mine.length == 1
        ? mine.first
        : await showModalBottomSheet<ListingCard>(
            context: context,
            builder: (sheetCtx) => SafeArea(
              child: ListView(shrinkWrap: true, children: [
                const Padding(padding: EdgeInsets.all(16), child: Text('Which event?', style: TextStyle(fontWeight: FontWeight.w800, fontSize: 16))),
                for (final m in mine)
                  ListTile(title: Text(m.title), subtitle: Text(m.status), onTap: () => Navigator.pop(sheetCtx, m)),
              ]),
            ),
          );
    if (l == null || !mounted) return;
    await Navigator.push(context, MaterialPageRoute(builder: (_) => LiveHostScreen(listingId: l.id, title: l.title)));
    _load();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.white,
      appBar: AppBar(
        backgroundColor: Colors.white, elevation: 0, foregroundColor: AvaColors.ink,
        title: Row(children: [
          Container(width: 26, height: 26,
              decoration: BoxDecoration(color: AvaColors.danger, borderRadius: BorderRadius.circular(8)),
              child: const Icon(Icons.sensors, color: Colors.white, size: 15)),
          const SizedBox(width: 8),
          const Text('AvaLive', style: TextStyle(fontWeight: FontWeight.w900)),
        ]),
        actions: [IconButton(onPressed: _load, icon: const Icon(Icons.refresh))],
      ),
      floatingActionButton: FloatingActionButton.extended(
        backgroundColor: AvaColors.danger,
        onPressed: _goLive,
        icon: const Icon(Icons.sensors, color: Colors.white),
        label: const Text('Go Live', style: TextStyle(color: Colors.white, fontWeight: FontWeight.w700)),
      ),
      body: RefreshIndicator(
        onRefresh: _load,
        child: _loading
            ? const Center(child: CircularProgressIndicator(color: AvaColors.brand))
            : (_live.isEmpty && _upcoming.isEmpty)
                ? ListView(children: const [
                    SizedBox(height: 140),
                    Icon(Icons.sensors_off, size: 48, color: AvaColors.sub),
                    SizedBox(height: 12),
                    Center(child: Text('No live events right now', style: TextStyle(color: AvaColors.sub))),
                    SizedBox(height: 4),
                    Center(child: Text('Browse AvaExplore to book upcoming ones', style: TextStyle(color: AvaColors.sub, fontSize: 12.5))),
                  ])
                : ListView(padding: const EdgeInsets.all(16), children: [
                    if (_live.isNotEmpty) ...[
                      const Text('Live now', style: TextStyle(fontWeight: FontWeight.w900, fontSize: 16)),
                      const SizedBox(height: 10),
                      for (final l in _live) _card(l, live: true),
                      const SizedBox(height: 12),
                    ],
                    if (_upcoming.isNotEmpty) ...[
                      const Text('Upcoming events', style: TextStyle(fontWeight: FontWeight.w900, fontSize: 16)),
                      const SizedBox(height: 10),
                      for (final l in _upcoming) _card(l, live: false),
                    ],
                    const SizedBox(height: 90),
                  ]),
      ),
    );
  }

  Widget _card(ListingCard l, {required bool live}) {
    return GestureDetector(
      onTap: () => live
          ? _watch(l)
          : Navigator.push(context, MaterialPageRoute(builder: (_) => ListingDetailScreen(listingId: l.id))).then((_) => _load()),
      child: Container(
        margin: const EdgeInsets.only(bottom: 14),
        decoration: BoxDecoration(color: AvaColors.soft, borderRadius: BorderRadius.circular(18)),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Stack(children: [
            Container(
              height: 150,
              width: double.infinity,
              decoration: BoxDecoration(
                gradient: const LinearGradient(colors: [Color(0xFF1FB6A6), Color(0xFF2E8BEE)], begin: Alignment.topLeft, end: Alignment.bottomRight),
                borderRadius: const BorderRadius.vertical(top: Radius.circular(18)),
                image: l.coverUrl != null ? DecorationImage(image: NetworkImage(l.coverUrl!), fit: BoxFit.cover) : null,
              ),
              child: l.coverUrl == null ? const Center(child: Icon(Icons.play_circle_fill, color: Colors.white, size: 52)) : null,
            ),
            if (live)
              Positioned(top: 10, left: 10, child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                decoration: BoxDecoration(color: AvaColors.danger, borderRadius: BorderRadius.circular(6)),
                child: const Text('● LIVE', style: TextStyle(color: Colors.white, fontWeight: FontWeight.w800, fontSize: 11)),
              )),
            Positioned(top: 10, right: 10, child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
              decoration: BoxDecoration(color: Colors.black54, borderRadius: BorderRadius.circular(6)),
              child: Text(l.priceLabel, style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w800, fontSize: 11)),
            )),
          ]),
          Padding(
            padding: const EdgeInsets.all(12),
            child: Row(children: [
              Avatar(seed: l.creator.uid, name: l.creator.name ?? 'Creator', size: 38),
              const SizedBox(width: 10),
              Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(l.title, maxLines: 1, overflow: TextOverflow.ellipsis,
                    style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 15)),
                Text('${l.creator.name ?? 'Creator'}${l.joinedCount > 0 ? ' · ${l.joinedCount} joined' : ''}',
                    style: const TextStyle(color: AvaColors.sub, fontSize: 12.5)),
              ])),
              Icon(live ? Icons.visibility : Icons.event, color: AvaColors.brand),
            ]),
          ),
        ]),
      ),
    );
  }
}
