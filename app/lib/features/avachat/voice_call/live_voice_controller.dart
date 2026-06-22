/// LiveVoiceController — the FAST online "Voice call Ava": Gemini Live native
/// audio. Mints an ephemeral token (model + Ava persona + voice locked
/// server-side via /api/ava/live/token), connects DIRECTLY to the Gemini Live
/// websocket, streams the mic up (PCM16/16k) and plays Ava's audio down
/// (PCM/24k). Sub-second latency; barge-in handled natively by Gemini Live.
///
/// Implements [VoiceCallApi] so [VoiceCallScreen] drives it exactly like the
/// on-device controller. Mirrors the proven pattern in
/// features/translation/translation_engine.dart.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/foundation.dart';
import 'package:flutter_pcm_sound/flutter_pcm_sound.dart';
import 'package:record/record.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import '../../../core/analytics.dart';
import '../../../core/ava_live_api.dart';
import '../../../core/ava_log.dart';
import 'voice_call_api.dart';

class LiveVoiceController implements VoiceCallApi {
  LiveVoiceController();

  @override
  final ValueNotifier<CallState> state = ValueNotifier<CallState>(CallState.preparing);
  @override
  final ValueNotifier<String> status = ValueNotifier<String>('Connecting…');
  @override
  final ValueNotifier<String> userCaption = ValueNotifier<String>('');
  @override
  final ValueNotifier<String> avaCaption = ValueNotifier<String>('');
  @override
  final ValueNotifier<bool> avaSpeaking = ValueNotifier<bool>(false);

  WebSocketChannel? _ws;
  String _model = 'gemini-live-2.5-flash-native-audio';
  AudioRecorder? _rec;
  StreamSubscription<Uint8List>? _micSub;
  bool _pcmReady = false;
  bool _disposed = false;
  bool _paused = false;
  bool _greeted = false;
  int _reconnects = 0;
  DateTime? _connectedAt;
  Timer? _reconnect;

  /// Pause the call (the 5-minute "still there?" guardrail): stop sending mic and
  /// drop incoming audio so no tokens are billed while we wait for the user.
  Future<void> pause() async {
    if (_disposed || _paused) return;
    _paused = true;
    await _stopMic();
    status.value = 'Paused';
    avaSpeaking.value = false;
  }

  /// Resume after the user taps Continue.
  Future<void> resume() async {
    if (_disposed || !_paused) return;
    _paused = false;
    await _startMic();
    _setListening();
  }

  @override
  Future<bool> start() async {
    state.value = CallState.preparing;
    status.value = 'Connecting to Ava…';
    final t = await AvaLiveApi.token();
    if (_disposed) return false;
    if ((t['status'] as num?)?.toInt() != 200 || (t['token'] ?? '').toString().isEmpty) {
      _fail(t['error']?.toString() ?? 'Could not start the call');
      return false;
    }
    _model = t['model']?.toString() ?? _model;
    final ok = await _connect(t['token'].toString());
    if (ok) Analytics.capture('voice_live_start', {'model': _model});
    return ok;
  }

  void _fail(String msg) {
    state.value = CallState.error;
    status.value = msg;
  }

  Future<bool> _connect(String token) async {
    if (token.isEmpty || _disposed) return false;
    try {
      final uri = Uri.parse(
        'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?access_token=${Uri.encodeComponent(token)}',
      );
      final ws = WebSocketChannel.connect(uri);
      _ws = ws;
      _connectedAt = DateTime.now();
      // The ephemeral token already carries the full bidiGenerateContentSetup
      // (model, voice, persona, transcription, compression), so the client's setup
      // is IGNORED — send an EMPTY setup (the protocol still needs a first frame).
      ws.sink.add(jsonEncode({'setup': <String, dynamic>{}}));
      ws.stream.listen(_onMessage, onError: (e) => _onSocketDown('error: $e'), onDone: () => _onSocketDown('closed'));
      await _setupPcm();
      await _startMic();
      // Stay "Connecting…" until the server confirms setupComplete; only then do we
      // greet + listen (sending audio/turns before that can get the session closed).
      status.value = 'Connecting…';
      return true;
    } catch (e) {
      AvaLog.I.log('voice_live', 'ws connect failed: $e');
      _fail('Could not reach Ava');
      return false;
    }
  }

  void _setListening() {
    if (_disposed) return;
    avaSpeaking.value = false;
    state.value = CallState.listening;
    status.value = 'Listening…';
  }

  void _onMessage(dynamic raw) {
    if (_disposed) return;
    try {
      final text = raw is String ? raw : utf8.decode(raw as List<int>);
      final m = (jsonDecode(text) as Map).cast<String, dynamic>();
      // Session is ready → greet (Ava speaks first) and start listening.
      if (m.containsKey('setupComplete')) {
        _reconnects = 0;
        _sendGreeting();
        _setListening();
        return;
      }
      final content = (m['serverContent'] as Map?)?.cast<String, dynamic>();
      if (content == null) return;
      // Live captions: what the user said + what Ava is saying.
      final inT = (content['inputTranscription'] as Map?)?['text']?.toString();
      if (inT != null && inT.isNotEmpty) userCaption.value = inT;
      final outT = (content['outputTranscription'] as Map?)?['text']?.toString();
      if (outT != null && outT.isNotEmpty) avaCaption.value = outT;
      // Ava's audio.
      final parts = ((content['modelTurn'] as Map?)?['parts'] as List?) ?? const [];
      var gotAudio = false;
      for (final p in parts) {
        final inline = ((p as Map)['inlineData'] as Map?);
        final data = inline?['data']?.toString();
        if (data != null && data.isNotEmpty) { _playPcm(base64Decode(data)); gotAudio = true; }
      }
      if (gotAudio && state.value != CallState.speaking) {
        state.value = CallState.speaking;
        avaSpeaking.value = true;
        status.value = 'Ava is speaking…';
      }
      // Barge-in: Gemini signals it when the user talks over Ava.
      if (content['interrupted'] == true) _setListening();
      if (content['turnComplete'] == true) _setListening();
    } catch (_) {/* non-JSON keepalives are fine */}
  }

  // Once the session is live, make Ava speak first (the system prompt already has
  // the user's name, so she greets by name). Native-audio models stay silent until
  // prompted, so without this the call would just sit on "Listening…".
  void _sendGreeting() {
    if (_greeted || _disposed) return;
    _greeted = true;
    try {
      _ws?.sink.add(jsonEncode({
        'clientContent': {
          'turns': [
            {'role': 'user', 'parts': [{'text': 'Greet me warmly by my name and ask how you can help — one short sentence.'}]}
          ],
          'turnComplete': true,
        }
      }));
    } catch (_) {}
  }

  void _onSocketDown(String why) {
    if (_disposed || state.value == CallState.ended) return;
    final code = _ws?.closeCode;
    final reason = _ws?.closeReason;
    final upMs = _connectedAt == null ? -1 : DateTime.now().difference(_connectedAt!).inMilliseconds;
    AvaLog.I.log('voice_live', 'gemini ws down ($why) code=$code reason=$reason up=${upMs}ms');
    Analytics.capture('voice_live_ws_closed', {
      'code': code ?? -1,
      'reason': (reason ?? '').toString(),
      'up_ms': upMs,
      'reconnects': _reconnects,
    });
    _ws = null;
    // If the socket dies almost immediately, it's a setup/config rejection, not a
    // timeout — looping would just spam. Only reconnect for a genuinely live
    // session that dropped, and cap the attempts.
    final wasLive = upMs > 4000;
    if (!wasLive || _reconnects >= 3) {
      _fail(wasLive ? 'Connection lost' : 'Couldn’t connect to Ava — please try again.');
      return;
    }
    _reconnects++;
    _greeted = false;
    _reconnect?.cancel();
    _reconnect = Timer(const Duration(seconds: 1), () async {
      if (_disposed) return;
      final t = await AvaLiveApi.token();
      if (!_disposed && (t['status'] as num?)?.toInt() == 200) {
        await _stopMic();
        await _connect(t['token']?.toString() ?? '');
      } else if (!_disposed) {
        _fail('Connection lost');
      }
    });
  }

  // ── audio in (mic 16k PCM16) / out (Gemini 24k PCM16) ───────────────────────

  Future<void> _startMic() async {
    if (_micSub != null) return;
    try {
      _rec ??= AudioRecorder();
      if (!await _rec!.hasPermission()) { _fail('Microphone permission needed'); return; }
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
      AvaLog.I.log('voice_live', 'mic stream failed: $e');
      _fail('Microphone failed to start');
    }
  }

  Future<void> _stopMic() async {
    await _micSub?.cancel();
    _micSub = null;
    try { await _rec?.stop(); } catch (_) {}
  }

  Future<void> _setupPcm() async {
    if (_pcmReady) return;
    try {
      await FlutterPcmSound.setup(sampleRate: 24000, channelCount: 1);
      FlutterPcmSound.setFeedThreshold(0);
      _pcmReady = true;
    } catch (e) {
      AvaLog.I.log('voice_live', 'pcm setup failed: $e');
    }
  }

  void _playPcm(Uint8List bytes) {
    if (!_pcmReady || _disposed || _paused) return;
    try {
      final samples = Int16List.view(bytes.buffer, bytes.offsetInBytes, bytes.lengthInBytes ~/ 2);
      FlutterPcmSound.feed(PcmArrayInt16(bytes: samples.buffer.asByteData()));
    } catch (_) {}
  }

  @override
  Future<void> dispose() async {
    if (_disposed) return;
    _disposed = true;
    state.value = CallState.ended;
    Analytics.capture('voice_live_end', const <String, Object>{});
    _reconnect?.cancel();
    await _stopMic();
    try { await _ws?.sink.close(); } catch (_) {}
    _ws = null;
    try { if (_pcmReady) await FlutterPcmSound.release(); } catch (_) {}
    _pcmReady = false;
  }
}
