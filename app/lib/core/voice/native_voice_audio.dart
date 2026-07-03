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

class NativeVoiceAudio {
  static const MethodChannel _m = MethodChannel('avatok/voice_audio');
  static const EventChannel _mic = EventChannel('avatok/voice_audio/mic');

  /// Native engine is currently implemented on Android only.
  static bool get isSupported => !kIsWeb && Platform.isAndroid;

  Stream<Uint8List>? _micStream;

  /// Async diagnostics pushed from native (capture_error, play_error, …). The
  /// controller forwards these to PostHog so runtime audio faults are visible.
  void Function(Map<String, dynamic> event)? onEvent;
  bool _handlerSet = false;

  void _ensureHandler() {
    if (_handlerSet) return;
    _handlerSet = true;
    _m.setMethodCallHandler((call) async {
      if (call.method == 'event' && call.arguments is Map) {
        try {
          onEvent?.call(Map<String, dynamic>.from(call.arguments as Map));
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
}
