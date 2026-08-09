import 'dart:async';
import 'dart:collection';
import 'dart:convert' show jsonDecode, jsonEncode;
import 'dart:io' show ProcessInfo;
import 'dart:math' show min;
import 'dart:typed_data';

import 'package:flutter/foundation.dart' show ValueNotifier;

import 'package:audioplayers/audioplayers.dart';
import 'package:record/record.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import 'analytics.dart';
import 'ava_log.dart';
import 'calls/call_audio_controller.dart';
import 'receptionist_api.dart';
import 'remote_config.dart';
import 'voice/native_voice_audio.dart';

/// [CALL-REL-7] Outcome of one reattach attempt (Specs/PERMANENT-P2P-CALL-
/// RELIABILITY-IMPLEMENTATION-PLAN-2026-07-24.md §4.3/§8).
enum _ReattachResult { success, retry, terminal }

/// ReceptionistCall — caller-side bridge for "Ava answers after N rings".
/// Spec: Specs/PROPOSAL-AI-RECEPTIONIST.md (+ RECEPTIONIST-V2).
///
/// When an outgoing call goes unanswered (or busy/declined) and the callee has
/// Ava enabled, the caller talks to Ava instead of a dead "No answer". This
/// streams the mic up (PCM16/16k) to the ReceptionRoom DO over a WebSocket and
/// plays Ava's PCM16/24k audio back. The DO holds the Gemini Live session,
/// enforces the call-length cap (~70s), captures the transcript, and on close posts the
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
    this.activationMode = 'rings', // rings|first_ring|manual|decline|busy|unknown_caller
    this.speaker = false,          // initial route: earpiece for audio calls
    this.teamId,                   // Team IVR fallback: tags the voicemail card
    this.teamSlot,                 // for the manager's team inbox + attribution
  });

  final String calleeUid;
  final String? callId;
  final String? callerPhone;
  final String? callerName;
  final String activationMode;
  final String? teamId;
  final int? teamSlot;

  /// Current audio route (loudspeaker vs earpiece). Mutable: the call screen's
  /// speaker button calls [setSpeaker] to switch mid-call.
  bool speaker;

  /// 'connecting' | 'connected' | 'wrapup' | 'ended'
  void Function(String status)? onStatus;

  /// [RECEPT-START-409-1] Why [start] returned false (server refusal reason,
  /// 'network', or null if start succeeded / wasn't reached). 'reattach_blocked'
  /// means another leg already owns a live Ava session for this call — benign.
  String? failReason;

  // ── native full-duplex engine (preferred) ───────────────────────────────────
  final NativeVoiceAudio _native = NativeVoiceAudio();
  bool _useNative = false;
  StreamSubscription<Uint8List>? _nativeMicSub;

  // ── [CALL-RING-AUDIBLE-3 2026-08-09] deferred audio-session start ──────────
  //
  // MEASURED: prod call avatok-6e17cdc2 (2026-08-09 01:21, hdavy2002@gmail.com).
  // [CALL-RING-AUDIBLE-2] proved the ringback tone is no longer STOPPED during
  // the receptionist spin-up (`ringback_audible phase=prewarm playing=true` at
  // both the 0 ms and the 2000 ms sample, position advancing). The owner still
  // heard it go quiet at ~beep 7, at the exact second of
  // `call_audio_owner_apply recept_prewarm_before/after`. So the tone played
  // but stopped being AUDIBLE, and the only thing that runs between those two
  // markers is [_startAudio] → `startEngine`.
  //
  // `startEngine` (android/.../AvaVoiceAudioPlugin.kt:461) writes
  // `AudioManager.mode = MODE_IN_COMMUNICATION`, then (kt:473-487) re-selects
  // the communication device for the `speaker` value this object was
  // CONSTRUCTED with, then opens an AudioRecord (VOICE_COMMUNICATION + AEC) and
  // an AudioTrack on `USAGE_VOICE_COMMUNICATION`. The ringback tone is on that
  // very same output — `core/ringback_player.dart:150` pins
  // `usageType: voiceCommunication` — so the mode switch, the device
  // re-selection and the new AudioTrack all land on the stream the tone is
  // sounding through, and re-level/re-route it mid-beep.
  //
  // The fix is ordering, not routing: nothing about that audio session is
  // needed until Ava is actually about to be heard, and the ava-live gate
  // ([CallSession._openAvaLiveGate]) already stops the tone at exactly that
  // instant. Deferring the engine start to the gate makes "tone stops" and
  // "device switches to the in-call session" the same moment, so there is no
  // window in which an attenuated tone is still supposed to be audible.
  //
  // Gated by `RemoteConfig.callRingAudibilityV1` at the CALLER (call_session):
  // when it is off nobody sets [deferAudioStart] and this file behaves exactly
  // as before, byte for byte.

  /// When true, [start] brings the SESSION up (config → /start → WebSocket) but
  /// does NOT open the device audio session; [startAudioNow] does that later.
  bool deferAudioStart = false;

  /// Has [_startAudio] already run (either inline from [start] or deferred)?
  bool _audioStarted = false;

  /// Read-only probe supplied by the owner so `recept_engine_started` can record
  /// whether the ava-live gate was already open when the engine started —
  /// `gate_open: true` is the success value for [CALL-RING-AUDIBLE-3].
  bool Function()? isAvaLiveGateOpen;

  /// Epoch ms of when this call started ringing, supplied by the owner. Only
  /// used to timestamp `recept_engine_started`.
  int? ringStartedAtMs;

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
  // ── [CALL-REL-7] receptionist WS reattach (gated: RemoteConfig.receptionistReconnectV1) ──
  // Flag OFF (default) → every field below stays unused and behavior is
  // byte-for-byte the pre-existing onDone/onError → _finish() path.
  String? _rtcUrlBase;        // relative rtc_url from /start, reused to build the reattach URL
  String? _reconnectToken;    // opaque, single-session, never logged
  int _reconnectExpiresAt = 0; // epoch ms — server-issued reconnect_token TTL
  int _hardCapDeadlineMs = 0;  // epoch ms — the receptionist's own hard cap; reconnect never extends it
  int _lastServerSeq = 0;      // count of Ava PCM frames received — sent back as last_seq on reattach
  bool _reconnecting = false;  // RECONNECTING state (STARTING→CONNECTED→RECONNECTING→CONNECTED)
  int _reconnectAttempts = 0;
  int _micDiscardedReconnect = 0; // mic frames dropped while the socket was down (never uploaded)
  // Echo guard. `_aecOk` = the native hardware AEC confirmed attached → safe to
  // run FULL-DUPLEX on speaker (Ava's voice is cancelled from the mic, so real
  // barge-in works and she never hears herself). When AEC is NOT confirmed and
  // we're on the loudspeaker, we fall back to a HALF-DUPLEX gate: while Ava is
  // emitting audio (+ a short tail) we stop uploading the mic, so her own echo
  // can't be transcribed and make her interrupt herself.
  bool _aecOk = false;
  int _lastAvaAudioAtMs = 0;
  int _echoSuppressed = 0;
  static const int _echoTailMs = 250;
  int _connectMs = 0; // when start() began — basis for first-audio latency
  int _bytesIn = 0; // total Ava audio bytes received
  int _segments = 0; // playable WAV segments enqueued (fallback only)
  int _playErrors = 0; // playback failures (fallback only)
  // ── live mic/speaker observability (heartbeat + dead-mic detector) ──────────
  int _micCaptured = 0; // mic frames produced by the engine (before the echo gate)
  int _micSent = 0;     // mic frames actually uploaded to the DO
  int _micBytes = 0;    // mic bytes uploaded
  int _lastMicAtMs = 0; // last captured mic frame — drives the dead-mic detector
  int _avaChunks = 0;   // Ava audio chunks received from the DO
  bool _hold = false;                    // countdown gate: buffer Ava audio until released
  final List<Uint8List> _heldAudio = []; // Ava chunks captured while held (native path)
  int _beats = 0;       // heartbeat counter
  bool _micStallFired = false;
  Timer? _hb;           // periodic in-call telemetry heartbeat
  Timer? _hardCap;
  final Completer<String> _done = Completer<String>();

  Future<String> get done => _done.future;

  // ── [AVA-VM-FALLBACK-1 2026-08-08] dumb-voicemail fallback ─────────────────
  //
  // MEASURED: prod call avatok-946b6090 (2026-08-07 20:52 IST, build 10523).
  // The session opened at 20:53:04.9 (`live_session_open`), produced NO audio,
  // timed out at 20:53:09.4, retried, and the CALL WAS ENDED at 20:53:19.9 with
  // reason `ava-live-timeout`. The owner was trying to leave a voicemail: he
  // never spoke, nothing was recorded, and from his side the app hung up on him.
  //
  // The fix is deliberately NOT "start a second receptionist session". A second
  // `/api/receptionist/start` for the same `call_id` is refused four different
  // ways — the KV reattach lock, the CallRoom DO ownership claim, the control-
  // plane authority row and the aggregate's `handoff` state — all of which
  // correctly exist to stop two Avas on one call. Instead this DEGRADES the
  // session already open: one control frame tells the DO to abandon the
  // conversational engine and run its existing deterministic voicemail flow
  // (cached greeting -> beep -> record -> finalize). The recording is then
  // stored, delivered and registered by the SAME `finalize()` as every other
  // receptionist voicemail — no second storage format, no new route.

  /// True once the fallback frame has been sent (idempotent guard).
  bool vmFallbackRequested = false;

  /// Server verdict, null until the DO reports it. See [onVmFallbackResult].
  bool? vmFallbackStored;
  int vmFallbackRecordedMs = 0;

  /// The DO's `vm_result` frame: did the recording qualify for delivery, and how
  /// much caller audio did it actually contain. Fires at most once, just before
  /// the session closes.
  void Function(bool stored, int recordedMs)? onVmFallbackResult;

  /// Has Ava ever actually produced audio on this session? The fallback is only
  /// meaningful while this is false — if she spoke, the session is working and
  /// degrading it would throw away a live conversation.
  bool get hasFirstAudio => _firstAudio;

  /// Ask the DO to abandon the AI engine and take a plain recorded message.
  ///
  /// Returns false when there is no live socket to ask on (nothing was sent, so
  /// the caller must fall back to its own honest end state). Returning TRUE only
  /// means the request left this device; [onVmFallbackResult] is the receipt.
  bool requestVoicemailFallback(String trigger) {
    if (_ended || vmFallbackRequested) return false;
    final ws = _ws;
    if (ws == null || !_wsConnected) return false;
    try {
      ws.sink.add(jsonEncode({'t': 'vm_fallback', 'reason': trigger}));
    } catch (_) {
      return false;
    }
    vmFallbackRequested = true;
    // [CALL-RING-AUDIBLE-3] The dumb-voicemail flow RECORDS THE CALLER, so it
    // needs the mic even though Ava never produced audio and the ava-live gate
    // therefore never opened to start the engine for us. Fire and forget: the
    // greeting/beep arrive over the same socket a moment later.
    if (deferAudioStart && !_audioStarted) unawaited(startAudioNow());
    Analytics.capture('ava_vm_fallback_requested', {
      'trigger': trigger,
      'activation_mode': activationMode,
      'engine': _useNative ? 'native' : 'fallback',
      'elapsed_ms': DateTime.now().millisecondsSinceEpoch - _connectMs,
      if (callId case final id?) 'call_id': id,
    });
    AvaLog.I.log('receptionist', 'voicemail fallback requested ($trigger)');
    return true;
  }

  /// [AVA-PREWARM-1] Has this session already finished (naturally, or aborted)?
  /// Lets a caller holding a pre-warmed instance tell a stale/dead one apart
  /// from a still-usable one without reaching into private state.
  bool get isEnded => _ended;

  /// Live VU levels (0..1) for the call screen's speaking animation. [micLevel]
  /// is the CALLER's mic energy (their icon + the link toward Ava light up when
  /// it's high); [avaLevel] is AVA's outgoing-audio energy (her icon + the link
  /// back to the caller light up). Rising-edge on each audio frame, decayed by
  /// [_levelTimer] so they fall back to 0 when a side goes quiet.
  final ValueNotifier<double> micLevel = ValueNotifier<double>(0);
  final ValueNotifier<double> avaLevel = ValueNotifier<double>(0);
  Timer? _levelTimer;

  /// Buffer Ava's audio instead of playing it — used during the on-screen 3-2-1
  /// countdown so she connects + renders the greeting in the background and is
  /// fully warmed up to speak the INSTANT the countdown hits zero.
  void beginHold() => _hold = true;

  /// Release the buffered audio and resume live playback (called at countdown 0).
  void release() {
    if (!_hold) return;
    _hold = false;
    if (_useNative) {
      for (final b in _heldAudio) { try { _native.feed(b); } catch (_) {/* drained */} }
      _heldAudio.clear();
    } else if (_pcmBuf.length > 0) {
      _enqueueSegment();
    }
  }

  // ~0.4 s of 24kHz mono PCM16 before we flush a playable WAV segment (fallback).
  static const int _flushBytes = 24000 * 2 * 2 ~/ 5;

  /// Returns true if Ava picked up (caller is now talking to Ava).
  Future<bool> start() async {
    _connectMs = DateTime.now().millisecondsSinceEpoch;
    final cfg = await ReceptionistApi.configFor(calleeUid);
    if (_ended) return false;
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
      activationMode: activationMode, teamId: teamId, teamSlot: teamSlot);
    if (_ended) {
      final createdSid = s?['session_id'] as String?;
      if (createdSid != null) {
        await ReceptionistApi.finish(createdSid, reason: 'caller_hangup_before_connect');
      }
      return false;
    }
    if (s == null || s['ok'] != true) {
      // [RECEPT-START-409-1] Record the server's actual refusal reason instead of
      // the blanket 'start_failed'. 'reattach_blocked' (409) is BENIGN: a session
      // for this exact call is already live (server RECEPT-REATTACH-1) — callers
      // read [failReason] to skip the misleading "Couldn't reach Ava" surface.
      failReason = s == null ? 'network' : (s['reason'] ?? 'start_failed').toString();
      Analytics.capture('ava_recept_skipped', {
        'reason': s == null ? 'start_failed' : 'refused_${s['reason'] ?? s['status']}',
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
    final hardCapMs = (s['hard_cap_ms'] as num?)?.toInt() ?? 70000;
    // [CALL-REL-7] Reattach contract fields (server always sends them now; only
    // consumed when the flag is on). rtc_url is kept as-is for the reattach URL
    // builder — never mutated on the connect path below.
    _rtcUrlBase = rtcUrl;
    _reconnectToken = s['reconnect_token'] as String?;
    _reconnectExpiresAt = (s['reconnect_expires_at'] as num?)?.toInt() ?? 0;
    _hardCapDeadlineMs = _connectMs + hardCapMs;

    try {
      onStatus?.call('connecting');
      _ws = WebSocketChannel.connect(Uri.parse(ReceptionistApi.wsUrl(rtcUrl)));
      _wsSub = _ws!.stream.listen(
        _onWs,
        onDone: () {
          Analytics.capture('ava_recept_transport_closed', {
            'stage': 'websocket_done',
            'had_first_audio': _firstAudio,
            'audio_chunks': _avaChunks,
            'ws_connected': _wsConnected,
            if (callId case final id?) 'call_id': id,
          });
          _handleTransportDown('model_closed');
        },
        onError: (Object e, StackTrace st) {
          final context = <String, Object>{
            'stage': 'receptionist_websocket_error',
            'engine': _useNative ? 'native' : 'fallback',
            'activation_mode': activationMode,
            if (callId case final id?) 'call_id': id,
          };
          Analytics.capture('ava_recept_transport_error', context);
          Analytics.error(domain: 'receptionist', code: 'websocket_error',
              message: e.toString(), action: 'finish_session', extra: context);
          Analytics.captureException(e, st, screen: 'call', handled: true, extra: context);
          _handleTransportDown('error');
        },
      );

      // [CALL-RING-AUDIBLE-3] Deferred: the socket is up and Ava can start
      // rendering server-side, but the device audio session (and with it the
      // MODE_IN_COMMUNICATION switch that re-levels the ringback tone) stays
      // closed until [startAudioNow] — called at the ava-live gate, the same
      // instant the tone is stopped.
      if (!deferAudioStart) {
        final micOk = await _startAudio();
        if (!micOk) {
          _finish('no_mic');
          return false;
        }
      }

      _wsConnected = true;
      _hardCap = Timer(Duration(milliseconds: hardCapMs + 2000), () => _finish('hard_cap'));
      // Live mic/speaker/network/memory visibility every 15s while the call runs,
      // so a stuck mic, dead playback, echo storm or leak is visible WITHOUT a
      // repro (the call may end before call_ended ever fires).
      _hb = Timer.periodic(const Duration(seconds: 15), (_) => _heartbeat());
      // Decay the speaking-animation VU levels ~12×/s so an icon stops pulsing
      // shortly after that side goes quiet (frames set a rising edge; this falls).
      _levelTimer = Timer.periodic(const Duration(milliseconds: 80), (_) {
        if (micLevel.value > 0.01) micLevel.value = micLevel.value * 0.72;
        if (avaLevel.value > 0.01) avaLevel.value = avaLevel.value * 0.72;
      });
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
    } catch (e, st) {
      AvaLog.I.log('receptionist', 'start failed: $e');
      final context = <String, Object>{
        'stage': 'receptionist_start_failed',
        'activation_mode': activationMode,
        if (callId case final id?) 'call_id': id,
      };
      Analytics.capture('ava_recept_transport_error', context);
      Analytics.error(domain: 'receptionist', code: 'start_failed',
          message: e.toString(), action: 'finish_session', extra: context);
      Analytics.captureException(e, st, screen: 'call', handled: true, extra: context);
      _finish('error');
      return false;
    }
  }

  /// [CALL-RING-AUDIBLE-3] Open the device audio session NOW, for a session that
  /// was started with [deferAudioStart]. Idempotent, and a no-op when the audio
  /// session is already up (the flag-off path always starts it inline in
  /// [start], so this can never double-open an engine).
  ///
  /// Called from [CallSession._openAvaLiveGate] immediately AFTER the ringback
  /// tone has been stopped and awaited, and BEFORE [release] lets Ava's buffered
  /// audio out — so the tone stop and the MODE_IN_COMMUNICATION switch happen
  /// back to back with nothing audible in between, and Ava's first word still
  /// plays through a fully-open engine.
  Future<bool> startAudioNow() async {
    if (_ended) return false;
    if (_audioStarted) return true; // already open (inline or an earlier defer)
    if (!deferAudioStart) return false; // never open an engine start() declined to
    final ok = await _startAudio();
    if (!ok) {
      // No mic at the one moment we actually need one. Ava is live server-side
      // but this device can neither hear nor be heard, so end honestly rather
      // than sit in silence — same verdict [start] reaches on the inline path.
      Analytics.capture('ava_recept_deferred_audio_failed', {
        'activation_mode': activationMode,
        if (callId case final id?) 'call_id': id,
      });
      await _finish('no_mic');
      return false;
    }
    return true;
  }

  /// Bring up audio capture + playback. Prefers the native full-duplex engine
  /// (AEC, smooth, barge-in); falls back to record + chunked-WAV. Returns false
  /// only when no mic could be opened.
  Future<bool> _startAudio() async {
    _audioStarted = true;
    // [CALL-RING-AUDIBLE-3] The engine-start site. `gate_open: true` is the
    // SUCCESS VALUE for this fix (the engine — and therefore the
    // MODE_IN_COMMUNICATION switch — ran at/after the ava-live gate, which is
    // where the ringback tone is stopped). `gate_open: false` with
    // `deferred: false` is the pre-fix behaviour this issue is about.
    Analytics.capture('recept_engine_started', {
      'at_ms_since_ring': ringStartedAtMs == null
          ? -1
          : DateTime.now().millisecondsSinceEpoch - ringStartedAtMs!,
      'gate_open': isAvaLiveGateOpen?.call() ?? false,
      'deferred': deferAudioStart,
      'speaker': speaker,
      'activation_mode': activationMode,
      if (callId case final id?) 'call_id': id,
    });
    // 1) Native engine (Android) — one AEC'd comm session for mic + playback.
    if (NativeVoiceAudio.isSupported) {
      _native.onEvent = (e) => Analytics.capture('ava_recept_native_event', {
            'kind': (e['kind'] ?? '').toString(),
            'error_scrubbed': (e['error'] ?? '').toString(),
            if (callId case final id?) 'call_id': id,
          });
      // [CALL-AUDIO-OWNER-1 2026-08-07] Re-assert the caller's actual route
      // intent BEFORE `startEngine` runs — it writes `AudioManager` itself
      // (legacy `isSpeakerphoneOn` pre-API 31, or previously an unconditional
      // clobber on API 31+ too; see the Kotlin-side fix in
      // AvaVoiceAudioPlugin.startEngine), which can leave the device on a
      // route that disagrees with what `CallAudioController.intent` says the
      // user actually wants going into the handoff.
      await CallAudioController.instance.reassert('recept_prewarm_before');
      final res = await _native.start(
          micSampleRate: 16000, playSampleRate: 24000, speaker: speaker);
      _useNative = res['ok'] == true;
      _aecOk = res['aec_enabled'] == true; // hardware echo cancellation confirmed
      // Re-assert AGAIN now that `startEngine` has returned — this is the
      // "loud again when Ava prewarms" half of the diagnosis: `startEngine`
      // just wrote its own route/mode, so pull the device back to the
      // caller's intent rather than whatever it left behind.
      await CallAudioController.instance.reassert('recept_prewarm_after');

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
        _nativeMicSub = _native.micStream().listen(_sendMic);
        return true;
      }
      AvaLog.I.log('receptionist', 'native engine unavailable (${res['reason']}) — falling back');
    }

    // 2) Fallback: record (with AEC where the OS offers it) + chunked-WAV player.
    if (!await _rec.hasPermission()) return false;
    // [CALL-AUDIO-OWNER-1 2026-08-07] Give the fallback TTS player the SAME
    // communication-audio context as the ringback tone players
    // (core/ringback_player.dart) instead of audioplayers' default
    // USAGE_MEDIA + AUDIOFOCUS_GAIN. Without this, this player could evict
    // the call's own AUDIOFOCUS_GAIN_TRANSIENT holder — the exact
    // [CALL-FOCUS-DEADLOCK-1] mechanism (2026-08-05 prod incident), just on
    // the receptionist's fallback path instead of a ringback tone.
    // `audioFocus: none` is load-bearing — never make this conditional.
    try {
      await _player.setAudioContext(AudioContext(
        android: AudioContextAndroid(
          isSpeakerphoneOn: speaker,
          audioMode: AndroidAudioMode.inCommunication,
          stayAwake: false,
          contentType: AndroidContentType.speech,
          usageType: AndroidUsageType.voiceCommunication,
          audioFocus: AndroidAudioFocus.none,
        ),
      ));
    } catch (_) {/* best-effort — a missing context write must never break the fallback path */}
    final mic = await _rec.startStream(const RecordConfig(
      encoder: AudioEncoder.pcm16bits, sampleRate: 16000, numChannels: 1,
      echoCancel: true, noiseSuppress: true, autoGain: true));
    _micSub = mic.listen(_sendMic);
    _playSub = _player.onPlayerComplete.listen((_) => _drainPlay());
    return true;
  }

  /// Upload one mic PCM16/16k frame to the DO, applying the half-duplex echo gate
  /// when hardware AEC isn't confirmed and we're on the loudspeaker (so Ava can't
  /// hear and interrupt herself). With AEC, or on earpiece, this is full-duplex.
  void _sendMic(Uint8List chunk) {
    if (_ended || chunk.isEmpty) return;
    final now = DateTime.now().millisecondsSinceEpoch;
    _micCaptured++;
    _lastMicAtMs = now; // a frame arrived → mic is alive
    final mp = _pcmPeak(chunk); // drive the caller-speaking animation
    if (mp > micLevel.value) micLevel.value = mp;
    // [CALL-REL-7] Socket is down and we're waiting on a reattach — never upload
    // into the void; count what we drop instead (§4.3/§8 client requirement 3).
    if (_reconnecting) { _micDiscardedReconnect++; return; }
    if (speaker && !_aecOk && now - _lastAvaAudioAtMs < _echoTailMs) {
      _echoSuppressed++;
      return;
    }
    _micSent++;
    _micBytes += chunk.length;
    try { _ws?.sink.add(chunk); } catch (_) {/* socket gone */}
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
        // [AVA-CLIENT-1] Deterministic "Ava is live" ack. The first inbound audio
        // frame is unambiguous proof Ava is speaking, so surface it as an explicit
        // status the session opens its ava-live gate on — no longer reliant on the
        // avaLevel meter crossing a threshold before the watchdog expires (that
        // race dropped otherwise-live unreachable-mode calls; see AVA-RECEPT-
        // UNREACHABLE-WATCHDOG-RACE). Fires even while held (countdown): a held
        // first frame still means Ava is live, and the gate honours it on release.
        onStatus?.call('live');
      }
      _bytesIn += data.length;
      _avaChunks++;
      _lastServerSeq++; // [CALL-REL-7] 1:1 with the DO's server audio seq — sent back as last_seq on reattach
      _lastAvaAudioAtMs = DateTime.now().millisecondsSinceEpoch; // echo-gate timing
      final bytes = data is Uint8List ? data : Uint8List.fromList(data);
      final ap = _pcmPeak(bytes); // drive the Ava-speaking animation
      if (ap > avaLevel.value) avaLevel.value = ap;
      if (_useNative) {
        // Native engine plays on the AEC'd comm stream — smooth + gapless, and
        // barge-in just works (caller's clean voice → Gemini stops → DO stops feeding).
        // While held (countdown), buffer instead of playing.
        if (_hold) { _heldAudio.add(bytes); } else { _native.feed(bytes); }
      } else {
        _pcmBuf.add(data);
        if (!_hold && _pcmBuf.length >= _flushBytes) _enqueueSegment();
      }
    } else if (data is String) {
      // Barge-in: the server's VAD heard the caller speak over Ava → drop her
      // queued audio so she goes silent immediately and the caller is heard.
      if (data.contains('"flush"')) _flushPlayback();
      if (data.contains('softcap')) onStatus?.call('wrapup');
      // [AVA-VM-FALLBACK-1] The DO's receipt for a degraded (dumb-voicemail)
      // session: whether the recording qualified for delivery and how much
      // CALLER audio it carried. Parsed properly rather than by substring —
      // it is the only frame here that carries values we act on. Handled
      // BEFORE the '"ended"' check below because both can arrive back to back
      // and the receipt must not be lost to the teardown.
      if (data.contains('vm_result')) {
        try {
          final m = jsonDecode(data);
          if (m is Map) {
            final stored = m['stored'] == true;
            final ms = (m['recorded_ms'] as num?)?.toInt() ?? 0;
            vmFallbackStored = stored;
            vmFallbackRecordedMs = ms;
            onVmFallbackResult?.call(stored, ms);
          }
        } catch (_) {/* malformed frame — the caller's own timeout is the backstop */}
      }
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
    } catch (e, st) {
      _playErrors++;
      _playing = false;
      final context = <String, Object>{
        'stage': 'receptionist_fallback_playback_failed',
        'segments': _segments,
        if (callId case final id?) 'call_id': id,
      };
      Analytics.capture('ava_recept_playback_error', context);
      Analytics.captureException(e, st, screen: 'call', handled: true, extra: context);
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

  /// In-call heartbeat: one rich snapshot of mic + speaker + engine + memory so a
  /// user's live call is diagnosable by email/phone in PostHog. Fires a one-shot
  /// `ava_recept_mic_stall` if the engine is up but no mic frame arrived for >3s
  /// (the dead-mic signature behind "Ava heard nothing").
  void _heartbeat() {
    if (_ended) return;
    final now = DateTime.now().millisecondsSinceEpoch;
    final micGap = _lastMicAtMs > 0 ? now - _lastMicAtMs : -1;
    final avaGap = _lastAvaAudioAtMs > 0 ? now - _lastAvaAudioAtMs : -1;
    if (!_micStallFired && _micCaptured > 0 && micGap > 3000) {
      _micStallFired = true;
      Analytics.capture('ava_recept_mic_stall', {
        'gap_ms': micGap, 'engine': _useNative ? 'native' : 'fallback',
        'mic_captured': _micCaptured, 'speaker': speaker,
        if (callId case final id?) 'call_id': id,
      });
    }
    Analytics.capture('ava_recept_progress', {
      'beat': ++_beats,
      'elapsed_s': ((now - _connectMs) / 1000).round(),
      'engine': _useNative ? 'native' : 'fallback',
      'aec_ok': _aecOk,
      'speaker': speaker,
      'got_audio': _firstAudio,
      // mic health
      'mic_captured': _micCaptured,
      'mic_sent': _micSent,
      'mic_bytes': _micBytes,
      'mic_gap_ms': micGap,           // high/growing = stalled or dead mic
      'echo_suppressed': _echoSuppressed,
      // speaker / playback health
      'ava_chunks': _avaChunks,
      'ava_bytes': _bytesIn,
      'ava_gap_ms': avaGap,           // high = Ava went quiet (waiting/ended)
      'play_errors': _playErrors,
      // device
      'rss_mb': _rssMb(),
      if (callId case final id?) 'call_id': id,
    });
  }

  static int _rssMb() {
    try {
      return (ProcessInfo.currentRss / (1024 * 1024)).round();
    } catch (_) {
      return 0;
    }
  }

  Future<void> hangup() => _finish('caller_hangup');

  /// [CALL-EXCL-1] Single-audio-authority yield: the device owner just accepted a
  /// real incoming call, so this receptionist leg must end WITHOUT posting a
  /// voicemail or a caller ack (Ava was mid-listen, but the owner is now on the
  /// line directly — there's nothing to "take a message" about). We send an
  /// explicit control frame so the ReceptionRoom DO finalizes with reason
  /// `owner_answered` (skips the voicemail message + caller ack) BEFORE the socket
  /// closes; if the socket is already gone the DO's close handler still finalizes.
  Future<void> yieldToOwner() async {
    if (_ended) return;
    Analytics.capture('ava_recept_yielded', {
      'reason': 'owner_answered',
      'engine': _useNative ? 'native' : 'fallback',
      if (callId case final id?) 'call_id': id,
    });
    try { _ws?.sink.add('{"t":"yield","reason":"owner_answered"}'); } catch (_) {}
    // Give the control frame a beat to reach the DO before we tear the socket
    // down (the DO finalizes on the frame; the close is the backstop).
    await Future<void>.delayed(const Duration(milliseconds: 120));
    await _finish('owner_answered');
  }

  /// [AVA-PREWARM-1] Abort a pre-warmed (not-yet-adopted, never-heard-by-the-
  /// caller) session with ZERO caller-visible side effects: no message posted
  /// to the owner's thread, no recording, no summary, no push. Sends an
  /// explicit control frame FIRST so the DO finalizes with reason
  /// `prewarm_abort` (worker/src/do/reception_room_cf.ts skips delivery for
  /// that reason, mirroring the existing `takenOver` skip) before the socket
  /// closes — same ordering as [yieldToOwner]. If the WS never connected, the
  /// safety-finalize route (`POST /api/receptionist/finish`) never posts
  /// anything either way, so this is side-effect-free even mid-`start()`.
  Future<void> abortPrewarm() async {
    if (_ended) return;
    Analytics.capture('ava_recept_prewarm_abort_sent', {
      'engine': _useNative ? 'native' : 'fallback',
      'had_first_audio': _firstAudio,
      if (callId case final id?) 'call_id': id,
    });
    try { _ws?.sink.add('{"t":"prewarm_abort"}'); } catch (_) {}
    await Future<void>.delayed(const Duration(milliseconds: 120));
    await _finish('prewarm_abort');
  }

  // ── [CALL-REL-7] receptionist WS reattach ───────────────────────────────────
  // Plan §4.3: STARTING → CONNECTED → RECONNECTING → CONNECTED, or → FINALIZING
  // → ENDED. Server contract: Specs/PERMANENT-P2P-CALL-RELIABILITY-
  // IMPLEMENTATION-PLAN-2026-07-24.md §8. Incident this fixes: AVATOK-CALL-
  // SYSTEM-BIBLE-2026-07-24.md Part 9 — a 32s caller WS blip killed the audio
  // leg immediately even though the DO kept Ava talking server-side.

  /// Single entry point for "the transport just went away". Flag OFF (or no
  /// reattach credentials from /start) is EXACTLY today's behavior: finish
  /// immediately. Flag ON attempts a bounded reattach before ever finishing.
  void _handleTransportDown(String reason) {
    if (_ended) return;
    if (!RemoteConfig.receptionistReconnectV1 || _reconnectToken == null || _rtcUrlBase == null) {
      _finish(reason);
      return;
    }
    if (_reconnecting) return; // an attempt is already in flight for this drop
    unawaited(_onSocketLost(reason));
  }

  Future<void> _onSocketLost(String reason) async {
    if (_ended || _reconnecting) return;
    _reconnecting = true;
    _reconnectAttempts = 0;
    final startMs = DateTime.now().millisecondsSinceEpoch;
    final sessionHash = (_sessionId ?? callId ?? '').hashCode.toString();
    Analytics.capture('receptionist_reconnect_started', {
      'session_hash': sessionHash,
      'reason': reason,
      if (callId case final id?) 'call_id': id,
    });
    onStatus?.call('reconnecting');
    await _wsSub?.cancel();
    _wsConnected = false;

    const backoffsMs = [250, 500, 1000, 2000, 2000];
    const maxBudgetMs = 8000;
    var idx = 0;
    while (true) {
      if (_ended) return;
      final now = DateTime.now().millisecondsSinceEpoch;
      final hardRemainMs = _hardCapDeadlineMs - now;
      if (hardRemainMs <= 0) { _reconnectFail('hard_cap', startMs, sessionHash); return; }
      final budgetLeftMs = maxBudgetMs - (now - startMs);
      if (budgetLeftMs <= 0) { _reconnectFail('recept_reconnect_timeout', startMs, sessionHash); return; }
      final waitMs = min(min(idx < backoffsMs.length ? backoffsMs[idx] : 2000, budgetLeftMs), hardRemainMs);
      if (waitMs > 0) await Future.delayed(Duration(milliseconds: waitMs));
      if (_ended) return;
      idx++;
      _reconnectAttempts++;
      final res = await _attemptReattach();
      if (_ended) {
        // hangup()/yieldToOwner() finished the call while this attempt was in
        // flight — don't resurrect a socket for an already-ended session. The
        // reattach succeeded (socket is live and DO-confirmed "resumed"), so
        // this is a deliberate discard, not a drop — close it clean (1000) so
        // the DO doesn't open another reattach grace window on it.
        if (res == _ReattachResult.success) {
          try { await _ws?.sink.close(1000); } catch (_) {}
        }
        return;
      }
      if (res == _ReattachResult.success) {
        _reconnecting = false;
        Analytics.capture('receptionist_reconnect_completed', {
          'session_hash': sessionHash,
          'attempts': _reconnectAttempts,
          'elapsed_ms': DateTime.now().millisecondsSinceEpoch - startMs,
          if (callId case final id?) 'call_id': id,
        });
        onStatus?.call('reconnected');
        return;
      }
      if (res == _ReattachResult.terminal) {
        _reconnectFail('recept_reconnect_denied', startMs, sessionHash);
        return;
      }
      // retry — loop again within the remaining backoff/budget/hard-cap window
    }
  }

  void _reconnectFail(String terminalReason, int startMs, String sessionHash) {
    Analytics.capture('receptionist_reconnect_failed', {
      'session_hash': sessionHash,
      'attempts': _reconnectAttempts,
      'elapsed_ms': DateTime.now().millisecondsSinceEpoch - startMs,
      'terminal_reason': terminalReason,
      if (callId case final id?) 'call_id': id,
    });
    // Always finish with the one contractual reason (plan §8 client req. 6);
    // the specific terminal_reason above is what dashboards slice by.
    _finish('recept_reconnect_timeout');
  }

  /// One reattach attempt: connect, wait for the server's `{t:"resumed"}` ack,
  /// then wait for either real post-resume audio or a bounded quiet period
  /// before declaring success (never claim "connected" off stale/buffered
  /// frames alone). A `{t:"terminal",...}` response or a 403/410-shaped close
  /// is [_ReattachResult.terminal] — never worth retrying (bad/expired token or
  /// the session already finalized). Anything else bounded-timeout → retry.
  Future<_ReattachResult> _attemptReattach() async {
    final url = _buildReattachUrl();
    if (url == null) return _ReattachResult.terminal;
    WebSocketChannel ch;
    try {
      ch = WebSocketChannel.connect(Uri.parse(ReceptionistApi.wsUrl(url)));
    } catch (_) {
      return _ReattachResult.retry;
    }
    final completer = Completer<_ReattachResult>();
    var first = true;
    var resumedSeen = false;
    Timer? quietTimer;
    late final StreamSubscription sub;
    sub = ch.stream.listen((data) {
      if (first) {
        first = false;
        if (data is String && data.contains('"terminal"')) {
          if (!completer.isCompleted) completer.complete(_ReattachResult.terminal);
          return;
        }
        if (data is String && data.contains('"resumed"')) {
          resumedSeen = true;
          // Bounded quiet period: the server confirmed resume even if Ava
          // stays silent for a moment (she may just be listening).
          quietTimer = Timer(const Duration(milliseconds: 1200), () {
            if (!completer.isCompleted) completer.complete(_ReattachResult.success);
          });
          return;
        }
        // Unexpected first frame — still a live socket, treat as resumed.
        if (!completer.isCompleted) completer.complete(_ReattachResult.success);
      }
      if (resumedSeen && data is List<int> && !completer.isCompleted) {
        quietTimer?.cancel();
        completer.complete(_ReattachResult.success);
      }
      _onWs(data);
    }, onDone: () {
      if (!completer.isCompleted) completer.complete(_ReattachResult.retry);
      _handleTransportDown('model_closed');
    }, onError: (Object e, StackTrace st) {
      if (!completer.isCompleted) completer.complete(_ReattachResult.retry);
      _handleTransportDown('error');
    });

    final result = await completer.future
        .timeout(const Duration(seconds: 3), onTimeout: () => _ReattachResult.retry);
    quietTimer?.cancel();
    if (result != _ReattachResult.success) {
      await sub.cancel();
      try { await ch.sink.close(); } catch (_) {}
      return result;
    }
    await _wsSub?.cancel();
    _ws = ch;
    _wsSub = sub;
    _wsConnected = true;
    return result;
  }

  /// Rebuild the reattach WS URL from the ORIGINAL /start rtc_url — swap the
  /// single-use `t` for `reattach=1&rt=<reconnect_token>&last_seq=<n>`, keeping
  /// any other param (e.g. `engine=cf`) untouched. Reuses [ReceptionistApi.wsUrl]
  /// (the existing generic relative→absolute WS helper) rather than adding a
  /// second one.
  String? _buildReattachUrl() {
    final base = _rtcUrlBase;
    final token = _reconnectToken;
    if (base == null || token == null || _sessionId == null) return null;
    if (_reconnectExpiresAt > 0 && DateTime.now().millisecondsSinceEpoch > _reconnectExpiresAt) return null;
    final orig = Uri.parse(base);
    final params = Map<String, String>.from(orig.queryParameters);
    params.remove('t');
    params['reattach'] = '1';
    params['rt'] = token;
    params['last_seq'] = _lastServerSeq.toString();
    return orig.replace(queryParameters: params).toString();
  }

  Future<void> _finish(String reason) async {
    if (_ended) return;
    _ended = true;
    _hardCap?.cancel();
    _hb?.cancel();
    _levelTimer?.cancel();
    micLevel.value = 0;
    avaLevel.value = 0;
    // Stop audio engines.
    Map<String, dynamic>? nativeCounters;
    // Each ReceptionistCall owns a native bridge instance. Detach its callback
    // before stopping so a delayed platform event cannot mutate the next call.
    _native.onEvent = null;
    if (_useNative) {
      try { nativeCounters = await _native.stop(); } catch (_) {}
      await _nativeMicSub?.cancel();
    } else {
      await _micSub?.cancel();
      try { await _rec.stop(); } catch (_) {}
      try { await _player.stop(); } catch (_) {}
      await _playSub?.cancel();
    }
    // [CALL-REL-7] Explicit clean-close code. A no-arg close() surfaces to the
    // server as 1005 (no status received) — the DO's reattach grace window
    // (commit d8a9790) treats any non-1000 caller-socket close as an unclean
    // drop and holds Gemini alive up to 8s before finalizing, which turned
    // EVERY normal hangup into a delayed voicemail + a misleading terminal
    // reason of caller_reconnect_timeout instead of caller_hangup. Every path
    // that reaches _finish() (hangup/caller_hangup, yieldToOwner/owner_answered,
    // ended_remote, no_mic, hard_cap, recept_reconnect_timeout, ...) is either a
    // deliberate client-initiated close (socket still open — code now lands) or
    // fires after the transport already died in onDone/onError via
    // _handleTransportDown (socket already gone — this call is a no-op, so the
    // 1005 the server saw for that drop is untouched). _handleTransportDown
    // itself never calls close() directly, so unexpected drops keep whatever
    // code the transport actually reported.
    try { await _ws?.sink.close(1000); } catch (_) {}
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
      'aec_ok': _aecOk,
      'speaker': speaker,
      'got_audio': _firstAudio,
      'audio_bytes_in': _bytesIn,
      'ava_chunks': _avaChunks,
      'segments': _segments,
      'play_errors': _playErrors,
      // [CALL-REL-7]
      'reconnect_attempts': _reconnectAttempts,
      'mic_discarded_reconnect': _micDiscardedReconnect,
      'echo_suppressed': _echoSuppressed,
      // final mic health — mic_captured:0 = dead mic / no input the whole call
      'mic_captured': _micCaptured,
      'mic_sent': _micSent,
      'mic_bytes': _micBytes,
      'beats': _beats,
      'rss_mb': _rssMb(),
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
  /// Normalized peak (0..1) of a little-endian PCM16 chunk — a cheap VU meter
  /// for the speaking animation. Sampled sparsely (every 4th sample) for speed.
  static double _pcmPeak(Uint8List b) {
    if (b.length < 2) return 0;
    int peak = 0;
    for (int i = 0; i + 1 < b.length; i += 8) {
      int s = b[i] | (b[i + 1] << 8);
      if (s > 32767) s -= 65536;
      final a = s < 0 ? -s : s;
      if (a > peak) peak = a;
    }
    return (peak / 32768.0).clamp(0.0, 1.0).toDouble();
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
