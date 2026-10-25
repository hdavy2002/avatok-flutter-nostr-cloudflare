import 'dart:async';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../data/models/reel.dart';
import '../data/reel_bookmarks.dart';
import '../data/repos/favourites_repo.dart';
import '../data/services.dart';
import '../ui/net_image.dart';
import 'desi.dart';
import 'fav_kit.dart';
import 'reels_real.dart';
import 'screens/sheets.dart';
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

  FavFilter _filter = FavFilter.all;

  Future<void> _remove(BuildContext context, FeedReel reel) async {
    try {
      await _store.toggle(reel);
    } catch (_) {
      if (context.mounted) toast(context, 'Could not remove that. Try again.');
    }
  }

  /// [HF-APP-DESI-3] Same layout as the approved Favourites canvas; cards are saved videos.
  @override
  Widget build(BuildContext context) {
    final signedIn = Services.instance.isSignedIn;
    final items = signedIn ? _store.items : const <FeedReel>[];
    const pad = EdgeInsets.fromLTRB(16, 12, 16, 24);
    Widget body;
    if (!signedIn) {
      body = ListView(padding: pad, children: [
        const FavHeader(count: 0, compact: true),
        const SizedBox(height: 14),
        DesiCard(
          tone: DesiTone.lav,
          corner: DesiCorner.marigold,
          child: Column(children: [
            Text('Log in or create an account to save videos.', textAlign: TextAlign.center, style: t(18)),
            const SizedBox(height: 14),
            DesiButton('LOG IN / CREATE ACCOUNT', kind: DesiButtonKind.plum, onTap: () => requireAccount(context, () => unawaited(_load()), reason: 'to see saved videos')),
          ]),
        ),
      ]);
    } else if (_loading && items.isEmpty) {
      body = ListView(padding: pad, children: const [FavHeader(count: 0, compact: true), SizedBox(height: 60), Center(child: CircularProgressIndicator())]);
    } else if (_error != null && items.isEmpty) {
      body = ListView(padding: pad, children: [
        const FavHeader(count: 0, compact: true),
        const SizedBox(height: 14),
        DesiCard(child: Center(child: TextButton(onPressed: _load, child: Text('Could not load saved videos. Retry', style: t(16, color: C.rani))))),
      ]);
    } else if (items.isEmpty) {
      body = ListView(padding: pad, children: [
        const FavHeader(count: 0, compact: true),
        const SizedBox(height: 14),
        FavEmptyCard(onWatch: () => context.go('/reels')),
      ]);
    } else {
      final online = items.where((r) => r.host.online).length;
      final shown = items.where((r) => switch (_filter) { FavFilter.all => true, FavFilter.online => r.host.online, FavFilter.offline => !r.host.online }).toList();
      body = RefreshIndicator(
        onRefresh: _load,
        child: ListView(padding: pad, children: [
          FavHeader(count: items.length),
          const SizedBox(height: 14),
          FavStats(online: online, saved: items.length),
          const SizedBox(height: 14),
          FavFilterPills(value: _filter, onPick: (f) => setState(() => _filter = f)),
          const SizedBox(height: 14),
          FavGrid(cards: [
            for (var i = 0; i < shown.length; i++)
              FavCard(
                index: i,
                image: _thumb(shown[i]),
                name: shown[i].host.name,
                sub: shown[i].caption,
                online: shown[i].host.online,
                rate: shown[i].host.rateRupees,
                heartLabel: 'Remove saved video',
                onOpen: () => context.go('/reels?reel=${Uri.encodeQueryComponent(shown[i].id)}', extra: shown[i]),
                onHeart: _store.busy(shown[i].id) ? null : () => _remove(context, shown[i]),
                onCall: () => startCall(context, influencerFromHost(shown[i].host)),
                onBook: () => context.push('/book/${Uri.encodeComponent(shown[i].host.slug)}'),
              ),
          ]),
          const SizedBox(height: 14),
          const FavTip(),
          const SizedBox(height: 10),
          const DesiMogra(),
        ]),
      );
    }
    return Scaffold(backgroundColor: C.page, body: SafeArea(child: body));
  }

  Widget _thumb(FeedReel reel) {
    final url = reel.thumbUrl ?? reel.host.avatar;
    const fallback = DecoratedBox(decoration: BoxDecoration(gradient: LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: [C.blush, C.lavtint])));
    if (url == null || url.isEmpty) return fallback;
    return NetImage(url, fit: BoxFit.cover, fallback: fallback);
  }
}
