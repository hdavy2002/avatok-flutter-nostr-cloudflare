import 'dart:math';

import '../../../core/api/api_client.dart';
import 'wallet_models.dart';

/// Typed calls for the Wallet screen. Money is never cached: every read is live.
class WalletApi {
  const WalletApi(this._api);

  final ApiClient _api;

  Future<WalletData> wallet() async => WalletData.fromJson(await _api.getJson('/api/hf/wallet'));

  /// Public route. `enabled: false` means purchases are off: show "Buying tokens is coming soon".
  Future<TokenCatalog> products() async =>
      TokenCatalog.fromJson(await _api.getJson('/api/hf/tokens/products', auth: false));

  /// Limits, debt and the "Are you sure?" threshold are checked here. 403 `limit` carries the message.
  Future<PreparedPurchase> prepare(String productId) async => PreparedPurchase.fromJson(
        await _api.postJson('/api/hf/tokens/play/prepare', body: {'productId': productId}),
        productId,
      );

  /// Idempotent: the same purchase token again answers `duplicate`, never a second credit.
  Future<VerifyResult> verify(String productId, String purchaseToken) async => VerifyResult.fromJson(
        await _api.postJson('/api/hf/tokens/play/verify', body: {'productId': productId, 'purchaseToken': purchaseToken}),
      );

  Future<RefundsInfo> refunds() async => RefundsInfo.fromJson(await _api.getJson('/api/hf/wallet/refunds'));

  /// Asks for a refund of one purchase lot (token mode); with no [lotId], of all unused old top-up money.
  /// The Idempotency-Key makes a retry safe.
  Future<void> requestRefund({String? lotId, String? idempotencyKey}) async {
    await _api.postJson(
      '/api/hf/wallet/refunds',
      body: lotId == null ? const <String, Object?>{} : {'lotId': lotId},
      idempotencyKey: idempotencyKey ?? newIdempotencyKey(),
    );
  }

  Future<void> cancelRefund(String id) async {
    await _api.postJson('/api/hf/wallet/refunds/${Uri.encodeComponent(id)}/cancel');
  }

  /// Old rupee money only.
  Future<List<WalletReceipt>> receipts() async {
    final j = await _api.getJson('/api/hf/wallet/receipts');
    final list = j['receipts'];
    if (list is! List) return const <WalletReceipt>[];
    return [
      for (final e in list)
        if (e is Map) WalletReceipt.fromJson(Map<String, dynamic>.from(e)),
    ];
  }

  static String newIdempotencyKey() {
    final r = Random.secure();
    final b = StringBuffer('hfw-');
    for (var i = 0; i < 16; i++) {
      b.write(r.nextInt(256).toRadixString(16).padLeft(2, '0'));
    }
    return b.toString();
  }
}
