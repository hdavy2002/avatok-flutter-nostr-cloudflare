/// A thin seam over Google Play Billing, so the purchase flow can be tested with a fake.
///
/// Contract (Specs/HF-PLAY-BILLING-RUNBOOK.md section 4):
///  * The price shown beside a buy button is [StoreProduct.priceText], Play's own localized string.
///  * [BillingAdapter.buy] sends the server's `obfuscatedAccountId` to Play (the plugin's
///    `applicationUserName`), without it the server rejects the purchase.
///  * The device NEVER acknowledges or consumes: the server does both after it credits. So the real
///    adapter never calls `completePurchase`, and buys with `autoConsume: false`.
class StoreProduct {
  const StoreProduct({
    required this.productId,
    required this.priceText,
    this.currencyCode,
    this.priceMicros,
  });

  final String productId;

  /// `ProductDetails.price`, for example `₹100.00`. Shown as is.
  final String priceText;

  /// `ProductDetails.currencyCode` (`INR`).
  final String? currencyCode;

  /// The price in millionths of the currency (`ProductDetails.rawPrice` x 1,000,000, rounded).
  final int? priceMicros;
}

enum StorePurchaseStatus { purchased, pending, canceled, error }

/// One purchase update from Play (the purchase stream, or the unconsumed purchases Play still lists).
class StorePurchase {
  const StorePurchase({
    required this.productId,
    required this.purchaseToken,
    required this.status,
    this.orderId,
    this.errorMessage,
  });

  final String productId;

  /// Play's purchase token. Empty on a cancelled or failed attempt that never produced one.
  final String purchaseToken;
  final StorePurchaseStatus status;
  final String? orderId;
  final String? errorMessage;
}

abstract class BillingAdapter {
  /// Is Google Play Billing usable on this device?
  Future<bool> isAvailable();

  /// Play's details (localized price) for [productIds]. Ids Play does not know are simply missing.
  /// Throws when Play cannot be reached.
  Future<Map<String, StoreProduct>> queryProducts(Set<String> productIds);

  /// Purchase updates. Subscribed once for the life of the app.
  Stream<StorePurchase> get purchases;

  /// Opens the Play purchase sheet. False when it could not open. The outcome arrives on [purchases].
  Future<bool> buy(StoreProduct product, {required String obfuscatedAccountId});

  /// Asks Play for the purchases it still lists as owned or pending (never consumed, so the server has
  /// not finished them). They arrive on [purchases] like any other update. This is the recovery path.
  Future<void> recover();
}
