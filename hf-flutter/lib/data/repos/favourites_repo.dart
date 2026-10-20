import '../api_client.dart';
import '../api_exception.dart';
import '../models/search.dart';
import '../response_cache.dart';

/// Saved ("hearted") influencers, keyed by the influencer's slug (worker/src/routes/hf_favourites.ts).
class FavouritesRepo {
  const FavouritesRepo(this._api);

  final ApiClient _api;

  static const String notOpenText = 'Favourites are not open yet. Please check back soon.';

  Future<T> _guard<T>(Future<T> Function() run) async {
    try {
      return await run();
    } on ApiException catch (e) {
      if (e.isNotEnabled) {
        throw const ApiException(kind: ApiFailure.http, status: 404, code: 'not_enabled', message: notOpenText);
      }
      rethrow;
    }
  }

  /// Newest first. Needs sign-in.
  Future<List<FavouriteHost>> list() => _guard(() async {
        final j = await _api.getJson('/api/hf/favourites', store: true);
        return [
          for (final e in (j['items'] is List ? j['items'] as List : const []))
            if (e is Map) FavouriteHost.fromJson(Map<String, dynamic>.from(e)),
        ];
      });

  /// [HF-APP-CACHE-1] The saved list cached-first. Hearting / un-hearting (PUT / DELETE) throws the cached copy away.
  Stream<List<FavouriteHost>> watchList() async* {
    try {
      await for (final j in _api.watchJson('/api/hf/favourites', policy: CachePolicy.live)) {
        yield [
          for (final e in (j['items'] is List ? j['items'] as List : const []))
            if (e is Map) FavouriteHost.fromJson(Map<String, dynamic>.from(e)),
        ];
      }
    } on ApiException catch (e) {
      if (e.isNotEnabled) {
        throw const ApiException(kind: ApiFailure.http, status: 404, code: 'not_enabled', message: notOpenText);
      }
      rethrow;
    }
  }

  /// Idempotent.
  Future<void> add(String slug) => _guard(() async {
        await _api.putJson('/api/hf/favourites/${Uri.encodeComponent(slug)}');
      });

  /// Idempotent.
  Future<void> remove(String slug) => _guard(() async {
        await _api.deleteJson('/api/hf/favourites/${Uri.encodeComponent(slug)}');
      });
}
