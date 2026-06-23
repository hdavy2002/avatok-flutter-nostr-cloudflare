import 'dart:async';
import 'dart:collection';
import 'dart:typed_data';

import 'package:audioplayers/audioplayers.dart';
import 'package:record/record.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import 'analytics.dart';
import 'ava_log.dart';
import 'receptionist_api.dart';

/// ReceptionistCall — caller-side bridge for "Ava answers after 5 rings".
/// Spec: Specs/PROPOSAL-AI-RECEPTIONIST.md.
///
/// When an outgoing call goes unanswered and the callee has Ava enabled, the
/// caller talks to Ava instead of getting a dead "No answer". This streams the
/// mic as PCM16/16k up to the ReceptionRoom DO over a WebSocket and plays Ava's
/// PCM16/24k audio back. The DO holds the Gemini Live session (via AI Gateway),
/// enforces the 2-minute cap, captures the transcript, and on close posts the
/// message + recording to the callee.
///
/// ⚠️ Audio playback here is a pragmatic chunked-WAV scheme on audioplayers
/// (no streaming-PCM plugin in pubspec). It is functional but latency/gapless
/// behaviour needs tuning on real devices — the structure + protocol are correct.
class ReceptionistCall {
  ReceptionistCall({
    required this.calleeUid,
    this.callId,
    this.callerPhone,
    this.callerName,
    this.activationMode = 'rings', // rings|first_ring|manual|decline
  });

  final String calleeUid;
  final String? callId;
  final String? callerPhone;
  final String? callerName;
  final String activationMode;

  /// 'connecting' | 'connected' | 'wrapup' | 'ended'
  void Function(String status)? onStatus;

  final AudioRecorder _rec = AudioRecorder();
  final AudioPlayer _player = AudioPlayer();
  final Queue<Uint8List> _playQueue = Queue<Uint8List>();
  final BytesBuilder _pcmBuf = BytesBuilder(copy: false);
  bool _playing = false;

  WebSocketChannel? _ws;
  StreamSubscription? _wsSub;
  StreamSubscription? _micSub;
  StreamSubscription? _playSub;
  String? _sessionId;
  bool _wsConnected = false;
  bool _ended = false;
  bool _firstAudio = false;
  int _connectMs = 0; // when start() began — basis for first-audio latency
  int _bytesIn = 0; // total Ava audio bytes received
  int _segments = 0; // playable WAV segments enqueued
  int _playErrors = 0; // playback failures
  Timer? _hardCap;
  final Completer<String> _done = Completer<String>();

  Future<String> get done => _done.future;

  // ~0.4 s of 24kHz mono PCM16 before we flush a playable WAV segment.
  static const int _flushBytes = 24000 * 2 * 2 ~/ 5;

  /// Returns true if Ava picked up (caller is now talking to Ava).
  Future<bool> start() async {
    _connectMs = DateTime.now().millisecondsSinceEpoch;
    final cfg = await ReceptionistApi.configFor(calleeUid);
    if (cfg == null) {
      // not premium / disabled / off — record WHY Ava didn't pick up.
      Analytics.capture('ava_recept_skipped', {
        'reason': 'unavailable',
        'activation_mode': activationMode,
        if (callId case final id?) 'call_id': id,
      });
      return false;
    }
    final s = await ReceptionistApi.start(
      to: calleeUid, callId: callId, callerPhone: callerPhone, callerName: callerName,
      activationMode: activationMode);
    if (s == null) {
      Analytics.capture('ava_recept_skipped', {
        'reason': 'start_failed',
        'activation_mode': activationMode,
        if (callId case final id?) 'call_id': id,
      });
      return false;
    }

    _sessionId = s['session_id'] as String?;
    final rtcUrl = s['rtc_url'] as String?;
    if (rtcUrl == null) {
      Analytics.capture('ava_recept_skipped', {
        'reason': 'no_rtc_url',
        'activation_mode': activationMode,
        if (callId case final id?) 'call_id': id,
      });
      return false;
    }
    final hardCapMs = (s['hard_cap_ms'] as num?)?.toInt() ?? 120000;

    try {
      onStatus?.call('connecting');
      _ws = WebSocketChannel.connect(Uri.parse(ReceptionistApi.wsUrl(rtcUrl)));
      _wsSub = _ws!.stream.listen(_onWs,
          onDone: () => _finish('model_closed'), onError: (_) => _finish('error'));

      if (!await _rec.hasPermission()) {
        _finish('no_mic');
        return false;
      }
      final mic = await _rec.startStream(const RecordConfig(
        encoder: AudioEncoder.pcm16bits, sampleRate: 16000, numChannels: 1));
      _micSub = mic.listen((chunk) {
        if (_ended) return;
        try { _ws?.sink.add(chunk); } catch (_) {/* socket gone */}
      });

      _playSub = _player.onPlayerComplete.listen((_) => _drainPlay());
      _wsConnected = true;
      _hardCap = Timer(Duration(milliseconds: hardCapMs + 2000), () => _finish('hard_cap'));
      onStatus?.call('connected');
      Analytics.capture('ava_recept_call_started', {
        'callee_hash': calleeUid.hashCode.toString(),
        'activation_mode': activationMode,
        'ws_connect_ms': DateTime.now().millisecondsSinceEpoch - _connectMs,
        if (callId case final id?) 'call_id': id,
      });
      AvaLog.I.log('receptionist', 'session started ${_sessionId ?? "?"}');
      return true;
    } catch (e) {
      AvaLog.I.log('receptionist', 'start failed: $e');
      _finish('error');
      return false;
    }
  }

  void _onWs(dynamic data) {
    if (_ended) return;
    if (data is List<int>) {
      // Time-to-first-audio (perceived latency) — client-side mirror of the DO's
      // ava_recept_first_audio; carries email/phone via the Analytics envelope.
      if (!_firstAudio) {
        _firstAudio = true;
        Analytics.capture('ava_recept_first_audio', {
          'ms': DateTime.now().millisecondsSinceEpoch - _connectMs,
          'activation_mode': activationMode,
          if (callId case final id?) 'call_id': id,
        });
      }
      _bytesIn += data.length;
      _pcmBuf.add(data);
      if (_pcmBuf.length >= _flushBytes) _enqueueSegment();
    } else if (data is String) {
      if (data.contains('softcap')) onStatus?.call('wrapup');
      if (data.contains('"ended"')) _finish('ended_remote');
      if (data.contains('"error"')) _finish('error');
    }
  }

  void _enqueueSegment() {
    final pcm = _pcmBuf.takeBytes();
    if (pcm.isEmpty) return;
    _segments++;
    _playQueue.add(_wrapWav(pcm, 24000));
    if (!_playing) _drainPlay();
  }

  Future<void> _drainPlay() async {
    if (_playQueue.isEmpty) {
      _playing = false;
      return;
    }
    _playing = true;
    final seg = _playQueue.removeFirst();
    try {
      await _player.play(BytesSource(seg, mimeType: 'audio/wav'));
    } catch (_) {
      _playErrors++;
      _playing = false;
    }
  }

  Future<void> hangup() => _finish('caller_hangup');

  Future<void> _finish(String reason) async {
    if (_ended) return;
    _ended = true;
    _hardCap?.cancel();
    await _micSub?.cancel();
    try { await _rec.stop(); } catch (_) {}
    try { await _player.stop(); } catch (_) {}
    await _playSub?.cancel();
    try { await _ws?.sink.close(); } catch (_) {}
    await _wsSub?.cancel();
    // The DO finalizes (posts message + recording) on WS close. Only hit the
    // safety finalize route if the socket never actually connected.
    if (!_wsConnected && _sessionId != null) {
      await ReceptionistApi.finish(_sessionId!, reason: reason);
    }
    Analytics.capture('ava_recept_call_ended', {
      'reason': reason,
      'activation_mode': activationMode,
      'got_audio': _firstAudio,
      'audio_bytes_in': _bytesIn,
      'segments': _segments,
      'play_errors': _playErrors,
      'duration_ms': DateTime.now().millisecondsSinceEpoch - _connectMs,
      'ws_connected': _wsConnected,
      if (callId case final id?) 'call_id': id,
    });
    AvaLog.I.log('receptionist', 'ended: $reason');
    onStatus?.call('ended');
    if (!_done.isCompleted) _done.complete(reason);
  }

  /// Minimal WAV (PCM16 mono) wrapper so audioplayers can play a raw segment.
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
