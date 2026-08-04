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

  /// [CALL-TRANSLATE-2C-4] `targetLanguage` is OPTIONAL and additive: omitted (the
  /// plain-resume case) the pending socket announces the language the plugin is
  /// already speaking, exactly as before.
  Future<void> resume({
    required String token,
    required String handle,
    String? targetLanguage,
  }) =>
      _methods.invokeMethod<void>('resume', {
        'token': token,
        'handle': handle,
        if (targetLanguage != null && targetLanguage.isNotEmpty) 'targetLanguage': targetLanguage,
      });

  /// [CALL-TRANSLATE-2C-4] TRUE make-before-break for a mid-call language switch.
  ///
  /// Opens a SECOND provider socket announcing [targetLanguage] while the live
  /// one KEEPS TRANSLATING. Nothing about the live session changes until the new
  /// socket reports `setupComplete`; at that instant the plugin swaps them and
  /// emits `language_switched`. This future completing means only "the second
  /// socket is being opened" — the cutover itself is signalled by that event, or
  /// by `resume_failed` with `switching: true` if the pending socket dies.
  ///
  /// [handle] is optional: null/omitted opens a FRESH session rather than
  /// resuming the old one's context.
  ///
  /// Throws [PlatformException] with:
  ///  * `not_prepared`      — no live session to switch away from
  ///  * `invalid_arguments` — empty token or language
  ///  * `switch_in_flight`  — a pending socket already exists (one at a time)
  Future<void> switchLanguage({
    required String token,
    required String targetLanguage,
    String? handle,
  }) =>
      _methods.invokeMethod<void>('switchLanguage', {
        'token': token,
        'targetLanguage': targetLanguage,
        if (handle != null && handle.isNotEmpty) 'handle': handle,
      });

  /// [CALL-TRANSLATE-2D-4] Abandon a pending make-before-break socket that Dart
  /// has given up on (its own cutover deadline, or a channel-level failure).
  ///
  /// Closes and nulls `pendingSocket` and NOTHING else: the live session, the
  /// language it is speaking, `active`/`paid`, the fallback state and the worker
  /// threads are all untouched, so the user keeps hearing the language they are
  /// already being translated into. Without this, a timed-out cutover left
  /// `pendingSocket` non-null for the rest of the call, which wedged every later
  /// `switchLanguage` with `switch_in_flight` AND silently disabled goAway-driven
  /// provider resume (the plugin gates resume on `pendingSocket == null`).
  ///
  /// [reason] is a short CATEGORY tag (≤40 chars, hard-capped natively) — never
  /// content. Returns true if a pending socket was actually abandoned.
  ///
  /// Dart still owns clearing any `setFallback(true, …)` it raised itself; this
  /// method deliberately does not touch the mute.
  Future<bool> cancelSwitch({String reason = 'cancelled'}) async {
    try {
      return await _methods.invokeMethod<bool>('cancelSwitch', {'reason': reason}) ?? false;
    } catch (_) {
      return false;
    }
  }

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
