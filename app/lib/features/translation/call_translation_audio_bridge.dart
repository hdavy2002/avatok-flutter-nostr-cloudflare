import 'dart:async';
import 'dart:convert';

import 'package:flutter/services.dart';

/// One event from the native call-translation plugin.
///
/// [CALL-TRANSLATE-2B-1] The native side emits a JSON object with `type` and
/// `value` PLUS a flat set of extra keys (counters, durations, reasons). The
/// original bridge decoded only `type`/`value`, so every counter the plugin
/// published — stall counts, PCM drops, uplink failures, short writes — was
/// silently discarded before Dart ever saw it. [data] carries those extras.
class CallTranslationAudioEvent {
  const CallTranslationAudioEvent(this.type, this.value, [this.data = const {}]);
  final String type;
  final String? value;

  /// Every key in the native payload except `type`/`value`. Never contains
  /// transcript text or audio-derived content — the plugin does not emit any
  /// (captions were removed in [CALL-TRANSLATE-2A-1]) and nothing here may be
  /// logged or forwarded to PostHog without checking that rule first.
  final Map<String, dynamic> data;

  int intOf(String key, [int fallback = 0]) {
    final v = data[key];
    if (v is num) return v.toInt();
    if (v is String) return int.tryParse(v) ?? fallback;
    return fallback;
  }

  bool boolOf(String key, [bool fallback = false]) {
    final v = data[key];
    if (v is bool) return v;
    if (v is num) return v != 0;
    if (v is String) return v == 'true' || v == '1';
    return fallback;
  }
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
        final extras = <String, dynamic>{};
        for (final entry in map.entries) {
          if (entry.key == 'type' || entry.key == 'value') continue;
          extras[entry.key] = entry.value;
        }
        return CallTranslationAudioEvent(
          map['type']?.toString() ?? 'unknown',
          map['value']?.toString(),
          extras,
        );
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

  /// [CALL-TRANSLATE-2B-2] Ask the plugin to un-mute (or re-mute) the ORIGINAL
  /// decoded call audio without tearing the session down. This is the same
  /// mechanism the native dead-air guard uses, exposed so Dart can invoke it
  /// for a route change, an audio-focus blip, or (Phase C) a language-switch
  /// cutover — the user hears the real speaker instead of silence.
  ///
  /// Best-effort by design: a failure here must never propagate into the call.
  Future<bool> setFallback({required bool enabled, String reason = 'switching'}) async {
    try {
      return await _methods.invokeMethod<bool>('setFallback', {
            'enabled': enabled,
            'reason': reason,
          }) ??
          false;
    } catch (_) {
      return false;
    }
  }

  /// [CALL-TRANSLATE-2B-3] Force an immediate `stats` event. The plugin also
  /// publishes stats every 30 s and once with `final:true` at every session-end
  /// path; this lets Dart sample sooner (e.g. to time first translated audio).
  Future<bool> requestStats() async {
    try {
      return await _methods.invokeMethod<bool>('stats') ?? false;
    } catch (_) {
      return false;
    }
  }

  Future<void> stop() async {
    try {
      await _methods.invokeMethod<void>('stop');
    } catch (_) {}
  }
}
