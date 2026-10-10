import '../../../core/api/api_client.dart';
import 'host_dashboard_models.dart';

/// Typed calls for the Host dashboard. Money is never cached: every read is live.
class HostDashboardApi {
  const HostDashboardApi(this._api);

  final ApiClient _api;

  /// `GET /api/hosts/me`: the profile status and the reviewer's note.
  Future<HostProfileStatus> profile() async => HostProfileStatus.fromJson(await _api.getJson('/api/hosts/me'));

  /// `GET /api/hosts/me/presence` -> `online | busy | offline`. 409 `not_live` until the profile is live.
  Future<String> presence() async => _presence(await _api.getJson('/api/hosts/me/presence'));

  /// `PUT /api/hosts/me/presence {online}`. Errors: 409 `not_live`, 403 `not_verified`, 409 `account_closing`.
  Future<String> setPresence(bool online) async =>
      _presence(await _api.putJson('/api/hosts/me/presence', body: {'online': online}));

  /// `POST /api/hosts/me/presence/beat`: keeps an online host online (the server drops one after 8 h of silence).
  Future<void> beat() async {
    await _api.postJson('/api/hosts/me/presence/beat');
  }

  Future<HostCallsData> calls() async => HostCallsData.fromJson(await _api.getJson('/api/hosts/me/calls'));

  /// The host block of `GET /api/hf/wallet`, or null when the answer has none.
  Future<HostEarnings?> earnings() async => HostEarnings.fromWalletJson(await _api.getJson('/api/hf/wallet'));

  Future<PayoutsData> payouts() async => PayoutsData.fromJson(await _api.getJson('/api/hosts/me/payouts'));

  /// `POST /api/hosts/me/payouts {amount}` (whole rupees). The Idempotency-Key makes a retry safe.
  Future<void> requestPayout(int amountRupees, {required String idempotencyKey}) async {
    await _api.postJson('/api/hosts/me/payouts', body: {'amount': amountRupees}, idempotencyKey: idempotencyKey);
  }

  /// Only while the request is still `requested`. 409 `not_cancellable` once it was approved.
  Future<void> cancelPayout(String id) async {
    await _api.postJson('/api/hosts/me/payouts/${Uri.encodeComponent(id)}/cancel');
  }

  static String _presence(Map<String, dynamic> j) {
    final p = (j['presence'] ?? 'offline').toString();
    return (p == 'online' || p == 'busy') ? p : 'offline';
  }
}
