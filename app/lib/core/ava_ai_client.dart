import 'dart:convert';

import 'api_auth.dart';
import 'ava_ai_store.dart';
import 'ava_contracts.dart';
import 'config.dart';

/// AvaAiClient (Phase 2 — BYO-AI Proxy + Moderation Gate).
///
/// The client ALWAYS calls the AvaTok Worker ([AvaApi.gemini]) — NEVER Google
/// directly — so the server-side moderation gate (llama-guard in/out) and the
/// daily-turn cap always apply.
///
/// When the user has connected their own Gemini key ([AvaAiStore.isConnected]),
/// we send that key to the Worker over TLS per-request (header `X-Ava-Gemini-Key`).
/// The Worker uses it to call Google Gemini for that one request and does NOT
/// store it. Without a connected key the Worker falls back to its own (cheap,
/// daily-capped) Workers-AI model. Either way auth is the standard authed-HTTP
/// path ([ApiAuth] — NIP-98 + optional Clerk bearer), same as every other call.
class AvaAiClient {
  AvaAiClient._();
  static final AvaAiClient I = AvaAiClient._();

  final AvaAiStore _store = AvaAiStore();

  /// Full URL for the Gemini proxy route. Built from the API origin + the
  /// Phase-0 [AvaApi.gemini] path so the client never re-declares the path
  /// (mirrors AvaTurnController._turnUrl).
  static String get _url {
    final origin = kApiBase.endsWith('/api')
        ? kApiBase.substring(0, kApiBase.length - '/api'.length)
        : kApiBase;
    return '$origin${AvaApi.gemini}';
  }

  /// Ask Ava a one-shot question (open chat / companion path). Returns an
  /// [AvaAnswer]; `blocked` is true when the gate refused (moderation or cap).
  ///
  /// [context] is optional grounding text. [history] is an optional prior
  /// turn list `[{role:'user'|'model', text:...}]` for multi-turn. [mode] can
  /// pass a specific `gemini-*` model id for BYO users (ignored for our-keys).
  Future<AvaAnswer> ask({
    required String message,
    String? context,
    String? mode,
    List<Map<String, String>>? history,
    Duration timeout = const Duration(seconds: 30),
  }) async {
    final body = <String, dynamic>{
      'message': message,
      if (context != null && context.isNotEmpty) 'context': context,
      if (mode != null && mode.isNotEmpty) 'mode': mode,
      if (history != null && history.isNotEmpty) 'history': history,
    };

    // Send the BYO key per-request when connected. Header (not body) keeps it
    // out of any body-logging path; the Worker reads `X-Ava-Gemini-Key` first.
    final extraHeaders = <String, String>{};
    final key = await _store.apiKey();
    if (key != null && key.isNotEmpty) extraHeaders['X-Ava-Gemini-Key'] = key;

    try {
      final res = await ApiAuth.postJsonH(_url, body, extraHeaders, timeout: timeout);
      final ok = res.statusCode == 200;
      Map<String, dynamic> j;
      try {
        j = jsonDecode(res.body) as Map<String, dynamic>;
      } catch (_) {
        j = const {};
      }
      if (!ok && j.isEmpty) {
        return AvaAnswer(
          answer: 'Ava is unavailable right now (${res.statusCode}). Please try again.',
          blocked: true,
          reason: 'http_${res.statusCode}',
        );
      }
      return AvaAnswer(
        answer: (j['answer'] as String?) ?? '',
        blocked: j['blocked'] == true,
        reason: j['reason'] as String?,
        remaining: (j['remaining'] as num?)?.toInt(),
        tier: j['tier'] as String?,
      );
    } catch (e) {
      return AvaAnswer(
        answer: 'Ava could not be reached. Check your connection and try again.',
        blocked: true,
        reason: 'network',
      );
    }
  }

  /// Whether the user has connected a BYO key (full features, uncapped).
  Future<bool> isByoConnected() => _store.isConnected();
}

/// The result of an [AvaAiClient.ask] call.
class AvaAnswer {
  const AvaAnswer({
    required this.answer,
    this.blocked = false,
    this.reason,
    this.remaining,
    this.tier,
  });

  /// Ava's reply text (a safe refusal/notice when [blocked]).
  final String answer;

  /// True when the server gate refused (moderation, daily cap, or AI disabled).
  final bool blocked;

  /// Machine reason when blocked: 'input_unsafe' | 'output_unsafe' | 'daily_cap'
  /// | 'ai_disabled' | 'http_<code>' | 'network'.
  final String? reason;

  /// Turns left today on the capped our-keys free tier (null for BYO/premium).
  final int? remaining;

  /// Which tier served this turn: 'byo' | 'ourkeys'.
  final String? tier;

  bool get hitDailyCap => reason == 'daily_cap';
}
