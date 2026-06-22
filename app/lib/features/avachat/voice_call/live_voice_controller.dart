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
import 'package:flutter_webrtc/flutter_webrtc.dart' show Helper;
import 'package:record/record.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import '../../../core/analytics.dart';
import '../../../core/ava_live_api.dart';
import '../../../core/ava_log.dart';
import '../../../core/disk_cache.dart';
import '../../../core/voice/google_voice.dart';
import '../../../core/voice/native_voice_audio.dart';
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
  String _model = 'gemini-3.1-flash-live-preview';
  AudioRecorder? _rec;
  StreamSubscription<Uint8List>? _micSub;
  bool _pcmReady = false;
  bool _disposed = false;

  // Native full-duplex audio engine (Android): one communication audio session
  // with the platform AcousticEchoCanceler attached, so Ava's voice is removed
  // from the mic and barge-in works on speaker. When unavailable we fall back to
  // the record + flutter_pcm_sound + half-duplex path.
  final NativeVoiceAudio _native = NativeVoiceAudio();
  bool _useNative = false;
  StreamSubscription<Uint8List>? _nativeMicSub;
  bool _paused = false;
  bool _greeted = false;
  int _reconnects = 0;
  DateTime? _connectedAt;
  Timer? _reconnect;

  // ── rich telemetry: one correlation id (call_id) stitches the whole call ─────
  String _callId = '';
  /// Correlation id for this call — every voice_live_* event carries it, and the
  /// screen stamps its own timer/segment events with it too.
  String get callId => _callId;
  final Stopwatch _callSw = Stopwatch(); // dial → … (whole-call clock)
  int _turns = 0; // Ava turns completed
  int _bargeins = 0;
  bool _firstAudio = false;
  bool _ready = false;

  // Echo guard. Timestamp of Ava's most recent audio chunk; on loudspeaker we
  // half-duplex the mic around it so the speaker echo of her own voice isn't
  // transcribed (which made her answer herself). Headset/earpiece stays full-duplex.
  DateTime _lastAvaAudioAt = DateTime.fromMillisecondsSinceEpoch(0);
  static const int _echoTailMs = 400;

  // Throughput counters (summarised in voice_live_end) — distinguish "no mic"
  // from "heard nothing" from "echo storm" at a glance.
  int _micFrames = 0;
  int _micBytes = 0;
  int _avaChunks = 0;
  int _avaBytes = 0;
  int _echoSuppressed = 0; // mic frames dropped by the half-duplex guard

  /// Capture a voice_live_* event with the call_id merged in.
  void _ev(String name, [Map<String, Object> props = const {}]) {
    Analytics.capture(name, {'call_id': _callId, ...props});
  }

  /// Coerce a native diagnostics map into telemetry props (drop nulls).
  Map<String, Object> _clean(Map<String, dynamic> m) {
    final out = <String, Object>{};
    m.forEach((k, v) { if (v != null) out[k] = v as Object; });
    return out;
  }

  String get _langTag =>
      AvaVoiceLangPref.current.isEmpty ? 'auto' : AvaVoiceLangPref.current;

  /// Pause the call (the 5-minute "still there?" guardrail): stop sending mic and
  /// drop incoming audio so no tokens are billed while we wait for the user.
  Future<void> pause() async {
    if (_disposed || _paused) return;
    _paused = true;
    // Native engine keeps running; _sendMic/_playAudio gate on _paused so nothing
    // is billed. Legacy path stops the mic stream outright.
    if (!_useNative) await _stopMic();
    status.value = 'Paused';
    avaSpeaking.value = false;
    _ev('voice_live_pause', {'at_ms': _callSw.elapsedMilliseconds});
  }

  /// Resume after the user taps Continue.
  Future<void> resume() async {
    if (_disposed || !_paused) return;
    _paused = false;
    if (!_useNative) await _startMic();
    _setListening();
    _ev('voice_live_resume', {'at_ms': _callSw.elapsedMilliseconds});
  }

  @override
  Future<bool> start() async {
    _callId = 'vc_${DateTime.now().microsecondsSinceEpoch.toRadixString(36)}';
    _callSw.start();
    _ev('voice_live_dial'); // user tapped Call
    state.value = CallState.preparing;
    status.value = 'Connecting to Ava…';
    await _loadSpeakerPref(); // restore the user's last speaker/earpiece choice
    final tokenSw = Stopwatch()..start();
    final t = await AvaLiveApi.token();
    final ok200 = (t['status'] as num?)?.toInt() == 200 && (t['token'] ?? '').toString().isNotEmpty;
    _ev('voice_live_token', {
      'token_ms': tokenSw.elapsedMilliseconds,
      'status': (t['status'] as num?)?.toInt() ?? -1,
      'ok': ok200,
    });
    if (_disposed) return false;
    if (!ok200) {
      _fail(t['error']?.toString() ?? 'Could not start the call', stage: 'token');
      return false;
    }
    _model = t['model']?.toString() ?? _model;
    final ok = await _connect(t['token'].toString());
    if (ok) {
      _ev('voice_live_start', {
        'model': _model,
        'connect_ms': _callSw.elapsedMilliseconds,
        'native': _useNative,
        'speaker': speakerOn.value,
        'lang': _langTag,
        'voice': GoogleVoicePref.current,
      });
    }
    return ok;
  }

  void _fail(String msg, {String stage = 'connect'}) {
    state.value = CallState.error;
    status.value = msg;
    _ev('voice_live_error', {'stage': stage, 'error': msg, 'ms': _callSw.elapsedMilliseconds});
  }

  Future<bool> _connect(String token) async {
    if (token.isEmpty || _disposed) return false;
    try {
      // EPHEMERAL-TOKEN AUTH: when the api key is an ephemeral token (name starts
      // with `auth_tokens/`), the Live WS method MUST be `BidiGenerateContentConstrained`
      // with `?access_token=` — the plain `BidiGenerateContent` method rejects the
      // token with close 1008 "unregistered caller / use API Key" (verified live, and
      // per googleapis/js-genai live.ts). Our /api/ava/live/token mints exactly such a
      // token, so we always use the Constrained method here.
      final uri = Uri.parse(
        'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained?access_token=${Uri.encodeComponent(token)}',
      );
      final ws = WebSocketChannel.connect(uri);
      _ws = ws;
      _connectedAt = DateTime.now();
      // The ephemeral token already carries the full bidiGenerateContentSetup
      // (model, voice, persona, transcription, compression), so the client's setup
      // is IGNORED — send an EMPTY setup (the protocol still needs a first frame).
      ws.sink.add(jsonEncode({'setup': <String, dynamic>{}}));
      ws.stream.listen(_onMessage, onError: (e) => _onSocketDown('error: $e'), onDone: () => _onSocketDown('closed'));
      await _startAudio();
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

  // Audio route. Default is the loudspeaker (hands-free), but the user can switch
  // to earpiece/Bluetooth for privacy: turning the speaker OFF lets Android route
  // to a connected Bluetooth/wired headset, otherwise the earpiece. The choice is
  // persisted per account (DiskCache is account-scoped) so it sticks across calls.
  static const _kSpeakerKey = 'voice_call_speaker';
  final ValueNotifier<bool> speakerOn = ValueNotifier<bool>(true);
  bool _routeApplied = false;

  Future<void> _loadSpeakerPref() async {
    final raw = await DiskCache.read(_kSpeakerKey);
    speakerOn.value = raw == null || raw.isEmpty ? true : raw == '1';
  }

  // Apply the saved route (legacy path only — the native engine sets its route in
  // [_native.start]). Opening the mic with AEC puts Android into communication
  // audio mode; without an explicit route Ava's playback goes to the quiet
  // earpiece. We default to the loudspeaker but honour the user's saved choice.
  Future<void> _applyRoute() async {
    try {
      await Helper.setSpeakerphoneOn(speakerOn.value);
      if (!_routeApplied) {
        _routeApplied = true;
        _ev('voice_live_speaker', {'on': speakerOn.value, 'ok': true});
      }
    } catch (e) {
      _ev('voice_live_speaker', {'on': speakerOn.value, 'ok': false, 'error': e.toString()});
    }
  }

  /// Toggle speaker ⇆ earpiece/Bluetooth mid-call (UI button). Speaker OFF lets
  /// Android route to a connected Bluetooth/wired headset, else the earpiece.
  Future<void> setSpeaker(bool on) async {
    speakerOn.value = on;
    try { await DiskCache.write(_kSpeakerKey, on ? '1' : '0'); } catch (_) {}
    try {
      if (_useNative) {
        await _native.setSpeaker(on);
      } else {
        await Helper.setSpeakerphoneOn(on);
      }
      _ev('voice_live_route_change', {'on': on, 'ok': true});
    } catch (e) {
      _ev('voice_live_route_change', {'on': on, 'ok': false, 'error': e.toString()});
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
        if (!_ready) {
          _ready = true;
          _ev('voice_live_ready', {'ready_ms': _callSw.elapsedMilliseconds});
        }
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
        if (data != null && data.isNotEmpty) { _playAudio(base64Decode(data)); gotAudio = true; }
      }
      if (gotAudio) {
        _lastAvaAudioAt = DateTime.now(); // drives the half-duplex echo guard
        if (!_firstAudio) {
          _firstAudio = true;
          // Time-to-first-audio: dial → Ava's first spoken byte (the greeting).
          _ev('voice_live_first_audio', {'ms': _callSw.elapsedMilliseconds});
        }
        if (state.value != CallState.speaking) {
          state.value = CallState.speaking;
          avaSpeaking.value = true;
          status.value = 'Ava is speaking…';
        }
      }
      // Barge-in: Gemini signals it when the user talks over Ava.
      if (content['interrupted'] == true) {
        _bargeins++;
        _ev('voice_live_bargein', {'at_ms': _callSw.elapsedMilliseconds});
        _setListening();
      }
      if (content['turnComplete'] == true) {
        _turns++;
        _ev('voice_live_turn', {'turn': _turns, 'ava_chars': avaCaption.value.length});
        _setListening();
      }
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
    _ev('voice_live_ws_closed', {
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
        await _stopAudio();
        await _connect(t['token']?.toString() ?? '');
      } else if (!_disposed) {
        _fail('Connection lost');
      }
    });
  }

  // ── audio engine: native full-duplex (AEC) on Android, else legacy fallback ──

  Future<bool> _hasMicPermission() async {
    try { _rec ??= AudioRecorder(); return await _rec!.hasPermission(); }
    catch (_) { return false; }
  }

  /// Bring up audio. Prefer the native full-duplex engine (platform AEC → real
  /// barge-in on speaker); fall back to record + flutter_pcm_sound + half-duplex.
  Future<void> _startAudio() async {
    if (NativeVoiceAudio.isSupported) {
      if (!await _hasMicPermission()) {
        _ev('voice_live_engine', {'native': false, 'reason': 'no_permission'});
        _fail('Microphone permission needed');
        return;
      }
      // Forward native async faults (capture_error/play_error) to PostHog.
      _native.onEvent = (e) => _ev('voice_live_native_event', _clean(e));
      final res = await _native.start(
        micSampleRate: 16000, playSampleRate: 24000, speaker: speakerOn.value);
      final ok = res['ok'] == true;
      // Rich native bring-up diagnostics: AEC/NS/AGC availability + enabled,
      // record/track states, session id, buffer sizes — pinpoints "echo not
      // cancelled" (aec_enabled=false) or "no audio" (track_state) at a glance.
      _ev('voice_live_native', _clean(res));
      if (ok) {
        _useNative = true;
        _routeApplied = true;
        _ev('voice_live_engine', {'native': true});
        _ev('voice_live_speaker', {'on': speakerOn.value, 'ok': true});
        _nativeMicSub = _native.micStream().listen(_sendMic);
        return;
      }
      _ev('voice_live_engine',
          {'native': false, 'reason': (res['reason'] ?? 'start_failed').toString()});
      // fall through to the legacy path
    }
    _useNative = false;
    await _setupPcm();
    await _startMic();
    await _applyRoute();
  }

  Future<void> _stopAudio() async {
    if (_useNative) {
      await _nativeMicSub?.cancel();
      _nativeMicSub = null;
      final stats = await _native.stop();
      if (stats != null) _ev('voice_live_native_end', _clean(stats));
    } else {
      await _stopMic();
    }
  }

  // Upload one mic PCM16/16k frame to Gemini. Native frames carry AEC already; the
  // legacy listener applies its own half-duplex gate before calling this.
  void _sendMic(Uint8List chunk) {
    final ws = _ws;
    if (ws == null || chunk.isEmpty || _paused) return;
    _micFrames++;
    _micBytes += chunk.length;
    try {
      ws.sink.add(jsonEncode({
        'realtimeInput': {
          'audio': {'data': base64Encode(chunk), 'mimeType': 'audio/pcm;rate=16000'},
        },
      }));
    } catch (_) {}
  }

  // Play one chunk of Ava's PCM16/24k. Native engine plays on the AEC'd comm
  // stream; legacy uses flutter_pcm_sound.
  void _playAudio(Uint8List bytes) {
    if (_disposed || _paused) return;
    _avaChunks++;
    _avaBytes += bytes.length;
    if (_useNative) { _native.feed(bytes); return; }
    _playPcm(bytes);
  }

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
        // Half-duplex echo guard (loudspeaker only): while Ava is producing audio
        // — and for a short tail after — don't upload the mic, else her own voice
        // echoes back, gets transcribed, and she replies to herself. On earpiece/
        // Bluetooth the echo is negligible so we keep full-duplex barge-in.
        if (speakerOn.value &&
            DateTime.now().difference(_lastAvaAudioAt).inMilliseconds < _echoTailMs) {
          _echoSuppressed++;
          return;
        }
        _sendMic(chunk);
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
    _ev('voice_live_end', {
      'duration_ms': _callSw.elapsedMilliseconds,
      'turns': _turns,
      'bargeins': _bargeins,
      'reconnects': _reconnects,
      'model': _model,
      'reached_ready': _ready,
      'heard_ava': _firstAudio,
      // engine + route + language context
      'native': _useNative,
      'speaker': speakerOn.value,
      'lang': _langTag,
      'voice': GoogleVoicePref.current,
      // throughput — "no mic" vs "heard nothing" vs "echo storm" at a glance
      'mic_frames': _micFrames,
      'mic_bytes': _micBytes,
      'ava_chunks': _avaChunks,
      'ava_bytes': _avaBytes,
      'echo_suppressed': _echoSuppressed,
    });
    _callSw.stop();
    _reconnect?.cancel();
    // Native engine resets its own audio mode/route on stop; only the legacy path
    // needs the speakerphone reset + flutter_pcm_sound release.
    if (!_useNative && _routeApplied) {
      try { await Helper.setSpeakerphoneOn(false); } catch (_) {}
    }
    await _stopAudio();
    try { await _ws?.sink.close(); } catch (_) {}
    _ws = null;
    if (!_useNative) {
      try { if (_pcmReady) await FlutterPcmSound.release(); } catch (_) {}
      _pcmReady = false;
    }
  }
}
