import 'dart:async';

import 'package:hf_app/features/wallet/billing/billing_adapter.dart';

/// A [BillingAdapter] with no Google Play. Script what Play answers, then assert what the app did.
///
/// ```dart
/// final billing = FakeBillingAdapter()
///   ..onBuy = (product, accountId) => Future(() => billing.emit(StorePurchase(...)));
/// ```
class FakeBillingAdapter implements BillingAdapter {
  FakeBillingAdapter({Map<String, StoreProduct>? products})
      : products = products ??
            const <String, StoreProduct>{
              'hf_tokens_100': StoreProduct(
                productId: 'hf_tokens_100',
                priceText: '₹100.00',
                currencyCode: 'INR',
                priceMicros: 100000000,
              ),
              'hf_tokens_1000': StoreProduct(
                productId: 'hf_tokens_1000',
                priceText: '₹1,000.00',
                currencyCode: 'INR',
                priceMicros: 1000000000,
              ),
            };

  bool available = true;
  Map<String, StoreProduct> products;

  /// When set, [queryProducts] throws it (Play unreachable).
  Object? queryError;

  /// What [buy] answers: false = the Play sheet could not open.
  bool opens = true;

  /// Purchases Play still lists as owned or pending. [recover] re-reports each one on the stream.
  final List<StorePurchase> unfinished = <StorePurchase>[];

  /// Called when the buy sheet opens: script the outcome by calling [emit].
  void Function(StoreProduct product, String obfuscatedAccountId)? onBuy;

  final List<String> boughtProductIds = <String>[];
  final List<String> accountIdsSent = <String>[];
  int recoverCalls = 0;

  final StreamController<StorePurchase> _ctrl = StreamController<StorePurchase>.broadcast();

  void emit(StorePurchase p) => _ctrl.add(p);

  /// The common script: Play answers [status] for the pack that was bought, with [token].
  void answerWith(StorePurchaseStatus status, {String token = 'tok-1', String orderId = 'GPA.1'}) {
    onBuy = (product, _) => Future<void>(() => emit(StorePurchase(
          productId: product.productId,
          purchaseToken: status == StorePurchaseStatus.canceled ? '' : token,
          status: status,
          orderId: orderId,
        )));
  }

  @override
  Future<bool> isAvailable() async => available;

  @override
  Future<Map<String, StoreProduct>> queryProducts(Set<String> productIds) async {
    final e = queryError;
    if (e != null) throw e;
    return {
      for (final id in productIds)
        if (products.containsKey(id)) id: products[id]!,
    };
  }

  @override
  Stream<StorePurchase> get purchases => _ctrl.stream;

  @override
  Future<bool> buy(StoreProduct product, {required String obfuscatedAccountId}) async {
    boughtProductIds.add(product.productId);
    accountIdsSent.add(obfuscatedAccountId);
    onBuy?.call(product, obfuscatedAccountId);
    return opens;
  }

  @override
  Future<void> recover() async {
    recoverCalls++;
    for (final p in List<StorePurchase>.of(unfinished)) {
      emit(p);
    }
  }
}
