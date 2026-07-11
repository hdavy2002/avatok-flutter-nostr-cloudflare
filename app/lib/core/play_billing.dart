import 'dart:async';

import 'package:in_app_purchase/in_app_purchase.dart';

import 'subscribe_api.dart';

/// PlayBilling — native Google Play Billing for Android in-app subscriptions.
///
/// Flow: [buy] launches the Play purchase sheet for a `avatok_*_monthly`
/// product → Play returns a purchase on [InAppPurchase.purchaseStream] →
/// we POST the purchase token to the Worker (`/subscribe/android/verify`),
/// which verifies it with the Google Play Developer API and flips the tier
/// (server is the SINGLE source of truth) → we `completePurchase` so Play
/// acknowledges it (un-acknowledged purchases are auto-refunded after 3 days).
///
/// Singleton: the purchase stream is process-global, so we keep one listener
/// alive and let screens re-bind their callbacks via [start].
class PlayBilling {
  PlayBilling._();
  static final PlayBilling instance = PlayBilling._();

  final InAppPurchase _iap = InAppPurchase.instance;
  StreamSubscription<List<PurchaseDetails>>? _sub;
  void Function(String message)? _onNotice;
  void Function(int tier)? _onEntitled;
  bool _started = false;

  /// Begin listening to the global purchase stream. Safe to call on every screen
  /// mount — it rebinds the callbacks but only attaches the listener once.
  void start({
    void Function(String message)? onNotice,
    void Function(int tier)? onEntitled,
  }) {
    _onNotice = onNotice;
    _onEntitled = onEntitled;
    if (_started) return;
    _started = true;
    _sub = _iap.purchaseStream.listen(
      _onPurchaseUpdates,
      onError: (_) => _notice('Purchase failed. Please try again.'),
    );
  }

  /// Launch the native Play purchase UI for [productId]
  /// (e.g. `avatok_plus_monthly`). Returns false if the store/product is
  /// unavailable; success is delivered later via the purchase stream.
  Future<bool> buy(String productId) async {
    if (!await _iap.isAvailable()) {
      _notice('Google Play billing is unavailable on this device.');
      return false;
    }
    final resp = await _iap.queryProductDetails(<String>{productId});
    if (resp.error != null || resp.productDetails.isEmpty) {
      _notice('This plan isn’t available yet. Please try again shortly.');
      return false;
    }
    final param = PurchaseParam(productDetails: resp.productDetails.first);
    // Subscriptions are purchased via buyNonConsumable in the in_app_purchase API.
    return _iap.buyNonConsumable(purchaseParam: param);
  }

  /// Re-fetch entitlements (e.g. after reinstall / new device). Restored
  /// purchases arrive on the same stream and are re-verified server-side.
  Future<void> restore() => _iap.restorePurchases();

  Future<void> _onPurchaseUpdates(List<PurchaseDetails> list) async {
    for (final p in list) {
      // The purchase stream is process-global and SHARED with wallet top-up
      // billing. `avatok_topup_*` consumables belong to WalletTopupBilling —
      // skip them here so we never mis-verify a top-up as a subscription.
      if (p.productID.startsWith('avatok_topup_')) continue;
      switch (p.status) {
        case PurchaseStatus.pending:
          _notice('Completing your purchase…');
          break;
        case PurchaseStatus.error:
          _notice('Purchase error: ${p.error?.message ?? 'unknown'}');
          if (p.pendingCompletePurchase) await _iap.completePurchase(p);
          break;
        case PurchaseStatus.canceled:
          if (p.pendingCompletePurchase) await _iap.completePurchase(p);
          break;
        case PurchaseStatus.purchased:
        case PurchaseStatus.restored:
          await _entitle(p);
          break;
      }
    }
  }

  Future<void> _entitle(PurchaseDetails p) async {
    final token = p.verificationData.serverVerificationData;
    Map<String, dynamic> res = const {};
    try {
      res = await SubscribeApi.verifyAndroid(p.productID, token);
    } catch (_) {/* fall through to the failure notice */}
    // Always finish the purchase so Play doesn't auto-refund; the server owns
    // the tier, so even if our verify call hiccups the token stays valid and a
    // later restore re-entitles.
    if (p.pendingCompletePurchase) await _iap.completePurchase(p);

    if (res['ok'] == true) {
      _onEntitled?.call((res['tier'] as num?)?.toInt() ?? 0);
      _notice('You’re all set — your subscription is active!');
    } else {
      _notice('We couldn’t confirm the purchase yet. If you were charged it will be restored automatically.');
    }
  }

  void _notice(String m) => _onNotice?.call(m);
}
