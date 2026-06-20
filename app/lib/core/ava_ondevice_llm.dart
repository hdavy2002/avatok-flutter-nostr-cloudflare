/// AvaOnDeviceLlm (Phase A — On-Device AI).
///
/// Thin wrapper around the Cactus `CactusLM` engine running **Qwen3-0.6B fully
/// on-device / offline**. Provides four jobs from ONE loaded model:
///   1. Short, fast chat replies (thinking OFF, token-capped, streamed).
///   2. Intent routing — decide LOCAL (answer on-device) vs CLOUD (escalate to
///      Workers AI) for a request.
///   3. Embeddings — text → vector (used by the on-device RAG store).
///   4. (later) tool-calling — Cactus function-calling is available via params.
///
/// Design rules:
///   • LOCAL ONLY. Completion runs `CompletionMode.local` — never Cactus cloud.
///     Our cloud escalation is a SEPARATE existing path (AvaAiClient → Workers AI
///     via AI Gateway); nothing here calls Cactus hybrid.
///   • Telemetry OFF (`CactusConfig.isTelemetryEnabled = false`).
///   • THINKING OFF. Qwen3 ships with a chain-of-thought "thinking" mode ON by
///     default (the long `<think>…</think>` block + ~10 s latency seen in
///     testing). We disable it two ways for robustness: the Qwen3 `/no_think`
///     soft-switch in the system prompt, AND we strip any `<think>` block from
///     the output as a safety net.
///   • Account-agnostic weights; swappable engine (only this file changes if we
///     move off Cactus).
library;

import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:cactus/cactus.dart';
import 'package:path_provider/path_provider.dart';

import 'ava_log.dart';

enum OnDeviceStatus { idle, downloading, initializing, ready, error }

/// Where a request should be answered.
enum RouteScope { local, cloud }

class RouteDecision {
  final RouteScope scope;
  final String raw; // the model's raw classification token (for debugging/UI)
  const RouteDecision(this.scope, this.raw);
  bool get isLocal => scope == RouteScope.local;
}

class OnDeviceMetrics {
  final double tokensPerSecond;
  final double timeToFirstTokenMs;
  final double totalTimeMs;
  final int totalTokens;
  const OnDeviceMetrics({
    required this.tokensPerSecond,
    required this.timeToFirstTokenMs,
    required this.totalTimeMs,
    required this.totalTokens,
  });
}

class OnDeviceReply {
  final String text;
  final bool ok;
  final OnDeviceMetrics? metrics;
  const OnDeviceReply({required this.text, required this.ok, this.metrics});
}

/// A streamed reply: [stream] emits text chunks for a typewriter UI; [done]
/// completes with the final cleaned reply + metrics.
class OnDeviceStream {
  final Stream<String> stream;
  final Future<OnDeviceReply> done;
  const OnDeviceStream({required this.stream, required this.done});
}

class AvaOnDeviceLlm {
  AvaOnDeviceLlm._();
  static final AvaOnDeviceLlm I = AvaOnDeviceLlm._();

  /// Cactus identifies models by a backend *slug*, which is NOT a simple
  /// transform of the name (e.g. "gemma-3-270m-it" → "gemma3-270m"). So we
  /// RESOLVE the Qwen3.5-0.8B slug at runtime from getModels() and cache it; if
  /// the catalog can't be reached we fall back to this best guess.
  static const String kPreferredSlugGuess = 'qwen3.5-0.8';

  /// The previous model — its on-device weights are deleted on first run of the
  /// new model to reclaim ~400 MB (owner request: switch 0.6B → 0.8B).
  static const String kOldModelSlug = 'qwen3-0.6';

  /// File where the resolved slug is cached so offline cold-starts still load.
  static const String _kSlugCacheFile = 'ava_ondevice_slug.txt';

  /// Resolved Cactus slug for Qwen3.5-0.8B (cached in-memory after first lookup).
  String? _resolvedSlug;

  /// Terse chat persona. `/no_think` disables Qwen3 reasoning so replies are
  /// short and quick. Kept to 1–2 sentences on purpose.
  static const String kChatSystem =
      'You are Ava, a concise on-device assistant. Answer in 1–2 short '
      'sentences. Do not show your reasoning. /no_think';

  /// Router persona — one-word classifier (a 0.6B model is far more reliable
  /// emitting a single token than JSON).
  static const String kRouterSystem =
      'You are an intent classifier for a phone assistant. Decide whether the '
      "user's request can be answered LOCALLY on the device (simple lookups: "
      "finding the user's own emails, photos, files, messages; reminders; quick "
      'facts already in the provided context) or needs the CLOUD (in-depth '
      'explanation, analysis, open-ended discussion, creative writing, or '
      'multi-step reasoning). Reply with ONLY one word: LOCAL or CLOUD. /no_think';

  CactusLM? _lm;

  final ValueNotifier<OnDeviceStatus> status =
      ValueNotifier<OnDeviceStatus>(OnDeviceStatus.idle);
  final ValueNotifier<double> downloadProgress = ValueNotifier<double>(0);
  final ValueNotifier<String> statusLine = ValueNotifier<String>('Not loaded');
  String? lastError;

  bool get isReady =>
      _lm != null &&
      status.value == OnDeviceStatus.ready &&
      (_lm?.isLoaded() ?? false);

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  Future<bool> ensureReady() async {
    if (isReady) return true;
    try {
      CactusConfig.isTelemetryEnabled = false;
      final lm = _lm ??= CactusLM();

      // Reclaim the previous model's ~400 MB before pulling the new one.
      await _purgeOldModel();
      final slug = await _resolveSlug(lm);

      status.value = OnDeviceStatus.downloading;
      statusLine.value = 'Downloading Qwen3.5-0.8B…';
      await lm.downloadModel(
        model: slug,
        downloadProcessCallback: (progress, statusMessage, isError) {
          if (isError) {
            lastError = statusMessage;
            statusLine.value = 'Download error: $statusMessage';
          } else {
            if (progress != null) downloadProgress.value = progress;
            statusLine.value = progress != null
                ? 'Downloading… ${(progress * 100).toStringAsFixed(0)}%'
                : statusMessage;
          }
        },
      );

      status.value = OnDeviceStatus.initializing;
      statusLine.value = 'Loading model into memory…';
      await lm.initializeModel(
        params: CactusInitParams(model: slug, contextSize: 2048),
      );

      status.value = OnDeviceStatus.ready;
      statusLine.value = 'Ready — Qwen3.5-0.8B (on-device)';
      lastError = null;
      AvaLog.I.log('ava_ondevice', 'model ready ($slug)');
      return true;
    } catch (e) {
      lastError = e.toString();
      status.value = OnDeviceStatus.error;
      statusLine.value = 'Error: $e';
      AvaLog.I.log('ava_ondevice', 'ensureReady FAILED: $e');
      return false;
    }
  }

  /// Resolve the Cactus slug for Qwen3.5-0.8B. Order: in-memory cache → on-disk
  /// cache (so offline cold-starts work) → live catalog (getModels) → best-guess
  /// fallback. The chosen slug is persisted on a successful catalog match.
  Future<String> _resolveSlug(CactusLM lm) async {
    if (_resolvedSlug != null) return _resolvedSlug!;

    final cached = await _readCachedSlug();
    if (cached != null && cached.isNotEmpty) {
      _resolvedSlug = cached;
      return cached;
    }

    try {
      final models = await lm.getModels();
      for (final m in models) {
        final hay = '${m.slug} ${m.name}'.toLowerCase();
        // Require 0.8 so we never pick Qwen3.5-2B.
        if (hay.contains('qwen3.5') && hay.contains('0.8')) {
          _resolvedSlug = m.slug;
          await _writeCachedSlug(m.slug);
          AvaLog.I.log('ava_ondevice', 'resolved slug = ${m.slug}');
          return m.slug;
        }
      }
    } catch (e) {
      AvaLog.I.log('ava_ondevice', 'slug resolve failed, using guess: $e');
    }

    _resolvedSlug = kPreferredSlugGuess;
    return _resolvedSlug!;
  }

  /// Delete the old model directory (<AppDocuments>/models/<oldSlug>) to free
  /// disk. Best-effort and idempotent (a no-op once it's gone).
  Future<void> _purgeOldModel() async {
    try {
      final docs = await getApplicationDocumentsDirectory();
      final dir = Directory('${docs.path}/models/$kOldModelSlug');
      if (await dir.exists()) {
        await dir.delete(recursive: true);
        AvaLog.I.log('ava_ondevice', 'deleted old model $kOldModelSlug');
      }
    } catch (e) {
      AvaLog.I.log('ava_ondevice', 'purge old model failed: $e');
    }
  }

  Future<String?> _readCachedSlug() async {
    try {
      final docs = await getApplicationDocumentsDirectory();
      final f = File('${docs.path}/$_kSlugCacheFile');
      if (await f.exists()) return (await f.readAsString()).trim();
    } catch (_) {}
    return null;
  }

  Future<void> _writeCachedSlug(String slug) async {
    try {
      final docs = await getApplicationDocumentsDirectory();
      await File('${docs.path}/$_kSlugCacheFile').writeAsString(slug);
    } catch (_) {}
  }

  void resetContext() {
    try {
      _lm?.reset();
    } catch (_) {}
  }

  void unload() {
    try {
      _lm?.unload();
    } catch (_) {}
    status.value = OnDeviceStatus.idle;
    downloadProgress.value = 0;
    statusLine.value = 'Not loaded';
  }

  // ── Chat (non-streaming) ─────────────────────────────────────────────────────

  Future<OnDeviceReply> ask(
    String prompt, {
    String? system,
    String? context,
    int maxTokens = 96,
    double temperature = 0.3,
  }) async {
    if (!await ensureReady()) {
      return OnDeviceReply(
          text: 'On-device model unavailable: ${lastError ?? 'unknown'}',
          ok: false);
    }
    try {
      final res = await _lm!.generateCompletion(
        messages: _buildMessages(prompt, system: system, context: context),
        params: CactusCompletionParams(
          maxTokens: maxTokens,
          temperature: temperature,
          completionMode: CompletionMode.local,
        ),
      );
      if (!res.success) {
        return const OnDeviceReply(text: 'No response.', ok: false);
      }
      return OnDeviceReply(
        text: stripThink(res.response),
        ok: true,
        metrics: _metrics(res),
      );
    } catch (e) {
      AvaLog.I.log('ava_ondevice', 'ask FAILED: $e');
      return OnDeviceReply(text: 'Error generating reply: $e', ok: false);
    }
  }

  // ── Chat (streaming, for the typewriter UI) ──────────────────────────────────

  /// Stream a reply. Emits cleaned text chunks as they generate; [done]
  /// resolves with the final reply + metrics. On any failure the stream emits
  /// one error line and [done] resolves with ok=false.
  Future<OnDeviceStream> askStream(
    String prompt, {
    String? system,
    String? context,
    int maxTokens = 96,
    double temperature = 0.3,
  }) async {
    if (!await ensureReady()) {
      final msg = 'On-device model unavailable: ${lastError ?? 'unknown'}';
      return OnDeviceStream(
        stream: Stream<String>.value(msg),
        done: Future.value(OnDeviceReply(text: msg, ok: false)),
      );
    }
    try {
      final streamed = await _lm!.generateCompletionStream(
        messages: _buildMessages(prompt, system: system, context: context),
        params: CactusCompletionParams(
          maxTokens: maxTokens,
          temperature: temperature,
          completionMode: CompletionMode.local,
        ),
      );

      // Filter chunks so a stray `<think>` block never shows in the typewriter.
      // We suppress everything until any `</think>` is seen; if no thinking
      // block appears, all chunks pass through.
      final controller = StreamController<String>();
      var inThink = false;
      final buf = StringBuffer();
      final sub = streamed.stream.listen((chunk) {
        buf.write(chunk);
        var out = chunk;
        if (chunk.contains('<think>')) {
          inThink = true;
          out = chunk.substring(0, chunk.indexOf('<think>'));
        }
        if (chunk.contains('</think>')) {
          inThink = false;
          out = chunk.substring(chunk.indexOf('</think>') + '</think>'.length);
        }
        if (!inThink && out.isNotEmpty) controller.add(out);
      }, onError: controller.addError, onDone: () => controller.close());

      final done = streamed.result.then((res) {
        sub.cancel();
        final cleaned = stripThink(buf.isNotEmpty ? buf.toString() : res.response);
        return OnDeviceReply(
          text: cleaned,
          ok: res.success,
          metrics: _metrics(res),
        );
      }).catchError((e) {
        sub.cancel();
        return OnDeviceReply(text: 'Error: $e', ok: false);
      });

      return OnDeviceStream(stream: controller.stream, done: done);
    } catch (e) {
      AvaLog.I.log('ava_ondevice', 'askStream FAILED: $e');
      return OnDeviceStream(
        stream: Stream<String>.value('Error: $e'),
        done: Future.value(OnDeviceReply(text: 'Error: $e', ok: false)),
      );
    }
  }

  // ── Intent routing ───────────────────────────────────────────────────────────

  /// Classify a request as LOCAL (answer on-device) or CLOUD (escalate). Fast +
  /// tiny (one token). Defaults to LOCAL on any ambiguity so we keep cheap
  /// requests off the cloud.
  Future<RouteDecision> route(String request) async {
    if (!await ensureReady()) {
      return const RouteDecision(RouteScope.cloud, 'unavailable');
    }
    try {
      final res = await _lm!.generateCompletion(
        messages: [
          ChatMessage(content: kRouterSystem, role: 'system'),
          ChatMessage(content: request, role: 'user'),
        ],
        params: CactusCompletionParams(
          maxTokens: 8,
          temperature: 0,
          completionMode: CompletionMode.local,
        ),
      );
      final raw = stripThink(res.response).toUpperCase();
      final scope = raw.contains('CLOUD') ? RouteScope.cloud : RouteScope.local;
      return RouteDecision(scope, raw.trim());
    } catch (e) {
      AvaLog.I.log('ava_ondevice', 'route FAILED: $e');
      return const RouteDecision(RouteScope.cloud, 'error');
    }
  }

  // ── Embeddings (for the on-device RAG store) ─────────────────────────────────

  /// Embed [text] → vector. Returns an empty list on failure (callers treat
  /// that as "no vector"). Requires the model to be loaded.
  Future<List<double>> embed(String text) async {
    if (!await ensureReady()) return const [];
    try {
      final res = await _lm!.generateEmbedding(text: text);
      return res.success ? res.embeddings : const [];
    } catch (e) {
      AvaLog.I.log('ava_ondevice', 'embed FAILED: $e');
      return const [];
    }
  }

  // ── helpers ──────────────────────────────────────────────────────────────────

  List<ChatMessage> _buildMessages(String prompt,
      {String? system, String? context}) {
    final sys = (system == null || system.isEmpty) ? kChatSystem : system;
    final user = (context != null && context.isNotEmpty)
        ? 'Context (from the user\'s own device):\n$context\n\nRequest: $prompt'
        : prompt;
    return [
      ChatMessage(content: sys, role: 'system'),
      ChatMessage(content: user, role: 'user'),
    ];
  }

  OnDeviceMetrics _metrics(CactusCompletionResult res) => OnDeviceMetrics(
        tokensPerSecond: res.tokensPerSecond,
        timeToFirstTokenMs: res.timeToFirstTokenMs,
        totalTimeMs: res.totalTimeMs,
        totalTokens: res.totalTokens,
      );

  /// Remove a Qwen3 `<think>…</think>` block (closed or, if the cap cut it off,
  /// unclosed) so only the final answer is shown.
  static String stripThink(String s) {
    var out = s;
    // Closed blocks.
    out = out.replaceAll(RegExp(r'<think>[\s\S]*?</think>', multiLine: true), '');
    // Unclosed leading block (answer never reached): keep nothing before a lone
    // close, or drop a dangling open tag's content.
    final close = out.indexOf('</think>');
    if (close >= 0) out = out.substring(close + '</think>'.length);
    final open = out.indexOf('<think>');
    if (open >= 0) out = out.substring(0, open);
    return out.trim();
  }
}
