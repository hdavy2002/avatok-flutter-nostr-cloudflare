import 'dart:async';

import 'package:in_app_purchase/in_app_purchase.dart';

import 'billing_adapter.dart';

/// The real adapter: `in_app_purchase` on Google Play.
///
/// Notes:
///  * Nothing touches the platform until a method is called, so building this object is safe in tests.
///  * `buyConsumable(autoConsume: false)`: the plugin must not consume. The server acknowledges and
///    consumes after it credits (runbook 4.3). We never call `completePurchase` for the same reason: on
///    Android it would acknowledge from the device, a second handler for the same purchase.
///  * [recover] uses `restorePurchases()`: Play re-reports every purchase it still lists (owned and not
///    consumed, or pending) on the purchase stream. A purchase the server already consumed is gone.
class PlayBillingAdapter implements BillingAdapter {
  PlayBillingAdapter();

  final Map<String, ProductDetails> _details = <String, ProductDetails>{};
  StreamController<StorePurchase>? _controller;

  InAppPurchase get _iap => InAppPurchase.instance;

  @override
  Stream<StorePurchase> get purchases => _ensureListening().stream;

  StreamController<StorePurchase> _ensureListening() {
    final existing = _controller;
    if (existing != null) return existing;
    final c = StreamController<StorePurchase>.broadcast();
    _controller = c;
    try {
      // One subscription for the life of the app: no cancel needed.
      _iap.purchaseStream.listen(
        (list) {
          for (final d in list) {
            c.add(_map(d));
          }
        },
        onError: (Object e) => c.add(StorePurchase(
          productId: '',
          purchaseToken: '',
          status: StorePurchaseStatus.error,
          errorMessage: '$e',
        )),
      );
    } catch (_) {
      // No billing on this device: the stream just stays quiet.
    }
    return c;
  }

  StorePurchase _map(PurchaseDetails d) {
    final StorePurchaseStatus s;
    switch (d.status) {
      case PurchaseStatus.pending:
        s = StorePurchaseStatus.pending;
      case PurchaseStatus.canceled:
        s = StorePurchaseStatus.canceled;
      case PurchaseStatus.error:
        s = StorePurchaseStatus.error;
      case PurchaseStatus.purchased:
      case PurchaseStatus.restored:
        s = StorePurchaseStatus.purchased;
    }
    return StorePurchase(
      productId: d.productID,
      purchaseToken: d.verificationData.serverVerificationData,
      status: s,
      orderId: d.purchaseID,
      errorMessage: d.error?.message,
    );
  }

  @override
  Future<bool> isAvailable() async {
    try {
      return await _iap.isAvailable();
    } catch (_) {
      return false;
    }
  }

  @override
  Future<Map<String, StoreProduct>> queryProducts(Set<String> productIds) async {
    if (productIds.isEmpty) return const <String, StoreProduct>{};
    final resp = await _iap.queryProductDetails(productIds);
    if (resp.error != null && resp.productDetails.isEmpty) {
      throw StateError(resp.error!.message);
    }
    _details
      ..clear()
      ..addEntries(resp.productDetails.map((d) => MapEntry(d.id, d)));
    return {
      for (final d in resp.productDetails)
        d.id: StoreProduct(
          productId: d.id,
          priceText: d.price,
          currencyCode: d.currencyCode,
          priceMicros: (d.rawPrice * 1000000).round(),
        ),
    };
  }

  @override
  Future<bool> buy(StoreProduct product, {required String obfuscatedAccountId}) async {
    final details = _details[product.productId];
    if (details == null) return false;
    try {
      return await _iap.buyConsumable(
        // applicationUserName is the Play obfuscatedAccountId on Android.
        purchaseParam: PurchaseParam(productDetails: details, applicationUserName: obfuscatedAccountId),
        autoConsume: false,
      );
    } catch (_) {
      return false;
    }
  }

  @override
  Future<void> recover() async {
    // Make sure the stream is being listened to first, so nothing Play re-reports is lost.
    _ensureListening();
    await _iap.restorePurchases();
  }
}
