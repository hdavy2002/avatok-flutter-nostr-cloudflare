import 'dart:convert';

import '../../core/api_auth.dart';
import '../../core/config.dart';

/// Worker endpoints for live voice translation (routes/translate.ts).
/// Billing language: ALWAYS "Tokens" — never "credits".
class TranslationApi {
  static const String _base = 'https://$kSignalingHost/api/translate';

  static Map<String, dynamic> _j(String b) {
    try { return (jsonDecode(b) as Map).cast<String, dynamic>(); } catch (_) { return {}; }
  }

  /// 5 Tokens/min = $3/hour.
  static const int ratePerMin = 5;

  /// Tokens for [minutes]. Name kept for source compatibility; the unit is
  /// Tokens, and every user-visible string says "Tokens".
  static int quoteCoins(int minutes) => minutes * ratePerMin;

  /// Start a metered session → { session_id, token, mode, ... } or status 402
  /// { error: insufficient_tokens, error_legacy: insufficient_avacoins }
  /// (pop-up #1) / 503 (kill switch). Use [isInsufficientTokens] to read it.
  static Future<Map<String, dynamic>> start({
    required String context, // consult | live | conference
    required String ref,
    required String targetLang,
  }) async {
    final r = await ApiAuth.postJson('$_base/start', {
      'context': context, 'ref': ref, 'target_lang': targetLang,
    }, timeout: const Duration(seconds: 15));
    return {..._j(r.body), 'status': r.statusCode};
  }

  /// Heartbeat — bills the elapsed slices. 402 → pop-up #2 (Tokens utilized).
  static Future<Map<String, dynamic>> beat(String sessionId) async {
    final r = await ApiAuth.postJson('$_base/$sessionId/beat', const {});
    return {..._j(r.body), 'status': r.statusCode};
  }

  /// Stop — per-minute pro-rata true-up server-side.
  static Future<Map<String, dynamic>> stop(String sessionId) async {
    final r = await ApiAuth.postJson('$_base/$sessionId/stop', const {});
    return {..._j(r.body), 'status': r.statusCode};
  }

  /// Fresh ephemeral token for a reconnect.
  static Future<Map<String, dynamic>> token(String sessionId) async {
    final r = await ApiAuth.postJson('$_base/$sessionId/token', const {});
    return {..._j(r.body), 'status': r.statusCode};
  }

  // [CALL-TRANSLATE-1] Separate 1:1 call contract. This never calls the legacy
  // TranslationEngine route, whose billing and source capture are different.
  //
  // [CALL-TRANSLATE-2B-3] `device_nonce` binds token issuance to the device
  // that created the session. It is OPTIONAL on the wire on every route below
  // EXCEPT stop — stopping must never be blockable, so callStop deliberately
  // sends no nonce. A null nonce is omitted rather than sent as null: the
  // Worker validates `^[A-Za-z0-9_.:-]{8,128}$` and 400s on a malformed value.
  /// [CALL-TRANSLATE-2D-4] [warmUp] marks a SPECULATIVE start (Phase C's
  /// language-sheet pre-open). The Worker meters warm-ups in their own hourly
  /// bucket (120/h) separately from real starts (60/h); omitting the flag spends
  /// the real-start budget on speculation, and a payer who browses the language
  /// list a few times then gets a 429 on the tap that mattered.
  ///
  /// 409 carries `{error, session_id, call_ref}` — the session_id is RECOVERABLE
  /// (an abandoned row from a crash or a warm-up whose /stop never landed), not
  /// a dead end. See `_openSession`'s conflict repair.
  static Future<Map<String, dynamic>> callStart({
    required String callRef,
    required String targetLang,
    required String sourceCapability,
    String? deviceNonce,
    bool warmUp = false,
  }) async {
    final r = await ApiAuth.postJson('$_base/call/start', {
      'call_ref': callRef,
      'target_lang': targetLang,
      'source_capability': sourceCapability,
      if (deviceNonce != null) 'device_nonce': deviceNonce,
      if (warmUp) 'warm_up': true,
    }, timeout: const Duration(seconds: 15));
    return {..._j(r.body), 'status': r.statusCode};
  }

  static Future<Map<String, dynamic>> callActivate(
    String id,
    String lease, {
    String? deviceNonce,
  }) async {
    final r = await ApiAuth.postJson('$_base/call/$id/activate', {
      'source_lease': lease, 'source_ready': true,
      if (deviceNonce != null) 'device_nonce': deviceNonce,
    }, timeout: const Duration(seconds: 15));
    return {..._j(r.body), 'status': r.statusCode};
  }

  static Future<Map<String, dynamic>> callRenew(String id, {String? deviceNonce}) async {
    final r = await ApiAuth.postJson('$_base/call/$id/renew', {
      if (deviceNonce != null) 'device_nonce': deviceNonce,
    });
    return {..._j(r.body), 'status': r.statusCode};
  }

  /// Stop takes NO nonce on purpose. A device whose nonce drifted must still be
  /// able to release its session row, and the invariant (original audio always
  /// restored) means stop can never be allowed to fail on an auth check.
  static Future<Map<String, dynamic>> callStop(String id) async {
    final r = await ApiAuth.postJson('$_base/call/$id/stop', const {});
    return {..._j(r.body), 'status': r.statusCode};
  }

  static Future<Map<String, dynamic>> callToken(String id, {String? deviceNonce}) async {
    final r = await ApiAuth.postJson('$_base/call/$id/token', {
      if (deviceNonce != null) 'device_nonce': deviceNonce,
    });
    return {..._j(r.body), 'status': r.statusCode};
  }

  /// [CALL-TRANSLATE-2B-1] Mid-call target-language change on the SAME billing
  /// session (no new session row). Wired for Phase C — the UI that calls this
  /// is not built yet, so nothing invokes it today.
  ///
  /// 200 → { ok, session_id, target_lang, previous_target_lang, token?,
  ///         token_expires_at?, model, rate_per_min, billed_minute, billed_tokens }
  /// 403 device_nonce_mismatch · 409 switch_conflict|call_ended
  /// 502 provider_unavailable — the row is ALREADY updated on 502, so the
  /// caller must stay on the OLD socket and not treat it as a clean rollback.
  static Future<Map<String, dynamic>> callLanguage(
    String id, {
    required String targetLang,
    String? deviceNonce,
    bool mint = true,
  }) async {
    final r = await ApiAuth.postJson('$_base/call/$id/language', {
      'target_lang': targetLang,
      'mint': mint,
      if (deviceNonce != null) 'device_nonce': deviceNonce,
    }, timeout: const Duration(seconds: 15));
    return {..._j(r.body), 'status': r.statusCode};
  }

  /// [CALL-TRANSLATE-2B-4] The 402 body carries `error: "insufficient_tokens"`
  /// with `error_legacy: "insufficient_avacoins"` for one release cycle. Read
  /// BOTH: a client shipped before the rename is still in the field, and a
  /// Worker rolled back would still send only the legacy key.
  ///
  /// [CALL-TRANSLATE-2D-4] The 402 body now also carries `paid_only: true`,
  /// `rate_per_min`, `balance` (PAID balance) and `spendable` (free+bonus+paid),
  /// with `reason` = `paid_balance_required` or `balance_exhausted`. Call
  /// translation is PAID-ONLY by owner decision (2026-08-04), so `spendable >
  /// balance` means the user genuinely holds tokens that this feature cannot
  /// spend — the copy must say "top up", never "you have no tokens".
  static bool isInsufficientTokens(Map<String, dynamic> body) {
    const hits = {'insufficient_tokens', 'insufficient_avacoins'};
    return hits.contains(body['error']?.toString()) ||
        hits.contains(body['error_legacy']?.toString());
  }
}
