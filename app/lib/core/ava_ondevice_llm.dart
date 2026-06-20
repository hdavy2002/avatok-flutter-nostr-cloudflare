/// AvaOnDeviceLlm (Phase A — On-Device AI).
///
/// Wrapper around the Cactus `CactusLM` engine running an on-device model fully
/// offline. One loaded model serves chat, intent routing, embeddings, and (for a
/// vision model) image understanding.
///
/// MODEL CHOICE (learned the hard way, confirmed by on-device telemetry):
/// Qwen3.5-0.8B does NOT run on the Cactus Flutter 1.3.0 engine — its native core
/// (Dec 2025) has no loader for that linear-attention architecture, so
/// `cactus_init` returns null even with weights + config.json present. That's why
/// the Cactus catalog never offered it to the Flutter SDK. So we use models the
/// shipped engine actually supports, loaded via the normal catalog:
///   1. PRIMARY  `lfm2-vl-450m` — Cactus's own vision model (chat + vision +
///      embeddings). Gives Phase 1 AND image understanding.
///   2. FALLBACK `qwen3-0.6`    — text-only, but PROVEN to load on-device. Ensures
///      we always end with a working model if the vision model can't load.
/// The first that initializes wins; [activeSlug] reflects which one loaded.
///
/// Design rules: LOCAL ONLY (never Cactus cloud), telemetry OFF, thinking-off
/// prompt + `<think>` stripped, account-agnostic weights, swappable engine.
library;

import 'dart:async';
import 'dart:io';

import 'package:cactus/cactus.dart';
import 'package:flutter/foundation.dart';

import 'analytics.dart';
import 'ava_log.dart';

enum OnDeviceStatus { idle, downloading, initializing, ready, error }

enum RouteScope { local, cloud }

class RouteDecision {
  final RouteScope scope;
  final String raw;
  const RouteDecision(this.scope, this.raw);
  bool get isLocal => scope == RouteScope.local;
}

/// A candidate on-device model (slug + display label + whether it sees images).
class OnDeviceModel {
  final String slug;
  final String label;
  final bool vision;
  const OnDeviceModel(this.slug, this.label, {this.vision = false});
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

class OnDeviceStream {
  final Stream<String> stream;
  final Future<OnDeviceReply> done;
  const OnDeviceStream({required this.stream, required this.done});
}

class AvaOnDeviceLlm {
  AvaOnDeviceLlm._();
  static final AvaOnDeviceLlm I = AvaOnDeviceLlm._();

  /// Models to try, in order. First that initializes wins.
  static const List<OnDeviceModel> kCandidates = <OnDeviceModel>[
    OnDeviceModel('lfm2-vl-450m', 'LFM2-VL-450M (vision)', vision: true),
    OnDeviceModel('qwen3-0.6', 'Qwen3-0.6B', vision: false),
  ];

  static const String kChatSystem =
      'You are Ava, a concise on-device assistant. Answer in 1–2 short '
      'sentences. Do not show your reasoning. /no_think';

  static const String kRouterSystem =
      'You are an intent classifier for a phone assistant. Decide whether the '
      "user's request can be answered LOCALLY on the device (simple lookups: "
      "finding the user's own emails, photos, files, messages; reminders; quick "
      'facts already in the provided context) or needs the CLOUD (in-depth '
      'explanation, analysis, open-ended discussion, creative writing, or '
      'multi-step reasoning). Reply with ONLY one word: LOCAL or CLOUD. /no_think';

  CactusLM? _lm;

  /// The model that actually loaded (slug), and its label / vision capability.
  String? activeSlug;
  OnDeviceModel? activeModel;

  final ValueNotifier<OnDeviceStatus> status =
      ValueNotifier<OnDeviceStatus>(OnDeviceStatus.idle);
  final ValueNotifier<double> downloadProgress = ValueNotifier<double>(0);
  final ValueNotifier<String> statusLine = ValueNotifier<String>('Not loaded');
  String? lastError;

  /// Human-readable diagnostics from the last load attempt (per-model errors +
  /// device memory). Shown on the error card AND sent to PostHog (with the user's
  /// email via the Analytics envelope) so a failed load is debuggable remotely.
  String lastDiag = '';

  bool get isReady =>
      _lm != null &&
      status.value == OnDeviceStatus.ready &&
      (_lm?.isLoaded() ?? false);

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  Future<bool> ensureReady() async {
    if (isReady) return true;
    final sw = Stopwatch()..start();
    try {
      CactusConfig.isTelemetryEnabled = false;
      final lm = _lm ??= CactusLM();

      await Analytics.capture('ondevice_load_start', {
        'candidates': kCandidates.map((c) => c.slug).join(','),
        'mem': await _memInfo(),
      });

      final diag = StringBuffer();
      for (final cand in kCandidates) {
        try {
          // 1) Download via the Cactus catalog (idempotent — skips if present).
          status.value = OnDeviceStatus.downloading;
          statusLine.value = 'Downloading ${cand.label}…';
          downloadProgress.value = 0;
          await lm.downloadModel(
            model: cand.slug,
            downloadProcessCallback: (progress, statusMessage, isError) {
              if (isError) {
                statusLine.value = 'Download error: $statusMessage';
              } else {
                if (progress != null) downloadProgress.value = progress;
                statusLine.value = progress != null
                    ? '${cand.label}: ${(progress * 100).toStringAsFixed(0)}%'
                    : statusMessage;
              }
            },
          );

          // 2) Initialize. Throws if the engine can't load this architecture.
          status.value = OnDeviceStatus.initializing;
          statusLine.value = 'Loading ${cand.label}…';
          await Analytics.capture('ondevice_init_start', {
            'slug': cand.slug,
            'mem': await _memInfo(),
          });
          await lm.initializeModel(
            params: CactusInitParams(model: cand.slug, contextSize: 2048),
          );

          if (lm.isLoaded()) {
            activeSlug = cand.slug;
            activeModel = cand;
            status.value = OnDeviceStatus.ready;
            statusLine.value = 'Ready — ${cand.label} (on-device)';
            lastError = null;
            await Analytics.capture('ondevice_init_ok', {
              'slug': cand.slug,
              'vision': cand.vision,
              'ms': sw.elapsedMilliseconds,
            });
            AvaLog.I.log('ava_ondevice', 'model ready (${cand.slug})');
            return true;
          }
          diag.writeln('${cand.slug}: init returned no handle');
        } catch (e) {
          diag.writeln('${cand.slug}: $e');
          await Analytics.error(
            domain: 'ondevice_ai',
            code: 'model_attempt_failed',
            message: e.toString(),
            action: 'ensureReady',
            extra: {'slug': cand.slug, 'mem': await _memInfo()},
          );
          AvaLog.I.log('ava_ondevice', 'attempt ${cand.slug} FAILED: $e');
        }
      }

      // Nothing loaded.
      lastDiag = '${diag.toString().trim()}\nmem: ${await _memInfo()}';
      throw Exception(
          'No on-device model could load. Tried: ${kCandidates.map((c) => c.slug).join(', ')}');
    } catch (e) {
      lastError = e.toString();
      status.value = OnDeviceStatus.error;
      statusLine.value = 'Error: $e';
      await Analytics.error(
        domain: 'ondevice_ai',
        code: 'load_failed',
        message: e.toString(),
        action: 'ensureReady',
        extra: {'diag': _cap(lastDiag, 480), 'mem': await _memInfo()},
      );
      AvaLog.I.log('ava_ondevice', 'ensureReady FAILED: $e | $lastDiag');
      return false;
    }
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
        final cleaned =
            stripThink(buf.isNotEmpty ? buf.toString() : res.response);
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

  // ── Embeddings ───────────────────────────────────────────────────────────────

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

  // ── Debug ────────────────────────────────────────────────────────────────────

  Future<List<String>> debugCatalog() async {
    try {
      final lm = _lm ??= CactusLM();
      final models = await lm.getModels();
      if (models.isEmpty) return const ['(catalog returned no models)'];
      return models
          .map((m) =>
              '${m.slug}  ·  ${m.name}  ·  ${m.sizeMb}MB${m.supportsVision ? ' · vision' : ''}')
          .toList();
    } catch (e) {
      return ['catalog error: $e'];
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

  static String stripThink(String s) {
    var out = s;
    out = out.replaceAll(RegExp(r'<think>[\s\S]*?</think>', multiLine: true), '');
    final close = out.indexOf('</think>');
    if (close >= 0) out = out.substring(close + '</think>'.length);
    final open = out.indexOf('<think>');
    if (open >= 0) out = out.substring(0, open);
    return out.trim();
  }

  static String _cap(String s, int n) => s.length > n ? s.substring(0, n) : s;

  /// Android memory snapshot (MemTotal / MemAvailable). Empty on non-Android.
  Future<String> _memInfo() async {
    if (!Platform.isAndroid) return '';
    try {
      final lines = await File('/proc/meminfo').readAsLines();
      String pick(String k) =>
          lines.firstWhere((l) => l.startsWith(k), orElse: () => '$k ?').trim();
      return '${pick('MemTotal:')} | ${pick('MemAvailable:')}';
    } catch (_) {
      return '';
    }
  }
}
