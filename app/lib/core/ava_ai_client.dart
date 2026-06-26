import 'dart:convert';

import 'package:http/http.dart' as http;

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
    String? source,
    List<Map<String, String>>? history,
    Duration timeout = const Duration(seconds: 30),
  }) async {
    final body = <String, dynamic>{
      'message': message,
      if (context != null && context.isNotEmpty) 'context': context,
      if (mode != null && mode.isNotEmpty) 'mode': mode,
      if (source != null && source.isNotEmpty) 'source': source,
      if (history != null && history.isNotEmpty) 'history': history,
    };
    // Client-measured round-trip so we can compare it to the server's own
    // breakdown (timings.*) and tell network latency apart from model latency.
    final reqStart = DateTime.now().millisecondsSinceEpoch;

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
          clientMs: DateTime.now().millisecondsSinceEpoch - reqStart,
        );
      }
      final clientMs = DateTime.now().millisecondsSinceEpoch - reqStart;
      final tm = (j['timings'] as Map?)?.cast<String, dynamic>();
      return AvaAnswer(
        answer: (j['answer'] as String?) ?? '',
        blocked: j['blocked'] == true,
        reason: j['reason'] as String?,
        remaining: (j['remaining'] as num?)?.toInt(),
        tier: j['tier'] as String?,
        images: (j['images'] as List?)?.map((e) => e.toString()).toList() ?? const [],
        clientMs: clientMs,
        serverMs: (tm?['total_ms'] as num?)?.toInt(),
        genMs: (tm?['gen_ms'] as num?)?.toInt(),
        setupMs: (tm?['setup_ms'] as num?)?.toInt(),
        toolCalls: (tm?['tool_calls'] as num?)?.toInt(),
      );
    } catch (e) {
      return AvaAnswer(
        answer: 'Ava could not be reached. Check your connection and try again.',
        blocked: true,
        reason: 'network',
        clientMs: DateTime.now().millisecondsSinceEpoch - reqStart,
      );
    }
  }

  /// Streaming companion chat — yields text deltas as the worker's SSE endpoint
  /// (`/api/ava/gemini/stream`) produces them, so the UI types the answer out
  /// LIVE (feels far faster). Throws on any failure so the caller can fall back
  /// to [ask]. Same signed-auth + optional BYO key as [ask].
  /// [onImage] fires for each AI-generated image URL the worker streams as a
  /// `{image:url}` SSE event (ChatAVA image generation). [onImagePending] fires on
  /// `{image_pending:true}` (show a "generating…" placeholder); [onImageFailed]
  /// fires on `{image_failed:true}` (clear the placeholder).
  Stream<String> askStream({
    required String message,
    String? context,
    List<Map<String, String>>? history,
    void Function(String url)? onImage,
    void Function()? onImagePending,
    void Function()? onImageFailed,
    Duration timeout = const Duration(seconds: 60),
  }) async* {
    final body = <String, dynamic>{
      'message': message,
      if (context != null && context.isNotEmpty) 'context': context,
      if (history != null && history.isNotEmpty) 'history': history,
    };
    final extra = <String, String>{};
    final key = await _store.apiKey();
    if (key != null && key.isNotEmpty) extra['X-Ava-Gemini-Key'] = key;

    final url = '$_url/stream';
    final bytes = utf8.encode(jsonEncode(body));
    final headers = await ApiAuth.signedHeaders('POST', url, body: bytes, extra: extra);

    final client = http.Client();
    try {
      final req = http.Request('POST', Uri.parse(url))
        ..headers.addAll(headers)
        ..bodyBytes = bytes;
      final resp = await client.send(req).timeout(timeout);
      if (resp.statusCode != 200) {
        throw Exception('stream http ${resp.statusCode}');
      }
      final lines = resp.stream.transform(utf8.decoder).transform(const LineSplitter());
      await for (final line in lines) {
        final t = line.trim();
        if (!t.startsWith('data:')) continue;
        final payload = t.substring(5).trim();
        if (payload.isEmpty || payload == '[DONE]') continue;
        try {
          final j = jsonDecode(payload) as Map<String, dynamic>;
          final delta = j['delta'] as String?;
          if (delta != null && delta.isNotEmpty) yield delta;
          final img = j['image'] as String?;
          if (img != null && img.isNotEmpty) onImage?.call(img);
          if (j['image_pending'] == true) onImagePending?.call();
          if (j['image_failed'] == true) onImageFailed?.call();
        } catch (_) {/* skip a malformed SSE line */}
      }
    } finally {
      client.close();
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
    this.images = const [],
    this.clientMs,
    this.serverMs,
    this.genMs,
    this.setupMs,
    this.toolCalls,
  });

  /// Client-measured total round-trip in ms (request send → response parsed).
  final int? clientMs;

  /// Server-reported total handler time in ms (`timings.total_ms`).
  final int? serverMs;

  /// Server-reported model+gate time in ms (`timings.gen_ms`) — the big one when
  /// the model itself is slow.
  final int? genMs;

  /// Server-reported setup time in ms (email + premium resolve).
  final int? setupMs;

  /// How many agentic tool round-trips the turn took. >0 on a composer tool
  /// (translate/rewrite/…) is a red flag — those should be a single shot.
  final int? toolCalls;

  /// AI-generated image URLs produced this turn (ChatAVA image generation).
  final List<String> images;

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
