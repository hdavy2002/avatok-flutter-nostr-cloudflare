import 'dart:math';

import 'package:url_launcher/url_launcher.dart';

import '../api_client.dart';
import '../api_exception.dart';
import '../cashfree_checkout.dart';
import '../in_app_checkout.dart';
import '../models/wallet.dart';

/// Wallet and top-up (HF-WIRE-6).
///
/// - `GET  /api/hf/app/wallet?cursor=&limit=` -> `{balancePaise, testCreditPaise, heldPaise, ledger[], nextCursor}`
/// - `POST /api/hf/wallet/topup {amount: whole rupees}` (Idempotency-Key) -> the order, with the server's own
///   credit/GST figures. The server is the source of truth for the maths.
/// - `GET  /api/hf/wallet/topup/:id` -> `{state: pending|paid|failed, creditPaise}`
///
/// Money is only ever added by the payment provider's signed message to the server, never by this app.
class WalletRepo {
  const WalletRepo(this._api, {this.retryDelay = const Duration(milliseconds: 800)});

  final ApiClient _api;

  /// [HF-WIRE-20] Pause before the one automatic second try of a read that failed on a dropped connection or a server hiccup.
  final Duration retryDelay;

  static const int minRupees = 10;
  static const int confirmFromRupees = 1000;

  /// Reads the wallet. A failure that is probably momentary (no connection, a 5xx, an unreadable reply) is tried once more after
  /// [retryDelay] before the error reaches the screen; refusals (401, 4xx) are not retried. [HF-WIRE-20]
  Future<WalletSnapshot> fetch({String? cursor, int limit = 20}) async {
    Future<WalletSnapshot> once() async =>
        WalletSnapshot.fromJson(await _api.getJson('/api/hf/app/wallet', query: {'cursor': cursor, 'limit': limit}));
    try {
      return await once();
    } on ApiException catch (e) {
      if (!e.isTransient) rethrow;
      await Future<void>.delayed(retryDelay);
      return once();
    }
  }

  /// [name] and [email] are what the payer typed on our "Your details" screen because the profile had none; the server hands them
  /// to the payment provider for the receipt (used for this order only, and only if the profile has nothing).
  Future<TopupOrder> createTopup(int rupees, {String? name, String? email}) async {
    final json = await _api.request(
      'POST',
      '/api/hf/wallet/topup',
      body: {
        'amount': rupees,
        'client': 'app',
        if (name != null && name.trim().isNotEmpty) 'customer_name': name.trim(),
        if (email != null && email.trim().isNotEmpty) 'customer_email': email.trim(),
      },
      headers: {'Idempotency-Key': _key()},
    );
    return TopupOrder.fromJson(json is Map<String, dynamic> ? json : <String, dynamic>{});
  }

  /// Saves the details the payer just typed to the profile (`PATCH /api/hf/me`). Best effort: the order carries them anyway, so a
  /// refusal (for example email saving not switched on yet) never blocks paying.
  Future<void> saveDetails({String? name, String? email}) async {
    for (final body in [
      if (name != null && name.trim().isNotEmpty) {'displayName': name.trim()},
      if (email != null && email.trim().isNotEmpty) {'email': email.trim()},
    ]) {
      try {
        await _api.request('PATCH', '/api/hf/me', body: body);
      } on ApiException {
        // ignored on purpose, see above
      }
    }
  }

  Future<TopupStatus> status(String orderId) async =>
      TopupStatus.fromJson(await _api.getJson('/api/hf/wallet/topup/${Uri.encodeComponent(orderId)}'));

  /// Same maths as the server (paid divided by 1.18, rounded DOWN to the paisa), for the preview line.
  static int creditPaiseFor(int paidPaise) => (paidPaise * 10000) ~/ 11800;

  static String _key() {
    final r = Random.secure();
    final tail = List.generate(8, (_) => r.nextInt(256).toRadixString(16).padLeft(2, '0')).join();
    return 'app-${DateTime.now().millisecondsSinceEpoch}-$tail';
  }
}

/// [inApp] is the checkout inside the app (the payment SDK; UPI app, UPI ID, card). [open] opens a link in a browser view: it is used
/// for the website KYC page and, only when the server flag `hfCheckoutMode` is "web", the hosted payment page. Tests replace
/// [inApp] and [launcher]. [HF-WIRE-21]
abstract final class Checkout {
  static InAppCheckout inApp = const CashfreeInAppCheckout();
  static Future<bool> Function(Uri url) launcher = _launch;

  static Future<bool> open(String url) async {
    final uri = Uri.tryParse(url);
    if (uri == null || !uri.hasScheme) return false;
    try {
      return await launcher(uri);
    } catch (_) {
      return false;
    }
  }

  static Future<bool> _launch(Uri url) => launchUrl(url, mode: LaunchMode.inAppBrowserView);
}
