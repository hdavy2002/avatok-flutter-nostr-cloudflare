// AvaLive landing — Phase 7: REAL marketplace data (the Phase-6 live-now feed),
// not the old demo rooms. Watching opens the paid viewer (the worker refuses
// non-payers — tapping an unbooked event routes to its booking page instead).
// "Go Live" lists the creator's own upcoming live events → broadcast HUD.
import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/avatar.dart';
import '../../core/listings_api.dart';
import '../../core/session_api.dart';
import '../../core/theme.dart';
import '../../core/ui/zine_widgets.dart';
import '../explore/listing_detail.dart';
import '../explore/widgets.dart';
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
            backgroundColor: Zine.paper,
            builder: (sheetCtx) => SafeArea(
              child: ListView(shrinkWrap: true, children: [
                Padding(padding: const EdgeInsets.all(18),
                    child: Text('Which event?', style: ZineText.cardTitle())),
                for (final m in mine)
                  ListTile(
                    title: Text(m.title, style: ZineText.value(size: 15)),
                    subtitle: Text(m.status.toUpperCase(), style: ZineText.tag(size: 11, color: Zine.inkSoft)),
                    onTap: () => Navigator.pop(sheetCtx, m),
                  ),
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
      appBar: ZineAppBar(
        title: 'AvaLive',
        markWord: 'Live',
        tag: 'LIVE NOW · CREATOR EVENTS',
        showBack: Navigator.of(context).canPop(),
        actions: [
          ZineBackButton(
            icon: PhosphorIcons.arrowClockwise(PhosphorIconsStyle.bold),
            onTap: _load,
          ),
        ],
      ),
      floatingActionButton: ZineButton(
        label: 'Go Live',
        variant: ZineButtonVariant.coral,
        icon: PhosphorIcons.broadcast(PhosphorIconsStyle.bold),
        trailingIcon: false,
        onPressed: _goLive,
      ),
      body: ZinePaper(
        child: RefreshIndicator(
          color: Zine.blueInk,
          onRefresh: _load,
          child: _loading
              ? const Center(child: CircularProgressIndicator(color: Zine.blueInk))
              : (_live.isEmpty && _upcoming.isEmpty)
                  ? ListView(children: [
                      const SizedBox(height: 130),
                      Center(child: ZineEmptyState(
                        icon: PhosphorIcons.broadcast(PhosphorIconsStyle.bold),
                        text: 'No live events right now.\nBrowse AvaExplore to book upcoming ones.',
                      )),
                    ])
                  : ListView(padding: const EdgeInsets.all(16), children: [
                      if (_live.isNotEmpty) ...[
                        Text('Live now', style: ZineText.cardTitle(size: 20)),
                        const SizedBox(height: 12),
                        for (final l in _live) _card(l, live: true),
                        const SizedBox(height: 14),
                      ],
                      if (_upcoming.isNotEmpty) ...[
                        Text('Upcoming events', style: ZineText.cardTitle(size: 20)),
                        const SizedBox(height: 12),
                        for (final l in _upcoming) _card(l, live: false),
                      ],
                      const SizedBox(height: 96),
                    ]),
        ),
      ),
    );
  }

  Widget _card(ListingCard l, {required bool live}) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 14),
      child: GestureDetector(
        onTap: () => live
            ? _watch(l)
            : Navigator.push(context, MaterialPageRoute(builder: (_) => ListingDetailScreen(listingId: l.id))).then((_) => _load()),
        child: Container(
          clipBehavior: Clip.antiAlias,
          decoration: BoxDecoration(
            color: Zine.card,
            borderRadius: BorderRadius.circular(Zine.r),
            border: Zine.border,
            boxShadow: Zine.shadowSm,
          ),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            SizedBox(
              height: 150,
              width: double.infinity,
              child: Stack(children: [
                Positioned.fill(
                  child: CoverImage(url: l.coverUrl, seed: l.id.hashCode, radius: BorderRadius.zero),
                ),
                // LIVE → coral sticker (white text allowed on coral).
                if (live)
                  Positioned(left: 10, top: 10, child: Container(
                    padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 4),
                    decoration: BoxDecoration(
                      color: Zine.coral,
                      borderRadius: BorderRadius.circular(100),
                      border: Border.all(color: Zine.ink, width: 2),
                      boxShadow: Zine.shadowXs,
                    ),
                    child: Row(mainAxisSize: MainAxisSize.min, children: [
                      Container(width: 6, height: 6, decoration: const BoxDecoration(color: Colors.white, shape: BoxShape.circle)),
                      const SizedBox(width: 5),
                      Text('LIVE', style: ZineText.tag(size: 10.5, color: Colors.white)),
                    ]),
                  )),
                // Price chip — card fill + ink border (no dark scrims).
                Positioned(right: 10, top: 10, child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 4),
                  decoration: BoxDecoration(
                    color: Zine.card,
                    borderRadius: BorderRadius.circular(100),
                    border: Border.all(color: Zine.ink, width: 2),
                    boxShadow: Zine.shadowXs,
                  ),
                  child: Text(l.priceLabel,
                      style: ZineText.value(size: 12,
                          color: l.priceLabel.toLowerCase() == 'free' ? Zine.mintInk : Zine.ink,
                          weight: FontWeight.w900)),
                )),
              ]),
            ),
            Container(height: Zine.bw, color: Zine.ink),
            Padding(
              padding: const EdgeInsets.all(12),
              child: Row(children: [
                Avatar(seed: l.creator.uid, name: l.creator.name ?? 'Creator', size: 38),
                const SizedBox(width: 10),
                Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(l.title, maxLines: 1, overflow: TextOverflow.ellipsis,
                      style: ZineText.value(size: 15, weight: FontWeight.w800)),
                  Text('${l.creator.name ?? 'Creator'}${l.joinedCount > 0 ? ' · ${l.joinedCount} joined' : ''}',
                      style: ZineText.sub(size: 12.5)),
                ])),
                PhosphorIcon(
                    live ? PhosphorIcons.eye(PhosphorIconsStyle.bold) : PhosphorIcons.calendarBlank(PhosphorIconsStyle.bold),
                    color: Zine.blueInk, size: 22),
              ]),
            ),
          ]),
        ),
      ),
    );
  }
}
