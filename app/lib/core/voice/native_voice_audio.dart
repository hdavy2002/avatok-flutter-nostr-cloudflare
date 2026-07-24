/// NativeVoiceAudio — Dart bridge to the native full-duplex voice-call audio
/// engine (Android: AvaVoiceAudioPlugin). It captures the mic and plays Ava's
/// PCM through ONE communication audio session with the platform
/// AcousticEchoCanceler attached, so Ava's own voice is removed from the mic and
/// the call is true full-duplex (real barge-in) on the loudspeaker.
///
/// Android only for now; [isSupported] is false elsewhere and the controller
/// falls back to the record + flutter_pcm_sound + half-duplex path.
library;

import 'dart:async';
import 'dart:io' show Platform;
import 'dart:typed_data';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:uuid/uuid.dart';

import '../analytics.dart';

/// CALL-REL-1: confirmed Android call-audio route. `unknown` means the
/// native/platform side has not reported (or does not support) a specific
/// route yet — callers must not assume `earpiece` in that case.
enum CallAudioRoute { earpiece, speaker, bluetooth, wiredHeadset, unknown }

String _routeToWire(CallAudioRoute r) {
  switch (r) {
    case CallAudioRoute.earpiece:
      return 'earpiece';
    case CallAudioRoute.speaker:
      return 'speaker';
    case CallAudioRoute.bluetooth:
      return 'bluetooth';
    case CallAudioRoute.wiredHeadset:
      return 'headset';
    case CallAudioRoute.unknown:
      return 'unknown';
  }
}

CallAudioRoute _routeFromWire(String? s) {
  switch (s) {
    case 'earpiece':
      return CallAudioRoute.earpiece;
    case 'speaker':
      return CallAudioRoute.speaker;
    case 'bluetooth':
      return CallAudioRoute.bluetooth;
    case 'headset':
    case 'wired_headset':
      return CallAudioRoute.wiredHeadset;
    default:
      return CallAudioRoute.unknown;
  }
}

/// CALL-REL-1: outcome of a [NativeVoiceAudio.selectRoute] request. `active`
/// is the route Android actually confirmed — the UI must render this, not
/// merely the last button press. See Specs/PERMANENT-P2P-CALL-RELIABILITY-
/// IMPLEMENTATION-PLAN-2026-07-24.md §4.2/§5.
class CallAudioRouteResult {
  final String requestId;
  final CallAudioRoute requested;
  final CallAudioRoute active;
  final bool exact;
  final String? fallbackReason;
  final String backend;
  final int elapsedMs;

  const CallAudioRouteResult({
    required this.requestId,
    required this.requested,
    required this.active,
    required this.exact,
    required this.backend,
    required this.elapsedMs,
    this.fallbackReason,
  });
}

class NativeVoiceAudio {
  static const MethodChannel _m = MethodChannel('avatok/voice_audio');
  static const EventChannel _mic = EventChannel('avatok/voice_audio/mic');

  /// CALL-BG-B5: the method channel above is global to the platform side, but
  /// [setMethodCallHandler] (set lazily in [_ensureHandler]) is per-Dart-*instance* —
  /// only the last instance to invoke a method "owns" the handler and will see
  /// [onNotificationHangup]/[onNotificationTapReturnToCall]. Code that needs those
  /// callbacks (the call session layer) MUST use this shared singleton rather than
  /// constructing a fresh `NativeVoiceAudio()`, or a later ad-hoc instance elsewhere
  /// in the app (e.g. `live_voice_controller.dart`, `receptionist_call.dart`) can
  /// silently steal the handler. See `Specs/CALL-SESSION-API.md` "WS-B integration".
  static final NativeVoiceAudio instance = NativeVoiceAudio();

  /// Native engine is currently implemented on Android only.
  static bool get isSupported => !kIsWeb && Platform.isAndroid;

  Stream<Uint8List>? _micStream;

  /// Async diagnostics pushed from native (capture_error, play_error, …). The
  /// controller forwards these to PostHog so runtime audio faults are visible.
  void Function(Map<String, dynamic> event)? onEvent;

  /// CALL-BG-B2: fired when the user taps "Hang up" on the ongoing-call
  /// notification (`CallForegroundService` → `AvaVoiceAudioPlugin.notifyHangupRequested`
  /// → method-channel event `onNotificationHangup`). WS-A's `CallSession.hangup()`
  /// must be wired to this — see `Specs/CALL-SESSION-API.md` "WS-B integration".
  /// [callId] is the room/call id the hang-up applies to.
  void Function(String callId)? onNotificationHangup;

  /// CALL-BG-B3: fired when the app is launched/foregrounded by tapping the
  /// ongoing-call notification (`MainActivity` → `AvaVoiceAudioPlugin.notifyNotificationTap`
  /// → method-channel event `onNotificationTapReturnToCall`). WS-A/WS-C must route
  /// back to the active `CallScreen` for [callId] when this fires — see
  /// `Specs/CALL-SESSION-API.md` "WS-B integration".
  void Function(String callId)? onNotificationTapReturnToCall;

  /// CALL-FOCUS-1: fired when the OS takes audio focus away from our call
  /// (another app started playing / took a call). The call session should HOLD
  /// the call — mute capture + show an "on hold" state — WITHOUT tearing down
  /// the RTC session. Delivered via the shared method-channel handler, so
  /// subscribers MUST use [NativeVoiceAudio.instance].
  void Function()? onAudioFocusLost;

  /// CALL-FOCUS-1: fired when the OS returns audio focus to our call. The call
  /// session should RESUME (unmute capture, clear the "on hold" state).
  void Function()? onAudioFocusRegained;

  bool _handlerSet = false;

  void _ensureHandler() {
    if (_handlerSet) return;
    _handlerSet = true;
    _m.setMethodCallHandler((call) async {
      if (call.method == 'event' && call.arguments is Map) {
        try {
          final args = Map<String, dynamic>.from(call.arguments as Map);
          final name = args['name'];
          if (name == 'onNotificationHangup') {
            final callId = (args['callId'] ?? '').toString();
            Analytics.capture('call_notification_hangup', {'call_id': callId});
            onNotificationHangup?.call(callId);
          } else if (name == 'onNotificationTapReturnToCall') {
            final callId = (args['callId'] ?? '').toString();
            Analytics.capture('call_notification_tap', {'call_id': callId});
            onNotificationTapReturnToCall?.call(callId);
          } else if (name == 'onAudioFocusLost') {
            onAudioFocusLost?.call();
          } else if (name == 'onAudioFocusRegained') {
            onAudioFocusRegained?.call();
          } else {
            onEvent?.call(args);
          }
        } catch (_) {}
      }
      return null;
    });
  }

  /// Start the engine. [speaker] selects loudspeaker vs earpiece/Bluetooth.
  /// Returns a diagnostics map: {ok, aec_available, aec_enabled, ns_*, agc_*,
  /// record_state, track_state, in_buf, out_buf, …}. `ok` is false (with a
  /// `reason`) if it couldn't start, so the caller can fall back.
  Future<Map<String, dynamic>> start({
    int micSampleRate = 16000,
    int playSampleRate = 24000,
    bool speaker = true,
  }) async {
    _ensureHandler();
    try {
      final r = await _m.invokeMethod<dynamic>('start', {
        'micSampleRate': micSampleRate,
        'playSampleRate': playSampleRate,
        'speaker': speaker,
      });
      if (r is Map) return Map<String, dynamic>.from(r);
      return {'ok': false, 'reason': 'no_result'};
    } catch (e) {
      return {'ok': false, 'reason': 'invoke_failed', 'error': e.toString()};
    }
  }

  /// Mic PCM16 frames (mono, micSampleRate) captured WITH echo cancellation.
  Stream<Uint8List> micStream() =>
      _micStream ??= _mic.receiveBroadcastStream().map((e) => e as Uint8List);

  /// Queue a chunk of Ava's PCM16 (mono, playSampleRate) for playback.
  Future<void> feed(Uint8List pcm) async {
    try { await _m.invokeMethod('feed', {'bytes': pcm}); } catch (_) {}
  }

  /// Switch loudspeaker ⇆ earpiece/Bluetooth mid-call.
  Future<void> setSpeaker(bool on) async {
    try { await _m.invokeMethod('setSpeaker', {'on': on}); } catch (_) {}
  }

  /// Stop the engine. Returns final counters {frames_captured, bytes_played,
  /// capture_errors, play_errors} for a rich end-of-call telemetry event.
  Future<Map<String, dynamic>?> stop() async {
    try {
      final r = await _m.invokeMethod<dynamic>('stop');
      return r is Map ? Map<String, dynamic>.from(r) : null;
    } catch (_) {
      return null;
    }
  }

  /// CALLFIX-16: Start P2P call audio mode (VOICE_COMMUNICATION + audio focus).
  /// Sets the AudioManager to MODE_IN_COMMUNICATION and requests audio focus so
  /// the platform applies hardware echo cancellation, noise suppression, and
  /// automatic gain control. Called at the start of a P2P WebRTC call.
  Future<void> startP2pAudioMode() async {
    try { await _m.invokeMethod('startP2pAudioMode'); } catch (_) {}
  }

  /// CALLFIX-16: Stop P2P call audio mode and restore normal audio.
  /// Called on call end to restore the normal audio mode and release audio focus
  /// so music/media can resume.
  Future<void> stopP2pAudioMode() async {
    try { await _m.invokeMethod('stopP2pAudioMode'); } catch (_) {}
  }

  /// CALLFIX-18: Get the current audio route (earpiece|speaker|bluetooth|headset).
  Future<String?> getAudioRoute() async {
    try {
      return await _m.invokeMethod<String>('getAudioRoute');
    } catch (_) {
      return null;
    }
  }

  /// CALLFIX-18: Set the audio route by name (earpiece|speaker|bluetooth|headset).
  Future<void> setAudioRoute(String route) async {
    try { await _m.invokeMethod('setAudioRoute', {'route': route}); } catch (_) {}
  }

  /// CALLFIX-18: Start Bluetooth SCO (audio data exchange).
  Future<void> startBluetoothSco() async {
    try { await _m.invokeMethod('startBluetoothSco'); } catch (_) {}
  }

  /// CALLFIX-18: Stop Bluetooth SCO.
  Future<void> stopBluetoothSco() async {
    try { await _m.invokeMethod('stopBluetoothSco'); } catch (_) {}
  }

  /// CALLFIX-19: Start proximity sensor for screen-off during earpiece calls.
  /// Only active when the audio route is earpiece; disabled for speaker/Bluetooth.
  Future<void> startProximitySensor() async {
    try { await _m.invokeMethod('startProximitySensor'); } catch (_) {}
  }

  /// CALLFIX-19: Stop proximity sensor.
  Future<void> stopProximitySensor() async {
    try { await _m.invokeMethod('stopProximitySensor'); } catch (_) {}
  }

  /// CALLFIX-20 / CALL-BG-B1: Start foreground service for ongoing calls.
  /// Shows an ongoing-call notification with chronometer and hang-up action.
  /// [callId] and [peerName] are used in the notification; [peerName] is the
  /// name of the person being called. [isVideo] adds the `camera`
  /// foregroundServiceType bit (required by Android 14+ for video calls).
  ///
  /// MUST be called at CALL SETUP — outgoing dial placed or incoming call
  /// accepted — NOT after P2P connects, so a call backgrounded while still
  /// ringing/connecting survives. See `Specs/CALL-SESSION-API.md` "WS-B
  /// integration" for the exact call site `CallSession.start()` must use.
  /// [at] records whether this was called on "dial" or "accept" for telemetry.
  Future<void> startCallForegroundService({
    required String callId,
    required String peerName,
    bool isVideo = false,
    String at = 'dial',
  }) async {
    // CALL-BG-INT1: the P2P call path never calls [start] (it uses flutter_webrtc,
    // not this native engine), so without this the method-channel handler would
    // never be bound during a P2P call and the notification Hang-up / tap-return
    // events would be dropped. Binding here makes whichever instance starts the
    // FGS own the handler — callers MUST use [NativeVoiceAudio.instance] so the
    // instance that carries [onNotificationHangup]/[onNotificationTapReturnToCall]
    // is the one that owns it.
    _ensureHandler();
    Analytics.capture('call_fgs_started', {
      'call_id': callId,
      'is_video': isVideo,
      'at': at,
    });
    try {
      await _m.invokeMethod('startCallForegroundService', {
        'callId': callId,
        'peerName': peerName,
        'isVideo': isVideo,
      });
    } catch (_) {}
  }

  /// CALLFIX-20 / CALL-BG-B1: Stop foreground service on call end. MUST be
  /// called exactly once per call, from `CallSession.hangup()` — see
  /// `Specs/CALL-SESSION-API.md` "WS-B integration". [reason] is telemetry-only
  /// (e.g. "hangup", "peer_left", "notification_hangup", "no_answer").
  Future<void> stopCallForegroundService({String reason = 'hangup'}) async {
    Analytics.capture('call_fgs_stopped', {'reason': reason});
    try { await _m.invokeMethod('stopCallForegroundService'); } catch (_) {}
  }

  /// CALLFIX-23: Listen for cellular call interruption (GSM call during VoIP).
  /// Returns a stream of events; each event is a map with 'state' = 'held' or 'resumed'.
  /// When a cellular call comes in, state='held'; when it ends, state='resumed'.
  /// The app mutes mic and shows "On hold" banner when held, unmutes when resumed.
  Stream<Map<String, dynamic>> get telephonyEventStream =>
      EventChannel('avatok/voice_audio/telephony')
          .receiveBroadcastStream()
          .map((e) => Map<String, dynamic>.from(e as Map));

  /// CALLFIX-23: Start listening for cellular call interruption.
  /// Call this at the start of a call; stop when the call ends.
  Future<void> startTelephonyMonitoring() async {
    try { await _m.invokeMethod('startTelephonyMonitoring'); } catch (_) {}
  }

  /// CALLFIX-23: Stop listening for cellular call interruption.
  Future<void> stopTelephonyMonitoring() async {
    try { await _m.invokeMethod('stopTelephonyMonitoring'); } catch (_) {}
  }

  /// CALL-FSI-1: whether the app may post full-screen-intent notifications — the
  /// lock-screen incoming-call UI. Android 14+ (API 34) revokes
  /// USE_FULL_SCREEN_INTENT for non-dialer apps unless the user grants it in
  /// Settings; without it, an incoming call rings but never wakes the screen /
  /// shows the call UI. On API < 34 (or non-Android) this returns true.
  Future<bool> canUseFullScreenIntent() async {
    if (!isSupported) return true;
    try {
      final r = await _m.invokeMethod<bool>('canUseFullScreenIntent');
      return r ?? true;
    } catch (_) {
      return true; // never gate the user on a check failure
    }
  }

  /// CALL-FSI-1: open the system per-app "Full screen intents" settings page
  /// (ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT) so the user can grant lock-screen
  /// call UI. Returns true if a settings activity was launched (API 34+ only).
  Future<bool> openFullScreenIntentSettings() async {
    if (!isSupported) return false;
    try {
      final r = await _m.invokeMethod<bool>('openFullScreenIntentSettings');
      return r ?? false;
    } catch (_) {
      return false;
    }
  }

  // ───────────────────────────────────────────────────────────────────────
  // CALL-REL-1: CallAudioController facade — the ONLY code path that may
  // start/stop the P2P communication session, request focus/mode, or select
  // a communication route. Gated behind RemoteConfig.callAudioControllerV2;
  // when the flag is off, [CallSession] must not call any of the methods
  // below and the app behaves exactly as before. See Specs/PERMANENT-P2P-
  // CALL-RELIABILITY-IMPLEMENTATION-PLAN-2026-07-24.md §5.
  // ───────────────────────────────────────────────────────────────────────

  String? _p2pCallId;
  bool _p2pSessionActive = false;
  CallAudioRoute _activeRoute = CallAudioRoute.unknown;

  /// Serializes [selectRoute] calls so native writes never interleave. A
  /// later request supersedes an earlier one only in effect (the last write
  /// wins on the native side); this queue guarantees they are never issued
  /// concurrently.
  Future<void> _routeQueue = Future<void>.value();

  final StreamController<CallAudioRouteResult> _routeEvents =
      StreamController<CallAudioRouteResult>.broadcast();

  /// Confirmed route transitions — requested, user toggle, fallback, etc.
  /// The UI should render [CallAudioRouteResult.active], not merely the
  /// last-requested route.
  Stream<CallAudioRouteResult> get routeEvents => _routeEvents.stream;

  /// CALL-REL-1: begin the single P2P call-audio session — activates the
  /// native `p2pActive` gate (proximity/telephony monitoring), the
  /// communication audio mode, and audio focus. Safe to call twice for the
  /// same [callId] (idempotent); does not itself pick a route — callers must
  /// follow with [selectRoute].
  Future<void> beginP2pSession({required String callId, required bool video}) async {
    _ensureHandler();
    if (_p2pSessionActive && _p2pCallId == callId) return;
    _p2pCallId = callId;
    _p2pSessionActive = true;
    _activeRoute = CallAudioRoute.unknown;
    try {
      await _m.invokeMethod('startP2pCall');
    } catch (_) {}
    // Establish MODE_IN_COMMUNICATION + audio focus BEFORE any route request
    // so the route change lands inside an already-open session instead of
    // triggering a cold re-route + volume ramp.
    await startP2pAudioMode();
    try {
      await startTelephonyMonitoring();
    } catch (_) {}
  }

  /// CALL-REL-1: end the P2P call-audio session. Stops monitoring, clears
  /// the communication device, abandons focus, stops proximity, and restores
  /// the prior mode exactly once. Safe to call after only partial setup or
  /// more than once.
  Future<void> endP2pSession({required String callId}) async {
    if (!_p2pSessionActive && _p2pCallId == null) return;
    _p2pSessionActive = false;
    _p2pCallId = null;
    _activeRoute = CallAudioRoute.unknown;
    try {
      await stopP2pAudioMode();
    } catch (_) {}
    try {
      await stopBluetoothSco();
    } catch (_) {}
    try {
      await stopProximitySensor();
    } catch (_) {}
    try {
      await stopTelephonyMonitoring();
    } catch (_) {}
    try {
      await _m.invokeMethod('stopP2pCall');
    } catch (_) {}
  }

  /// CALL-REL-1: request a communication route. Serialized — a call made
  /// while a previous one is still in flight waits its turn rather than
  /// interleaving native writes. [source] is telemetry-only
  /// (`user`, `initial`, `bluetooth_connected`, `system`, `fallback`).
  Future<CallAudioRouteResult> selectRoute(
    CallAudioRoute requested, {
    String source = 'user',
  }) {
    final op = _routeQueue.then((_) => _selectRouteInternal(requested, source));
    // Swallow errors in the chain link itself so one failed request cannot
    // permanently wedge the queue for subsequent callers.
    _routeQueue = op.then((_) => null, onError: (_) => null);
    return op;
  }

  Future<CallAudioRouteResult> _selectRouteInternal(
    CallAudioRoute requested,
    String source,
  ) async {
    final requestId = const Uuid().v4();
    final startMs = DateTime.now().millisecondsSinceEpoch;
    final priorActive = _activeRoute;
    Analytics.capture('call_audio_route_requested', {
      'call_id': _p2pCallId ?? '',
      'request_id': requestId,
      'requested_route': _routeToWire(requested),
      'source': source,
      'prior_active_route': _routeToWire(priorActive),
    });
    String backend = 'legacy_sco';
    CallAudioRoute active = requested;
    String? fallbackReason;
    try {
      await _m.invokeMethod('setAudioRoute', {'route': _routeToWire(requested)});
      final readback = await _m.invokeMethod<String>('getAudioRoute');
      active = _routeFromWire(readback) == CallAudioRoute.unknown
          ? requested
          : _routeFromWire(readback);
      if (active != requested) {
        fallbackReason = 'native_reported_different_route';
      }
    } catch (e) {
      active = priorActive == CallAudioRoute.unknown ? CallAudioRoute.earpiece : priorActive;
      fallbackReason = 'invoke_failed';
    }
    // Proximity is only meaningful for earpiece; keep it in step with route
    // selection so CallSession no longer has to manage it directly.
    try {
      if (active == CallAudioRoute.earpiece) {
        await startProximitySensor();
      } else {
        await stopProximitySensor();
      }
    } catch (_) {}
    _activeRoute = active;
    final elapsedMs = DateTime.now().millisecondsSinceEpoch - startMs;
    final result = CallAudioRouteResult(
      requestId: requestId,
      requested: requested,
      active: active,
      exact: active == requested,
      backend: backend,
      elapsedMs: elapsedMs,
      fallbackReason: fallbackReason,
    );
    Analytics.capture('call_audio_route_result', {
      'call_id': _p2pCallId ?? '',
      'request_id': requestId,
      'requested_route': _routeToWire(requested),
      'active_route': _routeToWire(active),
      'exact': result.exact,
      'backend': backend,
      'elapsed_ms': elapsedMs,
      if (fallbackReason != null) 'fallback_reason': fallbackReason,
    });
    if (!_routeEvents.isClosed) _routeEvents.add(result);
    return result;
  }

  /// CALL-REL-1: the last confirmed route, querying native if this
  /// controller has not observed one yet (e.g. right after app start).
  Future<CallAudioRoute> getActiveRoute() async {
    if (_activeRoute != CallAudioRoute.unknown) return _activeRoute;
    final r = await getAudioRoute();
    _activeRoute = _routeFromWire(r);
    return _activeRoute;
  }
}
