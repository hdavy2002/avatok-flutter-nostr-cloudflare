import 'dart:convert';
import 'dart:math';

import 'api_auth.dart';
import 'config.dart';

/// MoneyApi (Phase 2, audit A1) — wrapper for every MUTATING money endpoint.
/// Auto-attaches an `Idempotency-Key` (one fresh UUID per logical tap) and
/// retries safely on timeout with the SAME key, so a double-tap or a flaky
/// network can never double-charge: the server replays the stored response.
class MoneyApi {
  static String _uuid() {
    final r = Random.secure();
    String h(int n) => List<int>.generate(n, (_) => r.nextInt(256))
        .map((b) => b.toRadixString(16).padLeft(2, '0'))
        .join();
    return '${h(4)}-${h(2)}-${h(2)}-${h(2)}-${h(6)}';
  }

  static Map<String, dynamic> _json(String body) {
    try { return jsonDecode(body) as Map<String, dynamic>; } catch (_) { return {}; }
  }

  /// POST with idempotency key + one safe retry on timeout/network error.
  static Future<Map<String, dynamic>> _post(String url, Map<String, dynamic> body) async {
    final key = _uuid();
    for (var attempt = 0; ; attempt++) {
      try {
        final res = await ApiAuth.postJsonH(url, body, {'Idempotency-Key': key});
        final j = _json(res.body);
        if (j.isEmpty && res.statusCode >= 400) return {'error': 'http ${res.statusCode}'};
        return {...j, 'status': res.statusCode};
      } catch (_) {
        if (attempt >= 1) return {'error': 'network'};
        // Retry once with the SAME key — server-side replay, never re-executed.
      }
    }
  }

  // ── wallet ────────────────────────────────────────────────────────────────
  static Future<Map<String, dynamic>> balance() async =>
      _json((await ApiAuth.getSigned('$kWalletBase/balance')).body);

  /// Top-up any amount (USD cents == coins). Returns {checkout_url} or
  /// {error, reason:'pending_legal_approval'} while the legal flag is off.
  /// (Legacy hosted-Checkout path; the app now uses [topupIntent] instead.)
  static Future<Map<String, dynamic>> topup(int amountUsdCents) =>
      _post('$kWalletBase/topup', {'amountUsdCents': amountUsdCents});

  /// Create a Stripe PaymentIntent for the NATIVE in-app PaymentSheet (no browser
  /// redirect). [usdCents] is the real money amount in USD cents; the server is
  /// the single source of truth for the USD→coins conversion. Returns
  /// {payment_intent_client_secret, publishable_key, coins, cents} on success, or
  /// {error, reason:'pending_legal_approval'} while the legal flag is off.
  static Future<Map<String, dynamic>> topupIntent(int usdCents) =>
      _post('$kWalletBase/topup/intent', {'usd_cents': usdCents});

  /// Verify a Google Play top-up purchase server-side and credit Tokens. The
  /// server maps [productId] → Tokens (never trusts a client amount) and dedupes
  /// on Google's orderId, so replays/double-taps credit exactly once. Returns
  /// {ok, credited/coins, balance} on success, or {ok:false, reason} otherwise.
  static Future<Map<String, dynamic>> topupPlayVerify(String productId, String purchaseToken) =>
      _post('$kWalletBase/topup/play/verify', {'productId': productId, 'purchaseToken': purchaseToken});

  /// Keyset-paginated double-entry statement with server-side filters.
  static Future<Map<String, dynamic>> ledger({
    String? cursor, int limit = 50, List<String> types = const [], int? from, int? to, String? q,
  }) async {
    final p = <String, String>{
      'limit': '$limit',
      if (cursor != null && cursor.isNotEmpty) 'cursor': cursor,
      if (types.isNotEmpty) 'type': types.join(','),
      if (from != null) 'from': '$from',
      if (to != null) 'to': '$to',
      if (q != null && q.trim().isNotEmpty) 'q': q.trim(),
    };
    final qs = p.entries.map((e) => '${e.key}=${Uri.encodeQueryComponent(e.value)}').join('&');
    return _json((await ApiAuth.getSigned('$kWalletBase/ledger?$qs')).body);
  }

  static Future<Map<String, dynamic>> ledgerDetail(String id) async =>
      _json((await ApiAuth.getSigned('$kWalletBase/ledger/$id')).body);

  static Future<Map<String, dynamic>> resendReceipt(String id) =>
      _post('$kWalletBase/ledger/$id/receipt', const {});

  // ── admin money console (server enforces ADMIN_UIDS; 403 otherwise) ──────
  static Future<bool> isAdmin() async {
    try { return (await ApiAuth.getSigned('$kApiBase/admin/recon')).statusCode == 200; } catch (_) { return false; }
  }

  static Future<Map<String, dynamic>> adminAccount(String uid) async =>
      _json((await ApiAuth.getSigned('$kApiBase/admin/account/$uid')).body);
  static Future<Map<String, dynamic>> adminLedger({String? user, String? ref}) async =>
      _json((await ApiAuth.getSigned('$kApiBase/admin/ledger?user=${Uri.encodeQueryComponent(user ?? '')}&ref=${Uri.encodeQueryComponent(ref ?? '')}')).body);
  static Future<Map<String, dynamic>> adminRefund({required String orderId, required int amount, required String reason}) =>
      _post('$kApiBase/admin/refund', {'orderId': orderId, 'amount': amount, 'reason': reason});
  static Future<Map<String, dynamic>> adminAdjust({required String account, required int amount, required String reason}) =>
      _post('$kApiBase/admin/adjust', {'account': account, 'amount': amount, 'reason': reason});
  static Future<Map<String, dynamic>> adminRecon() async =>
      _json((await ApiAuth.getSigned('$kApiBase/admin/recon')).body);
}
