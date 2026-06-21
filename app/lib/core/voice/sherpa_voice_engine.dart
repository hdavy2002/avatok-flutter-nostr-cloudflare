/// SherpaVoiceEngine — the single on-device voice runtime (sherpa-onnx).
///
/// Wraps three sherpa-onnx capabilities behind one lazy-loaded API:
///   • Whisper-tiny STT  → [transcribe] (Float32List 16 kHz mono → text)
///   • Silero VAD        → [vadAccept]/[vadDetected]/[vadDrain] for the call loop
///   • SupertonicTTS-3   → [synthesize] (text → PCM at the model's own rate, picked voice)
///
/// Model files come from [VoiceModels] (downloaded + cached on first use). Native
/// objects are created once and reused; everything is null-safe so a missing model
/// or unsupported device degrades to "not ready" instead of crashing.
///
/// ⚠️ VERIFY ON DEVICE: native sherpa-onnx build config (Android NDK / iOS) and the
/// exact Kokoro voice→sid table (see [KokoroVoice.sid]). All STT/VAD audio is
/// 16 kHz mono; Kokoro outputs 24 kHz.
library;

import 'dart:typed_data';

import 'package:flutter/foundation.dart';
import 'package:sherpa_onnx/sherpa_onnx.dart' as so;

import '../analytics.dart';
import '../ava_log.dart';
import 'sherpa_models.dart';

/// Log + report a voice-engine failure so it shows up in PostHog (native/Dart
/// load errors were previously only in the local log, making them invisible).
void _voiceErr(String stage, Object e) {
  AvaLog.I.log('sherpa', '$stage FAILED: $e');
  Analytics.capture('voice_engine_error', {'stage': stage, 'error': e.toString()});
}

/// Result of a Kokoro synthesis: PCM16 samples + their sample rate (24000).
class TtsAudio {
  final Int16List pcm16;
  final int sampleRate;
  const TtsAudio(this.pcm16, this.sampleRate);
}

class SherpaVoiceEngine {
  SherpaVoiceEngine._();
  static final SherpaVoiceEngine I = SherpaVoiceEngine._();

  static const int sampleRate = 16000; // STT + VAD
  static const int vadWindow = 512; // Silero requires 512-sample windows @16k

  bool _bound = false;
  so.OfflineRecognizer? _recognizer;
  so.VoiceActivityDetector? _vad;
  so.OfflineTts? _tts;
  String _recognizerLang = '';

  void _ensureBindings() {
    if (_bound) return;
    so.initBindings();
    _bound = true;
  }

  // ── STT (Whisper) ──────────────────────────────────────────────────────────

  /// Build the Whisper recognizer for [lang] ('' / 'auto' = multilingual auto).
  /// Rebuilds if the language changed. Returns false if models aren't ready.
  Future<bool> ensureStt({String lang = ''}) async {
    if (!await VoiceModels.I.ensureVadAndStt()) {
      Analytics.capture('voice_engine_error', {'stage': 'ensureStt', 'error': 'models_not_ready'});
      return false;
    }
    try {
      _ensureBindings();
      if (_recognizer != null && _recognizerLang == lang) return true;
      _recognizer?.free();
      final whisper = so.OfflineWhisperModelConfig(
        encoder: VoiceModels.I.whisperEncoder,
        decoder: VoiceModels.I.whisperDecoder,
        language: lang == 'auto' ? '' : lang,
      );
      final model = so.OfflineModelConfig(
        whisper: whisper,
        tokens: VoiceModels.I.whisperTokens,
        modelType: 'whisper',
        numThreads: 1,
        debug: false,
      );
      _recognizer = so.OfflineRecognizer(so.OfflineRecognizerConfig(model: model));
      _recognizerLang = lang;
      Analytics.capture('voice_engine_ok', {'stage': 'ensureStt'});
      return true;
    } catch (e) {
      _voiceErr('ensureStt', e);
      return false;
    }
  }

  /// Transcribe 16 kHz mono float samples to text. '' on failure.
  Future<String> transcribe(Float32List samples, {String lang = ''}) async {
    if (samples.isEmpty) return '';
    if (!await ensureStt(lang: lang)) return '';
    try {
      final stream = _recognizer!.createStream();
      stream.acceptWaveform(samples: samples, sampleRate: sampleRate);
      _recognizer!.decode(stream);
      final text = _recognizer!.getResult(stream).text;
      stream.free();
      return text.trim();
    } catch (e) {
      _voiceErr('transcribe', e);
      return '';
    }
  }

  // ── VAD (Silero) ───────────────────────────────────────────────────────────

  Future<bool> ensureVad() async {
    if (!await VoiceModels.I.ensureVadAndStt()) return false;
    try {
      _ensureBindings();
      if (_vad != null) return true;
      final silero = so.SileroVadModelConfig(
        model: VoiceModels.I.vadPath,
        minSilenceDuration: 0.35,
        minSpeechDuration: 0.25,
        threshold: 0.5,
        windowSize: vadWindow,
      );
      _vad = so.VoiceActivityDetector(
        config: so.VadModelConfig(sileroVad: silero, numThreads: 1, debug: false),
        bufferSizeInSeconds: 30,
      );
      return true;
    } catch (e) {
      _voiceErr('ensureVad', e);
      return false;
    }
  }

  /// Feed exactly [vadWindow] samples.
  void vadAccept(Float32List window) {
    try { _vad?.acceptWaveform(window); } catch (_) {}
  }

  /// True while speech is currently active (used to detect barge-in).
  bool vadDetected() {
    try { return _vad?.isDetected() ?? false; } catch (_) { return false; }
  }

  /// Drain completed speech segments (each a Float32List utterance).
  List<Float32List> vadDrain() {
    final out = <Float32List>[];
    final v = _vad;
    if (v == null) return out;
    try {
      while (!v.isEmpty()) {
        out.add(v.front().samples);
        v.pop();
      }
    } catch (_) {}
    return out;
  }

  void vadFlush() { try { _vad?.flush(); } catch (_) {} }
  void vadReset() { try { _vad?.clear(); } catch (_) {} }

  // ── TTS (Kokoro) ────────────────────────────────────────────────────────────

  /// Build the SupertonicTTS-3 engine from CACHED files only (never downloads —
  /// the download happens via the explicit "Enable Ava Voice" flow). Returns
  /// false if the model isn't downloaded yet.
  Future<bool> ensureTts() async {
    if (!await VoiceModels.I.resolveTts()) return false;
    try {
      _ensureBindings();
      if (_tts != null) return true;
      final supertonic = so.OfflineTtsSupertonicModelConfig(
        durationPredictor: VoiceModels.I.ttsDurationPredictor,
        textEncoder: VoiceModels.I.ttsTextEncoder,
        vectorEstimator: VoiceModels.I.ttsVectorEstimator,
        vocoder: VoiceModels.I.ttsVocoder,
        ttsJson: VoiceModels.I.ttsJson,
        unicodeIndexer: VoiceModels.I.ttsUnicodeIndexer,
        voiceStyle: VoiceModels.I.ttsVoiceStyle,
      );
      final model = so.OfflineTtsModelConfig(
        supertonic: supertonic, numThreads: 2, debug: false, provider: 'cpu');
      _tts = so.OfflineTts(so.OfflineTtsConfig(model: model, maxNumSenetences: 1));
      Analytics.capture('voice_engine_ok', {'stage': 'ensureTts'});
      return true;
    } catch (e) {
      _voiceErr('ensureTts', e);
      return false;
    }
  }

  /// Synthesize [text] with Supertonic voice [sid]. Returns PCM16 at the model's
  /// own sample rate (read from the result, not hardcoded), or null.
  ///
  /// NOTE: Supertonic addresses voices by integer speaker id; [sid] is clamped to
  /// the model's speaker count so an out-of-range pick can't fail. Language is
  /// English via the stable `generate()` API; per-language synthesis (Supertonic
  /// supports 31 langs via `generateWithConfig` + an `extra` lang map) is a small
  /// follow-up once confirmed against the pinned package version.
  Future<TtsAudio?> synthesize(String text, {required int sid, double speed = 1.0}) async {
    if (text.trim().isEmpty) return null;
    if (!await ensureTts()) return null;
    try {
      final n = _tts!.numSpeakers;
      final safeSid = n > 0 ? (sid % n) : 0;
      final audio = _tts!.generate(text: text, sid: safeSid, speed: speed);
      final f32 = audio.samples;
      final pcm = Int16List(f32.length);
      for (var i = 0; i < f32.length; i++) {
        var s = (f32[i] * 32767.0).round();
        if (s > 32767) s = 32767; else if (s < -32768) s = -32768;
        pcm[i] = s;
      }
      return TtsAudio(pcm, audio.sampleRate);
    } catch (e) {
      _voiceErr('synthesize', e);
      return null;
    }
  }

  // ── on-demand memory: free native models when a session ends ─────────────────

  void releaseStt() {
    try { _recognizer?.free(); } catch (_) {}
    _recognizer = null;
    _recognizerLang = '';
  }

  void releaseVad() {
    try { _vad?.free(); } catch (_) {}
    _vad = null;
  }

  void releaseTts() {
    try { _tts?.free(); } catch (_) {}
    _tts = null;
  }

  /// Free everything (call ended) so the ~hundreds-of-MB native models leave RAM.
  /// The on-disk model files stay cached, so the next session reloads instantly.
  void releaseAll() {
    releaseStt();
    releaseVad();
    releaseTts();
  }

  // ── utils ────────────────────────────────────────────────────────────────────

  /// PCM16 little-endian bytes → normalized Float32 samples ([-1, 1]).
  static Float32List pcm16ToFloat32(Uint8List bytes) {
    final out = Float32List(bytes.length ~/ 2);
    final data = ByteData.view(bytes.buffer, bytes.offsetInBytes, bytes.length);
    for (var i = 0; i < out.length; i++) {
      out[i] = data.getInt16(i * 2, Endian.little) / 32768.0;
    }
    return out;
  }
}
