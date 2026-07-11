import 'dart:async';
import 'dart:collection';
import 'dart:convert';
import 'dart:typed_data';

import 'package:audioplayers/audioplayers.dart';
import 'package:record/record.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import 'analytics.dart';
import 'api_auth.dart';
import 'ava_log.dart';
import 'config.dart';
import 'receptionist_api.dart' show ReceptionistApi;
import 'voice/native_voice_audio.dart';

/// AgentVoiceCall — caller-side bridge for the Ava AI Voice Agent (Phase C,
/// Specs/PLAN-2026-07-11-dialpad-business-calls-ava-voice-agent.md §4/§8,
/// worker/src/do/agent_voice_room.ts). Structurally a sibling of
/// core/voicemail_call.dart's VoicemailCall — ONE WS carrying PCM16 mic audio
/// up and PCM16 agent audio down — with two deliberate differences:
///
///  1. SAMPLE RATE: the AgentVoiceRoom DO configures its Grok realtime session
///     via lib/grok.ts buildSessionUpdate() with the DEFAULT rate (16000) for
///     BOTH directions, so playback here is 16 kHz — NOT the 24 kHz the
///     voicemail/receptionist bots emit. Getting this wrong = chipmunk audio.
///  2. CONTROL FRAMES: the DO sends `{t:"agent_fail", reason:"GROK_SESSION_FAIL",
///     fallback:"voicemail"}` when the Grok session can't start (no key /
///     connect error / closed before first response — agent_voice_room.ts
///     failSessionStart). [done] then completes with 'agent_fail' so the UI
///     can fall back to the voicemail flow instead of dead air.
///
/// The conversation itself (greeting with the mandatory AI disclosure, RAG,
/// tools, wrap-up nudge, hard cap) is entirely server-driven; this class only
/// moves audio and reports status.
class AgentVoiceCall {
  AgentVoiceCall({required this.rtcUrl});

  final String rtcUrl;

  /// 'connecting' | 'connected' | 'ended'
  void Function(String status)? onStatus;

  final NativeVoiceAudio _native = NativeVoiceAudio();
  bool _useNative = false;
  StreamSubscription<Uint8List>? _nativeMicSub;

  final AudioRecorder _rec = AudioRecorder();
  final AudioPlayer _player = AudioPlayer();
  final Queue<Uint8List> _playQueue = Queue<Uint8List>();
  final BytesBuilder _pcmBuf = BytesBuilder(copy: false);
  bool _playing = false;
  StreamSubscription? _micSub;
  StreamSubscription? _playSub;

  WebSocketChannel? _ws;
  StreamSubscription? _wsSub;
  bool _ended = false;
  final Completer<String> _done = Completer<String>();

  /// Completes with the end reason: 'caller_hangup' | 'closed' | 'error' |
  /// 'no_mic' | 'agent_fail'. 'agent_fail' means the server told us to fall
  /// back to voicemail (GROK_SESSION_FAIL).
  Future<String> get done => _done.future;

  // Grok output is 16 kHz PCM16 (see class comment) — ~0.4s per fallback segment.
  static const int _playRate = 16000;
  static const int _flushBytes = _playRate * 2 * 2 ~/ 5;

  /// Connects and starts streaming. Returns true once the WS + mic are up
  /// (the agent's greeting streams in async after Grok session setup).
  Future<bool> start() async {
    try {
      onStatus?.call('connecting');
      _ws = WebSocketChannel.connect(Uri.parse(ReceptionistApi.wsUrl(rtcUrl)));
      _wsSub = _ws!.stream.listen(_onWs, onDone: () => _finish('closed'), onError: (_) => _finish('error'));
      final micOk = await _startAudio();
      if (!micOk) {
        await _finish('no_mic');
        return false;
      }
      onStatus?.call('connected');
      Analytics.capture('agent_call_started', {'engine': _useNative ? 'native' : 'fallback'});
      AvaLog.I.log('agent_voice', 'started engine=${_useNative ? "native" : "fallback"}');
      return true;
    } catch (e) {
      AvaLog.I.log('agent_voice', 'start failed: $e');
      await _finish('error');
      return false;
    }
  }

  Future<bool> _startAudio() async {
    if (NativeVoiceAudio.isSupported) {
      final res = await _native.start(micSampleRate: 16000, playSampleRate: _playRate, speaker: false);
      _useNative = res['ok'] == true;
      if (_useNative) {
        _nativeMicSub = _native.micStream().listen(_sendMic);
        return true;
      }
    }
    if (!await _rec.hasPermission()) return false;
    final mic = await _rec.startStream(const RecordConfig(
      encoder: AudioEncoder.pcm16bits, sampleRate: 16000, numChannels: 1,
      echoCancel: true, noiseSuppress: true, autoGain: true));
    _micSub = mic.listen(_sendMic);
    _playSub = _player.onPlayerComplete.listen((_) => _drainPlay());
    return true;
  }

  void _sendMic(Uint8List chunk) {
    if (_ended || chunk.isEmpty) return;
    try { _ws?.sink.add(chunk); } catch (_) {/* socket gone */}
  }

  void _onWs(dynamic data) {
    if (_ended) return;
    if (data is List<int>) {
      final bytes = data is Uint8List ? data : Uint8List.fromList(data);
      if (_useNative) {
        _native.feed(bytes); // agent audio plays on the AEC'd comm stream
      } else {
        _pcmBuf.add(data);
        if (_pcmBuf.length >= _flushBytes) _enqueueSegment();
      }
    } else if (data is String) {
      try {
        final j = jsonDecode(data) as Map<String, dynamic>;
        if (j['t'] == 'agent_fail') {
          // GROK_SESSION_FAIL — server refunded the hold and wants the client
          // to fall back to voicemail (agent_voice_room.ts failSessionStart).
          AvaLog.I.log('agent_voice', 'agent_fail: ${j['reason']}');
          Analytics.capture('agent_call_failed', {'reason': (j['reason'] ?? '').toString()});
          _finish('agent_fail');
        }
      } catch (_) {/* not JSON — ignore */}
    }
  }

  void _enqueueSegment() {
    final pcm = _pcmBuf.takeBytes();
    if (pcm.isEmpty) return;
    _playQueue.add(_wrapWav(pcm, _playRate));
    if (!_playing) _drainPlay();
  }

  Future<void> _drainPlay() async {
    if (_playQueue.isEmpty) { _playing = false; return; }
    _playing = true;
    final seg = _playQueue.removeFirst();
    try {
      await _player.play(BytesSource(seg, mimeType: 'audio/wav'));
    } catch (_) {
      _playing = false;
    }
  }

  /// Caller-initiated hangup. The DO finalizes on WS close (settle + refund
  /// unused escrow + voicemail-thread summary card — all server-side).
  Future<void> hangup() => _finish('caller_hangup');

  Future<void> _finish(String reason) async {
    if (_ended) return;
    _ended = true;
    if (_useNative) {
      try { await _native.stop(); } catch (_) {}
      await _nativeMicSub?.cancel();
    } else {
      await _micSub?.cancel();
      try { await _rec.stop(); } catch (_) {}
      try { await _player.stop(); } catch (_) {}
      await _playSub?.cancel();
    }
    try { await _ws?.sink.close(); } catch (_) {}
    await _wsSub?.cancel();
    Analytics.capture('agent_call_ended', {'reason': reason, 'engine': _useNative ? 'native' : 'fallback'});
    AvaLog.I.log('agent_voice', 'ended: $reason');
    onStatus?.call('ended');
    if (!_done.isCompleted) _done.complete(reason);
  }

  static Uint8List _wrapWav(Uint8List pcm, int sampleRate) {
    final out = Uint8List(44 + pcm.length);
    final dv = ByteData.view(out.buffer);
    void wr(int off, String s) { for (var i = 0; i < s.length; i++) dv.setUint8(off + i, s.codeUnitAt(i)); }
    wr(0, 'RIFF'); dv.setUint32(4, 36 + pcm.length, Endian.little); wr(8, 'WAVE');
    wr(12, 'fmt '); dv.setUint32(16, 16, Endian.little); dv.setUint16(20, 1, Endian.little);
    dv.setUint16(22, 1, Endian.little); dv.setUint32(24, sampleRate, Endian.little);
    dv.setUint32(28, sampleRate * 2, Endian.little); dv.setUint16(32, 2, Endian.little);
    dv.setUint16(34, 16, Endian.little); wr(36, 'data'); dv.setUint32(40, pcm.length, Endian.little);
    out.setRange(44, 44 + pcm.length, pcm);
    return out;
  }
}

/// AgentCallApi — thin client for POST /api/agent/call/start
/// (worker/src/routes/agent_voice_routes.ts agentCallStart()).
class AgentCallApi {
  AgentCallApi._();

  static Map<String, dynamic> _json(String body) {
    try { return jsonDecode(body) as Map<String, dynamic>; } catch (_) { return {}; }
  }

  /// [to] = the callee whose agent should answer. Returns the session info
  /// (`rtc_url`, `session_id`, `billing_mode`, ...) on 200, or a map with
  /// `error` (+ optional `fallback:'voicemail'`) on the documented failure
  /// statuses (503 flag off / 404 no profile / 402 wallet / 410 retired), or
  /// null on network failure. Callers should honor `fallback == 'voicemail'`.
  static Future<Map<String, dynamic>?> start({
    required String to,
    String? callId,
    String? traceId,
  }) async {
    try {
      final r = await ApiAuth.postJson('$kApiBase/agent/call/start', {
        'to': to,
        if (callId != null && callId.isNotEmpty) 'call_id': callId,
        if (traceId != null && traceId.isNotEmpty) 'trace_id': traceId,
      });
      final j = _json(r.body);
      if (r.statusCode == 200 && j['ok'] == true) return j;
      if (j.isNotEmpty) return j; // carries error + fallback hint
      return null;
    } catch (_) {
      return null;
    }
  }
}
