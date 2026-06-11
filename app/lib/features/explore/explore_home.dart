import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/listings_api.dart';
import '../../core/ui/zine.dart';
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
      backgroundColor: Zine.paper,
      body: SafeArea(
        bottom: false,
        child: RefreshIndicator(
          onRefresh: _load,
          color: Zine.blueInk,
          child: CustomScrollView(physics: const AlwaysScrollableScrollPhysics(), slivers: [
            SliverToBoxAdapter(child: _topBar()),
            SliverToBoxAdapter(child: _search()),
            if (_live.isNotEmpty) SliverToBoxAdapter(child: _liveRail()),
            SliverToBoxAdapter(child: _chips()),
            SliverToBoxAdapter(child: _drop()),
            if (_loading)
              const SliverToBoxAdapter(child: Padding(
                  padding: EdgeInsets.all(40),
                  child: Center(child: CircularProgressIndicator(color: Zine.blueInk))))
            else if (_listings.isEmpty)
              SliverToBoxAdapter(child: Padding(
                  padding: const EdgeInsets.all(40),
                  child: Center(child: ZineEmptyState(
                      icon: PhosphorIcons.binoculars(PhosphorIconsStyle.bold),
                      text: 'No listings here yet — check back soon.'))))
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

  // Appbar band (§8): paper-2 fill, ink bottom border, Fredoka wordmark with
  // the marker highlight on "Explore". Keeps the onMenu wiring.
  Widget _topBar() => Container(
        decoration: const BoxDecoration(
          color: Zine.paper2,
          border: Border(bottom: BorderSide(color: Zine.ink, width: Zine.bw)),
        ),
        padding: const EdgeInsets.fromLTRB(14, 10, 14, 12),
        child: Row(children: [
          ZineBackButton(onTap: widget.onMenu, icon: PhosphorIcons.list(PhosphorIconsStyle.bold)),
          const SizedBox(width: 12),
          const Expanded(
            child: ZineMarkTitle(pre: 'Ava', mark: 'Explore', fontSize: 24, textAlign: TextAlign.left),
          ),
          ZineBackButton(
            onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => const MyListingsScreen())),
            icon: PhosphorIcons.storefront(PhosphorIconsStyle.bold),
          ),
        ]),
      );

  // Search bar pinned at top of AvaExplore (A1) — ink-bordered card pill.
  Widget _search() => Padding(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 6),
        child: ZinePressable(
          onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => const ExploreSearchScreen())),
          radius: BorderRadius.circular(100),
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 13),
          child: Row(children: [
            PhosphorIcon(PhosphorIcons.magnifyingGlass(PhosphorIconsStyle.bold), color: Zine.inkSoft, size: 19),
            const SizedBox(width: 10),
            Text('Search events, sessions, creators…', style: ZineText.sub(size: 14)),
          ]),
        ),
      );

  // "Live now" rail: coral dot, joined count, Join button → pay popup.
  // Zine tile: ink-bordered card, cover on top, card-fill info band below
  // (no gradient scrims — gradients are forbidden).
  Widget _liveRail() => Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(18, 14, 18, 4),
          child: Row(children: [
            Container(width: 9, height: 9, decoration: BoxDecoration(
                color: Zine.coral, shape: BoxShape.circle,
                border: Border.all(color: Zine.ink, width: 2))),
            const SizedBox(width: 8),
            Text('Live now', style: ZineText.cardTitle()),
          ]),
        ),
        SizedBox(
          height: 172,
          child: ListView.separated(
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.fromLTRB(16, 6, 16, 8),
            itemCount: _live.length,
            separatorBuilder: (_, __) => const SizedBox(width: 12),
            itemBuilder: (_, i) {
              final l = _live[i];
              return GestureDetector(
                onTap: () => _open(l.id),
                child: Container(
                  width: 230,
                  clipBehavior: Clip.antiAlias,
                  decoration: BoxDecoration(
                    color: Zine.card,
                    borderRadius: BorderRadius.circular(Zine.rSm),
                    border: Zine.border,
                    boxShadow: Zine.shadowXs,
                  ),
                  child: Column(children: [
                    Expanded(child: Stack(children: [
                      Positioned.fill(child: CoverImage(
                          url: l.coverUrl, seed: l.id.hashCode, radius: BorderRadius.zero)),
                      Positioned(left: 8, top: 8, child: Container(
                        padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 3),
                        decoration: BoxDecoration(
                          color: Zine.coral,
                          borderRadius: BorderRadius.circular(100),
                          border: Border.all(color: Zine.ink, width: 2),
                          boxShadow: Zine.shadowXs,
                        ),
                        child: Row(mainAxisSize: MainAxisSize.min, children: [
                          Container(width: 6, height: 6, decoration: const BoxDecoration(
                              color: Colors.white, shape: BoxShape.circle)),
                          const SizedBox(width: 4),
                          Text('LIVE', style: ZineText.tag(size: 10, color: Colors.white)),
                        ]),
                      )),
                    ])),
                    Container(height: Zine.bw, color: Zine.ink),
                    Padding(
                      padding: const EdgeInsets.fromLTRB(10, 7, 10, 8),
                      child: Row(children: [
                        Expanded(child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            mainAxisSize: MainAxisSize.min,
                            children: [
                          Text(l.title, maxLines: 1, overflow: TextOverflow.ellipsis,
                              style: ZineText.value(size: 12.5, weight: FontWeight.w800)),
                          Text('${l.joinedCount} watching · ${l.priceLabel}',
                              maxLines: 1, overflow: TextOverflow.ellipsis,
                              style: ZineText.tag(size: 9.5, color: Zine.inkSoft)),
                        ])),
                        const SizedBox(width: 8),
                        ZinePressable(
                          onTap: () => _joinLive(l),
                          color: Zine.coral,
                          radius: BorderRadius.circular(100),
                          boxShadow: Zine.shadowXs,
                          padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 6),
                          child: Text('Join', style: ZineText.button(size: 14, color: Colors.white)),
                        ),
                      ]),
                    ),
                  ]),
                ),
              );
            },
          ),
        ),
      ]);

  Widget _chips() {
    final labels = ['All', for (final c in _cats) '${c.emoji} ${c.label}'];
    return SizedBox(
      height: 58,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
        itemCount: labels.length,
        separatorBuilder: (_, __) => const SizedBox(width: 9),
        itemBuilder: (c, i) => ZineChip(
          label: labels[i],
          active: i == _cat,
          onTap: () => _pickCat(i),
        ),
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
