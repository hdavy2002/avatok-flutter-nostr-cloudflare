// TranslationEngine — live speech-to-speech translation during a call/stream.
//
// Pipeline: incoming voice (picked up by the device mic while the call plays
// on speaker — Google-Translate-conversation style; Gemini's noise robustness
// and echoTargetLanguage=false make the loop self-limiting) → 16 kHz PCM16
// chunks → Gemini Live WS (gemini-3.5-live-translate-preview, ephemeral token
// minted by the Worker — the API key never reaches the device) → translated
// 24 kHz PCM16 → local playback.
//
// Billing rides the Worker heartbeat: 5 AvaCoins/min ($3/hour). A 402 from
// start/beat pauses the engine and surfaces the matching AvaCoins pop-up.
import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/foundation.dart';
import 'package:flutter_pcm_sound/flutter_pcm_sound.dart';
import 'package:record/record.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import '../../core/analytics.dart';
import '../../core/ava_log.dart';
import 'translation_api.dart';

enum TranslationState {
  off,           // not running
  connecting,    // start() in flight
  active,        // translating
  noFunds,       // start refused — wallet empty (pop-up #1)
  fundsExhausted,// ran out mid-call (pop-up #2)
  error,         // network/Gemini failure (auto-retry or manual)
}

class TranslationEngine {
  TranslationEngine({required this.context, required this.ref});

  /// consult | live | conference
  final String context;
  /// booking id / listing id / conversation id
  final String ref;

  final ValueNotifier<TranslationState> state = ValueNotifier(TranslationState.off);
  final ValueNotifier<String?> targetLang = ValueNotifier(null);
  final ValueNotifier<int> billedMinutes = ValueNotifier(0);
  final ValueNotifier<String> lastCaption = ValueNotifier(''); // output transcript (UI chip)

  String? _sessionId;
  WebSocketChannel? _ws;
  AudioRecorder? _rec;
  StreamSubscription<Uint8List>? _micSub;
  Timer? _beat;
  Timer? _reconnect;
  bool _pcmReady = false;
  bool _disposed = false;
  String _model = 'gemini-3.5-live-translate-preview';

  bool get running => state.value == TranslationState.active || state.value == TranslationState.connecting;

  // ---------------------------------------------------------------------------
  // lifecycle
  // ---------------------------------------------------------------------------

  /// Start translating into [lang]. Returns null on success or an error code:
  /// 'insufficient_avacoins' | 'disabled' | 'failed'.
  Future<String?> start(String lang) async {
    if (running) await stop();
    state.value = TranslationState.connecting;
    targetLang.value = lang;

    final r = await TranslationApi.start(context: context, ref: ref, targetLang: lang);
    final status = (r['status'] as num?)?.toInt() ?? 0;
    if (status == 402) {
      state.value = TranslationState.noFunds;
      return 'insufficient_avacoins';
    }
    if (status != 200) {
      state.value = TranslationState.off;
      return status == 503 ? 'disabled' : 'failed';
    }
    _sessionId = r['session_id']?.toString();
    _model = r['model']?.toString() ?? _model;
    final beatSec = (r['beat_every_sec'] as num?)?.toInt() ?? 300;
    billedMinutes.value = (r['billed_min'] as num?)?.toInt() ?? 0;

    final ok = await _connect(r['token']?.toString() ?? '');
    if (!ok) { state.value = TranslationState.error; return 'failed'; }

    _beat?.cancel();
    _beat = Timer.periodic(Duration(seconds: beatSec), (_) => _heartbeat());
    state.value = TranslationState.active;
    Analytics.capture('translation_started_client', {'context': context, 'lang': lang});
    return null;
  }

  /// After a successful wallet top-up: resume billing + audio.
  Future<bool> resume() async {
    final id = _sessionId;
    if (id == null) return false;
    final r = await TranslationApi.beat(id);
    if ((r['status'] as num?)?.toInt() != 200) return false;
    billedMinutes.value = (r['billed_min'] as num?)?.toInt() ?? billedMinutes.value;
    if (_ws == null) {
      final t = await TranslationApi.token(id);
      if ((t['status'] as num?)?.toInt() == 200) await _connect(t['token']?.toString() ?? '');
    }
    await _startMic();
    state.value = TranslationState.active;
    return true;
  }

  Future<void> stop() async {
    _beat?.cancel(); _beat = null;
    _reconnect?.cancel(); _reconnect = null;
    await _stopMic();
    try { await _ws?.sink.close(); } catch (_) {}
    _ws = null;
    if (_pcmReady) { try { await FlutterPcmSound.release(); } catch (_) {} _pcmReady = false; }
    final id = _sessionId; _sessionId = null;
    if (id != null) {
      try { await TranslationApi.stop(id); } catch (_) {}
      Analytics.capture('translation_stopped_client', {'context': context, 'minutes': billedMinutes.value});
    }
    if (!_disposed) state.value = TranslationState.off;
  }

  void dispose() {
    _disposed = true;
    stop();
    state.dispose(); targetLang.dispose(); billedMinutes.dispose(); lastCaption.dispose();
  }

  // ---------------------------------------------------------------------------
  // billing heartbeat
  // ---------------------------------------------------------------------------
  Future<void> _heartbeat() async {
    final id = _sessionId;
    if (id == null) return;
    try {
      final r = await TranslationApi.beat(id);
      final status = (r['status'] as num?)?.toInt() ?? 0;
      if (status == 402) {
        // AvaCoins exhausted mid-call → pause audio, surface pop-up #2.
        await _stopMic();
        state.value = TranslationState.fundsExhausted;
        return;
      }
      if (status == 200) billedMinutes.value = (r['billed_min'] as num?)?.toInt() ?? billedMinutes.value;
    } catch (e) {
      AvaLog.I.log('translate', 'heartbeat failed: $e'); // metering retries next tick
    }
  }

  // ---------------------------------------------------------------------------
  // Gemini Live WS
  // ---------------------------------------------------------------------------
  Future<bool> _connect(String token) async {
    if (token.isEmpty) return false;
    try {
      final uri = Uri.parse(
        'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?access_token=${Uri.encodeComponent(token)}',
      );
      final ws = WebSocketChannel.connect(uri);
      _ws = ws;
      // Config (language, modalities, transcripts) is LOCKED into the ephemeral
      // token's constraints server-side — setup only names the model.
      ws.sink.add(jsonEncode({'setup': {'model': 'models/$_model'}}));
      ws.stream.listen(_onMessage, onError: (e) => _onSocketDown('error: $e'), onDone: () => _onSocketDown('closed'));
      await _setupPcm();
      await _startMic();
      return true;
    } catch (e) {
      AvaLog.I.log('translate', 'ws connect failed: $e');
      return false;
    }
  }

  void _onMessage(dynamic raw) {
    try {
      final text = raw is String ? raw : utf8.decode(raw as List<int>);
      final m = (jsonDecode(text) as Map).cast<String, dynamic>();
      final content = (m['serverContent'] as Map?)?.cast<String, dynamic>();
      if (content == null) return;
      final outT = (content['outputTranscription'] as Map?)?['text']?.toString();
      if (outT != null && outT.isNotEmpty) lastCaption.value = outT;
      final parts = ((content['modelTurn'] as Map?)?['parts'] as List?) ?? const [];
      for (final p in parts) {
        final inline = ((p as Map)['inlineData'] as Map?);
        final data = inline?['data']?.toString();
        if (data != null && data.isNotEmpty) _playPcm(base64Decode(data));
      }
    } catch (_) {/* non-JSON keepalives are fine */}
  }

  void _onSocketDown(String why) {
    if (_disposed || _sessionId == null || state.value != TranslationState.active) return;
    AvaLog.I.log('translate', 'gemini ws down ($why) — reconnecting');
    _ws = null;
    // Live connections cap at ~10 min → mint a fresh token and reconnect.
    _reconnect?.cancel();
    _reconnect = Timer(const Duration(seconds: 1), () async {
      final id = _sessionId;
      if (id == null || state.value != TranslationState.active) return;
      final t = await TranslationApi.token(id);
      if ((t['status'] as num?)?.toInt() == 200) {
        await _stopMic();
        await _connect(t['token']?.toString() ?? '');
      } else {
        state.value = TranslationState.error;
      }
    });
  }

  // ---------------------------------------------------------------------------
  // audio in (16 kHz PCM16 mono mic stream) / out (24 kHz PCM16 playback)
  // ---------------------------------------------------------------------------
  Future<void> _startMic() async {
    if (_micSub != null) return;
    try {
      _rec ??= AudioRecorder();
      final stream = await _rec!.startStream(const RecordConfig(
        encoder: AudioEncoder.pcm16bits, sampleRate: 16000, numChannels: 1,
        echoCancel: true, noiseSuppress: true,
      ));
      _micSub = stream.listen((chunk) {
        final ws = _ws;
        if (ws == null || chunk.isEmpty) return;
        try {
          ws.sink.add(jsonEncode({
            'realtimeInput': {
              'audio': {'data': base64Encode(chunk), 'mimeType': 'audio/pcm;rate=16000'},
            },
          }));
        } catch (_) {}
      });
    } catch (e) {
      AvaLog.I.log('translate', 'mic stream failed: $e');
      state.value = TranslationState.error;
    }
  }

  Future<void> _stopMic() async {
    await _micSub?.cancel(); _micSub = null;
    try { await _rec?.stop(); } catch (_) {}
  }

  Future<void> _setupPcm() async {
    if (_pcmReady) return;
    try {
      await FlutterPcmSound.setup(sampleRate: 24000, channelCount: 1);
      FlutterPcmSound.setFeedThreshold(0); // we push as chunks arrive
      _pcmReady = true;
    } catch (e) {
      AvaLog.I.log('translate', 'pcm setup failed: $e');
    }
  }

  void _playPcm(Uint8List bytes) {
    if (!_pcmReady) return;
    try {
      final samples = Int16List.view(bytes.buffer, bytes.offsetInBytes, bytes.lengthInBytes ~/ 2);
      FlutterPcmSound.feed(PcmArrayInt16(bytes: samples.buffer.asByteData()));
    } catch (_) {}
  }
}
