/// AvaStt — speech-to-text for "Convert voice to text".
///
/// ENGINE (2026-06-27): NATIVE on-device speech recognition FIRST (the phone's
/// built-in recognizer via the `speech_to_text` plugin → Android SpeechRecognizer
/// / iOS Speech). It runs on-device on modern phones, needs NO app-bundled model
/// and NO download, the OS loads it on demand and frees it after — so dictation
/// feels instant and uses almost no memory. When the device has no usable
/// recognizer we fall back to CLOUD Whisper via our Worker (`POST /api/stt/
/// transcribe`) — the previous engine — so voice-to-text always works.
///
/// The public API is unchanged (`AvaOnDeviceStt.I.startDictation/stop/cancel`,
/// `statusLine`) so the chat composers keep working without edits. Native mode
/// streams partial results live into [statusLine]; cloud mode records 16 kHz
/// PCM16 and transcribes once at stop(). Only counters/timings go to telemetry,
/// never transcript text.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/foundation.dart';
import 'package:record/record.dart';
import 'package:speech_to_text/speech_to_text.dart';
import 'package:speech_to_text/speech_recognition_result.dart';

import 'analytics.dart';
import 'api_auth.dart';
import 'ava_log.dart';
import 'config.dart';

class AvaOnDeviceStt {
  AvaOnDeviceStt._();
  static final AvaOnDeviceStt I = AvaOnDeviceStt._();

  static const int sampleRate = 16000; // 16 kHz mono PCM16 (cloud fallback)

  /// Human-readable status for the composer ("Listening…", "Transcribing…").
  final ValueNotifier<String> statusLine = ValueNotifier<String>('');

  // ---- native recognizer (lazy, shared) -------------------------------------
  final SpeechToText _native = SpeechToText();
  bool _nativeTried = false;   // have we attempted initialize() this run?
  bool _nativeAvailable = false;

  /// Initialize the native recognizer once and report availability. Failures are
  /// swallowed (we just fall back to cloud) and logged to telemetry.
  Future<bool> _ensureNative() async {
    if (_nativeTried) return _nativeAvailable;
    _nativeTried = true;
    try {
      _nativeAvailable = await _native.initialize(
        onError: (e) => AvaLog.I.log('ava_stt', 'native error: ${e.errorMsg}'),
        onStatus: (s) => AvaLog.I.log('ava_stt', 'native status: $s'),
        finalTimeout: const Duration(seconds: 2),
      );
    } catch (e) {
      _nativeAvailable = false;
      AvaLog.I.log('ava_stt', 'native init FAILED: $e');
      Analytics.capture('stt_native_unavailable', {'reason': 'init_error', 'error': e.toString()});
    }
    if (!_nativeAvailable) {
      Analytics.capture('stt_native_unavailable', {'reason': 'not_available'});
    }
    return _nativeAvailable;
  }

  SttSession? _active;
  bool get isListening => _active != null;

  /// Start a dictation session. [lang] is a language code ("en", "es", …) or
  /// "" / "auto". [onText] is called once with the final transcript when stop()
  /// resolves. Returns null on mic-denied / failure.
  Future<SttSession?> startDictation({
    required String lang,
    required void Function(String fullText) onText,
  }) async {
    if (_active != null) return _active;
    final session = SttSession._(this, lang: lang, onText: onText);
    if (!await session._start()) {
      Analytics.capture('stt_unavailable', {'lang': lang, 'reason': 'start_failed'});
      return null;
    }
    _active = session;
    Analytics.capture('stt_start', {'lang': lang, 'engine': session.engine});
    return session;
  }

  /// One-shot transcription of a buffer of 16 kHz PCM16 bytes (cloud). '' on fail.
  Future<String> transcribePcm16(Uint8List pcm16, String lang) =>
      _transcribeWav(wavFromPcm16(pcm16, sampleRate), lang);

  void _clearActive(SttSession s) {
    if (identical(_active, s)) _active = null;
  }

  /// POST a WAV clip to the Worker → OpenRouter Whisper. Returns '' on any error.
  Future<String> _transcribeWav(Uint8List wav, String lang) async {
    try {
      final body = <String, dynamic>{'audio': base64Encode(wav), 'format': 'wav'};
      final l = lang.trim();
      if (l.isNotEmpty && l != 'auto') body['lang'] = l;
      final r = await ApiAuth.postJson('$kApiBase/stt/transcribe', body,
          timeout: const Duration(seconds: 45));
      if (r.statusCode != 200) {
        AvaLog.I.log('ava_stt', 'transcribe HTTP ${r.statusCode}: ${r.body}');
        Analytics.capture('stt_error', {'lang': lang, 'engine': 'openrouter_whisper', 'reason': 'http_${r.statusCode}'});
        return '';
      }
      final decoded = jsonDecode(r.body);
      if (decoded is Map && decoded['text'] is String) return decoded['text'] as String;
      return '';
    } catch (e) {
      AvaLog.I.log('ava_stt', 'transcribe FAILED: $e');
      Analytics.capture('stt_error', {'lang': lang, 'engine': 'openrouter_whisper', 'reason': 'exception'});
      return '';
    }
  }

  /// Map a short language code to a native locale id ("en" → "en_US"). Returns
  /// null (device default) for anything we don't have a mapping for.
  static String? localeFor(String lang) {
    final l = lang.trim().toLowerCase();
    if (l.isEmpty || l == 'auto') return null;
    if (l.contains('_') || l.contains('-')) return l.replaceAll('-', '_');
    return _localeMap[l];
  }

  static const Map<String, String> _localeMap = {
    'en': 'en_US', 'es': 'es_ES', 'fr': 'fr_FR', 'de': 'de_DE', 'pt': 'pt_BR',
    'it': 'it_IT', 'nl': 'nl_NL', 'hi': 'hi_IN', 'ar': 'ar_SA', 'bn': 'bn_IN',
    'ur': 'ur_PK', 'zh': 'zh_CN', 'ja': 'ja_JP', 'ko': 'ko_KR', 'ru': 'ru_RU',
    'tr': 'tr_TR', 'id': 'id_ID', 'vi': 'vi_VN', 'th': 'th_TH', 'pl': 'pl_PL',
    'uk': 'uk_UA', 'fa': 'fa_IR', 'ta': 'ta_IN', 'te': 'te_IN', 'mr': 'mr_IN',
  };
}

/// Wrap raw little-endian PCM16 mono samples in a minimal 44-byte WAV header.
Uint8List wavFromPcm16(Uint8List pcm, int sampleRate, {int channels = 1}) {
  const bitsPerSample = 16;
  final byteRate = sampleRate * channels * bitsPerSample ~/ 8;
  final blockAlign = channels * bitsPerSample ~/ 8;
  final dataLen = pcm.lengthInBytes;
  final out = BytesBuilder();
  void str(String s) => out.add(ascii.encode(s));
  void u32(int v) { final b = ByteData(4)..setUint32(0, v, Endian.little); out.add(b.buffer.asUint8List()); }
  void u16(int v) { final b = ByteData(2)..setUint16(0, v, Endian.little); out.add(b.buffer.asUint8List()); }
  str('RIFF'); u32(36 + dataLen); str('WAVE'); str('fmt '); u32(16); u16(1);
  u16(channels); u32(sampleRate); u32(byteRate); u16(blockAlign); u16(bitsPerSample);
  str('data'); u32(dataLen); out.add(pcm);
  return out.toBytes();
}

/// A single dictation session. Created via [AvaOnDeviceStt.startDictation].
/// Uses the native recognizer when available, else the cloud-record path.
class SttSession {
  SttSession._(this._owner, {required this.lang, required this.onText});

  final AvaOnDeviceStt _owner;
  final String lang;
  final void Function(String fullText) onText;

  bool _useNative = false;
  String get engine => _useNative ? 'native_os' : 'openrouter_whisper';

  // native state
  final Stopwatch _sw = Stopwatch();
  int? _firstPartialMs;
  String _lastText = '';
  bool _stopped = false;

  // cloud fallback state
  AudioRecorder? _rec;
  final BytesBuilder _pcm = BytesBuilder(copy: false);
  StreamSubscription<Uint8List>? _sub;

  static const int _sampleRate = AvaOnDeviceStt.sampleRate;

  Future<bool> _start() async {
    // Prefer the native on-device recognizer.
    if (await _owner._ensureNative()) {
      try {
        _useNative = true;
        return await _startNative();
      } catch (e) {
        AvaLog.I.log('ava_stt', 'native start FAILED, falling back: $e');
        Analytics.capture('stt_native_unavailable', {'reason': 'listen_error', 'error': e.toString()});
        _useNative = false;
      }
    }
    return await _startCloud();
  }

  Future<bool> _startNative() async {
    _owner.statusLine.value = 'Listening…';
    _sw
      ..reset()
      ..start();
    await _owner._native.listen(
      onResult: (SpeechRecognitionResult r) {
        _lastText = r.recognizedWords;
        if (_firstPartialMs == null && r.recognizedWords.trim().isNotEmpty) {
          _firstPartialMs = _sw.elapsedMilliseconds;
        }
        _owner.statusLine.value =
            r.recognizedWords.isEmpty ? 'Listening…' : 'Listening… ${r.recognizedWords}';
      },
      localeId: AvaOnDeviceStt.localeFor(lang),
      // Keep listening through natural pauses until the user taps ■ (tap-to-stop
      // flow), rather than auto-stopping after a couple of silent seconds.
      listenFor: const Duration(minutes: 2),
      pauseFor: const Duration(seconds: 30),
      listenOptions: SpeechListenOptions(
        partialResults: true,
        onDevice: false, // use on-device automatically when present, else network
        cancelOnError: true,
        listenMode: ListenMode.dictation,
      ),
    );
    return true;
  }

  Future<bool> _startCloud() async {
    try {
      _rec = AudioRecorder();
      if (!await _rec!.hasPermission()) {
        _owner.statusLine.value = 'Microphone permission needed';
        Analytics.capture('stt_unavailable', {'lang': lang, 'reason': 'no_permission'});
        return false;
      }
      _owner.statusLine.value = 'Listening…';
      _sw
        ..reset()
        ..start();
      final stream = await _rec!.startStream(const RecordConfig(
        encoder: AudioEncoder.pcm16bits,
        sampleRate: _sampleRate,
        numChannels: 1,
        echoCancel: true,
        noiseSuppress: true,
      ));
      _sub = stream.listen((chunk) { if (chunk.isNotEmpty) _pcm.add(chunk); });
      return true;
    } catch (e) {
      AvaLog.I.log('ava_stt', 'cloud start FAILED: $e');
      Analytics.capture('stt_unavailable', {'lang': lang, 'reason': 'start_error', 'error': e.toString()});
      _owner.statusLine.value = 'Voice-to-text failed to start';
      await _teardown();
      return false;
    }
  }

  /// Stop listening, finalize, return the text (also delivered via onText).
  Future<String> stop() async {
    if (_stopped) return _lastText;
    _stopped = true;
    String finalText = '';
    if (_useNative) {
      try { await _owner._native.stop(); } catch (_) {}
      finalText = _lastText.trim();
      if (finalText.isNotEmpty) onText(finalText);
    } else {
      await _sub?.cancel();
      _sub = null;
      try { await _rec?.stop(); } catch (_) {}
      final bytes = _pcm.toBytes();
      if (bytes.length >= _sampleRate * 2 * 0.3) {
        _owner.statusLine.value = 'Transcribing…';
        finalText = await _owner._transcribeWav(wavFromPcm16(bytes, _sampleRate), lang);
        if (finalText.isNotEmpty) { _lastText = finalText; onText(finalText); }
      }
    }
    _owner.statusLine.value = '';
    Analytics.capture('stt_done', {
      'lang': lang,
      'engine': engine,
      'ms': _sw.elapsedMilliseconds,
      'chars': finalText.length,
      'ok': finalText.isNotEmpty,
      if (_firstPartialMs != null) 'first_partial_ms': _firstPartialMs!,
    });
    await _teardown();
    return finalText;
  }

  /// Abandon the session without inserting text (user cancelled).
  Future<void> cancel() async {
    _stopped = true;
    if (_useNative) {
      try { await _owner._native.cancel(); } catch (_) {}
    } else {
      await _sub?.cancel();
      _sub = null;
      try { await _rec?.stop(); } catch (_) {}
    }
    _owner.statusLine.value = '';
    Analytics.capture('stt_cancel', {'lang': lang, 'engine': engine});
    await _teardown();
  }

  Future<void> _teardown() async {
    if (!_useNative) { try { _rec?.dispose(); } catch (_) {} }
    _owner._clearActive(this);
  }
}
