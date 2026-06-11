import 'package:flutter/material.dart';

import '../../core/analytics.dart';
import '../../core/listings_api.dart';
import '../../core/theme.dart';
import '../../core/ui/zine_widgets.dart';
import '../listings/create_listing_flow.dart';
import '../listings/my_listings_screen.dart';
import 'explore_search.dart';
import 'listing_detail.dart';
import 'widgets.dart';

/// AvaExplore — the live creator marketplace (Phase 6; dummy replaced).
/// Live-now rail on top (red dot, Join & pay popup), category rails, search.
class ExploreHome extends StatefulWidget {
  final VoidCallback onMenu;
  const ExploreHome({super.key, required this.onMenu});
  @override
  State<ExploreHome> createState() => _ExploreHomeState();
}

class _ExploreHomeState extends State<ExploreHome> {
  List<ExploreCategory> _cats = [];
  int _cat = 0; // 0 = All
  List<ListingCard> _live = [];
  List<ListingCard> _listings = [];
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
    Analytics.capture('explore_opened');
  }

  Future<void> _load() async {
    final results = await Future.wait([
      ListingsApi.categories(),
      ListingsApi.liveNow(),
      ListingsApi.explore(category: _cat == 0 ? null : _cats[_cat - 1].id),
    ]);
    if (!mounted) return;
    setState(() {
      _cats = results[0] as List<ExploreCategory>;
      _live = results[1] as List<ListingCard>;
      _listings = results[2] as List<ListingCard>;
      _loading = false;
    });
  }

  Future<void> _pickCat(int i) async {
    setState(() { _cat = i; _loading = true; });
    final l = await ListingsApi.explore(category: i == 0 ? null : _cats[i - 1].id);
    if (!mounted) return;
    setState(() { _listings = l; _loading = false; });
  }

  void _open(String id) =>
      Navigator.push(context, MaterialPageRoute(builder: (_) => ListingDetailScreen(listingId: id)));

  Future<void> _joinLive(ListingCard l) async {
    // "Live now" Join → popup card → confirm pays from wallet (Phase 7 deep-links
    // into the stream after payment).
    final ok = await showModalBottomSheet<bool>(
      context: context, isScrollControlled: true, backgroundColor: Colors.transparent,
      builder: (_) => CheckoutSheet(listing: l),
    );
    if (ok == true && mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('You\'re in! The stream opens here when AvaLive ships (Phase 7).')));
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.white,
      body: SafeArea(
        bottom: false,
        child: RefreshIndicator(
          onRefresh: _load,
          child: CustomScrollView(physics: const AlwaysScrollableScrollPhysics(), slivers: [
            SliverToBoxAdapter(child: _topBar()),
            SliverToBoxAdapter(child: _search()),
            if (_live.isNotEmpty) SliverToBoxAdapter(child: _liveRail()),
            SliverToBoxAdapter(child: _chips()),
            SliverToBoxAdapter(child: _drop()),
            if (_loading)
              const SliverToBoxAdapter(child: Padding(
                  padding: EdgeInsets.all(40), child: Center(child: CircularProgressIndicator())))
            else if (_listings.isEmpty)
              const SliverToBoxAdapter(child: Padding(
                  padding: EdgeInsets.all(40),
                  child: Center(child: Text('No listings here yet — check back soon.',
                      style: TextStyle(color: AvaColors.sub)))))
            else
              SliverPadding(
                padding: const EdgeInsets.fromLTRB(16, 4, 16, 24),
                sliver: SliverGrid(
                  gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
                      crossAxisCount: 2, crossAxisSpacing: 14, mainAxisSpacing: 16, childAspectRatio: 0.66),
                  delegate: SliverChildBuilderDelegate(
                      (c, i) => ListingCardTile(card: _listings[i], onTap: () => _open(_listings[i].id)),
                      childCount: _listings.length),
                ),
              ),
          ]),
        ),
      ),
    );
  }

  Widget _topBar() => Padding(
        padding: const EdgeInsets.fromLTRB(14, 10, 14, 6),
        child: Row(children: [
          GestureDetector(onTap: widget.onMenu, child: const Icon(Icons.menu, size: 24)),
          const SizedBox(width: 12),
          Text('AvaExplore', style: Theme.of(context).textTheme.titleLarge?.copyWith(fontSize: 20)),
          const SizedBox(width: 5),
          const Icon(Icons.verified, size: 16, color: AvaColors.brand),
          const Spacer(),
          GestureDetector(
            onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => const MyListingsScreen())),
            child: const Icon(Icons.storefront_outlined, size: 22),
          ),
        ]),
      );

  // Search bar pinned at top of AvaExplore (A1).
  Widget _search() => Padding(
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 6),
        child: GestureDetector(
          onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => const ExploreSearchScreen())),
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
            decoration: BoxDecoration(color: AvaColors.soft, borderRadius: BorderRadius.circular(16)),
            child: const Row(children: [
              Icon(Icons.search, color: AvaColors.sub, size: 20), SizedBox(width: 10),
              Text('Search events, sessions, creators…', style: TextStyle(color: AvaColors.sub, fontSize: 14)),
            ]),
          ),
        ),
      );

  // "Live now" rail: red dot, joined count, Join button → pay popup.
  Widget _liveRail() => Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(18, 12, 18, 4),
          child: Row(children: [
            Container(width: 9, height: 9, decoration: const BoxDecoration(color: AvaColors.coral, shape: BoxShape.circle)),
            const SizedBox(width: 7),
            Text('Live now', style: Theme.of(context).textTheme.titleLarge?.copyWith(fontSize: 18)),
          ]),
        ),
        SizedBox(
          height: 168,
          child: ListView.separated(
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
            itemCount: _live.length,
            separatorBuilder: (_, __) => const SizedBox(width: 12),
            itemBuilder: (_, i) {
              final l = _live[i];
              return GestureDetector(
                onTap: () => _open(l.id),
                child: SizedBox(width: 230, child: Stack(children: [
                  Positioned.fill(child: CoverImage(url: l.coverUrl, seed: l.id.hashCode)),
                  Positioned.fill(child: Container(decoration: BoxDecoration(
                      borderRadius: BorderRadius.circular(16),
                      gradient: LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter,
                          colors: [Colors.transparent, Colors.black.withValues(alpha: .55)])))),
                  Positioned(left: 10, top: 10, child: Container(
                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                    decoration: BoxDecoration(color: AvaColors.coral, borderRadius: BorderRadius.circular(8)),
                    child: const Row(mainAxisSize: MainAxisSize.min, children: [
                      Icon(Icons.circle, size: 7, color: Colors.white), SizedBox(width: 4),
                      Text('LIVE', style: TextStyle(color: Colors.white, fontSize: 10.5, fontWeight: FontWeight.w800)),
                    ]),
                  )),
                  Positioned(left: 12, right: 12, bottom: 10, child: Row(children: [
                    Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
                      Text(l.title, maxLines: 1, overflow: TextOverflow.ellipsis,
                          style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w800, fontSize: 13.5)),
                      Text('${l.joinedCount} watching · ${l.priceLabel}',
                          style: const TextStyle(color: Colors.white70, fontSize: 11)),
                    ])),
                    FilledButton(
                      style: FilledButton.styleFrom(backgroundColor: Colors.white, foregroundColor: AvaColors.coral,
                          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6), minimumSize: Size.zero),
                      onPressed: () => _joinLive(l),
                      child: const Text('Join', style: TextStyle(fontWeight: FontWeight.w800, fontSize: 12.5)),
                    ),
                  ])),
                ])),
              );
            },
          ),
        ),
      ]);

  Widget _chips() {
    final labels = ['All', for (final c in _cats) '${c.emoji} ${c.label}'];
    return SizedBox(
      height: 54,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
        itemCount: labels.length,
        separatorBuilder: (_, __) => const SizedBox(width: 8),
        itemBuilder: (c, i) {
          final on = i == _cat;
          return GestureDetector(
            onTap: () => _pickCat(i),
            child: Container(
              alignment: Alignment.center,
              padding: const EdgeInsets.symmetric(horizontal: 18),
              decoration: BoxDecoration(color: on ? AvaColors.ink : AvaColors.soft, borderRadius: BorderRadius.circular(20)),
              child: Text(labels[i], style: TextStyle(color: on ? Colors.white : AvaColors.ink,
                  fontWeight: FontWeight.w700, fontSize: 13.5)),
            ),
          );
        },
      ),
    );
  }

  /// "Become a creator" banner — zine card (blue fill, ink border, hard
  /// shadow). Banner taps open My Listings; the CTA jumps straight into the
  /// create-listing stepper (mockup behavior).
  Widget _drop() => Padding(
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
        child: ZineCard(
          color: Zine.blue,
          onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => const MyListingsScreen())),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              const Icon(Icons.auto_awesome, color: Zine.blueInk, size: 14),
              const SizedBox(width: 6),
              Text('BECOME A CREATOR', style: ZineText.kicker(color: Zine.blueInk)),
            ]),
            const SizedBox(height: 10),
            Text('Host live events & paid sessions,\nearn straight to your wallet',
                style: ZineText.cardTitle(size: 19)),
            const SizedBox(height: 14),
            ZineButton(
              label: 'Create a listing',
              fontSize: 17,
              onPressed: () => Navigator.push(
                  context, MaterialPageRoute(builder: (_) => const CreateListingFlow())),
            ),
          ]),
        ),
      );
}
