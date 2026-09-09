import 'dart:async';

import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:in_app_purchase/in_app_purchase.dart';

/// PlayPrices — the ONLY truthful source for what Google Play will charge.
///
/// [TOKENS-INR-DISPLAY-1] The wallet top-up tiers and the subscription plans are
/// FIXED-PRICE Play products. Their ids are USD-flavoured (`avatok_topup_10`,
/// `priceUsd: 10`) because that is how they were minted, but Google bills the
/// buyer in the buyer's own currency — ₹ for an Indian user. Printing a hardcoded
/// "$10" beside a button that charges rupees is a money lie, and India is the
/// only market (see the PRODUCT PIVOT in CLAUDE.md).
///
/// `ProductDetails.price` is Play's own localised, pre-formatted string
/// ("₹850.00"), already carrying the right symbol, grouping and decimals for the
/// device locale. Never re-derive it, never FX-convert it, never append a symbol
/// of your own to it.
///
/// Missing is normal: Play is unavailable on web, on a device with no Play
/// Services, and while a newly-created product is still propagating. Callers get
/// `null` and must fall back to a currency-FREE label (the token count), never to
/// a dollar figure.
class PlayPrices {
  PlayPrices._();

  static final Map<String, String> _cache = <String, String>{};

  /// Localised price for [productId] if it has already been fetched.
  static String? cached(String productId) => _cache[productId];

  /// Fetch and cache Play's localised price for each id in [ids]. Returns the
  /// prices it managed to resolve — an empty map is a normal outcome, not an
  /// error, and must never be surfaced to the user as a failure.
  static Future<Map<String, String>> fetch(Set<String> ids) async {
    if (kIsWeb || ids.isEmpty) return const <String, String>{};
    final missing = ids.where((id) => !_cache.containsKey(id)).toSet();
    if (missing.isEmpty) {
      return <String, String>{for (final id in ids) if (_cache[id] != null) id: _cache[id]!};
    }
    try {
      final iap = InAppPurchase.instance;
      if (!await iap.isAvailable()) return _hit(ids);
      final resp = await iap.queryProductDetails(missing);
      for (final p in resp.productDetails) {
        if (p.price.trim().isNotEmpty) _cache[p.id] = p.price.trim();
      }
    } catch (_) {
      // Store lookups fail for reasons we cannot fix here (no Play Services, no
      // network, product not yet live). Fall through to whatever is cached.
    }
    return _hit(ids);
  }

  static Map<String, String> _hit(Set<String> ids) =>
      <String, String>{for (final id in ids) if (_cache[id] != null) id: _cache[id]!};
}
