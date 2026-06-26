/// AvaStt — speech-to-text for "Convert voice to text".
///
/// ENGINE (2026-06-26): CLOUD Whisper via OpenRouter, behind our Worker
/// (`POST /api/stt/transcribe`). This REPLACED the on-device sherpa-onnx Whisper
/// stack, which shipped a ~30 MB native runtime in the APK and downloaded ~130 MB
/// of model files on first use — both now gone. The key stays server-side; no
/// audio is persisted.
///
/// DICTATION: a [SttSession] captures the mic as 16 kHz PCM16 mono into a buffer.
/// Unlike the old on-device engine there is no cheap streaming partial pass, so
/// transcription is a single request at stop(): we wrap the captured PCM as a WAV
/// clip, send it once, and return the text. The composer shows "Listening…" while
/// recording, then "Transcribing…" briefly. The public API is unchanged from the
/// sherpa build (the global is still `AvaOnDeviceStt.I`) so the chat composers
/// keep working without edits. Only counters go to telemetry, never transcript text.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/foundation.dart';
import 'package:record/record.dart';

import 'analytics.dart';
import 'api_auth.dart';
import 'ava_log.dart';
import 'config.dart';

class AvaOnDeviceStt {
  AvaOnDeviceStt._();
  static final AvaOnDeviceStt I = AvaOnDeviceStt._();

  static const int sampleRate = 16000; // 16 kHz mono PCM16

  /// Human-readable status for the composer ("Listening…", "Transcribing…").
  final ValueNotifier<String> statusLine = ValueNotifier<String>('');

  SttSession? _active;
  bool get isListening => _active != null;

  /// Start a dictation session. [lang] is a Whisper language code ("en", "es", …)
  /// or "" / "auto" for auto-detect. [onText] is called once with the final
  /// transcript when stop() resolves. Returns null on mic-denied / failure.
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
    Analytics.capture('stt_start', {'lang': lang, 'engine': 'openrouter_whisper'});
    return session;
  }

  /// One-shot transcription of a buffer of 16 kHz PCM16 bytes. '' on failure.
  Future<String> transcribePcm16(Uint8List pcm16, String lang) =>
      _transcribeWav(wavFromPcm16(pcm16, sampleRate), lang);

  void _clearActive(SttSession s) {
    if (identical(_active, s)) _active = null;
  }

  /// POST a WAV clip to the Worker → OpenRouter Whisper. Returns '' on any error.
  Future<String> _transcribeWav(Uint8List wav, String lang) async {
    try {
      final body = <String, dynamic>{
        'audio': base64Encode(wav),
        'format': 'wav',
      };
      final l = lang.trim();
      if (l.isNotEmpty && l != 'auto') body['lang'] = l;
      final r = await ApiAuth.postJson('$kApiBase/stt/transcribe', body,
          timeout: const Duration(seconds: 45));
      if (r.statusCode != 200) {
        AvaLog.I.log('ava_stt', 'transcribe HTTP ${r.statusCode}: ${r.body}');
        return '';
      }
      final decoded = jsonDecode(r.body);
      if (decoded is Map && decoded['text'] is String) return decoded['text'] as String;
      return '';
    } catch (e) {
      AvaLog.I.log('ava_stt', 'transcribe FAILED: $e');
      return '';
    }
  }
}

/// Wrap raw little-endian PCM16 mono samples in a minimal 44-byte WAV header so
/// Whisper sees a well-formed file. No extra dependency — just the canonical
/// RIFF/WAVE layout.
Uint8List wavFromPcm16(Uint8List pcm, int sampleRate, {int channels = 1}) {
  const bitsPerSample = 16;
  final byteRate = sampleRate * channels * bitsPerSample ~/ 8;
  final blockAlign = channels * bitsPerSample ~/ 8;
  final dataLen = pcm.lengthInBytes;
  final out = BytesBuilder();
  void str(String s) => out.add(ascii.encode(s));
  void u32(int v) {
    final b = ByteData(4)..setUint32(0, v, Endian.little);
    out.add(b.buffer.asUint8List());
  }
  void u16(int v) {
    final b = ByteData(2)..setUint16(0, v, Endian.little);
    out.add(b.buffer.asUint8List());
  }

  str('RIFF');
  u32(36 + dataLen);
  str('WAVE');
  str('fmt ');
  u32(16); // PCM fmt chunk size
  u16(1); // audio format = PCM
  u16(channels);
  u32(sampleRate);
  u32(byteRate);
  u16(blockAlign);
  u16(bitsPerSample);
  str('data');
  u32(dataLen);
  out.add(pcm);
  return out.toBytes();
}

/// A single dictation session. Created via [AvaOnDeviceStt.startDictation].
class SttSession {
  SttSession._(this._owner, {required this.lang, required this.onText});

  final AvaOnDeviceStt _owner;
  final String lang;
  final void Function(String fullText) onText;

  final AudioRecorder _rec = AudioRecorder();
  final BytesBuilder _pcm = BytesBuilder(copy: false);
  StreamSubscription<Uint8List>? _sub;
  bool _stopped = false;
  String _lastText = '';

  static const int _sampleRate = AvaOnDeviceStt.sampleRate;

  Future<bool> _start() async {
    try {
      if (!await _rec.hasPermission()) {
        _owner.statusLine.value = 'Microphone permission needed';
        Analytics.capture('stt_unavailable', {'lang': lang, 'reason': 'no_permission'});
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
      return true;
    } catch (e) {
      AvaLog.I.log('ava_stt', 'start FAILED: $e');
      Analytics.capture('stt_unavailable', {'lang': lang, 'reason': 'start_error', 'error': e.toString()});
      _owner.statusLine.value = 'Voice-to-text failed to start';
      await _teardown();
      return false;
    }
  }

  /// Stop listening, transcribe the captured clip in the cloud, return the text.
  Future<String> stop() async {
    if (_stopped) return _lastText;
    _stopped = true;
    final sw = Stopwatch()..start();
    await _sub?.cancel();
    _sub = null;
    try { await _rec.stop(); } catch (_) {}
    final bytes = _pcm.toBytes();
    String finalText = '';
    // Need ~0.3 s of audio to be worth a request.
    if (bytes.length >= _sampleRate * 2 * 0.3) {
      _owner.statusLine.value = 'Transcribing…';
      final wav = wavFromPcm16(bytes, _sampleRate);
      finalText = await _owner._transcribeWav(wav, lang);
      if (finalText.isNotEmpty) {
        _lastText = finalText;
        onText(finalText);
      }
    }
    _owner.statusLine.value = '';
    Analytics.capture('stt_done', {
      'lang': lang,
      'ms': sw.elapsedMilliseconds,
      'chars': finalText.length,
      'engine': 'openrouter_whisper',
    });
    await _teardown();
    return finalText;
  }

  /// Abandon the session without inserting text (user cancelled).
  Future<void> cancel() async {
    _stopped = true;
    await _sub?.cancel();
    _sub = null;
    try { await _rec.stop(); } catch (_) {}
    _owner.statusLine.value = '';
    Analytics.capture('stt_cancel', {'lang': lang, 'engine': 'openrouter_whisper'});
    await _teardown();
  }

  Future<void> _teardown() async {
    try { _rec.dispose(); } catch (_) {}
    _owner._clearActive(this);
  }
}
