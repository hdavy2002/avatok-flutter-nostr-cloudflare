import '../api_client.dart';
import '../response_cache.dart';
import '../models/me.dart';

/// Who am I. One cheap call used for routing and the Me screen.
class MeRepo {
  const MeRepo(this._api);

  final ApiClient _api;

  /// Needs a signed-in session. Throws `ApiException` (401 when signed out).
  Future<Me> fetch() async => Me.fromJson(await _api.getJson('/api/hf/me', store: true));

  /// [HF-APP-CACHE-1] The last `/me` this account loaded on this phone (up to 30 days old), or null. Lets the app start signed in at once.
  Future<Me?> cached() async {
    final j = await _api.peekJson('/api/hf/me', maxAge: const Duration(days: 30));
    return j == null ? null : Me.fromJson(j);
  }

  /// Cached first, then fresh.
  Stream<Me> watch() => _api.watchJson('/api/hf/me', policy: CachePolicy.profile).map(Me.fromJson);
}
