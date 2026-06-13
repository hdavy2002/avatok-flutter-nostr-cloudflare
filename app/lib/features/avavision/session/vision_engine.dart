// vision_engine.dart — the AvaVision session orchestrator: "AvaVoice with eyes".
//
// Owns the realtime plumbing the screen renders:
//   • native camera + on-device model (PoseChannel) → 30 fps overlay + local score
//   • ~1 fps LOW-res JPEG → Gemini Live video channel (master §2: server-locked)
//   • mic 16 kHz PCM16 → Live; Live 24 kHz PCM16 → speaker
//   • debounced `[SYSTEM: <label> <score>, <hint>]` text cues into Live (master §5)
//   • on-demand hi-res frame for "Analyze my form" (the snapshot path)
//
// The Live WS + PCM audio plumbing is copied from the live-translation feature
// (`app/lib/features/translation/translation_engine.dart`) — same WS framing,
// same `record` mic stream, same `flutter_pcm_sound` playback, same ~10-min
// reconnect-with-fresh-token logic. We do NOT reinvent the audio engine; we add
// the video frame send + the vision streams. Billing/session lifecycle lives in
// the screen (mirrors `call_screen.dart`), not here.
import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/foundation.dart';
import 'package:flutter_pcm_sound/flutter_pcm_sound.dart';
import 'package:record/record.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import '../../../core/ava_log.dart';
import 'pose_channel.dart';
import 'scoring.dart';
import '../../../core/avavision_api.dart';

enum VisionEngineState { idle, connecting, live, reconnecting, error }

class VisionEngine {
  VisionEngine({required this.agent});

  final VisionAgent agent;

  // ── public, screen-rendered state ──────────────────────────────────────────
  final ValueNotifier<VisionEngineState> state = ValueNotifier(VisionEngineState.idle);
  /// Latest native vision frame (drives the overlay painter).
  final ValueNotifier<VisionFrame> frame = ValueNotifier(const VisionFrame());
  /// Latest local geometry score (0..100) or null (qualitative/none/no subject).
  final ValueNotifier<int?> localScore = ValueNotifier(null);
  /// Score the agent reported via a text turn (qualitative/hybrid). null = none.
  final ValueNotifier<int?> agentScore = ValueNotifier(null);
  /// Live caption (agent output transcript) for an optional on-screen chip.
  final ValueNotifier<String> caption = ValueNotifier('');
  /// True while the front camera is actively streaming (powers the "can see you"
  /// indicator together with the live state).
  final ValueNotifier<bool> cameraOn = ValueNotifier(false);
  final ValueNotifier<bool> muted = ValueNotifier(false);

  String get scoreLabel => agent.scoreLabel ?? 'Score';
  bool get scoringActive => agent.scoringMode != 'none';

  // ── engine selection (master §6) ────────────────────────────────────────────
  String get _engine {
    if (agent.capability == 'pose') {
      return agent.engineUpgradeAndroidWeb == 'mediapipe_pose' ? 'mediapipe_pose' : 'movenet';
    }
    if (agent.capability == 'gemini_only') return 'none';
    return 'mediapipe_tasks';
  }

  late final VisionScorer _scorer = VisionScorer(
      capability: agent.capability, engine: _engine, scoringMode: agent.scoringMode);

  // ── internals ───────────────────────────────────────────────────────────────
  final PoseChannel _pose = PoseChannel();
  WebSocketChannel? _ws;
  AudioRecorder? _rec;
  StreamSubscription<Uint8List>? _micSub;
  StreamSubscription<VisionFrame>? _frameSub;
  StreamSubscription<VisionLiveFrame>? _liveSub;
  Timer? _reconnect, _cueTimer;
  bool _pcmReady = false, _disposed = false;
  String _model = '';
  String _sessionId = '';

  // SYSTEM-cue debounce: remember the last sent so we don't spam Live.
  int? _lastCueScore;
  String? _lastCueHint;

  bool get hasOnDeviceModel => _engine != 'none';

  // ───────────────────────────────────────────────────────────────────────────
  // lifecycle
  // ───────────────────────────────────────────────────────────────────────────

  /// Start everything once the screen has a session ticket. The screen has
  /// already obtained camera+mic consent before calling this.
  Future<void> start(VisionSessionTicket ticket) async {
    _sessionId = ticket.sessionId;
    _model = ticket.model;
    state.value = VisionEngineState.connecting;

    // 1) native camera + model (free, on-device). gemini_only → camera only.
    await _pose.start(
      capability: agent.capability,
      engine: _engine,
      overlayStyle: agent.overlayStyle,
      lensFacing: 'front',
    );
    cameraOn.value = true;
    _frameSub = _pose.frames.listen(_onFrame);
    _liveSub = _pose.liveFrames.listen(_onLiveFrame);

    // 2) Gemini Live (voice + 1 fps video). Reuses the translation WS plumbing.
    final ok = await _connect(ticket.geminiToken);
    if (!ok) { state.value = VisionEngineState.error; return; }

    // 3) debounced SYSTEM score/hint cues (master §5), ~every 3 s.
    _cueTimer = Timer.periodic(const Duration(seconds: 3), (_) => _pushCue());
    state.value = VisionEngineState.live;
  }

  Future<void> toggleMute() async {
    muted.value = !muted.value;
    if (muted.value) {
      await _stopMic();
    } else if (state.value == VisionEngineState.live) {
      await _startMic();
    }
  }

  Future<String> flipCamera() => _pose.flipCamera();

  /// Capture one hi-res frame and POST it to the snapshot route. Returns the
  /// parsed result map (caller handles 429 SNAPSHOT_CAP_REACHED, 402, etc.).
  Future<Map<String, dynamic>> analyze() async {
    final bytes = await _pose.captureSnapshot();
    if (bytes == null || bytes.isEmpty) {
      return {'status': 0, 'error': 'capture_failed'};
    }
    return AvaVisionApi.snapshotRaw(_sessionId, base64Encode(bytes));
  }

  Future<void> stop() async {
    _cueTimer?.cancel(); _cueTimer = null;
    _reconnect?.cancel(); _reconnect = null;
    await _frameSub?.cancel(); _frameSub = null;
    await _liveSub?.cancel(); _liveSub = null;
    await _stopMic();
    try { await _ws?.sink.close(); } catch (_) {}
    _ws = null;
    await _pose.stop();
    cameraOn.value = false;
    if (_pcmReady) { try { await FlutterPcmSound.release(); } catch (_) {} _pcmReady = false; }
    if (!_disposed) state.value = VisionEngineState.idle;
  }

  void dispose() {
    _disposed = true;
    stop();
    _pose.dispose();
    state.dispose(); frame.dispose(); localScore.dispose(); agentScore.dispose();
    caption.dispose(); cameraOn.dispose(); muted.dispose();
  }

  // ───────────────────────────────────────────────────────────────────────────
  // vision frames
  // ───────────────────────────────────────────────────────────────────────────
  void _onFrame(VisionFrame f) {
    frame.value = f;
    if (_scorer.producesLocalScore) {
      final r = _scorer.evaluate(f);
      if (r.score != null) localScore.value = r.score;
      _lastCueHint = r.hint ?? _lastCueHint;
    }
  }

  void _onLiveFrame(VisionLiveFrame lf) {
    final ws = _ws;
    if (ws == null || lf.jpeg.isEmpty) return;
    // 1 fps LOW-res JPEG → Live video channel. Resolution/fps are already
    // server-locked into the ephemeral token (master §2); this is just the feed.
    try {
      ws.sink.add(jsonEncode({
        'realtimeInput': {
          'video': {'data': base64Encode(lf.jpeg), 'mimeType': 'image/jpeg'},
        },
      }));
    } catch (_) {}
  }

  // ───────────────────────────────────────────────────────────────────────────
  // SYSTEM cues (text events into Live) — master §5
  // ───────────────────────────────────────────────────────────────────────────
  void _pushCue() {
    final ws = _ws;
    if (ws == null || agent.scoringMode == 'none' || agent.scoringMode == 'gemini_qualitative') {
      return; // nothing locally computed to ground the agent with
    }
    final s = localScore.value;
    if (s == null) return;
    // Debounce: only resend when the score moved ≥5 or the hint changed.
    if (_lastCueScore != null &&
        (s - _lastCueScore!).abs() < 5 &&
        _lastCueHint == _lastCueSentHint) {
      return;
    }
    _lastCueScore = s;
    _lastCueSentHint = _lastCueHint;
    final hint = (_lastCueHint != null && _lastCueHint!.isNotEmpty) ? ', $_lastCueHint' : '';
    _sendText('[SYSTEM: $scoreLabel $s$hint]');
  }

  String? _lastCueSentHint;

  /// Public hook the screen uses to inject the "2 minutes remaining" cue so
  /// wrap-up is exact (master §5), and to forward anything else as a text turn.
  void sendSystemText(String text) => _sendText('[SYSTEM: $text]');

  void _sendText(String text) {
    final ws = _ws;
    if (ws == null) return;
    try {
      ws.sink.add(jsonEncode({
        'clientContent': {
          'turns': [
            {'role': 'user', 'parts': [{'text': text}]}
          ],
          'turnComplete': false,
        },
      }));
    } catch (_) {}
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Gemini Live WS (copied from TranslationEngine, + video send already above)
  // ───────────────────────────────────────────────────────────────────────────
  Future<bool> _connect(String token) async {
    if (token.isEmpty) return false;
    try {
      final uri = Uri.parse(
        'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?access_token=${Uri.encodeComponent(token)}',
      );
      final ws = WebSocketChannel.connect(uri);
      _ws = ws;
      // Voice, language, system prompt AND the LOW-res/~1fps video config are
      // locked into the ephemeral token server-side — setup only names the model.
      ws.sink.add(jsonEncode({'setup': {'model': 'models/$_model'}}));
      ws.stream.listen(_onMessage, onError: (e) => _onSocketDown('error: $e'),
          onDone: () => _onSocketDown('closed'));
      await _setupPcm();
      if (!muted.value) await _startMic();
      return true;
    } catch (e) {
      AvaLog.I.log('avavision', 'ws connect failed: $e');
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
      if (outT != null && outT.isNotEmpty) {
        caption.value = outT;
        _maybeParseAgentScore(outT);
      }
      final parts = ((content['modelTurn'] as Map?)?['parts'] as List?) ?? const [];
      for (final p in parts) {
        final inline = ((p as Map)['inlineData'] as Map?);
        final data = inline?['data']?.toString();
        if (data != null && data.isNotEmpty) _playPcm(base64Decode(data));
      }
    } catch (_) {/* non-JSON keepalives are fine */}
  }

  // In qualitative/hybrid modes the agent may speak a number; surface the most
  // recent integer as the agent-reported badge value (best-effort, optional).
  void _maybeParseAgentScore(String t) {
    if (agent.scoringMode != 'gemini_qualitative' && agent.scoringMode != 'hybrid') return;
    final match = RegExp(r'\b(\d{1,3})\b').firstMatch(t);
    if (match == null) return;
    final v = int.tryParse(match.group(1)!);
    if (v != null && v >= 0 && v <= 100) agentScore.value = v;
  }

  void _onSocketDown(String why) {
    if (_disposed || _sessionId.isEmpty || state.value != VisionEngineState.live) return;
    AvaLog.I.log('avavision', 'gemini ws down ($why) — reconnecting');
    _ws = null;
    state.value = VisionEngineState.reconnecting;
    _reconnect?.cancel();
    _reconnect = Timer(const Duration(seconds: 1), () async {
      if (_disposed || _sessionId.isEmpty) return;
      // Live connections cap at ~10 min → mint a fresh token and reconnect.
      final t = await AvaVisionApi.sessionToken(_sessionId);
      if ((t['status'] as num?)?.toInt() == 200) {
        await _stopMic();
        final ok = await _connect(t['token']?.toString() ?? '');
        state.value = ok ? VisionEngineState.live : VisionEngineState.error;
      } else {
        state.value = VisionEngineState.error;
      }
    });
  }

  // ── audio in / out (identical to TranslationEngine) ─────────────────────────
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
        if (ws == null || chunk.isEmpty || muted.value) return;
        try {
          ws.sink.add(jsonEncode({
            'realtimeInput': {
              'audio': {'data': base64Encode(chunk), 'mimeType': 'audio/pcm;rate=16000'},
            },
          }));
        } catch (_) {}
      });
    } catch (e) {
      AvaLog.I.log('avavision', 'mic stream failed: $e');
      state.value = VisionEngineState.error;
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
      FlutterPcmSound.setFeedThreshold(0);
      _pcmReady = true;
    } catch (e) {
      AvaLog.I.log('avavision', 'pcm setup failed: $e');
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
