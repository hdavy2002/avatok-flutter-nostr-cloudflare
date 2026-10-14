import '../../../core/format/money.dart';
import '../billing/billing_adapter.dart';
import 'wallet_models.dart';

class PackBreakdown {
  const PackBreakdown({
    required this.paidPaise,
    required this.gstPaise,
    required this.walletPaise,
  });

  final int paidPaise;
  final int gstPaise;
  final int walletPaise;

  String get total => formatPaise(paidPaise);
  String get gst => formatPaise(gstPaise);
  String get wallet => formatPaise(walletPaise);
  String get line =>
      'Total $total · GST included $gst · Added to wallet $wallet';
  String get lines =>
      'Total payment: $total\nGST included: $gst\nAdded to wallet: $wallet';
}

PackBreakdown splitGstInclusive(int paidPaise, {int gstBps = 1800}) {
  final paid = paidPaise < 0 ? 0 : paidPaise;
  final denominator = 10000 + (gstBps < 0 ? 0 : gstBps);
  final wallet = (2 * paid * 10000 + denominator) ~/ (2 * denominator);
  return PackBreakdown(
    paidPaise: paid,
    gstPaise: paid - wallet,
    walletPaise: wallet,
  );
}

/// A money pack joined with Play's localized product price.
class PackOffer {
  const PackOffer({required this.pack, this.store});

  final TokenPack pack;
  final StoreProduct? store;

  String get productId => pack.productId;

  /// The text beside the buy button: Play's price, never a number from our server.
  String? get priceText => store?.priceText;

  PackBreakdown? get breakdown {
    final s = store;
    if (s != null &&
        s.currencyCode == 'INR' &&
        s.priceMicros != null &&
        s.priceMicros! > 0) {
      return splitGstInclusive(
        (s.priceMicros! + 5000) ~/ 10000,
        gstBps: pack.gstBps,
      );
    }
    final paid = pack.pricePaise;
    if (paid == null) return null;
    if (pack.gstPaise != null && pack.walletPaise != null) {
      return PackBreakdown(
        paidPaise: paid,
        gstPaise: pack.gstPaise!,
        walletPaise: pack.walletPaise!,
      );
    }
    return splitGstInclusive(paid, gstBps: pack.gstBps);
  }
}

/// Everything the "Add money" section needs to draw itself.
class PackOffers {
  const PackOffers({
    required this.enabled,
    required this.offers,
    this.storeAvailable = true,
    this.storeError = false,
    this.missingProductIds = const <String>[],
  });

  /// False when the products route says purchases are off ("Adding money is coming soon").
  final bool enabled;
  final List<PackOffer> offers;

  /// False when Google Play Billing cannot be used on this device.
  final bool storeAvailable;

  /// True when Play could not be reached to read the prices.
  final bool storeError;

  /// Requested catalogue IDs absent from Play; identifiers only, never billing tokens/errors.
  final List<String> missingProductIds;

  static const PackOffers off = PackOffers(
    enabled: false,
    offers: <PackOffer>[],
  );
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
  final catalogue = o.pack.pricePaise;
  if (catalogue != null) return catalogue;
  final per = o.pack.purchasePaisePerToken;
  if (per != null) return (o.pack.tokens * per).round();
  return null;
}
