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

  /// Start the engine. [speaker] selects loudspeaker vs earpiece/Bluetooth.
  /// Returns false if it couldn't start (e.g. mic permission denied) so the
  /// caller can fall back to the legacy audio path.
  Future<bool> start({
    int micSampleRate = 16000,
    int playSampleRate = 24000,
    bool speaker = true,
  }) async {
    try {
      final ok = await _m.invokeMethod<bool>('start', {
        'micSampleRate': micSampleRate,
        'playSampleRate': playSampleRate,
        'speaker': speaker,
      });
      return ok ?? false;
    } catch (_) {
      return false;
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

  Future<void> stop() async {
    try { await _m.invokeMethod('stop'); } catch (_) {}
  }
}
