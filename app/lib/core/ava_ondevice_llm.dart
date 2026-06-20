/// AvaOnDeviceLlm (Phase A — On-Device AI, step 1: prove Qwen3-0.6B locally).
///
/// A thin wrapper around the Cactus `CactusLM` engine that runs **Qwen3-0.6B
/// fully on-device / offline**. This is the first vertical slice of the on-device
/// AI plan: get one model loading and answering on a real phone with NO network,
/// BEFORE wiring routing/embeddings/STT/RAG.
///
/// Design notes (so the rest can be wired later without churn):
///   • LOCAL ONLY. Completion runs with `CompletionMode.local` — we NEVER use
///     Cactus's own hybrid cloud. Our cloud escalation (Workers AI via AI
///     Gateway) is a separate, existing path; nothing here calls it.
///   • Telemetry OFF. `CactusConfig.isTelemetryEnabled = false` before any use.
///   • Account-AGNOSTIC weights. The model file is the same for every account on
///     the device (Cactus caches it under app support), so it is NOT per-account.
///     Any per-account state (chat history, embeddings) is handled elsewhere and
///     stays scoped — this service holds none.
///   • Swappable. Everything goes through this one class; if Cactus is ever
///     replaced (e.g. llama.cpp), only this file changes.
///
/// Status surfaces are exposed as [ValueNotifier]s so a screen can show download
/// progress / readiness without polling. Every method is non-throwing.
library;

import 'package:flutter/foundation.dart';
import 'package:cactus/cactus.dart';

import 'ava_log.dart';

/// Lifecycle of the on-device model.
enum OnDeviceStatus { idle, downloading, initializing, ready, error }

/// Per-completion performance numbers (shown on the test screen so we can judge
/// whether on-device quality/speed is good enough to wire the rest).
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

/// One on-device answer.
class OnDeviceReply {
  final String text;
  final bool ok;
  final OnDeviceMetrics? metrics;
  const OnDeviceReply({required this.text, required this.ok, this.metrics});
}

class AvaOnDeviceLlm {
  AvaOnDeviceLlm._();
  static final AvaOnDeviceLlm I = AvaOnDeviceLlm._();

  /// Cactus model slug. "qwen3-0.6" is Cactus's catalog id for Qwen3-0.6B and is
  /// also the engine default. Downloaded by Cactus from its own model host on
  /// first use, then cached on-device (no R2 hosting needed for this slice).
  static const String kModelSlug = 'qwen3-0.6';

  CactusLM? _lm;

  /// Live status for the UI. Never throws; reflects the last transition.
  final ValueNotifier<OnDeviceStatus> status =
      ValueNotifier<OnDeviceStatus>(OnDeviceStatus.idle);

  /// Download progress 0.0–1.0 (only meaningful while [status]==downloading).
  final ValueNotifier<double> downloadProgress = ValueNotifier<double>(0);

  /// Human-readable status line (download %, "loading", error text).
  final ValueNotifier<String> statusLine = ValueNotifier<String>('Not loaded');

  /// Last error message (for display), if any.
  String? lastError;

  bool get isReady =>
      _lm != null &&
      status.value == OnDeviceStatus.ready &&
      (_lm?.isLoaded() ?? false);

  /// Download-on-first-use + load into memory. Idempotent; safe to call
  /// repeatedly. Returns true when the model is ready to answer.
  Future<bool> ensureReady() async {
    if (isReady) return true;
    try {
      // Privacy: kill Cactus's default-on telemetry before anything runs.
      CactusConfig.isTelemetryEnabled = false;

      final lm = _lm ??= CactusLM();

      // 1) Fetch the weights (no-op if already cached on this device).
      status.value = OnDeviceStatus.downloading;
      statusLine.value = 'Downloading Qwen3-0.6B…';
      await lm.downloadModel(
        model: kModelSlug,
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

      // 2) Initialise the model for local inference.
      status.value = OnDeviceStatus.initializing;
      statusLine.value = 'Loading model into memory…';
      await lm.initializeModel(
        params: CactusInitParams(model: kModelSlug, contextSize: 2048),
      );

      status.value = OnDeviceStatus.ready;
      statusLine.value = 'Ready — Qwen3-0.6B (on-device)';
      lastError = null;
      AvaLog.I.log('ava_ondevice', 'model ready ($kModelSlug)');
      return true;
    } catch (e) {
      lastError = e.toString();
      status.value = OnDeviceStatus.error;
      statusLine.value = 'Error: $e';
      AvaLog.I.log('ava_ondevice', 'ensureReady FAILED: $e');
      return false;
    }
  }

  /// Ask Qwen one turn, fully on-device. [system] is an optional system prompt;
  /// [history] is optional prior turns. Loads the model first if needed.
  Future<OnDeviceReply> ask(
    String prompt, {
    String? system,
    List<ChatMessage> history = const [],
    int maxTokens = 256,
    double temperature = 0.3,
  }) async {
    final ready = await ensureReady();
    if (!ready) {
      return OnDeviceReply(
        text: 'On-device model unavailable: ${lastError ?? 'unknown error'}',
        ok: false,
      );
    }
    try {
      final messages = <ChatMessage>[
        if (system != null && system.isNotEmpty)
          ChatMessage(content: system, role: 'system'),
        ...history,
        ChatMessage(content: prompt, role: 'user'),
      ];

      final res = await _lm!.generateCompletion(
        messages: messages,
        params: CactusCompletionParams(
          maxTokens: maxTokens,
          temperature: temperature,
          // LOCAL ONLY — never Cactus hybrid cloud.
          completionMode: CompletionMode.local,
        ),
      );

      if (!res.success) {
        return const OnDeviceReply(
            text: 'The model returned no response.', ok: false);
      }
      return OnDeviceReply(
        text: res.response.trim(),
        ok: true,
        metrics: OnDeviceMetrics(
          tokensPerSecond: res.tokensPerSecond,
          timeToFirstTokenMs: res.timeToFirstTokenMs,
          totalTimeMs: res.totalTimeMs,
          totalTokens: res.totalTokens,
        ),
      );
    } catch (e) {
      AvaLog.I.log('ava_ondevice', 'ask FAILED: $e');
      return OnDeviceReply(text: 'Error generating reply: $e', ok: false);
    }
  }

  /// Clear the conversation context but keep the model resident (fast re-use).
  void resetContext() {
    try {
      _lm?.reset();
    } catch (_) {/* best-effort */}
  }

  /// Free the model from RAM (call when leaving the test screen).
  void unload() {
    try {
      _lm?.unload();
    } catch (_) {/* best-effort */}
    status.value = OnDeviceStatus.idle;
    downloadProgress.value = 0;
    statusLine.value = 'Not loaded';
  }
}
