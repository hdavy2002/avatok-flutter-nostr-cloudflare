import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/auth/session.dart';

/// Local storage key of the hearts on host cards (one list per account on this phone, see `scopedKey`).
const String kFavouritesKey = 'hf.fav.hosts.v1';

/// The hosts this person hearted on the Discover cards: a local-only list of slugs on the phone.
/// Nothing is sent to the server. A storage that cannot be read just means no hearts yet.
final favouriteHostsProvider = NotifierProvider<FavouriteHosts, Set<String>>(
  FavouriteHosts.new,
);

class FavouriteHosts extends Notifier<Set<String>> {
  bool _alive = true;

  @override
  Set<String> build() {
    // A different account on the same phone has its own hearts.
    ref.watch(sessionProvider.select((s) => s.user?.id));
    _alive = true;
    ref.onDispose(() => _alive = false);
    unawaited(_load());
    return const <String>{};
  }

  Future<void> _load() async {
    final entry = await ref
        .read(jsonCacheProvider)
        .read(kFavouritesKey, scoped: true);
    final data = entry?.data;
    if (!_alive || data is! List) return;
    state = <String>{...state, for (final e in data) e.toString()};
  }

  bool isFavourite(String slug) => state.contains(slug);

  /// Hearts or un-hearts [slug] and saves the list.
  Future<void> toggle(String slug) async {
    final next = <String>{...state};
    if (!next.remove(slug)) next.add(slug);
    state = next;
    await ref
        .read(jsonCacheProvider)
        .write(kFavouritesKey, next.toList(), scoped: true);
  }
}
