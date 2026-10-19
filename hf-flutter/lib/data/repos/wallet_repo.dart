import 'dart:math';

import 'package:url_launcher/url_launcher.dart';

import '../api_client.dart';
import '../models/wallet.dart';

/// Wallet and top-up (HF-WIRE-6).
///
/// - `GET  /api/hf/app/wallet?cursor=&limit=` -> `{balancePaise, testCreditPaise, heldPaise, ledger[], nextCursor}`
/// - `POST /api/hf/wallet/topup {amount: whole rupees}` (Idempotency-Key) -> the order, with the server's own
///   credit/GST figures. The server is the source of truth for the maths.
/// - `GET  /api/hf/wallet/topup/:id` -> `{state: pending|paid|failed, creditPaise}`
///
/// Money is only ever added by the payment provider's signed message to the server, never by this app.
class WalletRepo {
  const WalletRepo(this._api);

  final ApiClient _api;

  static const int minRupees = 10;
  static const int confirmFromRupees = 1000;

  Future<WalletSnapshot> fetch({String? cursor, int limit = 20}) async =>
      WalletSnapshot.fromJson(await _api.getJson('/api/hf/app/wallet', query: {'cursor': cursor, 'limit': limit}));

  Future<TopupOrder> createTopup(int rupees) async {
    final json = await _api.request(
      'POST',
      '/api/hf/wallet/topup',
      body: {'amount': rupees},
      headers: {'Idempotency-Key': _key()},
    );
    return TopupOrder.fromJson(json is Map<String, dynamic> ? json : <String, dynamic>{});
  }

  Future<TopupStatus> status(String orderId) async =>
      TopupStatus.fromJson(await _api.getJson('/api/hf/wallet/topup/${Uri.encodeComponent(orderId)}'));

  /// Same maths as the server (paid divided by 1.18, rounded DOWN to the paisa), for the preview line.
  static int creditPaiseFor(int paidPaise) => (paidPaise * 10000) ~/ 11800;

  static String _key() {
    final r = Random.secure();
    final tail = List.generate(8, (_) => r.nextInt(256).toRadixString(16).padLeft(2, '0')).join();
    return 'app-${DateTime.now().millisecondsSinceEpoch}-$tail';
  }
}

/// Opens the payment page. A Chrome Custom Tab on Android. Tests replace [launcher].
abstract final class Checkout {
  static Future<bool> Function(Uri url) launcher = _launch;

  static Future<bool> open(String url) async {
    final uri = Uri.tryParse(url);
    if (uri == null || !uri.hasScheme) return false;
    try {
      return await launcher(uri);
    } catch (_) {
      return false;
    }
  }

  static Future<bool> _launch(Uri url) => launchUrl(url, mode: LaunchMode.inAppBrowserView);
}
