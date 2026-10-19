import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../data.dart';
import '../state.dart';
import '../theme.dart';
import '../widgets.dart';

/// Favourites: reels the fan saved with ♥ (HF-REEL-7).
class FavouritesScreen extends StatelessWidget {
  const FavouritesScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: ListenableBuilder(
          listenable: demo,
          builder: (context, _) {
            final saved = reels.where((r) => demo.isFav(r.id)).toList();
            return CustomScrollView(
              slivers: [
                const SliverPadding(
                  padding: EdgeInsets.fromLTRB(20, 16, 20, 14),
                  sliver: SliverToBoxAdapter(child: Headline(solid: 'MY', outline: 'FAVOURITES', size: 40)),
                ),
                if (saved.isEmpty)
                  SliverFillRemaining(
                    hasScrollBody: false,
                    child: Padding(
                      padding: const EdgeInsets.all(32),
                      child: Column(
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: [
                          const ArtMoment('favourites/empty-sakhi.webp', label: 'TARA\nhugging a heart', size: 200),
                          const SizedBox(height: 18),
                          Text('No favourites yet', style: t(22, color: C.maroon)),
                          const SizedBox(height: 6),
                          Text('Tap ♥ on a reel to save it here.', textAlign: TextAlign.center, style: t(16, color: C.muted, w: FontWeight.w700)),
                          const SizedBox(height: 20),
                          ChunkyButton(label: 'WATCH REELS', onTap: () => context.go('/reels')),
                        ],
                      ),
                    ),
                  )
                else
                  SliverPadding(
                    padding: const EdgeInsets.fromLTRB(20, 0, 20, 24),
                    sliver: SliverGrid.count(
                      crossAxisCount: 2,
                      mainAxisSpacing: 12,
                      crossAxisSpacing: 12,
                      childAspectRatio: 0.62,
                      children: [for (final r in saved) _FavCard(reel: r)],
                    ),
                  ),
              ],
            );
          },
        ),
      ),
    );
  }
}

class _FavCard extends StatelessWidget {
  const _FavCard({required this.reel});

  final Reel reel;

  @override
  Widget build(BuildContext context) {
    final who = reel.who;
    return GestureDetector(
      onTap: () => context.push('/profile/${who.id}'),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(16),
        child: Stack(
          fit: StackFit.expand,
          children: [
            DecoratedBox(
              decoration: BoxDecoration(gradient: LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: [who.tones.first, who.tones.last, C.cinema])),
              child: who.portrait == null ? null : Art(who.portrait!, fit: BoxFit.cover, alignment: Alignment.topCenter),
            ),
            const DecoratedBox(
              decoration: BoxDecoration(gradient: LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: [Color(0x00000000), Color(0xCC1A0B26)], stops: [0.45, 1])),
            ),
            Positioned(
              top: 8,
              right: 8,
              child: GestureDetector(
                onTap: () => demo.toggleFav(reel.id),
                child: const Icon(Icons.favorite_rounded, color: C.rani, size: 28, semanticLabel: 'Remove from favourites'),
              ),
            ),
            Positioned(
              left: 10,
              right: 10,
              bottom: 10,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(who.name, style: t(16, color: C.ivory)),
                  Text(reel.caption, maxLines: 2, overflow: TextOverflow.ellipsis, style: t(13, color: C.cream, w: FontWeight.w600)),
                  const SizedBox(height: 6),
                  StatusPill(online: who.online),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
