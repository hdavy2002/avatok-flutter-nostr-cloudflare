/// AvaOnDeviceStt — on-device speech-to-text for "Convert voice to text".
///
/// ENGINE (2026-06-21): runs on the consolidated [SherpaVoiceEngine] (sherpa-onnx
/// Whisper-tiny), replacing the earlier whisper_ggml build (which itself replaced
/// the removed Cactus STT). Private, on-device, multilingual — it takes the same
/// language the user picked for their Kokoro voice.
///
/// LIVE DICTATION: a [SttSession] captures the mic as 16 kHz PCM16 mono, accumulates
/// it, and every ~1.8 s transcribes everything spoken so far — so the text grows in
/// the message box AS the user talks. stop() runs a final pass and returns the full
/// text. Public API is unchanged from the previous build so the chat composers keep
/// working. Local only; no message content is sent to telemetry (only counters).
library;

import 'dart:async';
import 'dart:typed_data';

import 'package:flutter/foundation.dart';
import 'package:record/record.dart';

import 'analytics.dart';
import 'ava_log.dart';
import 'voice/sherpa_voice_engine.dart';

class AvaOnDeviceStt {
  AvaOnDeviceStt._();
  static final AvaOnDeviceStt I = AvaOnDeviceStt._();

  /// Human-readable status for the composer ("Preparing…", "Listening…").
  final ValueNotifier<String> statusLine = ValueNotifier<String>('');

  SttSession? _active;
  bool get isListening => _active != null;

  /// Start a live dictation session. [lang] is a Whisper language code ("en",
  /// "es", …) or "" / "auto" for auto-detect. [onText] is called with the FULL
  /// transcript so far each time it updates. Returns null on mic-denied / failure.
  Future<SttSession?> startDictation({
    required String lang,
    required void Function(String fullText) onText,
  }) async {
    if (_active != null) return _active;
    statusLine.value = 'Preparing Whisper…';
    if (!await SherpaVoiceEngine.I.ensureStt(lang: lang)) {
      statusLine.value = 'Voice model not ready';
      return null;
    }
    final session = SttSession._(this, lang: lang, onText: onText);
    if (!await session._start()) return null;
    _active = session;
    Analytics.capture('stt_start', {'lang': lang, 'engine': 'sherpa_whisper'});
    return session;
  }

  /// One-shot transcription of a buffer of 16 kHz PCM16 bytes. '' on failure.
  Future<String> transcribePcm16(Uint8List pcm16, String lang) async {
    final f32 = SherpaVoiceEngine.pcm16ToFloat32(pcm16);
    return SherpaVoiceEngine.I.transcribe(f32, lang: lang);
  }

  void _clearActive(SttSession s) {
    if (identical(_active, s)) _active = null;
  }
}

/// A single live-dictation session. Created via [AvaOnDeviceStt.startDictation].
class SttSession {
  SttSession._(this._owner, {required this.lang, required this.onText});

  final AvaOnDeviceStt _owner;
  final String lang;
  final void Function(String fullText) onText;

  final AudioRecorder _rec = AudioRecorder();
  final BytesBuilder _pcm = BytesBuilder(copy: false);
  StreamSubscription<Uint8List>? _sub;
  Timer? _tick;
  bool _transcribing = false;
  bool _stopped = false;
  String _lastText = '';

  static const int _sampleRate = SherpaVoiceEngine.sampleRate; // 16 kHz

  Future<bool> _start() async {
    try {
      if (!await _rec.hasPermission()) {
        _owner.statusLine.value = 'Microphone permission needed';
        return false;
      }
      _owner.statusLine.value = 'Listening…';
      final stream = await _rec.startStream(const RecordConfig(
        encoder: AudioEncoder.pcm16bits,
        sampleRate: _sampleRate,
        numChannels: 1,
        echoCancel: true,
        noiseSuppress: true,
      ));
      _sub = stream.listen((chunk) {
        if (chunk.isNotEmpty) _pcm.add(chunk);
      });
      _tick = Timer.periodic(const Duration(milliseconds: 1800), (_) => _transcribePartial());
      return true;
    } catch (e) {
      AvaLog.I.log('ava_stt', 'start FAILED: $e');
      _owner.statusLine.value = 'Voice-to-text failed to start';
      await _teardown();
      return false;
    }
  }

  Future<void> _transcribePartial() async {
    if (_transcribing || _stopped) return;
    final bytes = _pcm.toBytes();
    if (bytes.length < _sampleRate * 2 * 0.4) return; // need ~0.4 s
    _transcribing = true;
    try {
      final f32 = SherpaVoiceEngine.pcm16ToFloat32(bytes);
      final text = await SherpaVoiceEngine.I.transcribe(f32, lang: lang);
      if (!_stopped && text.isNotEmpty && text != _lastText) {
        _lastText = text;
        onText(text);
      }
    } catch (_) {
      // transient — keep listening
    } finally {
      _transcribing = false;
    }
  }

  /// Stop listening, run a final transcription, return the full text.
  Future<String> stop() async {
    if (_stopped) return _lastText;
    _stopped = true;
    _tick?.cancel();
    _owner.statusLine.value = 'Transcribing…';
    final sw = Stopwatch()..start();
    await _sub?.cancel();
    _sub = null;
    try { await _rec.stop(); } catch (_) {}
    final bytes = _pcm.toBytes();
    String finalText = _lastText;
    if (bytes.length >= _sampleRate * 2 * 0.3) {
      try {
        final f32 = SherpaVoiceEngine.pcm16ToFloat32(bytes);
        final text = await SherpaVoiceEngine.I.transcribe(f32, lang: lang);
        if (text.isNotEmpty) finalText = text;
      } catch (_) {}
    }
    _lastText = finalText;
    _owner.statusLine.value = '';
    Analytics.capture('stt_done', {
      'lang': lang,
      'ms': sw.elapsedMilliseconds,
      'chars': finalText.length,
      'engine': 'sherpa_whisper',
    });
    await _teardown();
    return finalText;
  }

  /// Abandon the session without inserting text (user cancelled).
  Future<void> cancel() async {
    _stopped = true;
    _tick?.cancel();
    await _sub?.cancel();
    _sub = null;
    try { await _rec.stop(); } catch (_) {}
    _owner.statusLine.value = '';
    Analytics.capture('stt_cancel', {'lang': lang, 'engine': 'sherpa_whisper'});
    await _teardown();
  }

  Future<void> _teardown() async {
    try { _rec.dispose(); } catch (_) {}
    _owner._clearActive(this);
  }
}
