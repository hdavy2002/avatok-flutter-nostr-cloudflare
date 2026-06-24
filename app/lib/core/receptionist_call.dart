import 'dart:async';
import 'dart:collection';
import 'dart:typed_data';

import 'package:audioplayers/audioplayers.dart';
import 'package:record/record.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import 'analytics.dart';
import 'ava_log.dart';
import 'receptionist_api.dart';
import 'voice/native_voice_audio.dart';

/// ReceptionistCall — caller-side bridge for "Ava answers after N rings".
/// Spec: Specs/PROPOSAL-AI-RECEPTIONIST.md (+ RECEPTIONIST-V2).
///
/// When an outgoing call goes unanswered (or busy/declined) and the callee has
/// Ava enabled, the caller talks to Ava instead of a dead "No answer". This
/// streams the mic up (PCM16/16k) to the ReceptionRoom DO over a WebSocket and
/// plays Ava's PCM16/24k audio back. The DO holds the Gemini Live session,
/// enforces the 2-minute cap, captures the transcript, and on close posts the
/// message + recording to the callee.
///
/// AUDIO ENGINE (RECEPTIONIST-V2): we use the SHARED native full-duplex engine
/// [NativeVoiceAudio] — the exact engine the live "Voice call Ava" uses — which
/// runs ONE communication audio session with the platform AcousticEchoCanceler
/// attached. That gives smooth, gapless playback AND real barge-in on the
/// loudspeaker AND earpiece (Ava's own voice is removed from the mic, so Gemini
/// hears the caller cleanly and stops talking when interrupted). When the native
/// engine is unavailable (e.g. iOS) we fall back to record + a chunked-WAV
/// player on audioplayers (functional, less smooth).
class ReceptionistCall {
  ReceptionistCall({
    required this.calleeUid,
    this.callId,
    this.callerPhone,
    this.callerName,
    this.activationMode = 'rings', // rings|first_ring|manual|decline|busy
    this.speaker = false,          // initial route: earpiece for audio calls
  });

  final String calleeUid;
  final String? callId;
  final String? callerPhone;
  final String? callerName;
  final String activationMode;

  /// Current audio route (loudspeaker vs earpiece). Mutable: the call screen's
  /// speaker button calls [setSpeaker] to switch mid-call.
  bool speaker;

  /// 'connecting' | 'connected' | 'wrapup' | 'ended'
  void Function(String status)? onStatus;

  // ── native full-duplex engine (preferred) ───────────────────────────────────
  final NativeVoiceAudio _native = NativeVoiceAudio();
  bool _useNative = false;
  StreamSubscription<Uint8List>? _nativeMicSub;

  // ── fallback engine (record + chunked-WAV playback) ──────────────────────────
  final AudioRecorder _rec = AudioRecorder();
  final AudioPlayer _player = AudioPlayer();
  final Queue<Uint8List> _playQueue = Queue<Uint8List>();
  final BytesBuilder _pcmBuf = BytesBuilder(copy: false);
  bool _playing = false;
  StreamSubscription? _micSub;
  StreamSubscription? _playSub;

  WebSocketChannel? _ws;
  StreamSubscription? _wsSub;
  String? _sessionId;
  bool _wsConnected = false;
  bool _ended = false;
  bool _firstAudio = false;
  int _connectMs = 0; // when start() began — basis for first-audio latency
  int _bytesIn = 0; // total Ava audio bytes received
  int _segments = 0; // playable WAV segments enqueued (fallback only)
  int _playErrors = 0; // playback failures (fallback only)
  Timer? _hardCap;
  final Completer<String> _done = Completer<String>();

  Future<String> get done => _done.future;

  // ~0.4 s of 24kHz mono PCM16 before we flush a playable WAV segment (fallback).
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

      final micOk = await _startAudio();
      if (!micOk) {
        _finish('no_mic');
        return false;
      }

      _wsConnected = true;
      _hardCap = Timer(Duration(milliseconds: hardCapMs + 2000), () => _finish('hard_cap'));
      onStatus?.call('connected');
      Analytics.capture('ava_recept_call_started', {
        'callee_hash': calleeUid.hashCode.toString(),
        'activation_mode': activationMode,
        'engine': _useNative ? 'native' : 'fallback',
        'speaker': speaker,
        'ws_connect_ms': DateTime.now().millisecondsSinceEpoch - _connectMs,
        if (callId case final id?) 'call_id': id,
      });
      AvaLog.I.log('receptionist', 'session started ${_sessionId ?? "?"} engine=${_useNative ? "native" : "fallback"}');
      return true;
    } catch (e) {
      AvaLog.I.log('receptionist', 'start failed: $e');
      _finish('error');
      return false;
    }
  }

  /// Bring up audio capture + playback. Prefers the native full-duplex engine
  /// (AEC, smooth, barge-in); falls back to record + chunked-WAV. Returns false
  /// only when no mic could be opened.
  Future<bool> _startAudio() async {
    // 1) Native engine (Android) — one AEC'd comm session for mic + playback.
    if (NativeVoiceAudio.isSupported) {
      _native.onEvent = (e) => Analytics.capture('ava_recept_native_event', {
            'kind': (e['kind'] ?? '').toString(),
            'error_scrubbed': (e['error'] ?? '').toString(),
            if (callId case final id?) 'call_id': id,
          });
      final res = await _native.start(
          micSampleRate: 16000, playSampleRate: 24000, speaker: speaker);
      _useNative = res['ok'] == true;
      Analytics.capture('ava_recept_native', {
        'ok': res['ok'] == true,
        'aec_available': res['aec_available'] == true,
        'aec_enabled': res['aec_enabled'] == true,
        'ns_enabled': res['ns_enabled'] == true,
        'agc_enabled': res['agc_enabled'] == true,
        'speaker': speaker,
        if (res['reason'] != null) 'reason': res['reason'].toString(),
        if (callId case final id?) 'call_id': id,
      });
      if (_useNative) {
        _nativeMicSub = _native.micStream().listen((chunk) {
          if (_ended) return;
          try { _ws?.sink.add(chunk); } catch (_) {/* socket gone */}
        });
        return true;
      }
      AvaLog.I.log('receptionist', 'native engine unavailable (${res['reason']}) — falling back');
    }

    // 2) Fallback: record (with AEC where the OS offers it) + chunked-WAV player.
    if (!await _rec.hasPermission()) return false;
    final mic = await _rec.startStream(const RecordConfig(
      encoder: AudioEncoder.pcm16bits, sampleRate: 16000, numChannels: 1,
      echoCancel: true, noiseSuppress: true, autoGain: true));
    _micSub = mic.listen((chunk) {
      if (_ended) return;
      try { _ws?.sink.add(chunk); } catch (_) {/* socket gone */}
    });
    _playSub = _player.onPlayerComplete.listen((_) => _drainPlay());
    return true;
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
          'engine': _useNative ? 'native' : 'fallback',
          if (callId case final id?) 'call_id': id,
        });
      }
      _bytesIn += data.length;
      if (_useNative) {
        // Native engine plays on the AEC'd comm stream — smooth + gapless, and
        // barge-in just works (caller's clean voice → Gemini stops → DO stops feeding).
        _native.feed(data is Uint8List ? data : Uint8List.fromList(data));
      } else {
        _pcmBuf.add(data);
        if (_pcmBuf.length >= _flushBytes) _enqueueSegment();
      }
    } else if (data is String) {
      // Barge-in: the server's VAD heard the caller speak over Ava → drop her
      // queued audio so she goes silent immediately and the caller is heard.
      if (data.contains('"flush"')) _flushPlayback();
      if (data.contains('softcap')) onStatus?.call('wrapup');
      if (data.contains('"ended"')) _finish('ended_remote');
      if (data.contains('"error"')) _finish('error');
    }
  }

  // ── fallback playback (chunked WAV) ──────────────────────────────────────────
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

  /// Barge-in flush. Native engine uses a small real-time buffer that drains on
  /// its own once Gemini stops feeding, so there's nothing to clear there; the
  /// fallback player's queue must be dropped so Ava goes silent at once.
  void _flushPlayback() {
    if (_useNative) return;
    _playQueue.clear();
    _pcmBuf.clear();
    _playing = false;
    try { _player.stop(); } catch (_) {}
  }

  /// Switch loudspeaker ⇆ earpiece mid-call (driven by the call screen's button).
  Future<void> setSpeaker(bool on) async {
    speaker = on;
    if (_useNative) await _native.setSpeaker(on);
  }

  Future<void> hangup() => _finish('caller_hangup');

  Future<void> _finish(String reason) async {
    if (_ended) return;
    _ended = true;
    _hardCap?.cancel();
    // Stop audio engines.
    Map<String, dynamic>? nativeCounters;
    if (_useNative) {
      try { nativeCounters = await _native.stop(); } catch (_) {}
      await _nativeMicSub?.cancel();
    } else {
      await _micSub?.cancel();
      try { await _rec.stop(); } catch (_) {}
      try { await _player.stop(); } catch (_) {}
      await _playSub?.cancel();
    }
    try { await _ws?.sink.close(); } catch (_) {}
    await _wsSub?.cancel();
    // The DO finalizes (posts message + recording) on WS close. Only hit the
    // safety finalize route if the socket never actually connected.
    if (!_wsConnected && _sessionId != null) {
      await ReceptionistApi.finish(_sessionId!, reason: reason);
    }
    if (nativeCounters != null) {
      Analytics.capture('ava_recept_native_end', {
        'frames_captured': nativeCounters['frames_captured'] ?? 0,
        'bytes_played': nativeCounters['bytes_played'] ?? 0,
        'capture_errors': nativeCounters['capture_errors'] ?? 0,
        'play_errors': nativeCounters['play_errors'] ?? 0,
        if (callId case final id?) 'call_id': id,
      });
    }
    Analytics.capture('ava_recept_call_ended', {
      'reason': reason,
      'activation_mode': activationMode,
      'engine': _useNative ? 'native' : 'fallback',
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

  /// Minimal WAV (PCM16 mono) wrapper so audioplayers can play a raw segment
  /// (fallback engine only).
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
