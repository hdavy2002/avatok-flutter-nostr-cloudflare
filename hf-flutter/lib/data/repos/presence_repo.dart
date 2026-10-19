import '../api_client.dart';

/// Influencer presence, the feed's online count and "Notify me" (HF-WIRE-5).
///
/// - `GET/PUT /api/hosts/me/presence` -> `{ok, presence: online|busy|offline}`. `busy` is set by the
///   server while a call is running; the app can only ask for online or offline.
/// - `GET /api/hf/online-count` -> `{count}` (public, cached 60 s).
/// - `GET/POST/DELETE /api/hf/hosts/:slug/notify` -> `{subscribed}`; one WhatsApp when she goes online.
class PresenceRepo {
  const PresenceRepo(this._api);

  final ApiClient _api;

  /// `online`, `busy` or `offline`.
  Future<String> fetch() async => _presence(await _api.getJson('/api/hosts/me/presence'));

  /// Returns the presence the server ended up with (can be `busy` when going online mid-call).
  Future<String> set({required bool online}) async =>
      _presence(await _api.putJson('/api/hosts/me/presence', body: {'online': online}));

  /// Public. Throws `ApiException` on any failure (the pill hides itself).
  Future<int> onlineCount() async {
    final j = await _api.getJson('/api/hf/online-count', auth: false);
    final c = j['count'];
    return c is num ? c.toInt() : 0;
  }

  /// Needs an account with a verified WhatsApp number.
  Future<void> notifyMe(String slug) async {
    await _api.postJson('/api/hf/hosts/${Uri.encodeComponent(slug)}/notify');
  }

  Future<bool> isSubscribed(String slug) async {
    final j = await _api.getJson('/api/hf/hosts/${Uri.encodeComponent(slug)}/notify');
    return j['subscribed'] == true;
  }

  static String _presence(Map<String, dynamic> j) {
    final p = j['presence'];
    return p == 'online' || p == 'busy' ? p as String : 'offline';
  }
}
