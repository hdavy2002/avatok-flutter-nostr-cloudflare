/// VoiceCallController — the hands-free "Voice call Ava" loop.
///
/// Fully local except the reasoning: Silero VAD hears the user, Whisper turns
/// speech into text, Gemini (online) replies, Kokoro speaks the reply on-device —
/// then it listens again. The user can interrupt Ava (barge-in) by speaking.
///
/// Turn cycle:
///   listening → (VAD emits an utterance) → thinking (STT + Gemini) →
///   speaking (Kokoro TTS playback) → listening …
///
/// Everything degrades gracefully: if a model isn't ready or a step fails, the
/// call surfaces an error line instead of crashing. Reasoning uses
/// [AvaAiClient.ask] with a short spoken-style system prompt + rolling history.
library;

import 'dart:async';
import 'dart:typed_data';

import 'package:audioplayers/audioplayers.dart';
import 'package:flutter/foundation.dart';
import 'package:record/record.dart';

import '../../../core/analytics.dart';
import '../../../core/ava_ai_client.dart';
import '../../../core/ava_log.dart';
import '../../../core/kokoro_voice.dart';
import '../../../core/voice/kokoro_tts.dart';
import '../../../core/voice/sherpa_voice_engine.dart';

enum CallState { preparing, listening, thinking, speaking, error, ended }

class VoiceCallController {
  VoiceCallController();

  static const _system =
      'You are Ava, a warm, concise voice companion talking to the user hands-free. '
      'Reply in a natural spoken style, short (1–3 sentences), no markdown, no lists, '
      'no emojis. You can role-play characters or give advice when asked. If you did '
      'not understand, ask the user to repeat briefly.';

  final ValueNotifier<CallState> state = ValueNotifier<CallState>(CallState.preparing);
  final ValueNotifier<String> status = ValueNotifier<String>('Warming up…');
  final ValueNotifier<String> userCaption = ValueNotifier<String>('');
  final ValueNotifier<String> avaCaption = ValueNotifier<String>('');
  /// True while Ava is the active talker (drives the orb animation target).
  final ValueNotifier<bool> avaSpeaking = ValueNotifier<bool>(false);

  final AudioRecorder _rec = AudioRecorder();
  final AudioPlayer _player = AudioPlayer();
  StreamSubscription<Uint8List>? _micSub;

  final List<Map<String, String>> _history = [];
  final List<Float32List> _queue = [];
  Uint8List _carry = Uint8List(0);
  bool _turnBusy = false;
  bool _disposed = false;

  String get _sttLang => KokoroVoicePref.current.sttLang;
  int get _sid => KokoroVoicePref.current.sid;

  /// Download models if needed, then start listening. Returns false on failure.
  Future<bool> start() async {
    state.value = CallState.preparing;
    status.value = 'Preparing voice…';
    // STT + VAD first (small), then TTS (large Kokoro download on first call).
    final sttOk = await SherpaVoiceEngine.I.ensureStt(lang: _sttLang);
    final vadOk = await SherpaVoiceEngine.I.ensureVad();
    if (!sttOk || !vadOk) { _fail('Voice models unavailable'); return false; }
    status.value = 'Preparing Ava’s voice…';
    await SherpaVoiceEngine.I.ensureTts(); // best-effort; call still works text-side

    if (!await _rec.hasPermission()) { _fail('Microphone permission needed'); return false; }
    try {
      _player.onPlayerComplete.listen((_) { if (!_disposed) _onAvaDone(); });
      final stream = await _rec.startStream(const RecordConfig(
        encoder: AudioEncoder.pcm16bits,
        sampleRate: SherpaVoiceEngine.sampleRate,
        numChannels: 1,
        echoCancel: true,
        noiseSuppress: true,
      ));
      _micSub = stream.listen(_onMic, onError: (_) {});
      _setListening();
      Analytics.capture('voice_call_start', {'lang': _sttLang, 'sid': _sid});
      return true;
    } catch (e) {
      AvaLog.I.log('voice_call', 'start FAILED: $e');
      _fail('Could not start the call');
      return false;
    }
  }

  void _setListening() {
    if (_disposed) return;
    avaSpeaking.value = false;
    state.value = CallState.listening;
    status.value = 'Listening…';
  }

  void _fail(String msg) {
    state.value = CallState.error;
    status.value = msg;
  }

  // Feed the mic to the VAD in 512-sample (1024-byte) windows; drain utterances.
  void _onMic(Uint8List chunk) {
    if (_disposed || chunk.isEmpty) return;
    // append to carry
    final merged = Uint8List(_carry.length + chunk.length)
      ..setRange(0, _carry.length, _carry)
      ..setRange(_carry.length, _carry.length + chunk.length, chunk);
    var offset = 0;
    const winBytes = SherpaVoiceEngine.vadWindow * 2; // 512 samples * 2 bytes
    while (merged.length - offset >= winBytes) {
      final window = Uint8List.sublistView(merged, offset, offset + winBytes);
      SherpaVoiceEngine.I.vadAccept(SherpaVoiceEngine.pcm16ToFloat32(window));
      offset += winBytes;
    }
    _carry = Uint8List.sublistView(merged, offset);

    switch (state.value) {
      case CallState.speaking:
        // Barge-in: the user starts talking over Ava → stop playback, reset and
        // listen fresh. Drop segments captured during playback (likely echo of
        // Ava's own voice) so she never answers herself.
        if (SherpaVoiceEngine.I.vadDetected()) {
          _player.stop();
          Analytics.capture('voice_call_bargein', const <String, Object>{});
          _bargeIn();
        }
        SherpaVoiceEngine.I.vadDrain();
        break;
      case CallState.listening:
        for (final seg in SherpaVoiceEngine.I.vadDrain()) {
          _queue.add(seg);
        }
        _drainQueue();
        break;
      default:
        // thinking / preparing / error — don't capture; clear any stray segments.
        SherpaVoiceEngine.I.vadDrain();
    }
  }

  void _bargeIn() {
    SherpaVoiceEngine.I.vadReset();
    _queue.clear();
    _setListening();
  }

  Future<void> _drainQueue() async {
    if (_turnBusy || _disposed || _queue.isEmpty) return;
    _turnBusy = true;
    final samples = _queue.removeAt(0);
    try {
      await _handleTurn(samples);
    } catch (e) {
      AvaLog.I.log('voice_call', 'turn FAILED: $e');
      _setListening();
    } finally {
      _turnBusy = false;
      if (!_disposed && _queue.isNotEmpty) _drainQueue();
    }
  }

  Future<void> _handleTurn(Float32List samples) async {
    if (_disposed) return;
    final turnSw = Stopwatch()..start();
    state.value = CallState.thinking;
    status.value = 'Thinking…';
    // STT (on-device Whisper)
    final sttSw = Stopwatch()..start();
    final text = await SherpaVoiceEngine.I.transcribe(samples, lang: _sttLang);
    final sttMs = sttSw.elapsedMilliseconds;
    if (text.trim().isEmpty) { _setListening(); return; }
    userCaption.value = text;
    avaCaption.value = '';
    _history.add({'role': 'user', 'text': text});

    // LLM (Gemini 2.5-flash, thinking OFF server-side — speed-first)
    final llmSw = Stopwatch()..start();
    final ans = await AvaAiClient.I.ask(
      message: text,
      context: _system,
      history: _trimHistory(),
    );
    final llmMs = llmSw.elapsedMilliseconds;
    if (_disposed) return;
    final reply = ans.answer.trim();
    if (reply.isEmpty) { _setListening(); return; }
    avaCaption.value = reply;
    _history.add({'role': 'model', 'text': reply});

    await _speak(reply,
        sttMs: sttMs, llmMs: llmMs, userChars: text.length, turnSw: turnSw, blocked: ans.blocked);
  }

  Future<void> _speak(String text,
      {int sttMs = 0, int llmMs = 0, int userChars = 0, Stopwatch? turnSw, bool blocked = false}) async {
    if (_disposed) return;
    // TTS (on-device Supertonic synth → wav). Measure synth separately from playback.
    final ttsSw = Stopwatch()..start();
    final path = await KokoroTts.speakToFile(text);
    final ttsMs = ttsSw.elapsedMilliseconds;
    // Rich per-turn latency — speed is everything in a voice call.
    Analytics.capture('voice_call_turn_timing', {
      'stt_ms': sttMs,
      'llm_ms': llmMs,
      'tts_ms': ttsMs,
      'total_ms': turnSw?.elapsedMilliseconds ?? (sttMs + llmMs + ttsMs),
      'user_chars': userChars,
      'ava_chars': text.length,
      'blocked': blocked,
      'spoke': path != null,
    });
    if (_disposed) return;
    if (path == null) {
      // No voice model yet — keep the conversation going text-side.
      status.value = 'Voice still downloading…';
      _setListening();
      return;
    }
    state.value = CallState.speaking;
    avaSpeaking.value = true;
    status.value = 'Ava is speaking…';
    try {
      await _player.play(DeviceFileSource(path));
    } catch (_) {
      _onAvaDone();
    }
  }

  void _onAvaDone() {
    if (_disposed) return;
    if (state.value == CallState.speaking || avaSpeaking.value) _setListening();
  }

  List<Map<String, String>> _trimHistory() {
    const max = 10;
    return _history.length <= max ? List.of(_history) : _history.sublist(_history.length - max);
  }

  Future<void> dispose() async {
    if (_disposed) return;
    _disposed = true;
    state.value = CallState.ended;
    Analytics.capture('voice_call_end', {'turns': _history.length ~/ 2});
    await _micSub?.cancel();
    try { await _rec.stop(); } catch (_) {}
    try { await _rec.dispose(); } catch (_) {}
    try { await _player.stop(); } catch (_) {}
    try { await _player.dispose(); } catch (_) {}
    // Free the native models so the call's RAM is released; the on-disk cache
    // stays, so the next call reloads instantly.
    SherpaVoiceEngine.I.releaseAll();
  }
}
