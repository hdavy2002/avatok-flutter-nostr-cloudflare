import 'dart:async';

import 'package:flutter/foundation.dart';

import 'repos/favourites_repo.dart';
import 'services.dart';

/// Which influencers (by slug) the signed-in fan has hearted. Shared by the feed, the profile and the
/// Favourites tab so the ♥ is the same everywhere. Changes are optimistic and roll back on failure.
class FavouritesStore extends ChangeNotifier {
  FavouritesStore(this._repo);

  final FavouritesRepo _repo;

  static FavouritesStore? _override;

  /// The app-wide store. Tests install their own with [override].
  static FavouritesStore get instance => _override ?? (_cached ??= FavouritesStore(FavouritesRepo(Services.instance.api)));
  static FavouritesStore? _cached;

  @visibleForTesting
  static set override(FavouritesStore? s) => _override = s;

  final Set<String> _slugs = {};
  bool _loaded = false;
  Future<void>? _loading;

  bool isFav(String slug) => _slugs.contains(slug);

  /// How many toggles the server has confirmed. A list that is open elsewhere refreshes when this moves (not on the
  /// optimistic flip, which would race the server write).
  int get syncedCount => _synced;
  int _synced = 0;

  /// The saved slugs now (a copy).
  Set<String> get slugs => Set.of(_slugs);
  bool get loaded => _loaded;

  /// Loads the saved list once (and again after [reset]). Never throws: the ♥ simply starts empty.
  Future<void> ensureLoaded() => _loaded ? Future<void>.value() : (_loading ??= _load());

  Future<void> _load() async {
    try {
      final items = await _repo.list();
      _slugs
        ..clear()
        ..addAll(items.map((e) => e.slug));
      _loaded = true;
    } catch (_) {
      // leave unloaded: the next tap tries again
    } finally {
      _loading = null;
    }
    notifyListeners();
  }

  /// Forget everything (sign-out).
  void reset() {
    _slugs.clear();
    _loaded = false;
    _loading = null;
    notifyListeners();
  }

  /// Flip the ♥ for [slug] now, then tell the server. On failure the ♥ goes back and the error is rethrown
  /// so the caller can say so. Returns the new state (true = saved).
  Future<bool> toggle(String slug) async {
    await ensureLoaded();
    final was = _slugs.contains(slug);
    if (was) {
      _slugs.remove(slug);
    } else {
      _slugs.add(slug);
    }
    notifyListeners();
    try {
      if (was) {
        await _repo.remove(slug);
      } else {
        await _repo.add(slug);
      }
      _synced++;
      notifyListeners();
      return !was;
    } catch (_) {
      if (was) {
        _slugs.add(slug);
      } else {
        _slugs.remove(slug);
      }
      notifyListeners();
      rethrow;
    }
  }
}

/// Tap handler body for the ♥: toggles and reports a failure through [onError] (a toast).
Future<void> toggleFavourite(String slug, {required void Function(Object error) onError, void Function(bool saved)? onDone, FavouritesStore? store}) async {
  try {
    final saved = await (store ?? FavouritesStore.instance).toggle(slug);
    onDone?.call(saved);
  } catch (e) {
    onError(e);
  }
}
