import 'dart:async';

import 'package:in_app_purchase/in_app_purchase.dart';

import 'money_api.dart';

/// A single fixed-price wallet top-up tier, mirroring the active
/// `avatok_topup_*` one-time products in the Play Console. The USD/Token values
/// are display-only — the SERVER is the source of truth for the credited amount
/// (it maps productId → Tokens in routes/wallet.ts). Keep this list in lock-step
/// with the Play Console and PLAY_TOPUP_PRODUCTS on the worker.
class TopupTier {
  const TopupTier(this.productId, this.usd, this.tokens);
  final String productId;
  final int usd;
  final int tokens;
}

const List<TopupTier> kTopupTiers = [
  TopupTier('avatok_topup_5', 5, 500),
  TopupTier('avatok_topup_10', 10, 1000),
  TopupTier('avatok_topup_25', 25, 2500),
  TopupTier('avatok_topup_50', 50, 5000),
  TopupTier('avatok_topup_100', 100, 10000),
];

const Set<String> _kTopupIds = {
  'avatok_topup_5', 'avatok_topup_10', 'avatok_topup_25', 'avatok_topup_50', 'avatok_topup_100',
};

bool isTopupProduct(String id) => id.startsWith('avatok_topup_');

/// WalletTopupBilling — native Google Play Billing for AvaWallet top-ups.
///
/// Flow: [buy] launches the Play purchase sheet for an `avatok_topup_*`
/// CONSUMABLE product → Play returns a purchase on the global purchase stream →
/// we POST the purchase token to the Worker (`/api/wallet/topup/play/verify`),
/// which verifies it with the Google Play Developer API and credits Tokens
/// (server is the SINGLE source of truth for the amount) → we `completePurchase`
/// so Play finishes it. Consumables can be re-purchased, so the same tier can be
/// topped up again and again.
///
/// The purchase stream is process-global and SHARED with subscription billing
/// ([PlayBilling]); this class only ever touches `avatok_topup_*` products and
/// leaves everything else for the subscription handler (and vice versa).
class WalletTopupBilling {
  WalletTopupBilling._();
  static final WalletTopupBilling instance = WalletTopupBilling._();

  final InAppPurchase _iap = InAppPurchase.instance;
  StreamSubscription<List<PurchaseDetails>>? _sub;
  void Function(String message)? _onNotice;
  void Function(int tokensCredited)? _onCredited;
  bool _started = false;

  /// Begin listening to the global purchase stream. Safe to call on every screen
  /// mount — it rebinds the callbacks but only attaches the listener once.
  void start({
    void Function(String message)? onNotice,
    void Function(int tokensCredited)? onCredited,
  }) {
    _onNotice = onNotice;
    _onCredited = onCredited;
    if (_started) return;
    _started = true;
    _sub = _iap.purchaseStream.listen(
      _onPurchaseUpdates,
      onError: (_) => _notice('Top-up failed. Please try again.'),
    );
  }

  void dispose() {
    _sub?.cancel();
    _sub = null;
    _started = false;
  }

  /// Launch the native Play purchase UI for a top-up [productId] (e.g.
  /// `avatok_topup_10`). Returns false if the store/product is unavailable;
  /// success is delivered later via the purchase stream → [onCredited].
  Future<bool> buy(String productId) async {
    if (!_kTopupIds.contains(productId)) {
      _notice('Unknown top-up option.');
      return false;
    }
    if (!await _iap.isAvailable()) {
      _notice('Google Play billing is unavailable on this device.');
      return false;
    }
    final resp = await _iap.queryProductDetails(<String>{productId});
    if (resp.error != null || resp.productDetails.isEmpty) {
      _notice('This top-up isn’t available yet. Please try again shortly.');
      return false;
    }
    final param = PurchaseParam(productDetails: resp.productDetails.first);
    // Consumable: autoConsume (default true) lets the tier be re-purchased.
    return _iap.buyConsumable(purchaseParam: param);
  }

  Future<void> _onPurchaseUpdates(List<PurchaseDetails> list) async {
    for (final p in list) {
      if (!isTopupProduct(p.productID)) continue; // not ours — subscription handler owns it
      switch (p.status) {
        case PurchaseStatus.pending:
          _notice('Completing your top-up…');
          break;
        case PurchaseStatus.error:
          _notice('Top-up error: ${p.error?.message ?? 'unknown'}');
          if (p.pendingCompletePurchase) await _iap.completePurchase(p);
          break;
        case PurchaseStatus.canceled:
          if (p.pendingCompletePurchase) await _iap.completePurchase(p);
          break;
        case PurchaseStatus.purchased:
        case PurchaseStatus.restored:
          await _credit(p);
          break;
      }
    }
  }

  Future<void> _credit(PurchaseDetails p) async {
    final token = p.verificationData.serverVerificationData;
    Map<String, dynamic> res = const {};
    try {
      res = await MoneyApi.topupPlayVerify(p.productID, token);
    } catch (_) {/* fall through to the failure notice */}
    // Always finish the purchase so Play doesn't leave it dangling. Crediting is
    // idempotent on Google's orderId, so a later re-verify can't double-credit.
    if (p.pendingCompletePurchase) await _iap.completePurchase(p);

    if (res['ok'] == true) {
      final credited = (res['credited'] as num?)?.toInt() ?? (res['coins'] as num?)?.toInt() ?? 0;
      _onCredited?.call(credited);
      if (res['duplicate'] == true) {
        _notice('This top-up was already added to your wallet.');
      } else {
        _notice('Top-up complete — Tokens added to your wallet!');
      }
    } else {
      _notice('We couldn’t confirm your top-up yet. If you were charged it will be credited automatically.');
    }
  }

  void _notice(String m) => _onNotice?.call(m);
}
