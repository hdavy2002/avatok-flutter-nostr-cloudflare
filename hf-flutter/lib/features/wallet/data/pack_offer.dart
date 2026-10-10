import '../billing/billing_adapter.dart';
import 'wallet_models.dart';

/// A token pack as the person sees it: the server's pack (tokens, value per token) joined with Play's own
/// product details (the localized price string). [store] is null when Play does not know the product.
class PackOffer {
  const PackOffer({required this.pack, this.store});

  final TokenPack pack;
  final StoreProduct? store;

  String get productId => pack.productId;

  /// The text beside the buy button: Play's price, never a number from our server.
  String? get priceText => store?.priceText;
}

/// Everything the "Add money" section needs to draw itself.
class PackOffers {
  const PackOffers({
    required this.enabled,
    required this.offers,
    this.storeAvailable = true,
    this.storeError = false,
  });

  /// False when the products route says purchases are off ("Buying tokens is coming soon").
  final bool enabled;
  final List<PackOffer> offers;

  /// False when Google Play Billing cannot be used on this device.
  final bool storeAvailable;

  /// True when Play could not be reached to read the prices.
  final bool storeError;

  static const PackOffers off = PackOffers(enabled: false, offers: <PackOffer>[]);
}

/// Decides only "is this pack at or above the Are-you-sure line". Never shown.
///
/// Uses Play's price when Play reports rupees (micros / 10,000 = paise), else the catalogue price per
/// token. Null when neither is known: the caller then asks to confirm, the safe side.
int? packPricePaise(PackOffer o) {
  final s = o.store;
  if (s != null && s.currencyCode == 'INR' && s.priceMicros != null) {
    return (s.priceMicros! + 5000) ~/ 10000;
  }
  final per = o.pack.purchasePaisePerToken;
  if (per != null) return (o.pack.tokens * per).round();
  return null;
}
