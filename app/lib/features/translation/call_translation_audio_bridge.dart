import 'dart:async';
import 'dart:convert';

import 'package:flutter/services.dart';

class CallTranslationAudioEvent {
  const CallTranslationAudioEvent(this.type, this.value);
  final String type;
  final String? value;
}

/// Android host bridge over flutter_webrtc's decoded incoming playback.
class CallTranslationAudioBridge {
  CallTranslationAudioBridge._();
  static final instance = CallTranslationAudioBridge._();

  static const sourceCapability = 'webrtc_same_capture_pcm16_v1';
  static const _methods = MethodChannel('avatok/call_translation_audio');
  static const _events = EventChannel('avatok/call_translation_audio_events');

  Stream<CallTranslationAudioEvent>? _stream;

  Stream<CallTranslationAudioEvent> get events => _stream ??= _events
      .receiveBroadcastStream()
      .map((raw) {
        final decoded = jsonDecode(raw?.toString() ?? '{}');
        final map = decoded is Map ? decoded.cast<String, dynamic>() : const <String, dynamic>{};
        return CallTranslationAudioEvent(map['type']?.toString() ?? 'unknown', map['value']?.toString());
      });

  Future<bool> isSupported() async {
    try {
      return await _methods.invokeMethod<bool>('isSupported') ?? false;
    } catch (_) {
      return false;
    }
  }

  Future<void> prepare({required String token, required String targetLanguage}) async {
    await _methods.invokeMethod<void>('prepare', {
      'token': token,
      'targetLanguage': targetLanguage,
    });
  }

  Future<void> activate() => _methods.invokeMethod<void>('activate');

  Future<void> commitPaid() => _methods.invokeMethod<void>('commitPaid');

  Future<void> resume({required String token, required String handle}) =>
      _methods.invokeMethod<void>('resume', {'token': token, 'handle': handle});

  Future<void> stop() async {
    try {
      await _methods.invokeMethod<void>('stop');
    } catch (_) {}
  }
}
