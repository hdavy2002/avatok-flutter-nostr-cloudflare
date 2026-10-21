import 'dart:async';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../ui/motion.dart';
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
  FavouritesStore? _store;
  int _seenSynced = 0;

  @override
  void initState() {
    super.initState();
    try {
      _store = FavouritesStore.instance;
      _seenSynced = _store!.syncedCount;
      _store!.addListener(_onStore);
    } catch (_) {
      _store = null; // no services yet (a bare widget test): the list simply loads once
    }
    unawaited(_load());
  }

  @override
  void dispose() {
    _store?.removeListener(_onStore);
    super.dispose();
  }

  /// [HF-REELS-FAV-1] The tab stays alive under the bottom bar, so a ♥ tapped on a reel must refresh the list.
  void _onStore() {
    final s = _state;
    final store = _store;
    if (!mounted || store == null || !store.loaded || s is! AsyncData<List<FavouriteHost>>) return;
    if (store.syncedCount == _seenSynced) return; // only a server-confirmed change refreshes the list
    _seenSynced = store.syncedCount;
    final shown = {for (final h in s.value) h.slug};
    final saved = store.slugs;
    if (shown.length != saved.length || !shown.containsAll(saved)) unawaited(_reload());
  }

  /// A quiet refresh: the grid stays on screen.
  Future<void> _reload() async {
    try {
      final items = await widget.repo.list();
      if (mounted) setState(() => _state = AsyncData(items));
    } catch (_) {
      // keep what is shown; pull-to-open again retries
    }
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
                  children: [for (final h in items) _FavCard(key: ValueKey(h.slug), host: h, onRemove: () => unawaited(_remove(h)))],
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
  const _FavCard({super.key, required this.host, required this.onRemove});

  final FavouriteHost host;
  final VoidCallback onRemove;

  @override
  Widget build(BuildContext context) {
    return HfReveal(child: GestureDetector(
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
                behavior: HitTestBehavior.opaque,
                onTap: onRemove,
                child: const SizedBox(width: 48, height: 48, child: Center(child: Icon(Icons.favorite_rounded, color: C.rani, size: 28, semanticLabel: 'Remove from favourites'))),
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
    ));
  }
}
