import 'package:flutter/material.dart';

import '../../core/theme.dart';
import 'listing_detail.dart';
import 'product.dart';

/// AvaExplore — the Nostr creator marketplace; the default landing screen.
class ExploreHome extends StatefulWidget {
  final VoidCallback onMenu;
  const ExploreHome({super.key, required this.onMenu});
  @override
  State<ExploreHome> createState() => _ExploreHomeState();
}

class _ExploreHomeState extends State<ExploreHome> {
  static const _cats = ['All', 'Presets', 'Templates', 'Courses', 'Services', 'Music', 'Photos'];
  int _cat = 0;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.white,
      body: SafeArea(
        bottom: false,
        child: CustomScrollView(slivers: [
          SliverToBoxAdapter(child: _topBar()),
          SliverToBoxAdapter(child: _search()),
          SliverToBoxAdapter(child: _chips()),
          SliverToBoxAdapter(child: _drop()),
          SliverToBoxAdapter(child: _trendingHeader()),
          SliverPadding(
            padding: const EdgeInsets.fromLTRB(16, 4, 16, 24),
            sliver: SliverGrid(
              gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
                crossAxisCount: 2, crossAxisSpacing: 14, mainAxisSpacing: 16, childAspectRatio: 0.72),
              delegate: SliverChildBuilderDelegate(
                (c, i) => _ProductCard(product: kProducts[i]), childCount: kProducts.length),
            ),
          ),
        ]),
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
          const Icon(Icons.search, size: 22),
          const SizedBox(width: 16),
          _badge(Icons.notifications_none_rounded, dot: true),
          const SizedBox(width: 16),
          _badge(Icons.mail_outline, count: '5'),
        ]),
      );

  Widget _badge(IconData icon, {bool dot = false, String? count}) => Stack(clipBehavior: Clip.none, children: [
        Icon(icon, size: 22),
        if (dot) Positioned(right: -1, top: -1, child: Container(width: 8, height: 8,
            decoration: const BoxDecoration(color: AvaColors.coral, shape: BoxShape.circle))),
        if (count != null) Positioned(right: -7, top: -6, child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
            decoration: BoxDecoration(color: AvaColors.coral, borderRadius: BorderRadius.circular(10)),
            child: Text(count, style: const TextStyle(color: Colors.white, fontSize: 10, fontWeight: FontWeight.w700)))),
      ]);

  Widget _search() => Padding(
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 6),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
          decoration: BoxDecoration(color: AvaColors.soft, borderRadius: BorderRadius.circular(16)),
          child: const Row(children: [
            Icon(Icons.search, color: AvaColors.sub, size: 20), SizedBox(width: 10),
            Text('Search presets, courses, services…', style: TextStyle(color: AvaColors.sub, fontSize: 14)),
          ]),
        ),
      );

  Widget _chips() => SizedBox(
        height: 54,
        child: ListView.separated(
          scrollDirection: Axis.horizontal,
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
          itemCount: _cats.length, separatorBuilder: (_, __) => const SizedBox(width: 8),
          itemBuilder: (c, i) {
            final on = i == _cat;
            return GestureDetector(
              onTap: () => setState(() => _cat = i),
              child: Container(
                alignment: Alignment.center,
                padding: const EdgeInsets.symmetric(horizontal: 18),
                decoration: BoxDecoration(color: on ? AvaColors.ink : AvaColors.soft, borderRadius: BorderRadius.circular(20)),
                child: Text(_cats[i], style: TextStyle(color: on ? Colors.white : AvaColors.ink,
                    fontWeight: FontWeight.w700, fontSize: 13.5))),
            );
          },
        ),
      );

  Widget _drop() => Padding(
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
        child: Container(
          padding: const EdgeInsets.all(18),
          decoration: BoxDecoration(gradient: AvaColors.dropGradient, borderRadius: BorderRadius.circular(20)),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              const Icon(Icons.auto_awesome, color: Colors.white, size: 13),
              const SizedBox(width: 5),
              Text('CREATOR DROP', style: TextStyle(color: Colors.white.withValues(alpha: 0.95),
                  fontSize: 10.5, letterSpacing: 1.4, fontWeight: FontWeight.w800)),
            ]),
            const SizedBox(height: 10),
            const Text('Sell your work,\npaid instantly over Nostr',
                style: TextStyle(color: Colors.white, fontSize: 19, height: 1.2, fontWeight: FontWeight.w800)),
            const SizedBox(height: 14),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 10),
              decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(12)),
              child: const Text('Start selling', style: TextStyle(color: Color(0xFFFF6F6F), fontWeight: FontWeight.w800))),
          ]),
        ),
      );

  Widget _trendingHeader() => Padding(
        padding: const EdgeInsets.fromLTRB(18, 14, 18, 8),
        child: Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
          Text('Trending today', style: Theme.of(context).textTheme.titleLarge?.copyWith(fontSize: 19)),
          Text('See all', style: TextStyle(color: AvaColors.brand, fontWeight: FontWeight.w700)),
        ]),
      );
}

class _ProductCard extends StatelessWidget {
  final Product product;
  const _ProductCard({required this.product});
  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => ListingDetail(product: product))),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Expanded(child: Container(
          decoration: BoxDecoration(
            gradient: AvaColors.thumbGradients[product.gradient % AvaColors.thumbGradients.length],
            borderRadius: BorderRadius.circular(16)),
          padding: const EdgeInsets.all(10),
          child: Align(alignment: Alignment.topLeft, child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
            decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(12)),
            child: Text(product.category, style: const TextStyle(fontSize: 11, fontWeight: FontWeight.w700)))),
        )),
        const SizedBox(height: 8),
        Text(product.title, maxLines: 1, overflow: TextOverflow.ellipsis,
            style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 14)),
        const SizedBox(height: 4),
        Row(children: [
          Container(width: 16, height: 16, decoration: BoxDecoration(
              gradient: AvaColors.thumbGradients[(product.gradient + 2) % 5], shape: BoxShape.circle)),
          const SizedBox(width: 6),
          Expanded(child: Text(product.author, maxLines: 1, overflow: TextOverflow.ellipsis,
              style: const TextStyle(color: AvaColors.sub, fontSize: 12))),
        ]),
        const SizedBox(height: 6),
        Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
          Text(product.price, style: TextStyle(fontWeight: FontWeight.w800, fontSize: 14,
              color: product.price == 'Free' ? AvaColors.brand : AvaColors.ink)),
          Row(children: [
            const Icon(Icons.star, color: Color(0xFFFFB400), size: 14),
            const SizedBox(width: 2),
            Text(product.rating, style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600)),
          ]),
        ]),
      ]),
    );
  }
}
