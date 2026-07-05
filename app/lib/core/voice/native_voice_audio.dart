/// NativeVoiceAudio — Dart bridge to the native full-duplex voice-call audio
/// engine (Android: AvaVoiceAudioPlugin). It captures the mic and plays Ava's
/// PCM through ONE communication audio session with the platform
/// AcousticEchoCanceler attached, so Ava's own voice is removed from the mic and
/// the call is true full-duplex (real barge-in) on the loudspeaker.
///
/// Android only for now; [isSupported] is false elsewhere and the controller
/// falls back to the record + flutter_pcm_sound + half-duplex path.
library;

import 'dart:io' show Platform;
import 'dart:typed_data';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

import '../analytics.dart';

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
}
