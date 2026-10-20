import 'dart:async';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../data/api_exception.dart';
import '../data/favourites_store.dart';
import '../data/models/search.dart';
import '../data/repos/favourites_repo.dart';
import '../ui/async_view.dart';
import '../ui/net_image.dart';
import 'state.dart';
import 'theme.dart';
import 'widgets.dart';

/// The real Favourites tab (HF-WIRE-9): the influencers the fan hearted, as a grid, with a remove button.
class RealFavourites extends StatefulWidget {
  const RealFavourites({super.key, required this.repo});

  final FavouritesRepo repo;

  @override
  State<RealFavourites> createState() => _RealFavouritesState();
}

class _RealFavouritesState extends State<RealFavourites> {
  AsyncState<List<FavouriteHost>> _state = const AsyncLoading();

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    if (!demo.signedIn) {
      setState(() => _state = const AsyncData(<FavouriteHost>[]));
      return;
    }
    setState(() => _state = const AsyncLoading());
    AsyncState<List<FavouriteHost>> next;
    try {
      // [HF-APP-CACHE-1] saved list first, then the server's
      await for (final items in widget.repo.watchList()) {
        if (mounted) setState(() => _state = AsyncData(items));
      }
      return;
    } catch (e) {
      next = AsyncFailure(e);
    }
    if (mounted) setState(() => _state = next);
  }

  Future<void> _remove(FavouriteHost h) async {
    final s = _state;
    if (s is! AsyncData<List<FavouriteHost>>) return;
    final before = s.value;
    setState(() => _state = AsyncData([for (final x in before) if (x.slug != h.slug) x]));
    await toggleFavourite(h.slug, onError: (e) {
      if (!mounted) return;
      setState(() => _state = AsyncData(before)); // roll back
      toast(context, e is ApiException ? e.userMessage : 'Could not remove that. Please try again.');
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Padding(padding: EdgeInsets.fromLTRB(20, 16, 20, 14), child: Headline(solid: 'MY', outline: 'FAVOURITES', size: 40)),
            Expanded(
              child: AsyncView<List<FavouriteHost>>(
                state: _state,
                onRetry: () => unawaited(_load()),
                builder: (context, items) => GridView.count(
                  padding: const EdgeInsets.fromLTRB(20, 0, 20, 24),
                  crossAxisCount: 2,
                  mainAxisSpacing: 12,
                  crossAxisSpacing: 12,
                  childAspectRatio: 0.62,
                  children: [for (final h in items) _FavCard(host: h, onRemove: () => unawaited(_remove(h)))],
                ),
                isEmpty: (items) => items.isEmpty,
                emptyTitle: 'No favourites yet',
                emptyMessage: demo.signedIn ? 'Tap ♥ on a reel to save it here.' : 'Sign in, then tap ♥ on a reel to save it here.',
                emptyAction: ChunkyButton(
                  label: demo.signedIn ? 'WATCH REELS' : 'SIGN IN',
                  onTap: () => demo.signedIn ? context.go('/reels') : requireAccount(context, () => unawaited(_load()), reason: 'to see your favourites'),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _FavCard extends StatelessWidget {
  const _FavCard({required this.host, required this.onRemove});

  final FavouriteHost host;
  final VoidCallback onRemove;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      key: ValueKey('fav-${host.slug}'),
      onTap: () => context.push('/profile/${host.slug}'),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(16),
        child: Stack(
          fit: StackFit.expand,
          children: [
            host.photoUrl == null
                ? const ColoredBox(color: C.cinema)
                : NetImage(host.photoUrl!, fit: BoxFit.cover, alignment: Alignment.topCenter, fallback: const ColoredBox(color: C.cinema)),
            const DecoratedBox(
              decoration: BoxDecoration(gradient: LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: [Color(0x00000000), Color(0xCC1A0B26)], stops: [0.45, 1])),
            ),
            Positioned(
              top: 8,
              right: 8,
              child: GestureDetector(
                key: ValueKey('remove-${host.slug}'),
                onTap: onRemove,
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
                  Text(host.name, style: t(16, color: C.ivory)),
                  if (host.headline != null) Text(host.headline!, maxLines: 2, overflow: TextOverflow.ellipsis, style: t(14, color: C.cream, w: FontWeight.w600)),
                  const SizedBox(height: 6),
                  StatusPill(online: host.online),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
