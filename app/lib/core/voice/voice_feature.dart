/// VoiceFeature — the "Enable Ava Voice" gate for the heavy on-device voice models.
///
/// Talking to Ava (and her speaking back) needs ~300+ MB of models. We do NOT
/// bundle them and we do NOT download them silently. The user turns the feature on
/// once in Settings → Ava voice; this downloads everything in the background while
/// the UI shows "Downloading Ava Voice…" → "Getting it ready…" → "Ava Voice is
/// ready ✓". After that the engine loads/frees the models ON DEMAND (per call /
/// per dictation) to keep RAM low.
///
/// Readiness is derived from the cached files on disk (device-level), so it
/// survives restarts. [progress] + [VoiceModels.status] drive the live UI text.
library;

import 'package:flutter/foundation.dart';

import '../analytics.dart';
import 'sherpa_models.dart';

enum VoiceFeatureState { off, downloading, preparing, ready, error }

class VoiceFeature {
  VoiceFeature._();
  static final VoiceFeature I = VoiceFeature._();

  /// Live feature state for the Settings card.
  final ValueNotifier<VoiceFeatureState> state =
      ValueNotifier<VoiceFeatureState>(VoiceFeatureState.off);

  /// Download progress 0..1 (-1 = indeterminate, e.g. unpacking). Mirrors
  /// [VoiceModels.progress] so the card can show a bar.
  ValueNotifier<double> get progress => VoiceModels.I.progress;

  /// Human-readable step text ("Downloading Ava Voice…", "Unpacking…").
  ValueNotifier<String> get status => VoiceModels.I.status;

  bool get isReady => state.value == VoiceFeatureState.ready;
  bool get isBusy =>
      state.value == VoiceFeatureState.downloading ||
      state.value == VoiceFeatureState.preparing;

  /// Reflect cached readiness at startup / when the card opens. No download.
  Future<void> refresh() async {
    if (isBusy) return;
    final ready = await VoiceModels.I.isAllReady();
    state.value = ready ? VoiceFeatureState.ready : VoiceFeatureState.off;
  }

  /// Download every voice model in the background. Safe to call again if a prior
  /// attempt failed (it resumes the missing pieces). Idempotent when ready.
  Future<bool> enable() async {
    if (isReady) return true;
    if (isBusy) return false;
    state.value = VoiceFeatureState.downloading;
    Analytics.capture('voice_feature_enable_start', const <String, Object>{});
    try {
      // 1) speech models (VAD + Whisper, ~110 MB)
      final sttOk = await VoiceModels.I.ensureVadAndStt();
      // 2) Ava's voice (Kokoro, ~330 MB) — the big one
      final ttsOk = await VoiceModels.I.downloadTts();
      state.value = VoiceFeatureState.preparing;
      final ready = await VoiceModels.I.isAllReady();
      if (sttOk && ttsOk && ready) {
        state.value = VoiceFeatureState.ready;
        status.value = '';
        Analytics.capture('voice_feature_ready', const <String, Object>{});
        return true;
      }
      state.value = VoiceFeatureState.error;
      Analytics.capture('voice_feature_failed', {'stt': sttOk, 'tts': ttsOk});
      return false;
    } catch (e) {
      state.value = VoiceFeatureState.error;
      Analytics.capture('voice_feature_failed', {'error': e.toString()});
      return false;
    }
  }
}
