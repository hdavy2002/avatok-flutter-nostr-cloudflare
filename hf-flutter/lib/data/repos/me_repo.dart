import '../api_client.dart';
import '../models/me.dart';

/// Who am I. One cheap call used for routing and the Me screen.
class MeRepo {
  const MeRepo(this._api);

  final ApiClient _api;

  /// Needs a signed-in session. Throws `ApiException` (401 when signed out).
  Future<Me> fetch() async => Me.fromJson(await _api.getJson('/api/hf/me'));
}
