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

  static int quoteCoins(int minutes) => minutes * ratePerMin;

  /// Start a metered session → { session_id, token, mode, ... } or
  /// status 402 { error: insufficient_avacoins } (pop-up #1) / 503 (kill switch).
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
  static Future<Map<String, dynamic>> callStart({
    required String callRef,
    required String targetLang,
    required String sourceCapability,
  }) async {
    final r = await ApiAuth.postJson('$_base/call/start', {
      'call_ref': callRef,
      'target_lang': targetLang,
      'source_capability': sourceCapability,
    }, timeout: const Duration(seconds: 15));
    return {..._j(r.body), 'status': r.statusCode};
  }

  static Future<Map<String, dynamic>> callActivate(String id, String lease) async {
    final r = await ApiAuth.postJson('$_base/call/$id/activate', {
      'source_lease': lease, 'source_ready': true,
    }, timeout: const Duration(seconds: 15));
    return {..._j(r.body), 'status': r.statusCode};
  }

  static Future<Map<String, dynamic>> callRenew(String id) async {
    final r = await ApiAuth.postJson('$_base/call/$id/renew', const {});
    return {..._j(r.body), 'status': r.statusCode};
  }

  static Future<Map<String, dynamic>> callStop(String id) async {
    final r = await ApiAuth.postJson('$_base/call/$id/stop', const {});
    return {..._j(r.body), 'status': r.statusCode};
  }

  static Future<Map<String, dynamic>> callToken(String id) async {
    final r = await ApiAuth.postJson('$_base/call/$id/token', const {});
    return {..._j(r.body), 'status': r.statusCode};
  }
}
