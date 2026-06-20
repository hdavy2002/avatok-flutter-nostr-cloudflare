/// AvaOnDeviceLlm (Phase A — On-Device AI).
///
/// Thin wrapper around the Cactus `CactusLM` engine running **Qwen3.5-0.8B fully
/// on-device / offline**. One loaded model serves chat, intent routing,
/// embeddings, and (later) vision + tool-calling.
///
/// WHY WE DOWNLOAD DIRECTLY (not via Cactus's catalog):
/// Cactus 1.3.0's model catalog (Supabase get-models) does NOT list Qwen3.5-0.8B
/// for the Flutter SDK, so `downloadModel(slug)` fails ("Failed to get model").
/// We therefore bypass the catalog and pull the weights straight from the
/// official Cactus-Compute HuggingFace release into the EXACT folder the engine
/// loads from — `<AppDocuments>/models/<slug>` — reusing Cactus's own
/// download+extract code (`DownloadService`) so the on-disk layout is identical
/// to a normal catalog download. `initializeModel(model: <slug>)` then loads it.
///
/// The catalog's `quantization` value is unused for weight decoding — it only
/// sizes an output buffer (`max(maxTokens * q, 2048)`), so defaulting to 8 when
/// the catalog can't be reached is harmless (a slightly larger buffer).
///
/// Design rules: LOCAL ONLY (never Cactus cloud), telemetry OFF, thinking OFF
/// (`/no_think` + `<think>` stripped), account-agnostic weights, swappable engine.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:cactus/cactus.dart';
// ignore: implementation_imports — reuse Cactus's exact download+extract so the
// on-disk model layout matches a normal catalog download (CI runs
// `flutter analyze || true`, so this lint never fails the build).
import 'package:cactus/src/utils/models/download.dart';
import 'package:flutter/foundation.dart';
import 'package:path_provider/path_provider.dart';

import 'analytics.dart';
import 'ava_log.dart';

enum OnDeviceStatus { idle, downloading, initializing, ready, error }

/// Where a request should be answered.
enum RouteScope { local, cloud }

class RouteDecision {
  final RouteScope scope;
  final String raw;
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

  /// Folder/slug the model is stored + loaded under (<AppDocuments>/models/<slug>).
  static const String kModelSlug = 'qwen3.5-0.8b';

  /// Zip filename (used as the on-disk temp name during download).
  static const String kModelZipName = 'qwen3.5-0.8b-int4.zip';

  /// Direct weights URL (official Cactus-Compute HF release, int4).
  static const String kModelDirectUrl =
      'https://huggingface.co/Cactus-Compute/Qwen3.5-0.8B/resolve/v1.14/weights/qwen3.5-0.8b-int4.zip';

  /// The model MANIFEST. It lives at the HF repo ROOT (NOT inside the weights
  /// zip) and the engine REQUIRES it to identify the architecture — without it
  /// `cactus_init` returns null. We fetch it separately into the model folder.
  static const String kConfigUrl =
      'https://huggingface.co/Cactus-Compute/Qwen3.5-0.8B/resolve/v1.14/config.json';

  /// Previous model — deleted on first run of the new one to reclaim ~400 MB.
  static const String kOldModelSlug = 'qwen3-0.6';

  /// Terse persona. `/no_think` keeps replies short/fast (Qwen3.5 is non-thinking
  /// by default; this is belt-and-braces).
  static const String kChatSystem =
      'You are Ava, a concise on-device assistant. Answer in 1–2 short '
      'sentences. Do not show your reasoning. /no_think';

  /// Router persona — one-word classifier.
  static const String kRouterSystem =
      'You are an intent classifier for a phone assistant. Decide whether the '
      "user's request can be answered LOCALLY on the device (simple lookups: "
      "finding the user's own emails, photos, files, messages; reminders; quick "
      'facts already in the provided context) or needs the CLOUD (in-depth '
      'explanation, analysis, open-ended discussion, creative writing, or '
      'multi-step reasoning). Reply with ONLY one word: LOCAL or CLOUD. /no_think';

  CactusLM? _lm;

  /// The slug that actually loaded (for display).
  String? activeSlug;

  final ValueNotifier<OnDeviceStatus> status =
      ValueNotifier<OnDeviceStatus>(OnDeviceStatus.idle);
  final ValueNotifier<double> downloadProgress = ValueNotifier<double>(0);
  final ValueNotifier<String> statusLine = ValueNotifier<String>('Not loaded');
  String? lastError;

  /// Human-readable diagnostics from the last load attempt (extracted file
  /// listing + device memory). Shown on the error card AND sent to PostHog so a
  /// failed load is debuggable remotely by the user's email.
  String lastDiag = '';

  bool get isReady =>
      _lm != null &&
      status.value == OnDeviceStatus.ready &&
      (_lm?.isLoaded() ?? false);

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  Future<bool> ensureReady() async {
    if (isReady) return true;
    final sw = Stopwatch()..start();
    String modelPath = '';
    try {
      CactusConfig.isTelemetryEnabled = false;
      final lm = _lm ??= CactusLM();
      final docs = await getApplicationDocumentsDirectory();
      modelPath = '${docs.path}/models/$kModelSlug';

      // Reclaim the previous model's ~400 MB before pulling the new one.
      await _purgeOldModel();

      final already = await DownloadService.modelExists(kModelSlug);
      await Analytics.capture('ondevice_load_start', {
        'slug': kModelSlug,
        'already_downloaded': already,
        'mem': await _memInfo(),
      });

      // Download directly from the HF release into <AppDocuments>/models/<slug>,
      // reusing Cactus's own extract logic. Idempotent: skips if already present.
      if (!already) {
        status.value = OnDeviceStatus.downloading;
        statusLine.value = 'Downloading Qwen3.5-0.8B…';
        downloadProgress.value = 0;
        final ok = await DownloadService.downloadAndExtractModels(
          [
            DownloadTask(
              url: kModelDirectUrl,
              filename: kModelZipName,
              folder: kModelSlug,
            ),
          ],
          (progress, statusMessage, isError) {
            if (isError) {
              statusLine.value = 'Download error: $statusMessage';
            } else {
              if (progress != null) downloadProgress.value = progress;
              statusLine.value = progress != null
                  ? 'Downloading… ${(progress * 100).toStringAsFixed(0)}%'
                  : statusMessage;
            }
          },
        );
        await Analytics.capture('ondevice_download_done', {
          'slug': kModelSlug,
          'ok': ok,
          'ms': sw.elapsedMilliseconds,
        });
        if (!ok) {
          throw Exception('Download/extract failed from $kModelDirectUrl');
        }
      }

      // The engine needs config.json (the architecture manifest) NEXT TO the
      // weights — it lives outside the zip, so fetch it on its own. Cheap, and it
      // repairs an existing weights-only folder without re-downloading the model.
      final configOk = await _ensureConfig(modelPath);
      await Analytics.capture('ondevice_config', {
        'model_path': modelPath,
        'ok': configOk,
      });

      // Diagnostics: exactly what landed on disk (this is what tells us whether a
      // failure is an extraction problem vs the native runtime rejecting the model).
      final files = await _listModelDir();
      final filesStr = _cap(files.join(', '), 480);
      lastDiag =
          'path: $modelPath\nfiles (${files.length}): $filesStr\nmem: ${await _memInfo()}';
      await Analytics.capture('ondevice_model_files', {
        'model_path': modelPath,
        'file_count': files.length,
        'files': filesStr,
      });

      status.value = OnDeviceStatus.initializing;
      statusLine.value = 'Loading model into memory…';
      await Analytics.capture('ondevice_init_start', {
        'model_path': modelPath,
        'context_size': 2048,
        'file_count': files.length,
        'mem': await _memInfo(),
      });
      await lm.initializeModel(
        params: CactusInitParams(model: kModelSlug, contextSize: 2048),
      );

      activeSlug = kModelSlug;
      status.value = OnDeviceStatus.ready;
      statusLine.value = 'Ready — Qwen3.5-0.8B (on-device)';
      lastError = null;
      await Analytics.capture('ondevice_init_ok', {
        'slug': kModelSlug,
        'ms': sw.elapsedMilliseconds,
      });
      AvaLog.I.log('ava_ondevice', 'model ready ($kModelSlug)');
      return true;
    } catch (e) {
      lastError = e.toString();
      status.value = OnDeviceStatus.error;
      statusLine.value = 'Error: $e';
      // Rich error event — carries the user's email via the Analytics envelope,
      // plus the on-disk file listing + memory so we can diagnose remotely.
      await Analytics.error(
        domain: 'ondevice_ai',
        code: 'load_failed',
        message: e.toString(),
        action: 'ensureReady',
        extra: {
          'slug': kModelSlug,
          'model_path': modelPath,
          'diag': _cap(lastDiag, 480),
          'mem': await _memInfo(),
        },
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

      // Suppress any `<think>` block from the typewriter (belt-and-braces).
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

  // ── Embeddings (for the on-device RAG store) ─────────────────────────────────

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

  /// List the catalog as the device sees it (for diagnostics only — we no longer
  /// depend on it to load the model). Never throws.
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

  /// Remove a Qwen `<think>…</think>` block (closed or, if the cap cut it off,
  /// unclosed) so only the final answer is shown.
  static String stripThink(String s) {
    var out = s;
    out = out.replaceAll(RegExp(r'<think>[\s\S]*?</think>', multiLine: true), '');
    final close = out.indexOf('</think>');
    if (close >= 0) out = out.substring(close + '</think>'.length);
    final open = out.indexOf('<think>');
    if (open >= 0) out = out.substring(0, open);
    return out.trim();
  }

  /// Ensure `config.json` (the architecture manifest) is present next to the
  /// weights. Downloads it from the HF repo root if missing. Returns true if the
  /// file is present afterwards. Best-effort; never throws.
  Future<bool> _ensureConfig(String modelPath) async {
    try {
      final f = File('$modelPath/config.json');
      if (await f.exists() && await f.length() > 0) return true;
      final client = HttpClient();
      try {
        final req = await client.getUrl(Uri.parse(kConfigUrl));
        final resp = await req.close();
        if (resp.statusCode != 200) {
          AvaLog.I.log('ava_ondevice', 'config.json HTTP ${resp.statusCode}');
          return false;
        }
        final body = await resp.transform(utf8.decoder).join();
        await f.writeAsString(body);
        AvaLog.I.log('ava_ondevice', 'config.json written (${body.length} B)');
        return true;
      } finally {
        client.close(force: true);
      }
    } catch (e) {
      AvaLog.I.log('ava_ondevice', 'config.json fetch FAILED: $e');
      return false;
    }
  }

  static String _cap(String s, int n) => s.length > n ? s.substring(0, n) : s;

  /// List the extracted model folder (filename: size) so we can see whether the
  /// download produced a valid model directory.
  Future<List<String>> _listModelDir() async {
    try {
      final docs = await getApplicationDocumentsDirectory();
      final dir = Directory('${docs.path}/models/$kModelSlug');
      if (!await dir.exists()) return const ['<folder missing>'];
      final out = <String>[];
      await for (final e in dir.list(recursive: true)) {
        if (e is File) {
          final kb = (await e.length()) / 1024;
          out.add('${e.path.split('/').last}:${kb.toStringAsFixed(0)}KB');
        }
      }
      return out.isEmpty ? const ['<empty folder>'] : out;
    } catch (e) {
      return ['<list error: $e>'];
    }
  }

  /// Android memory snapshot (MemTotal / MemAvailable) — a likely suspect for a
  /// native init failure. Empty on non-Android or on any error.
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

  /// Delete the old model directory to free disk. Best-effort, idempotent.
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
}
