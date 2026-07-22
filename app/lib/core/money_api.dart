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

  /// [TOKENS-FX-1] Region-aware top-up quote (server decides from edge geo;
  /// [country] is a testing override): {country, currency: 'INR'|'USD',
  /// tokens_per_unit, min_amount, presets: [{amount, tokens}], fx_usd_rate,
  /// note}. India → INR fixed 1 Token = ₹1 (min ₹100); everywhere else → USD
  /// (1 USD = 100 Tokens, min $1).
  static Future<Map<String, dynamic>> topupQuote({String? country}) async =>
      _json((await ApiAuth.getSigned(
              '$kWalletBase/topup-quote${country == null ? '' : '?country=${Uri.encodeQueryComponent(country)}'}'))
          .body);

  /// Create a Stripe PaymentIntent for the NATIVE in-app PaymentSheet (no browser
  /// redirect). [amountMinor] is the real money amount in MINOR units of
  /// [currency] (USD cents, or paise for India's fixed ₹1/Token pricing); the
  /// server is the single source of truth for the money→Tokens conversion.
  /// Returns {payment_intent_client_secret, publishable_key, coins, cents,
  /// currency} on success, or {error, reason:'pending_legal_approval'} while the
  /// legal flag is off.
  static Future<Map<String, dynamic>> topupIntent(int amountMinor, {String currency = 'usd'}) =>
      _post('$kWalletBase/topup/intent', {
        'amount_minor': amountMinor,
        'currency': currency,
        // Legacy field for an older server — USD only, so an old server can
        // never misread INR paise as USD cents.
        if (currency == 'usd') 'usd_cents': amountMinor,
      });

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

  /// [WALLET-COCKPIT-1] Human-labeled statement feed (wallet_transactions):
  /// each entry = {id, ts, type, direction, feature_key, label, tokens (signed),
  /// balance_after?, ref}. Keyset cursor pagination, newest first.
  static Future<Map<String, dynamic>> statement({
    String? cursor, int limit = 50, String? direction, int? from, int? to, String? q,
  }) async {
    final p = <String, String>{
      'limit': '$limit',
      if (cursor != null && cursor.isNotEmpty) 'cursor': cursor,
      if (direction != null && direction.isNotEmpty) 'direction': direction,
      if (from != null) 'from': '$from',
      if (to != null) 'to': '$to',
      if (q != null && q.trim().isNotEmpty) 'q': q.trim(),
    };
    final qs = p.entries.map((e) => '${e.key}=${Uri.encodeQueryComponent(e.value)}').join('&');
    return _json((await ApiAuth.getSigned('$kWalletBase/statement?$qs')).body);
  }

  /// [WALLET-COCKPIT-1] Cockpit aggregates over the last [days] days: balance,
  /// earned/spent totals, per-feature breakdown, burn/day, runway, AI minutes.
  /// [WALLET-REDESIGN-1] `tzOffsetMin` (minutes east of UTC, e.g. 330 for IST)
  /// makes the server bucket `daily_spend` by the user's LOCAL day, so the
  /// 7-day bar chart doesn't attribute late-night spend to the wrong bar.
  /// Also returns `by_category` (donut) alongside the existing `by_feature`.
  static Future<Map<String, dynamic>> summary({int days = 30, int? tzOffsetMin}) async =>
      _json((await ApiAuth.getSigned(
        '$kWalletBase/summary?days=$days${tzOffsetMin != null ? '&tz_offset_min=$tzOffsetMin' : ''}',
      )).body);

  /// [WALLET-REDESIGN-1] CSV statement for a date window — backs the export
  /// sheet (share / save / email). Returns the raw CSV body.
  static Future<String> statementCsv({required int from, required int to, int? tzOffsetMin}) async {
    final qs = 'from=$from&to=$to&format=csv'
        '${tzOffsetMin != null ? '&tz_offset_min=$tzOffsetMin' : ''}';
    final r = await ApiAuth.getSigned('$kWalletBase/statement/export?$qs');
    return r.body;
  }

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
