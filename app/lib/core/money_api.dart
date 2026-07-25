import 'dart:convert';
import 'dart:math';

import 'package:http/http.dart' as http;

import 'analytics.dart';
import 'api_auth.dart';
import 'config.dart';

/// [WALLET-GET-STATE-1] Coarse classification of a GET result, independent of
/// the raw HTTP status — this is what callers should branch on, not the number.
/// `none` also covers a genuine 200 with a zero balance: that is NOT an error,
/// it is a fact, and must never be conflated with `transport`/`auth`/`server`.
enum MoneyApiErrorClass { none, transport, auth, server, client }

/// Typed result of a money GET. Replaces the old pattern of silently coercing
/// every failure (401, 500, a Cloudflare HTML error page, a timeout) to `{}`,
/// which is indistinguishable from "the server truly returned nothing" and is
/// exactly how a flaky network got read as "not premium" / "0 tokens" (see
/// Root-Cause Report §17).
class MoneyApiResult {
  /// True only for a genuine 200 with a JSON body — the one case a caller may
  /// trust [data] as authoritative.
  final bool ok;
  /// Real HTTP status, or 0 when the request never got a response (transport
  /// failure — DNS, timeout, thrown exception).
  final int status;
  final Map<String, dynamic> data;
  final MoneyApiErrorClass errorClass;
  const MoneyApiResult({
    required this.ok,
    required this.status,
    required this.data,
    required this.errorClass,
  });

  static const MoneyApiResult transportFailure = MoneyApiResult(
      ok: false, status: 0, data: {}, errorClass: MoneyApiErrorClass.transport);
}

/// MoneyApi (Phase 2, audit A1) — wrapper for every money endpoint.
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

  /// Test-only network seam for [_get]. When set, `_get` calls this instead of
  /// `ApiAuth.getSigned` — mirrors the function-pointer injection pattern
  /// already used in this codebase (`ApiAuth.clerkBearer`, `onAuthExpired`),
  /// so `app/test/wallet_entitlement_test.dart` can exercise the status/
  /// error-class logic without a live network. Throw from the override to
  /// simulate a transport failure. Tests MUST reset this to null afterward.
  static Future<http.Response> Function(String url)? debugGetOverride;

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

  /// [WALLET-GET-STATE-1] Shared GET wrapper: preserves HTTP status for both
  /// JSON and non-JSON responses (a Cloudflare/edge HTML error page no longer
  /// silently reads as an empty-but-successful body), and classifies the
  /// result so callers can distinguish "the server said no" (auth/client),
  /// "the server is broken" (server), and "we never heard back" (transport)
  /// from a genuine, trustworthy answer. Never throws.
  static Future<MoneyApiResult> _get(String url) async {
    final endpoint = Uri.parse(url).path;
    try {
      final res = debugGetOverride != null
          ? await debugGetOverride!(url)
          : await ApiAuth.getSigned(url);
      final status = res.statusCode;
      Map<String, dynamic> data;
      bool parsed = true;
      try {
        data = jsonDecode(res.body) as Map<String, dynamic>;
      } catch (_) {
        data = const {};
        parsed = false;
      }
      final MoneyApiErrorClass cls;
      final ok = status == 200 && parsed;
      if (ok) {
        cls = MoneyApiErrorClass.none;
      } else if (status == 401 || status == 403) {
        cls = MoneyApiErrorClass.auth;
      } else if (status >= 500 || !parsed) {
        // A 5xx, OR a 2xx/edge response that ISN'T JSON (gateway/HTML error
        // page) — both mean "cannot trust this response", never "zero".
        cls = MoneyApiErrorClass.server;
      } else {
        cls = MoneyApiErrorClass.client;
      }
      _emitGetTelemetry(endpoint, status, cls);
      return MoneyApiResult(ok: ok, status: status, data: data, errorClass: cls);
    } catch (_) {
      // Transport failure — DNS, timeout, thrown exception. ApiAuth._tracked
      // already fires the generic apiError(status:0); this adds the money-
      // specific classification a caller actually branches on.
      _emitGetTelemetry(endpoint, 0, MoneyApiErrorClass.transport);
      return MoneyApiResult.transportFailure;
    }
  }

  static void _emitGetTelemetry(String endpoint, int status, MoneyApiErrorClass cls) {
    try {
      // No secrets, no body — endpoint + status/error class + whatever account
      // identifier Analytics already attaches to every event (account_id,
      // clerk_uid, email — see Analytics._base).
      Analytics.capture('money_get_result', {
        'endpoint': endpoint,
        'status': status,
        'error_class': cls.name,
      });
    } catch (_) {/* telemetry must never break a read */}
  }

  // ── wallet ────────────────────────────────────────────────────────────────

  /// Canonical typed wallet-balance read. Use this — not [balance] — for any
  /// entitlement/affordability decision. See `core/wallet_entitlement.dart`.
  static Future<MoneyApiResult> balanceResult() => _get('$kWalletBase/balance');

  @Deprecated('Use balanceResult() — this silently coerces every failure '
      '(401/500/timeout/non-JSON) to {}, which is how a flaky network got '
      'read as "not premium" / "0 tokens". [WALLET-GET-STATE-1]')
  static Future<Map<String, dynamic>> balance() async => (await balanceResult()).data;

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
      (await _get(
              '$kWalletBase/topup-quote${country == null ? '' : '?country=${Uri.encodeQueryComponent(country)}'}'))
          .data;

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
    return (await _get('$kWalletBase/ledger?$qs')).data;
  }

  static Future<Map<String, dynamic>> ledgerDetail(String id) async =>
      (await _get('$kWalletBase/ledger/$id')).data;

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
    return (await _get('$kWalletBase/statement?$qs')).data;
  }

  /// [WALLET-COCKPIT-1] Cockpit aggregates over the last [days] days: balance,
  /// earned/spent totals, per-feature breakdown, burn/day, runway, AI minutes.
  /// [WALLET-REDESIGN-1] `tzOffsetMin` (minutes east of UTC, e.g. 330 for IST)
  /// makes the server bucket `daily_spend` by the user's LOCAL day, so the
  /// 7-day bar chart doesn't attribute late-night spend to the wrong bar.
  /// Also returns `by_category` (donut) alongside the existing `by_feature`.
  static Future<Map<String, dynamic>> summary({int days = 30, int? tzOffsetMin}) async =>
      (await _get(
        '$kWalletBase/summary?days=$days${tzOffsetMin != null ? '&tz_offset_min=$tzOffsetMin' : ''}',
      )).data;

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
      (await _get('$kApiBase/admin/account/$uid')).data;
  static Future<Map<String, dynamic>> adminLedger({String? user, String? ref}) async =>
      (await _get('$kApiBase/admin/ledger?user=${Uri.encodeQueryComponent(user ?? '')}&ref=${Uri.encodeQueryComponent(ref ?? '')}')).data;
  static Future<Map<String, dynamic>> adminRefund({required String orderId, required int amount, required String reason}) =>
      _post('$kApiBase/admin/refund', {'orderId': orderId, 'amount': amount, 'reason': reason});
  static Future<Map<String, dynamic>> adminAdjust({required String account, required int amount, required String reason}) =>
      _post('$kApiBase/admin/adjust', {'account': account, 'amount': amount, 'reason': reason});
  static Future<Map<String, dynamic>> adminRecon() async =>
      (await _get('$kApiBase/admin/recon')).data;
}
