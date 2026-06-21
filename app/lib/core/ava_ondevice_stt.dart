/// AvaOnDeviceStt — on-device speech-to-text (Whisper) for "Convert voice to text".
///
/// ENGINE (2026-06-21): the original Phase-2b version ran on Cactus' `CactusSTT`,
/// which was ripped out with the Cactus on-device LLM. This rebuild runs Whisper
/// fully on-device via `whisper_ggml` (whisper.cpp). It is PRIVATE (no audio leaves
/// the phone — the right fit for a local-first messenger) and multilingual, taking
/// the same language the user picked for their Kokoro voice.
///
/// LIVE DICTATION: tapping "Convert voice to text" opens a [SttSession]. We capture
/// the mic as 16 kHz PCM16 mono (same config as the translation/vision engines),
/// accumulate it, and every ~1.8 s transcribe a WAV snapshot of everything spoken
/// so far — so the text grows in the message box AS the user talks. On stop we run
/// one final transcription and return the full text. The model is loaded into
/// memory on first use (whisper-tiny, auto-downloaded + cached by the package).
///
/// Local only. No message content is sent to telemetry — only counters (ms, chars).
library;

import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/foundation.dart';
import 'package:path_provider/path_provider.dart';
import 'package:record/record.dart';
import 'package:whisper_ggml/whisper_ggml.dart';

import 'analytics.dart';
import 'ava_log.dart';

class AvaOnDeviceStt {
  AvaOnDeviceStt._();
  static final AvaOnDeviceStt I = AvaOnDeviceStt._();

  /// whisper-tiny: ~75 MB, fast on phones, good enough for dictation. (Bump to
  /// [WhisperModel.base] later if accuracy needs it.)
  static const WhisperModel kModel = WhisperModel.tiny;

  final WhisperController _whisper = WhisperController();

  /// Human-readable status for the composer ("Loading Whisper…", "Listening…").
  final ValueNotifier<String> statusLine = ValueNotifier<String>('');

  bool _modelReady = false;
  SttSession? _active;
  bool get isListening => _active != null;

  /// Make sure whisper-tiny is downloaded/cached before the first transcription.
  /// Idempotent and safe to await repeatedly. Never throws.
  Future<void> _ensureModel() async {
    if (_modelReady) return;
    try {
      statusLine.value = 'Preparing Whisper…';
      await _whisper.downloadModel(kModel);
      _modelReady = true;
    } catch (e) {
      AvaLog.I.log('ava_stt', 'model prepare failed: $e');
    }
  }

  /// Start a live dictation session. [lang] is a Whisper language code ("en",
  /// "es", …) or "auto". [onText] is called with the FULL transcript so far each
  /// time it updates — the caller replaces the message-box text with it. Returns
  /// null if the mic permission is denied or the engine fails to start.
  Future<SttSession?> startDictation({
    required String lang,
    required void Function(String fullText) onText,
  }) async {
    if (_active != null) return _active;
    await _ensureModel();
    final session = SttSession._(this, lang: lang, onText: onText);
    final ok = await session._start();
    if (!ok) return null;
    _active = session;
    Analytics.capture('stt_start', {'lang': lang, 'engine': 'whisper_ggml'});
    return session;
  }

  /// Transcribe a finished audio file once (e.g. "record audio → text" in a
  /// text-only chat). Returns '' on failure. [lang] is a Whisper code or "auto".
  Future<String> transcribeFile(String audioPath, String lang) async {
    await _ensureModel();
    return _transcribeFile(audioPath, lang);
  }

  /// Transcribe a finished WAV file once (used for the final pass and for
  /// "record audio → text"). Returns '' on failure.
  Future<String> _transcribeFile(String wavPath, String lang) async {
    try {
      final r = await _whisper.transcribe(
        model: kModel,
        audioPath: wavPath,
        lang: lang,
      );
      return (r?.transcription.text ?? '').trim();
    } catch (e) {
      AvaLog.I.log('ava_stt', 'transcribe FAILED: $e');
      return '';
    }
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

  static const int _sampleRate = 16000;

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
      // Re-transcribe the growing buffer so the box fills in as the user speaks.
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
    // Need at least ~0.4 s of audio before the first pass.
    if (bytes.length < _sampleRate * 2 * 0.4) return;
    _transcribing = true;
    try {
      final wav = await _writeWav(bytes);
      final text = await _owner._transcribeFile(wav, lang);
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
        final wav = await _writeWav(bytes);
        final text = await _owner._transcribeFile(wav, lang);
        if (text.isNotEmpty) finalText = text;
      } catch (_) {}
    }
    _lastText = finalText;
    _owner.statusLine.value = '';
    Analytics.capture('stt_done', {
      'lang': lang,
      'ms': sw.elapsedMilliseconds,
      'chars': finalText.length,
      'engine': 'whisper_ggml',
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
    Analytics.capture('stt_cancel', {'lang': lang, 'engine': 'whisper_ggml'});
    await _teardown();
  }

  Future<void> _teardown() async {
    try { _rec.dispose(); } catch (_) {}
    _owner._clearActive(this);
  }

  // Build a self-contained 16 kHz/mono/16-bit WAV from raw PCM so each snapshot
  // is a valid file Whisper can read (avoids reading a half-written stream).
  Future<String> _writeWav(Uint8List pcm) async {
    final dir = await getTemporaryDirectory();
    final path = '${dir.path}/ava_stt_live.wav';
    final f = File(path);
    await f.writeAsBytes(_wavBytes(pcm), flush: true);
    return path;
  }

  Uint8List _wavBytes(Uint8List pcm) {
    const channels = 1;
    const bitsPerSample = 16;
    final byteRate = _sampleRate * channels * bitsPerSample ~/ 8;
    final blockAlign = channels * bitsPerSample ~/ 8;
    final dataLen = pcm.length;
    final buf = BytesBuilder();
    void s(String x) => buf.add(x.codeUnits);
    void u32(int v) => buf.add(Uint8List(4)..buffer.asByteData().setUint32(0, v, Endian.little));
    void u16(int v) => buf.add(Uint8List(2)..buffer.asByteData().setUint16(0, v, Endian.little));
    s('RIFF'); u32(36 + dataLen); s('WAVE');
    s('fmt '); u32(16); u16(1); u16(channels); u32(_sampleRate); u32(byteRate); u16(blockAlign); u16(bitsPerSample);
    s('data'); u32(dataLen); buf.add(pcm);
    return buf.toBytes();
  }
}
