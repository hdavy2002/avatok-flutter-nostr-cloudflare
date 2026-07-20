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

/// VoicemailCall — caller-side bridge for "leave a voicemail" on a business
/// (dialpad) call (Specs/PLAN-2026-07-11-dialpad-business-calls-ava-voice-agent.md
/// §3 step 4 / §7 item 5, worker/src/do/voicemail_room.ts). Deliberately a
/// MUCH SIMPLER cousin of core/receptionist_call.dart's ReceptionistCall — the
/// server DO has no dialog loop or barge-in, it just: speaks a fixed greeting,
/// plays a tone, records up to `record_sec`(+grace) of caller audio, then
/// closes the socket. The WIRE PROTOCOL is BYTE-IDENTICAL to the receptionist
/// bridge (PCM16 16k mic up / PCM16 24k audio down over one WS — see
/// voicemail_room.ts's file header), so this reuses the SAME native full-duplex
/// audio engine ([NativeVoiceAudio]) receptionist_call.dart uses, with the
/// barge-in/echo-tail logic stripped out (nothing here ever interrupts).
class VoicemailCall {
  VoicemailCall({required this.rtcUrl});

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
  Future<String> get done => _done.future;

  static const int _flushBytes = 24000 * 2 * 2 ~/ 5; // ~0.4s of 24kHz PCM16

  /// Connects and starts streaming. Returns true once the WS + mic are up
  /// (does NOT wait for the server's greeting/tone — those stream in async).
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
      Analytics.capture('voicemail_call_started', {'engine': _useNative ? 'native' : 'fallback'});
      AvaLog.I.log('voicemail', 'started engine=${_useNative ? "native" : "fallback"}');
      return true;
    } catch (e) {
      AvaLog.I.log('voicemail', 'start failed: $e');
      await _finish('error');
      return false;
    }
  }

  Future<bool> _startAudio() async {
    if (NativeVoiceAudio.isSupported) {
      final res = await _native.start(micSampleRate: 16000, playSampleRate: 24000, speaker: false);
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
        _native.feed(bytes); // greeting + tone play on the AEC'd comm stream
      } else {
        _pcmBuf.add(data);
        if (_pcmBuf.length >= _flushBytes) _enqueueSegment();
      }
    } else if (data is String) {
      // Server sends {"t":"ended","reason":...} on finalize — the WS onDone
      // handler already covers the close, so this is just observability.
      try {
        final j = jsonDecode(data) as Map<String, dynamic>;
        if (j['t'] == 'ended') AvaLog.I.log('voicemail', 'server ended: ${j['reason']}');
      } catch (_) {/* not JSON — ignore */}
    }
  }

  void _enqueueSegment() {
    final pcm = _pcmBuf.takeBytes();
    if (pcm.isEmpty) return;
    _playQueue.add(_wrapWav(pcm, 24000));
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

  /// Caller-initiated hangup (they finished / want to stop early). The DO
  /// finalizes on WS close exactly as if the record window had elapsed.
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
    Analytics.capture('voicemail_call_ended', {'reason': reason, 'engine': _useNative ? 'native' : 'fallback'});
    AvaLog.I.log('voicemail', 'ended: $reason');
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

/// VoicemailApi — thin client for POST /api/voicemail/start
/// (worker/src/routes/voicemail_routes.ts voicemailStart()).
class VoicemailApi {
  VoicemailApi._();

  static Map<String, dynamic> _json(String body) {
    try { return jsonDecode(body) as Map<String, dynamic>; } catch (_) { return {}; }
  }

  /// [to] = the callee (voicemail recipient). Returns the session info
  /// (`rtc_url`, `record_sec`, ...) or null on any failure/flag-off (503).
  ///
  /// [free] marks the FREE AvaTOK↔AvaTOK auto-voicemail path (Phase WS2). The
  /// server uses it to play ONE GENERIC system greeting ("The person you're
  /// calling isn't available right now…") instead of the per-owner business
  /// prompt, and to accept the request under `avatokVoicemailFree` rather than
  /// the paid `voicemailBot`. Harmless on an older server (unknown body field is
  /// ignored). Defaults false so the existing business NoAnswerCard path is
  /// byte-for-byte unchanged.
  static Future<Map<String, dynamic>?> start({
    required String to,
    String? callId,
    String? traceId,
    bool free = false,
  }) async {
    try {
      final r = await ApiAuth.postJson('$kApiBase/voicemail/start', {
        'to': to,
        if (callId != null && callId.isNotEmpty) 'call_id': callId,
        if (traceId != null && traceId.isNotEmpty) 'trace_id': traceId,
        if (free) 'free': true,
      });
      if (r.statusCode != 200) return null;
      final j = _json(r.body);
      return (j.isEmpty || j['ok'] != true) ? null : j;
    } catch (_) {
      return null;
    }
  }
}
