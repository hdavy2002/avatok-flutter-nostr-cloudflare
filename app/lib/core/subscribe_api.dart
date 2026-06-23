import 'dart:convert';

import 'api_auth.dart';
import 'config.dart';

/// SubscribeApi — Phase 1 subscription tiers (Free / Plus / Pro / Max).
///
/// The plan matrix is SERVER-OWNED: we only READ it to render the Subscribe
/// screen; the server enforces every cap. Checkout returns either a Stripe web
/// URL (open in a browser) or a Google Play product id (the Android client
/// launches native Play Billing, then calls [verifyAndroid] with the token).
class SubscribeApi {
  static Map<String, dynamic> _json(String body) {
    try { return jsonDecode(body) as Map<String, dynamic>; } catch (_) { return {}; }
  }

  /// GET the plan matrix + the caller's current tier/state.
  /// Returns { plans: [...], current: { tier, status, source, renewsAt } }.
  static Future<Map<String, dynamic>> plans() async {
    final res = await ApiAuth.getSigned('$kSubscribeBase/plans');
    return _json(res.body);
  }

  /// Start checkout for [tier] (1=Plus, 2=Pro, 3=Max) on [platform] ('web' | 'android').
  /// Web → { checkout_url }. Android → { play_product_id }.
  static Future<Map<String, dynamic>> checkout(int tier, {required String platform}) async {
    final res = await ApiAuth.postJson(
      '$kSubscribeBase/checkout',
      {'tier': tier, 'platform': platform},
    );
    return {..._json(res.body), 'status': res.statusCode};
  }

  /// Verify a Google Play purchase after native Play Billing completes.
  static Future<Map<String, dynamic>> verifyAndroid(String productId, String purchaseToken) async {
    final res = await ApiAuth.postJson(
      '$kSubscribeBase/android/verify',
      {'productId': productId, 'purchaseToken': purchaseToken},
    );
    return {..._json(res.body), 'status': res.statusCode};
  }

  /// Cancel — keeps the tier until renews_at, then auto-downgrades to Free.
  static Future<Map<String, dynamic>> cancel() async {
    final res = await ApiAuth.postJson('$kSubscribeBase/cancel', {});
    return {..._json(res.body), 'status': res.statusCode};
  }
}
