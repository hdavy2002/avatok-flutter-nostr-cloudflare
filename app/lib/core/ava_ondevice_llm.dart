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
import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:cactus/cactus.dart';
// ignore: implementation_imports — reuse Cactus's exact download+extract for the
// direct-HF fallback when a model isn't in the Flutter catalog. CI runs
// `flutter analyze || true`, so this lint never fails the build.
import 'package:cactus/src/utils/models/download.dart';
import 'package:flutter/foundation.dart';
import 'package:path_provider/path_provider.dart';

import 'analytics.dart';
import 'ava_log.dart';

enum OnDeviceStatus { idle, downloading, initializing, ready, error }

enum RouteScope { local, apps, cloud }

class RouteDecision {
  final RouteScope scope;
  final String raw;
  const RouteDecision(this.scope, this.raw);
  bool get isLocal => scope == RouteScope.local;
  bool get isApps => scope == RouteScope.apps;
  bool get isCloud => scope == RouteScope.cloud;
}

/// A candidate on-device model (slug + display label + whether it sees images).
class OnDeviceModel {
  final String slug;
  final String label;
  final bool vision;

  /// Optional direct-HuggingFace fallback used when the Cactus catalog doesn't
  /// serve this slug (e.g. newer LFM2.5 models). When set, we download the
  /// weights zip + config.json straight from HF into <AppDocuments>/models/<slug>.
  final String? zipUrl;
  final String? zipName;
  final String? configUrl;

  const OnDeviceModel(
    this.slug,
    this.label, {
    this.vision = false,
    this.zipUrl,
    this.zipName,
    this.configUrl,
  });
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

  /// Models to try, in order. First that initializes wins. LFM2.5-350M is the
  /// tiny text-only orchestrator (route + chat + tools + embed); Qwen3-0.6B is a
  /// proven fallback so loading can never regress.
  static const List<OnDeviceModel> kCandidates = <OnDeviceModel>[
    OnDeviceModel(
      'ava-ai-350',
      'Ava AI 350',
      vision: false,
      // Hosted on OUR Cloudflare R2 (avatok-blobs), served publicly via
      // blossom.avatok.ai with no Worker in the path. This gives the download a
      // professional "Ava AI 350" name and removes the third-party host
      // dependency. (Same LFM2.5-350M int4 weights; the engine loads it by the
      // local folder name = slug, so renaming the slug is safe.)
      zipUrl:
          'https://blossom.avatok.ai/models/ava-ai-350/ava-ai-350-int4.zip',
      zipName: 'ava-ai-350-int4.zip',
      configUrl:
          'https://blossom.avatok.ai/models/ava-ai-350/config.json',
    ),
    // LFM2-350M — the proven LFM2 generation (it's the text backbone of the
    // LFM2-VL-450M that already loaded), pinned to v1.11. Tried if LFM2.5 won't init.
    OnDeviceModel(
      'lfm2-350m',
      'LFM2-350M',
      vision: false,
      zipUrl:
          'https://huggingface.co/Cactus-Compute/LFM2-350M/resolve/v1.11/weights/lfm2-350m-int4.zip',
      zipName: 'lfm2-350m-int4.zip',
      configUrl:
          'https://huggingface.co/Cactus-Compute/LFM2-350M/resolve/v1.11/config.json',
    ),
    OnDeviceModel('qwen3-0.6', 'Qwen3-0.6B', vision: false),
  ];

  /// Previous models whose weights we delete on first run to reclaim space.
  /// Includes the old 'lfm2.5-350m' folder so devices that fetched it before the
  /// rename reclaim the space and re-fetch once as the branded 'ava-ai-350'.
  static const List<String> kPurgeSlugs = [
    'lfm2-vl-450m',
    'qwen3.5-0.8b',
    'lfm2.5-350m',
  ];

  static const String kChatSystem =
      "You are Ava, the user's personal assistant inside the AvaTOK app. Be "
      'warm, concise and direct — answer in 1–3 short sentences.\n'
      'GROUNDING RULES (important):\n'
      '- Answer ONLY from the Context provided to you (the user\'s own notes, '
      'messages and files) and from tool results you were actually given.\n'
      '- If the Context does not contain the answer, say plainly that you don\'t '
      'have that yet and suggest how the user could add it. Do NOT guess.\n'
      '- NEVER claim to have checked email, messages, a calendar, Drive, or any '
      'app unless real results for it appear in the Context. Inventing such '
      'results is a serious error.\n'
      '- Do not repeat unrelated notes from the Context; use only what answers '
      'the request.\n'
      'Do not show your reasoning. /no_think';

  static const String kRouterSystem =
      'You are an intent classifier for a phone assistant. Reply with ONLY one '
      'word — APPS, LOCAL, or CLOUD:\n'
      '- APPS: the user wants to DO an action in their connected apps (send or '
      'check email, send a message, create a calendar event, find or share a '
      'Drive file, etc.).\n'
      "- LOCAL: a simple lookup answerable from the device — finding the user's "
      'own past messages, conversations, notes, or facts already in the '
      'provided context.\n'
      '- CLOUD: anything else — in-depth explanation, analysis, discussion, '
      'creative writing, or multi-step reasoning.\n'
      'Answer with exactly one word. /no_think';

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

  /// How many times we've actually loaded the model this process, and when it
  /// last became ready — so telemetry can tell a normal first load from the OS
  /// evicting the model and forcing a reload.
  int _loadCount = 0;
  DateTime? _lastReadyAt;

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

      // Owner asked to remove the previous model(s) — reclaim their weights.
      await _purgeModels(kPurgeSlugs);

      _loadCount++;
      final secsSinceReady = _lastReadyAt == null
          ? -1
          : DateTime.now().difference(_lastReadyAt!).inSeconds;
      await Analytics.capture('ondevice_load_start', {
        'candidates': kCandidates.map((c) => c.slug).join(','),
        'mem': await _memInfo(),
        'load_n': _loadCount,
        // A 2nd+ load means the model was unloaded/evicted since last ready.
        'cold_reload': _loadCount > 1,
        'secs_since_ready': secsSinceReady,
      });

      final diag = StringBuffer();
      for (final cand in kCandidates) {
        try {
          // 1) Get the weights. Try the Cactus catalog first; if the catalog
          // doesn't serve this slug (newer models like LFM2.5 aren't in the
          // Flutter catalog), fall back to a direct HuggingFace download.
          status.value = OnDeviceStatus.downloading;
          statusLine.value = 'Downloading ${cand.label}…';
          downloadProgress.value = 0;
          void cb(double? p, String s, bool err) {
            if (err) {
              statusLine.value = 'Download error: $s';
            } else {
              if (p != null) downloadProgress.value = p;
              statusLine.value = p != null
                  ? '${cand.label}: ${(p * 100).toStringAsFixed(0)}%'
                  : s;
            }
          }

          if (!await DownloadService.modelExists(cand.slug)) {
            var fromCatalog = false;
            try {
              await lm.downloadModel(model: cand.slug, downloadProcessCallback: cb);
              fromCatalog = true;
            } catch (e) {
              if (cand.zipUrl == null) rethrow; // no fallback → try next model
              AvaLog.I.log(
                  'ava_ondevice', 'catalog miss ${cand.slug} ($e) → direct HF');
            }
            if (!fromCatalog && cand.zipUrl != null) {
              statusLine.value = 'Downloading ${cand.label} (direct)…';
              final ok = await DownloadService.downloadAndExtractModels(
                [
                  DownloadTask(
                      url: cand.zipUrl!,
                      filename: cand.zipName!,
                      folder: cand.slug),
                ],
                cb,
              );
              if (!ok) throw Exception('direct download failed for ${cand.slug}');
            }
          }
          // Direct-download models keep config.json (the arch manifest) separate
          // from the weights zip — fetch it next to the weights. No-op otherwise.
          await _ensureConfig(cand);

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
            _lastReadyAt = DateTime.now();
            final okProps = <String, Object>{
              'slug': cand.slug,
              'vision': cand.vision,
              'ms': sw.elapsedMilliseconds,
              'load_n': _loadCount,
            };
            okProps.addAll(await _deviceSnapshot());
            await Analytics.capture('ondevice_init_ok', okProps);
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
      // ignore: unawaited_futures
      _emitGen('chat', res, maxTokens: maxTokens, ctxChars: context?.length ?? 0);
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
        // ignore: unawaited_futures
        _emitGen('chat_stream', res,
            maxTokens: maxTokens, ctxChars: context?.length ?? 0);
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
    // Fast-path: a confident phrase match for an explicit app action skips a
    // whole model generation (faster) AND stops the tiny model mis-routing an
    // obvious "check my email" to LOCAL where it would hallucinate.
    final kw = _keywordRoute(request);
    if (kw != null) {
      // ignore: unawaited_futures
      Analytics.capture('ondevice_route', {
        'scope': kw.scope.name,
        'source': 'keyword',
        'reason': 'matched explicit app phrase',
        'confidence': 0.9,
        'ms': 0,
      });
      return kw;
    }
    if (!await ensureReady()) {
      return const RouteDecision(RouteScope.cloud, 'unavailable');
    }
    final sw = Stopwatch()..start();
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
      final RouteScope scope;
      if (raw.contains('APPS')) {
        scope = RouteScope.apps;
      } else if (raw.contains('CLOUD')) {
        scope = RouteScope.cloud;
      } else {
        scope = RouteScope.local;
      }
      // ignore: unawaited_futures
      Analytics.capture('ondevice_route', {
        'scope': scope.name,
        'source': 'model',
        'reason': 'on-device intent classifier',
        'confidence': 0.6,
        'ms': sw.elapsedMilliseconds,
        'tok_per_s': double.parse(res.tokensPerSecond.toStringAsFixed(1)),
      });
      return RouteDecision(scope, raw.trim());
    } catch (e) {
      AvaLog.I.log('ava_ondevice', 'route FAILED: $e');
      return const RouteDecision(RouteScope.cloud, 'error');
    }
  }

  /// Conservative keyword router for the obvious app-action cases only — high
  /// precision, so we short-circuit just when confident. Ambiguous requests
  /// (especially LOCAL vs CLOUD) still go to the model router. Returns null =
  /// "ask the model".
  static RouteDecision? _keywordRoute(String request) {
    final q = request.toLowerCase();
    const appsPhrases = <String>[
      'check my email', 'check email', 'my inbox', 'unread email',
      'unread emails', 'any new email', 'any new emails', 'send an email',
      'send email', 'email to ', 'reply to the email', 'my calendar',
      'schedule a meeting', 'create an event', 'add to my calendar',
      'my google drive', 'file in my drive', 'in google drive',
    ];
    for (final p in appsPhrases) {
      if (q.contains(p)) return const RouteDecision(RouteScope.apps, 'kw');
    }
    return null;
  }

  // ── Vision (image → caption) ─────────────────────────────────────────────────

  /// Whether the loaded model can see images (true for LFM2-VL).
  bool get visionAvailable => activeModel?.vision == true;

  /// Look at a local image and return text about it. By default a one-sentence
  /// caption (for the photo/cow demo); pass [prompt] to repurpose it, e.g. OCR of
  /// a PDF page image. Empty string if the model can't see images or on failure.
  Future<String> caption(
    String imagePath, {
    String? prompt,
    int maxTokens = 80,
  }) async {
    if (!await ensureReady()) return '';
    if (!visionAvailable) return '';
    // CRITICAL: downscale to LFM2-VL's native 512px BEFORE inference. A larger
    // image is tiled into many vision tokens and OOM-crashes the native engine
    // (the "spinner hangs then app crashes"). One 512 tile = tiny + fast.
    final path = await _downscaleForVision(imagePath, maxDim: 512);
    try {
      await Analytics.capture('ondevice_caption_start', {'mem': await _memInfo()});
      final sys = prompt == null
          ? 'You describe images. Reply with ONE detailed sentence naming '
              'the main objects, animals, people, and the scene. /no_think'
          : prompt;
      final res = await _lm!.generateCompletion(
        messages: [
          ChatMessage(content: sys, role: 'system'),
          ChatMessage(
            content: 'Describe this image.',
            role: 'user',
            images: [path],
          ),
        ],
        params: CactusCompletionParams(
          maxTokens: maxTokens,
          temperature: 0.2,
          completionMode: CompletionMode.local,
        ),
      );
      await Analytics.capture('ondevice_caption_done', {
        'ok': res.success,
        'len': res.response.length,
      });
      return res.success ? stripThink(res.response) : '';
    } catch (e) {
      AvaLog.I.log('ava_ondevice', 'caption FAILED: $e');
      return '';
    } finally {
      // Clean up the temp downscaled copy (never the user's original).
      if (path != imagePath) {
        try {
          await File(path).delete();
        } catch (_) {}
      }
    }
  }

  /// Re-encode [srcPath] so its longest side is ≤[maxDim] (PNG). Returns the
  /// original path if it's already small enough or on any failure. Uses pure
  /// dart:ui (no extra dependency) and runs off the widget tree.
  Future<String> _downscaleForVision(String srcPath, {int maxDim = 512}) async {
    try {
      final bytes = await File(srcPath).readAsBytes();
      final probe = await ui.instantiateImageCodec(bytes);
      final probeFrame = await probe.getNextFrame();
      final w = probeFrame.image.width;
      final h = probeFrame.image.height;
      probeFrame.image.dispose();
      final longest = w > h ? w : h;
      if (longest <= maxDim) return srcPath;

      final scale = maxDim / longest;
      final tw = (w * scale).round().clamp(1, maxDim);
      final th = (h * scale).round().clamp(1, maxDim);
      final codec =
          await ui.instantiateImageCodec(bytes, targetWidth: tw, targetHeight: th);
      final frame = await codec.getNextFrame();
      final data =
          await frame.image.toByteData(format: ui.ImageByteFormat.png);
      frame.image.dispose();
      if (data == null) return srcPath;

      final tmp = await getTemporaryDirectory();
      final out = File(
          '${tmp.path}/ava_vis_${DateTime.now().millisecondsSinceEpoch}.png');
      await out.writeAsBytes(data.buffer.asUint8List());
      return out.path;
    } catch (e) {
      AvaLog.I.log('ava_ondevice', 'downscale failed: $e');
      return srcPath;
    }
  }

  // ── Embeddings ───────────────────────────────────────────────────────────────

  Future<List<double>> embed(String text) async {
    if (!await ensureReady()) return const [];
    final sw = Stopwatch()..start();
    try {
      final res = await _lm!.generateEmbedding(text: text);
      // ignore: unawaited_futures
      Analytics.capture('ondevice_embed', {
        'slug': activeSlug ?? '',
        'ok': res.success,
        'ms': sw.elapsedMilliseconds,
        'dims': res.success ? res.embeddings.length : 0,
        'chars': text.length,
      });
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

  /// Emit a per-generation perf event (tokens/sec, time-to-first-token, total
  /// ms, token count) so on-device speed is watchable remotely. The user's email
  /// rides automatically via the Analytics envelope. Best-effort, never throws.
  Future<void> _emitGen(String mode, CactusCompletionResult res,
      {int maxTokens = 0, int ctxChars = 0}) async {
    try {
      final props = <String, Object>{
        'mode': mode,
        'slug': activeSlug ?? '',
        'ok': res.success,
        'max_tokens': maxTokens,
        'ctx_chars': ctxChars,
        'tokens': res.totalTokens,
        'tok_per_s': double.parse(res.tokensPerSecond.toStringAsFixed(1)),
        'ttft_ms': res.timeToFirstTokenMs.round(),
        'total_ms': res.totalTimeMs.round(),
      };
      props.addAll(await _deviceSnapshot()); // ram tier / battery / temp
      await Analytics.capture('ondevice_generate', props);
    } catch (_) {}
  }

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

  /// Fetch config.json (the architecture manifest) next to the weights for a
  /// direct-HF model. Catalog models bundle config inside their zip, so this is
  /// only needed for candidates that declare a [OnDeviceModel.configUrl].
  /// Best-effort; never throws.
  Future<void> _ensureConfig(OnDeviceModel cand) async {
    final url = cand.configUrl;
    if (url == null) return;
    try {
      final docs = await getApplicationDocumentsDirectory();
      final f = File('${docs.path}/models/${cand.slug}/config.json');
      if (await f.exists() && await f.length() > 0) return;
      final client = HttpClient();
      try {
        final req = await client.getUrl(Uri.parse(url));
        final resp = await req.close();
        if (resp.statusCode != 200) {
          AvaLog.I.log(
              'ava_ondevice', 'config.json ${cand.slug} HTTP ${resp.statusCode}');
          return;
        }
        final body = await resp.transform(utf8.decoder).join();
        await f.parent.create(recursive: true);
        await f.writeAsString(body);
        AvaLog.I.log('ava_ondevice',
            'config.json ${cand.slug} written (${body.length} B)');
      } finally {
        client.close(force: true);
      }
    } catch (e) {
      AvaLog.I.log('ava_ondevice', 'config fetch ${cand.slug} FAILED: $e');
    }
  }

  /// Delete the given model folders (<AppDocuments>/models/<slug>) to free disk.
  /// Best-effort, idempotent.
  Future<void> _purgeModels(List<String> slugs) async {
    try {
      final docs = await getApplicationDocumentsDirectory();
      for (final s in slugs) {
        final dir = Directory('${docs.path}/models/$s');
        if (await dir.exists()) {
          await dir.delete(recursive: true);
          AvaLog.I.log('ava_ondevice', 'deleted old model $s');
        }
      }
    } catch (e) {
      AvaLog.I.log('ava_ondevice', 'purge failed: $e');
    }
  }

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

  /// A small device-health snapshot for telemetry: RAM total/available + tier,
  /// battery %, and CPU/SoC temperature. Read straight from Android's procfs /
  /// sysfs (the same way [_memInfo] reads /proc/meminfo) so we need NO extra
  /// plugin. All best-effort — any unreadable value is simply omitted. Lets us
  /// answer "does Ava run comfortably on a 2–3 GB phone, and what does it do to
  /// battery/heat?" without a single new dependency.
  Future<Map<String, Object>> _deviceSnapshot() async {
    final m = <String, Object>{};
    if (!Platform.isAndroid) return m;
    try {
      final lines = await File('/proc/meminfo').readAsLines();
      int kb(String k) {
        final l = lines.firstWhere((x) => x.startsWith(k), orElse: () => '');
        final mt = RegExp(r'(\d+)').firstMatch(l);
        return mt != null ? int.parse(mt.group(1)!) : 0;
      }

      final totalMb = kb('MemTotal:') ~/ 1024;
      final availMb = kb('MemAvailable:') ~/ 1024;
      if (totalMb > 0) {
        m['ram_total_mb'] = totalMb;
        m['ram_avail_mb'] = availMb;
        m['ram_tier'] = totalMb < 2600 ? 'low' : (totalMb < 4600 ? 'mid' : 'high');
      }
    } catch (_) {}
    final bat = await _readIntFile(const [
      '/sys/class/power_supply/battery/capacity',
      '/sys/class/power_supply/Battery/capacity',
    ]);
    if (bat != null && bat >= 0 && bat <= 100) m['battery_pct'] = bat;
    final temp = await _readIntFile(const [
      '/sys/class/thermal/thermal_zone0/temp',
    ]);
    if (temp != null) {
      // Most devices report milli-°C (e.g. 41200); some report whole °C.
      final c = temp > 1000 ? (temp / 1000).round() : temp;
      if (c > 0 && c < 130) m['temp_c'] = c;
    }
    return m;
  }

  /// Read the first readable path as an int (sysfs counters). Best-effort.
  Future<int?> _readIntFile(List<String> paths) async {
    for (final p in paths) {
      try {
        final f = File(p);
        if (await f.exists()) {
          final v = int.tryParse((await f.readAsString()).trim());
          if (v != null) return v;
        }
      } catch (_) {}
    }
    return null;
  }
}
