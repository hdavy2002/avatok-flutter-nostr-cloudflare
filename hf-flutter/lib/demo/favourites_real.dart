import 'dart:async';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../data/reel_bookmarks.dart';
import '../data/repos/favourites_repo.dart';
import '../data/services.dart';
import '../ui/net_image.dart';
import 'state.dart';
import 'theme.dart';
import 'widgets.dart';

/// Saved videos; the old saved-host repository remains separate for profile favourites.
class RealFavourites extends StatefulWidget {
  const RealFavourites({super.key, required this.repo});
  final FavouritesRepo repo;
  @override
  State<RealFavourites> createState() => _RealFavouritesState();
}

class _RealFavouritesState extends State<RealFavourites> {
  final _store = ReelBookmarks.instance;
  String? _account;
  Object? _error;
  bool _loading = false;
  @override
  void initState() {
    super.initState();
    demo.addListener(_accountChanged);
    Services.instance.authAccount.addListener(_accountChanged);
    _store.addListener(_changed);
    _accountChanged();
  }

  void _changed() {
    if (mounted) setState(() {});
  }

  void _accountChanged() {
    final id = Services.instance.user?.id;
    if (_account == id) {
      _changed();
      return;
    }
    _account = id;
    _error = null;
    if (id != null) unawaited(_load());
    _changed();
  }

  Future<void> _load() async {
    final id = _account;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      await _store.refresh();
    } catch (e) {
      if (mounted && id == _account) _error = e;
    } finally {
      if (mounted && id == _account) setState(() => _loading = false);
    }
  }

  @override
  void dispose() {
    demo.removeListener(_accountChanged);
    Services.instance.authAccount.removeListener(_accountChanged);
    _store.removeListener(_changed);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final signedIn = Services.instance.isSignedIn;
    final items = signedIn ? _store.items : const [];
    return Scaffold(
      body: SafeArea(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Padding(
              padding: EdgeInsets.all(20),
              child: Headline(solid: 'SAVED', outline: 'VIDEOS', size: 36),
            ),
            Expanded(
              child: !signedIn
                  ? Center(
                      child: Padding(
                        padding: const EdgeInsets.all(24),
                        child: Column(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Text(
                              'Log in or create an account to save videos.',
                              textAlign: TextAlign.center,
                              style: t(18),
                            ),
                            const SizedBox(height: 16),
                            ChunkyButton(
                              label: 'LOG IN / CREATE ACCOUNT',
                              onTap: () => requireAccount(
                                context,
                                () => unawaited(_load()),
                                reason: 'to see saved videos',
                              ),
                            ),
                          ],
                        ),
                      ),
                    )
                  : _loading && items.isEmpty
                  ? const Center(child: CircularProgressIndicator())
                  : _error != null && items.isEmpty
                  ? Center(
                      child: TextButton(
                        onPressed: _load,
                        child: const Text('Could not load saved videos. Retry'),
                      ),
                    )
                  : items.isEmpty
                  ? Center(
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Text(
                            'Tap ♥ on a reel to save it here.',
                            style: t(16),
                          ),
                          TextButton(
                            onPressed: () => context.go('/reels'),
                            child: const Text('WATCH REELS'),
                          ),
                        ],
                      ),
                    )
                  : RefreshIndicator(
                      onRefresh: _load,
                      child: GridView.builder(
                        padding: const EdgeInsets.all(16),
                        gridDelegate:
                            const SliverGridDelegateWithFixedCrossAxisCount(
                              crossAxisCount: 2,
                              childAspectRatio: 0.65,
                              crossAxisSpacing: 12,
                              mainAxisSpacing: 12,
                            ),
                        itemCount: items.length,
                        itemBuilder: (context, index) {
                          final reel = items[index];
                          return ClipRRect(
                            borderRadius: BorderRadius.circular(14),
                            child: Material(
                              color: C.cinema,
                              child: InkWell(
                                onTap: () => context.go(
                                  '/reels?reel=${Uri.encodeQueryComponent(reel.id)}',
                                  extra: reel,
                                ),
                                child: Stack(
                                  fit: StackFit.expand,
                                  children: [
                                    if (reel.thumbUrl != null)
                                      NetImage(
                                        reel.thumbUrl!,
                                        fit: BoxFit.cover,
                                        fallback: const ColoredBox(
                                          color: C.cinema,
                                        ),
                                      ),
                                    const Center(
                                      child: Icon(
                                        Icons.play_circle_outline_rounded,
                                        size: 40,
                                        color: C.ivory,
                                      ),
                                    ),
                                    Positioned(
                                      top: 0,
                                      right: 0,
                                      child: IconButton(
                                        tooltip: 'Remove saved video',
                                        onPressed: _store.busy(reel.id)
                                            ? null
                                            : () async {
                                                try {
                                                  await _store.toggle(reel);
                                                } catch (_) {
                                                  if (context.mounted)
                                                    toast(
                                                      context,
                                                      'Could not remove that. Try again.',
                                                    );
                                                }
                                              },
                                        icon: const Icon(
                                          Icons.favorite_rounded,
                                          color: C.rani,
                                        ),
                                      ),
                                    ),
                                    Positioned(
                                      left: 0,
                                      right: 0,
                                      bottom: 0,
                                      child: ColoredBox(
                                        color: const Color(0xAA000000),
                                        child: Padding(
                                          padding: const EdgeInsets.all(10),
                                          child: Text(
                                            reel.caption.isEmpty
                                                ? reel.host.name
                                                : reel.caption,
                                            maxLines: 2,
                                            overflow: TextOverflow.ellipsis,
                                            style: t(14, color: C.ivory),
                                          ),
                                        ),
                                      ),
                                    ),
                                  ],
                                ),
                              ),
                            ),
                          );
                        },
                      ),
                    ),
            ),
          ],
        ),
      ),
    );
  }
}
